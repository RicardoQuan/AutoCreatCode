using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BoTech
{
    internal sealed class EquipmentFlowEditorForm : Form
    {
        private const string LocalHostName = "equipment-flow.local";
        private readonly WebView2 browser;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();

        public EquipmentFlowEditorForm()
        {
            json.MaxJsonLength = 32 * 1024 * 1024;
            Text = "AutoCreatCode - 流程编辑器";
            WindowState = FormWindowState.Maximized;
            MinimumSize = new System.Drawing.Size(1100, 700);
            StartPosition = FormStartPosition.CenterScreen;

            browser = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = System.Drawing.Color.FromArgb(17, 24, 33),
            };
            Controls.Add(browser);
            Shown += InitializeBrowserAsync;
        }

        private async void InitializeBrowserAsync(object sender, EventArgs e)
        {
            try
            {
                var webRoot = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "EquipmentFlowEditor");
                var startPage = Path.Combine(webRoot, "index.html");
                if (!File.Exists(startPage))
                    throw new FileNotFoundException("设备流程 Web UI 文件未部署到程序目录。", startPage);

                var userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "BoTech",
                    "EquipmentFlowWebView2"
                );
                Directory.CreateDirectory(userDataFolder);
                var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await browser.EnsureCoreWebView2Async(environment);

                var core = browser.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.NavigationStarting += OnNavigationStarting;
                core.DownloadStarting += OnDownloadStarting;
                core.WebMessageReceived += OnWebMessageReceived;
                core.SetVirtualHostNameToFolderMapping(
                    LocalHostName,
                    webRoot,
                    CoreWebView2HostResourceAccessKind.DenyCors
                );
                browser.Source = new Uri($"https://{LocalHostName}/index.html");
            }
            catch (Exception exception)
            {
                MessageBox.Show(
                    this,
                    "AutoCreatCode 启动失败。请检查 WebView2 Runtime 和程序目录中的 EquipmentFlowEditor 文件。\r\n\r\n"
                        + exception.Message,
                    "AutoCreatCode",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                Close();
            }
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var destination)
                || !string.Equals(destination.Host, LocalHostName, StringComparison.OrdinalIgnoreCase))
            {
                e.Cancel = true;
            }
        }

        private void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs e)
        {
            var suggestedName = Path.GetFileName(e.ResultFilePath);
            if (string.IsNullOrWhiteSpace(suggestedName))
                suggestedName = "TaskProject.json";

            using (var dialog = new SaveFileDialog
            {
                Title = "保存 WebUI 文件",
                FileName = suggestedName,
                InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                Filter = "Task 项目 JSON|*.json|C# 源文件|*.cs|Excel 工作簿|*.xlsx|CSV 文件|*.csv|TSV 文件|*.tsv|Draw.io 文件|*.drawio|ZIP 文件|*.zip|所有文件|*.*",
                OverwritePrompt = true,
            })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK)
                {
                    e.Cancel = true;
                    e.Handled = true;
                    return;
                }

                e.ResultFilePath = dialog.FileName;
                e.Handled = true;
            }
        }

        // The same WebEditor output service uses this bridge when hosted inside WinForms.
        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var source)
                || !string.Equals(source.Host, LocalHostName, StringComparison.OrdinalIgnoreCase)) return;

            string requestText;
            try { requestText = e.TryGetWebMessageAsString(); }
            catch { return; }

            string requestId = string.Empty;
            IDictionary<string, object> request = null;
            var response = new Dictionary<string, object>();
            try
            {
                request = json.Deserialize<Dictionary<string, object>>(requestText);
                requestId = GetRequestValue(request, "requestId");
                response["requestId"] = requestId;
                response["ok"] = true;
                response["result"] = ExecuteNativeOutputRequest(request);
            }
            catch (Exception exception)
            {
                response["requestId"] = requestId;
                response["ok"] = false;
                response["error"] = exception.Message;
            }

            try { browser.CoreWebView2.PostWebMessageAsString(json.Serialize(response)); }
            catch { /* The page may have navigated while a native dialog was open. */ }
        }

        private object ExecuteNativeOutputRequest(IDictionary<string, object> request)
        {
            if (request == null) throw new InvalidDataException("本机文件请求内容无效。");
            switch (GetRequestValue(request, "action"))
            {
                case "chooseProjectFile":
                    using (var dialog = new SaveFileDialog
                    {
                        Title = "保存 Task 项目",
                        Filter = "Task 项目文件 (*.json)|*.json",
                        DefaultExt = "json",
                        AddExtension = true,
                        OverwritePrompt = true,
                        CheckPathExists = true,
                        FileName = GetRequestValue(request, "suggestedName"),
                        InitialDirectory = Directory.Exists(GetRequestValue(request, "currentDirectory"))
                            ? Path.GetFullPath(GetRequestValue(request, "currentDirectory"))
                            : string.Empty,
                    })
                    {
                        if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                        var projectPath = Path.GetFullPath(dialog.FileName);
                        return new Dictionary<string, object>
                        {
                            ["path"] = projectPath,
                            ["directoryPath"] = Path.GetDirectoryName(projectPath),
                            ["fileName"] = Path.GetFileName(projectPath),
                        };
                    }
                case "writeProjectFile":
                {
                    var projectPath = GetRequestValue(request, "filePath");
                    var content = GetRequestValue(request, "content");
                    if (string.IsNullOrWhiteSpace(projectPath)) throw new InvalidDataException("项目保存路径不能为空。");
                    projectPath = Path.GetFullPath(projectPath);
                    if (!string.Equals(Path.GetExtension(projectPath), ".json", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("项目文件必须使用 .json 扩展名。");
                    var directory = Path.GetDirectoryName(projectPath);
                    if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
                        throw new DirectoryNotFoundException("项目保存目录不存在：" + directory);
                    if (Encoding.UTF8.GetByteCount(content) > 12 * 1024 * 1024)
                        throw new InvalidDataException("项目文件超过 12 MB 限制。");
                    File.WriteAllText(projectPath, content, new UTF8Encoding(false));
                    return new Dictionary<string, object>
                    {
                        ["path"] = projectPath,
                        ["directoryPath"] = directory,
                        ["fileName"] = Path.GetFileName(projectPath),
                    };
                }
                case "chooseDirectory":
                    using (var dialog = new FolderBrowserDialog
                    {
                        Description = "选择 C# 输出目录",
                        ShowNewFolderButton = true,
                    })
                    {
                        var currentPath = GetRequestValue(request, "currentPath");
                        if (!string.IsNullOrWhiteSpace(currentPath) && Directory.Exists(currentPath))
                            dialog.SelectedPath = Path.GetFullPath(currentPath);
                        if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                        var selectedPath = Path.GetFullPath(dialog.SelectedPath);
                        return new Dictionary<string, object>
                        {
                            ["path"] = selectedPath,
                            ["name"] = new DirectoryInfo(selectedPath).Name,
                        };
                    }
                case "createDirectory":
                {
                    var parentPath = GetRequestValue(request, "parentPath");
                    var childName = GetRequestValue(request, "childName");
                    if (string.IsNullOrWhiteSpace(parentPath) || string.IsNullOrWhiteSpace(childName))
                        throw new InvalidDataException("输出目录或子目录名称不能为空。");
                    if (!string.Equals(Path.GetFileName(childName), childName, StringComparison.Ordinal)
                        || childName == "."
                        || childName == ".."
                        || childName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                        throw new InvalidDataException("Task 子目录名称无效。");
                    var parent = Path.GetFullPath(parentPath);
                    if (!Directory.Exists(parent)) throw new DirectoryNotFoundException("输出父目录不存在：" + parent);
                    var directory = Path.GetFullPath(Path.Combine(parent, childName));
                    var prefix = parent.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                        + Path.DirectorySeparatorChar;
                    if (!directory.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Task 子目录路径无效。");
                    Directory.CreateDirectory(directory);
                    return new Dictionary<string, object>
                    {
                        ["path"] = directory,
                        ["name"] = Path.GetFileName(directory),
                    };
                }
                case "formatCSharp":
                {
                    var source = GetRequestValue(request, "source");
                    if (Encoding.UTF8.GetByteCount(source) > 8 * 1024 * 1024)
                        throw new InvalidDataException("C# 源码超过 8 MB 格式化限制。");
                    return FormatCSharp(source);
                }
                case "fileExists":
                {
                    var target = GetSafeOutputFilePath(request);
                    return File.Exists(target);
                }
                case "writeText":
                {
                    var target = GetSafeOutputFilePath(request);
                    var content = GetRequestValue(request, "content");
                    if (Encoding.UTF8.GetByteCount(content) > 8 * 1024 * 1024)
                        throw new InvalidDataException("C# 输出内容超过 8 MB 限制。");
                    File.WriteAllText(target, content, new UTF8Encoding(false));
                    return new Dictionary<string, object>
                    {
                        ["fileName"] = Path.GetFileName(target),
                        ["path"] = target,
                    };
                }
                case "openDirectory":
                {
                    var directoryPath = GetRequestValue(request, "directoryPath");
                    if (string.IsNullOrWhiteSpace(directoryPath)) throw new InvalidDataException("输出目录不能为空。");
                    var directory = Path.GetFullPath(directoryPath);
                    if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("输出目录不存在：" + directory);
                    Process.Start(new ProcessStartInfo("explorer.exe", "\"" + directory + "\"")
                    {
                        UseShellExecute = true,
                    });
                    return new Dictionary<string, object> { ["path"] = directory };
                }
                default:
                    throw new InvalidOperationException("本机文件助手不支持该操作。");
            }
        }

        private static string GetRequestValue(IDictionary<string, object> request, string key)
        {
            object value;
            return request != null && request.TryGetValue(key, out value) && value != null
                ? Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture)
                : string.Empty;
        }

        private static string FormatCSharp(string source)
        {
            var formatterPath = Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory,
                "EquipmentFlowEditor",
                "tools",
                "csharpier",
                "CSharpierFormatter.exe"
            );
            if (!File.Exists(formatterPath))
                throw new FileNotFoundException("CSharpier 格式化助手缺失。", formatterPath);

            var startInfo = new ProcessStartInfo
            {
                FileName = formatterPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (var process = new Process { StartInfo = startInfo })
            {
                if (!process.Start()) throw new InvalidOperationException("无法启动 CSharpier 格式化助手。");
                var utf8 = new UTF8Encoding(false);
                using (var outputReader = new StreamReader(process.StandardOutput.BaseStream, utf8, false))
                using (var errorReader = new StreamReader(process.StandardError.BaseStream, utf8, false))
                {
                    var outputTask = outputReader.ReadToEndAsync();
                    var errorTask = errorReader.ReadToEndAsync();
                    var inputBytes = utf8.GetBytes(source ?? string.Empty);
                    if (inputBytes.Length > 0)
                        process.StandardInput.BaseStream.Write(inputBytes, 0, inputBytes.Length);
                    process.StandardInput.BaseStream.Flush();
                    process.StandardInput.Close();
                    process.WaitForExit();
                    var formatted = outputTask.GetAwaiter().GetResult();
                    var error = errorTask.GetAwaiter().GetResult();
                    if (process.ExitCode != 0)
                        throw new InvalidDataException(string.IsNullOrWhiteSpace(error)
                            ? "CSharpier 格式化失败，退出代码 " + process.ExitCode + "。"
                            : error.Trim());
                    return formatted;
                }
            }
        }

        private static string GetSafeOutputFilePath(IDictionary<string, object> request)
        {
            var directoryPath = GetRequestValue(request, "directoryPath");
            var fileName = GetRequestValue(request, "fileName");
            if (string.IsNullOrWhiteSpace(directoryPath) || string.IsNullOrWhiteSpace(fileName))
                throw new InvalidDataException("输出目录或文件名不能为空。");
            if (!string.Equals(Path.GetFileName(fileName), fileName, StringComparison.Ordinal)
                || !string.Equals(Path.GetExtension(fileName), ".cs", StringComparison.OrdinalIgnoreCase)
                || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                throw new InvalidDataException("C# 输出文件名必须是安全的 .cs 文件名，且不能包含目录路径。");

            var fullDirectory = Path.GetFullPath(directoryPath);
            if (!Directory.Exists(fullDirectory)) throw new DirectoryNotFoundException("输出目录不存在：" + fullDirectory);
            var fullPath = Path.GetFullPath(Path.Combine(fullDirectory, fileName));
            var prefix = fullDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("输出文件路径无效。");
            return fullPath;
        }
    }
}
