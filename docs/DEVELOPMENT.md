# 浏览器开发与版本更新

## 浏览器是主要开发入口

WebEditor 是 AutoCreatCode 的唯一界面源代码。日常设计和功能优化直接修改 src/AutoCreatCode/WebEditor 下的 HTML、CSS、JavaScript 与 Monaco 资源：

1. 克隆仓库。
2. 双击 src/AutoCreatCode/WebEditor/OpenInBrowser.cmd。
3. 在浏览器中编辑和预览。刷新页面即可载入改动。

请保留 vendor/monaco 目录结构；它包含本地运行所需的 ESM 代码和 Worker，编辑器运行时不访问互联网。浏览器与桌面窗口的本地存储彼此独立，可通过“保存项目”导出的 JSON 在两边继续编辑。

浏览器开发无需安装 .NET。若要使用 CSharpier 格式化输出，需要 .NET 8 SDK，并运行：

~~~powershell
cd src/AutoCreatCode/WebEditor/tools/csharpier-formatter
.\publish.ps1
~~~

该命令生成 WebEditor/tools/csharpier/CSharpierFormatter.exe。生成的格式化器目录已加入 .gitignore，避免把 80 MB 运行文件提交到源码仓库。项目压缩包和桌面安装包会在发布时自动附上自包含的格式化器。

## 桌面宿主开发

只有修改桌面启动、文件对话框或 WebView2 桥接时才需要改动 EquipmentFlowEditorForm.cs。宿主目标为 .NET Framework 4.8，Web UI 仍从相邻的 EquipmentFlowEditor 目录加载。

Windows 机器需要 .NET Framework 4.8 Developer Pack 和 .NET SDK。构建桌面宿主：

~~~powershell
dotnet build src/AutoCreatCode/AutoCreatCode.csproj -c Release
~~~

WebView2 NuGet 依赖固定为 1.0.4258.31。不要将设备控制工程中的其余 C# 文件复制进这个独立应用。

## 发布更新版本

1. 在 CHANGELOG.md 增加版本说明并更新产品文档。
2. 确认浏览器源代码及桌面宿主项目均已提交到 main。
3. 创建并推送版本标签，例如 v1.1。
4. .github/workflows/release.yml 会在 Windows 构建机上生成离线安装包和项目 ZIP，并将它们附加到同名 GitHub Release。

首个 v1.0 版本在仓库 main 首次更新时自动发布；后续版本使用 v主版本.次版本标签。工作流会下载微软官方离线安装程序、校验 Authenticode 签名，然后封装依赖。

## Monaco 编辑器更新

tools/monaco-build 保存 Monaco 构建入口和锁定的开发依赖清单；vendor/monaco 是实际随应用运行的资源。更新时按 tools/monaco-build/README.md 的步骤重建资源，并保留上游许可证与第三方声明。
