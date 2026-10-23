param(
    [switch]$Serve,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$rootPath = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

function Get-ContentType([string]$Path) {
    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        '.html' { return 'text/html; charset=utf-8' }
        '.js' { return 'text/javascript; charset=utf-8' }
        '.css' { return 'text/css; charset=utf-8' }
        '.json' { return 'application/json; charset=utf-8' }
        '.txt' { return 'text/plain; charset=utf-8' }
        '.svg' { return 'image/svg+xml' }
        '.png' { return 'image/png' }
        '.jpg' { return 'image/jpeg' }
        '.jpeg' { return 'image/jpeg' }
        '.gif' { return 'image/gif' }
        '.ico' { return 'image/x-icon' }
        '.ttf' { return 'font/ttf' }
        '.woff' { return 'font/woff' }
        '.woff2' { return 'font/woff2' }
        '.wasm' { return 'application/wasm' }
        default { return 'application/octet-stream' }
    }
}

function Read-HttpRequest([System.IO.Stream]$Stream) {
    $headerBytes = [System.Collections.Generic.List[byte]]::new()
    $matched = 0
    $terminator = [byte[]]@(13, 10, 13, 10)
    while ($headerBytes.Count -lt 65536 -and $matched -lt $terminator.Length) {
        $next = $Stream.ReadByte()
        if ($next -lt 0) { return $null }
        $value = [byte]$next
        $headerBytes.Add($value)
        if ($value -eq $terminator[$matched]) { $matched++ }
        else { $matched = if ($value -eq $terminator[0]) { 1 } else { 0 } }
    }
    if ($matched -ne $terminator.Length) { throw 'HTTP 请求头超出长度限制或格式无效。' }

    $headerText = [System.Text.Encoding]::ASCII.GetString($headerBytes.ToArray(), 0, $headerBytes.Count - 4)
    $lines = $headerText -split "`r`n"
    $requestParts = $lines[0].Split(' ', 3)
    if ($requestParts.Length -lt 2) { throw 'HTTP 请求行格式无效。' }

    $headers = @{}
    foreach ($line in $lines | Select-Object -Skip 1) {
        $separator = $line.IndexOf(':')
        if ($separator -gt 0) { $headers[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim() }
    }

    $contentLength = 0
    if ($headers.ContainsKey('Content-Length')) {
        if (-not [int]::TryParse($headers['Content-Length'], [ref]$contentLength) -or $contentLength -lt 0 -or $contentLength -gt 33554432) {
            throw 'HTTP 请求体长度无效或超过 32 MB。'
        }
    }
    $body = [byte[]]::new($contentLength)
    $read = 0
    while ($read -lt $contentLength) {
        $count = $Stream.Read($body, $read, $contentLength - $read)
        if ($count -le 0) { throw 'HTTP 请求体未完整接收。' }
        $read += $count
    }

    return [pscustomobject]@{
        Method = $requestParts[0].ToUpperInvariant()
        Target = $requestParts[1]
        Headers = $headers
        Body = $body
    }
}

function Send-HttpResponse([System.IO.Stream]$Stream, [string]$Status, [string]$ContentType, [byte[]]$Body, [string]$Method) {
    $headers = "HTTP/1.1 $Status`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nCache-Control: no-cache`r`nX-Content-Type-Options: nosniff`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Method -ne 'HEAD' -and $Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

function Get-SafeOutputFilePath([string]$DirectoryPath, [string]$FileName) {
    if ([string]::IsNullOrWhiteSpace($DirectoryPath) -or [string]::IsNullOrWhiteSpace($FileName)) { throw '输出目录或文件名不能为空。' }
    if ([System.IO.Path]::GetFileName($FileName) -ne $FileName -or [System.IO.Path]::GetExtension($FileName) -ne '.cs' -or $FileName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) {
        throw 'C# 输出文件名必须是安全的 .cs 文件名，且不能包含目录路径。'
    }
    $fullDirectory = [System.IO.Path]::GetFullPath($DirectoryPath)
    if (-not [System.IO.Directory]::Exists($fullDirectory)) { throw "输出目录不存在：$fullDirectory" }
    $fullPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($fullDirectory, $FileName))
    $prefix = $fullDirectory.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw '输出文件路径无效。' }
    return [pscustomobject]@{ Directory = $fullDirectory; File = $fullPath }
}

function Invoke-CSharpier([string]$Source) {
    $formatterPath = Join-Path $PSScriptRoot 'tools\csharpier\CSharpierFormatter.exe'
    if (-not [System.IO.File]::Exists($formatterPath)) { throw "CSharpier 格式化助手缺失：$formatterPath" }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $formatterPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $outputReader = $null
    $errorReader = $null
    try {
        if (-not $process.Start()) { throw '无法启动 CSharpier 格式化助手。' }
        $utf8 = [System.Text.UTF8Encoding]::new($false)
        $outputReader = [System.IO.StreamReader]::new($process.StandardOutput.BaseStream, $utf8, $false)
        $errorReader = [System.IO.StreamReader]::new($process.StandardError.BaseStream, $utf8, $false)
        $outputTask = $outputReader.ReadToEndAsync()
        $errorTask = $errorReader.ReadToEndAsync()
        $inputBytes = $utf8.GetBytes([string]$Source)
        if ($inputBytes.Length -gt 0) { $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length) }
        $process.StandardInput.BaseStream.Flush()
        $process.StandardInput.Close()
        $process.WaitForExit()
        $formatted = $outputTask.GetAwaiter().GetResult()
        $errorText = $errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            if ([string]::IsNullOrWhiteSpace($errorText)) { $errorText = "CSharpier formatting failed with exit code $($process.ExitCode)." }
            throw $errorText.Trim()
        }
        return $formatted
    }
    finally {
        if ($outputReader) { $outputReader.Dispose() }
        if ($errorReader) { $errorReader.Dispose() }
        $process.Dispose()
    }
}

function Show-NativeDialog([System.Windows.Forms.CommonDialog]$Dialog) {
    # This server has no visible console. Give native dialogs a temporary owner
    # so Windows places them in front of the browser that requested them.
    $owner = [System.Windows.Forms.Form]::new()
    $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $owner.ShowInTaskbar = $false
    $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $owner.Width = 1
    $owner.Height = 1
    $owner.Opacity = 0.01
    $owner.TopMost = $true
    try {
        $owner.Show()
        $owner.Activate()
        return $Dialog.ShowDialog($owner)
    }
    finally {
        $owner.Close()
        $owner.Dispose()
    }
}

function Invoke-NativeOperation([object]$Request) {
    switch ([string]$Request.action) {
        'chooseProjectFile' {
            Add-Type -AssemblyName System.Windows.Forms
            $dialog = [System.Windows.Forms.SaveFileDialog]::new()
            $dialog.Title = '保存 Task 项目'
            $dialog.Filter = 'Task 项目文件 (*.json)|*.json'
            $dialog.DefaultExt = 'json'
            $dialog.AddExtension = $true
            $dialog.OverwritePrompt = $true
            $dialog.CheckPathExists = $true
            $dialog.FileName = [string]$Request.suggestedName
            $currentDirectory = [string]$Request.currentDirectory
            if (-not [string]::IsNullOrWhiteSpace($currentDirectory) -and [System.IO.Directory]::Exists($currentDirectory)) {
                $dialog.InitialDirectory = [System.IO.Path]::GetFullPath($currentDirectory)
            }
            try {
                if ((Show-NativeDialog $dialog) -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
                $fullPath = [System.IO.Path]::GetFullPath($dialog.FileName)
                return @{ path = $fullPath; directoryPath = [System.IO.Path]::GetDirectoryName($fullPath); fileName = [System.IO.Path]::GetFileName($fullPath) }
            }
            finally { $dialog.Dispose() }
        }
        'writeProjectFile' {
            $filePath = [string]$Request.filePath
            if ([string]::IsNullOrWhiteSpace($filePath)) { throw '项目保存路径不能为空。' }
            $fullPath = [System.IO.Path]::GetFullPath($filePath)
            if ([System.IO.Path]::GetExtension($fullPath) -ne '.json') { throw '项目文件必须使用 .json 扩展名。' }
            $directory = [System.IO.Path]::GetDirectoryName($fullPath)
            if (-not [System.IO.Directory]::Exists($directory)) { throw "项目保存目录不存在：$directory" }
            $content = [string]$Request.content
            if ([System.Text.Encoding]::UTF8.GetByteCount($content) -gt 12582912) { throw '项目文件超过 12 MB 限制。' }
            [System.IO.File]::WriteAllText($fullPath, $content, [System.Text.UTF8Encoding]::new($false))
            return @{ path = $fullPath; directoryPath = $directory; fileName = [System.IO.Path]::GetFileName($fullPath) }
        }
        'chooseDirectory' {
            Add-Type -AssemblyName System.Windows.Forms
            $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
            $dialog.Description = '选择 C# 输出目录'
            $dialog.ShowNewFolderButton = $true
            if (-not [string]::IsNullOrWhiteSpace([string]$Request.currentPath) -and [System.IO.Directory]::Exists([string]$Request.currentPath)) {
                $dialog.SelectedPath = [System.IO.Path]::GetFullPath([string]$Request.currentPath)
            }
            try {
                if ((Show-NativeDialog $dialog) -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
                $selectedPath = [System.IO.Path]::GetFullPath($dialog.SelectedPath)
                return @{ path = $selectedPath; name = [System.IO.Path]::GetFileName($selectedPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)) }
            }
            finally { $dialog.Dispose() }
        }
        'fileExists' {
            $target = Get-SafeOutputFilePath ([string]$Request.directoryPath) ([string]$Request.fileName)
            return [System.IO.File]::Exists($target.File)
        }
        'createDirectory' {
            $parentPath = [string]$Request.parentPath
            $childName = [string]$Request.childName
            if ([string]::IsNullOrWhiteSpace($parentPath) -or [string]::IsNullOrWhiteSpace($childName)) { throw '输出目录或子目录名称不能为空。' }
            if ([System.IO.Path]::GetFileName($childName) -ne $childName -or $childName -in @('.', '..') -or $childName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw 'Task 子目录名称无效。' }
            $parent = [System.IO.Path]::GetFullPath($parentPath)
            if (-not [System.IO.Directory]::Exists($parent)) { throw "输出父目录不存在：$parent" }
            $directory = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($parent, $childName))
            $prefix = $parent.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
            if (-not $directory.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Task 子目录路径无效。' }
            [System.IO.Directory]::CreateDirectory($directory) | Out-Null
            return @{ path = $directory; name = [System.IO.Path]::GetFileName($directory) }
        }
        'formatCSharp' {
            $source = [string]$Request.source
            if ([System.Text.Encoding]::UTF8.GetByteCount($source) -gt 8388608) { throw 'C# 源码超过 8 MB 格式化限制。' }
            return Invoke-CSharpier $source
        }
        'writeText' {
            $target = Get-SafeOutputFilePath ([string]$Request.directoryPath) ([string]$Request.fileName)
            $content = [string]$Request.content
            if ($content.Length -gt 8000000) { throw 'C# 输出内容超过 8 MB 限制。' }
            [System.IO.File]::WriteAllText($target.File, $content, [System.Text.UTF8Encoding]::new($false))
            return @{ fileName = [System.IO.Path]::GetFileName($target.File); path = $target.File }
        }
        'openDirectory' {
            if ([string]::IsNullOrWhiteSpace([string]$Request.directoryPath)) { throw '输出目录不能为空。' }
            $directory = [System.IO.Path]::GetFullPath([string]$Request.directoryPath)
            if (-not [System.IO.Directory]::Exists($directory)) { throw "输出目录不存在：$directory" }
            $explorer = Join-Path $env:WINDIR 'explorer.exe'
            Start-Process -FilePath $explorer -ArgumentList ('"{0}"' -f $directory) | Out-Null
            return @{ path = $directory }
        }
        default { throw '本机文件助手不支持该操作。' }
    }
}

if (-not $Serve) {
    $portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $portProbe.Start()
        $Port = [int]$portProbe.LocalEndpoint.Port
    }
    finally {
        $portProbe.Stop()
    }

    $quotedScriptPath = '"' + $PSCommandPath.Replace('"', '""') + '"'
    $serverArguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', $quotedScriptPath, '-Serve', '-Port', [string]$Port)
    $serverProcess = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList $serverArguments
    $url = "http://127.0.0.1:$Port/?equipmentFlowLocal=1"
    $ready = $false

    for ($attempt = 0; $attempt -lt 50 -and -not $ready; $attempt++) {
        if ($serverProcess.HasExited) {
            throw '本地 WebEditor 服务启动失败。请检查 Windows PowerShell 是否可用。'
        }
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
            $ready = $response.StatusCode -eq 200
        }
        catch {
            Start-Sleep -Milliseconds 120
        }
    }

    if (-not $ready) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        throw '本地 WebEditor 服务没有在预期时间内启动。'
    }

    Start-Process -FilePath $url
    exit 0
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
$lastRequestAt = [DateTime]::UtcNow
$idleTimeout = [TimeSpan]::FromMinutes(60)
$utf8 = [System.Text.UTF8Encoding]::new($false)

try {
    while ($true) {
        if (-not $listener.Pending()) {
            if ([DateTime]::UtcNow - $lastRequestAt -gt $idleTimeout) { break }
            Start-Sleep -Milliseconds 80
            continue
        }

        $client = $listener.AcceptTcpClient()
        $client.ReceiveTimeout = 3000
        $client.SendTimeout = 3000
        $stream = $client.GetStream()

        try {
            $request = Read-HttpRequest $stream
            if ($null -eq $request) { continue }
            $method = $request.Method
            $uri = [Uri]::new("http://127.0.0.1:$Port$($request.Target)")
            $requestPath = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
            $lastRequestAt = [DateTime]::UtcNow

            if ($requestPath -eq '__keepalive') {
                $responseBytes = [byte[]]::new(0)
                $status = '204 No Content'
                $contentType = 'text/plain; charset=utf-8'
            }
            elseif ($requestPath -eq '__native' -and $method -eq 'POST') {
                $origin = [string]$request.Headers['Origin']
                $expectedOrigins = @("http://127.0.0.1:$Port", "http://localhost:$Port")
                $postedContentType = ([string]$request.Headers['Content-Type']).Split(';')[0].Trim().ToLowerInvariant()
                if ($origin -notin $expectedOrigins -or $postedContentType -ne 'application/json') {
                    $responseObject = @{ ok = $false; error = '本机文件助手只接受来自当前 WebEditor 的 JSON 请求。' }
                    $status = '403 Forbidden'
                }
                else {
                    $requestJson = $utf8.GetString($request.Body)
                    $nativeRequest = ConvertFrom-Json -InputObject $requestJson -ErrorAction Stop
                    $requestId = [string]$nativeRequest.requestId
                    try {
                        $result = Invoke-NativeOperation $nativeRequest
                        $responseObject = @{ requestId = $requestId; ok = $true; result = $result }
                        $status = '200 OK'
                    }
                    catch {
                        $responseObject = @{ requestId = $requestId; ok = $false; error = $_.Exception.Message }
                        $status = '200 OK'
                    }
                }
                $responseBytes = $utf8.GetBytes((ConvertTo-Json -InputObject $responseObject -Compress -Depth 6))
                $contentType = 'application/json; charset=utf-8'
            }
            elseif ($method -notin @('GET', 'HEAD')) {
                $responseBytes = $utf8.GetBytes('Method Not Allowed')
                $status = '405 Method Not Allowed'
                $contentType = 'text/plain; charset=utf-8'
            }
            else {
                if ([string]::IsNullOrWhiteSpace($requestPath)) { $requestPath = 'index.html' }
                $relativePath = $requestPath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
                $filePath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($rootPath, $relativePath))

                if (-not $filePath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or -not [System.IO.File]::Exists($filePath)) {
                    $responseBytes = $utf8.GetBytes('Not Found')
                    $status = '404 Not Found'
                    $contentType = 'text/plain; charset=utf-8'
                }
                else {
                    $responseBytes = [System.IO.File]::ReadAllBytes($filePath)
                    $status = '200 OK'
                    $contentType = Get-ContentType $filePath
                }
            }

            Send-HttpResponse $stream $status $contentType $responseBytes $method
        }
        catch {
            # A browser can close a speculative request while the page is changing.
        }
        finally {
            $stream.Dispose()
            $client.Dispose()
        }
    }
}
finally {
    $listener.Stop()
}
