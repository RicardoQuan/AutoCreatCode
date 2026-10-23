$ErrorActionPreference = 'Stop'

function Show-InstallerMessage([string]$Text, [System.Windows.Forms.MessageBoxIcon]$Icon = [System.Windows.Forms.MessageBoxIcon]::Information) {
    [void][System.Windows.Forms.MessageBox]::Show(
        $Text,
        'AutoCreatCode 安装程序',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        $Icon
    )
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-DotNetFramework48 {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine,
        [Microsoft.Win32.RegistryView]::Registry64
    )
    try {
        $key = $baseKey.OpenSubKey('SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full')
        if (-not $key) { return $false }
        try { return [int]$key.GetValue('Release', 0) -ge 528040 }
        finally { $key.Dispose() }
    }
    finally { $baseKey.Dispose() }
}

function Test-WebView2Runtime {
    $runtimeId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $locations = @(
        @{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry32; Path = "SOFTWARE\Microsoft\EdgeUpdate\Clients\$runtimeId" },
        @{ Hive = [Microsoft.Win32.RegistryHive]::CurrentUser; View = [Microsoft.Win32.RegistryView]::Registry32; Path = "SOFTWARE\Microsoft\EdgeUpdate\Clients\$runtimeId" },
        @{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry64; Path = "SOFTWARE\Microsoft\EdgeUpdate\Clients\$runtimeId" },
        @{ Hive = [Microsoft.Win32.RegistryHive]::CurrentUser; View = [Microsoft.Win32.RegistryView]::Registry64; Path = "SOFTWARE\Microsoft\EdgeUpdate\Clients\$runtimeId" }
    )
    foreach ($location in $locations) {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($location.Hive, $location.View)
        try {
            $key = $baseKey.OpenSubKey($location.Path)
            if (-not $key) { continue }
            try {
                $version = [string]$key.GetValue('pv', '')
                if ($version -and $version -ne '0.0.0.0') { return $true }
            }
            finally { $key.Dispose() }
        }
        finally { $baseKey.Dispose() }
    }
    return $false
}

function Invoke-Prerequisite([string]$Path, [string[]]$Arguments, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "安装包缺少 $Name 安装文件。请重新下载完整的离线安装包。"
    }
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010, 1641)) {
        throw "$Name 安装失败，返回代码：$($process.ExitCode)。"
    }
    return $process.ExitCode
}

Add-Type -AssemblyName System.Windows.Forms

try {
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'AutoCreatCode V1.0 需要 64 位 Windows。'
    }

    if (-not (Test-IsAdministrator)) {
        $arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
        $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
        exit $process.ExitCode
    }

    $appProcesses = @(Get-Process -Name 'AutoCreatCode' -ErrorAction SilentlyContinue)
    if ($appProcesses.Count -gt 0) {
        throw '请先关闭正在运行的 AutoCreatCode，再重新运行安装程序。'
    }

    $payloadZip = Join-Path $PSScriptRoot 'payload.zip'
    if (-not (Test-Path -LiteralPath $payloadZip -PathType Leaf)) {
        throw '安装包内容不完整，找不到依赖与程序文件。'
    }

    $payloadRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('AutoCreatCode-Install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
    try {
        Expand-Archive -LiteralPath $payloadZip -DestinationPath $payloadRoot -Force
        $prerequisiteRoot = Join-Path $payloadRoot 'prerequisites'
        $restartRequired = $false

        if (-not (Test-DotNetFramework48)) {
            $code = Invoke-Prerequisite (Join-Path $prerequisiteRoot 'NDP48-x86-x64-AllOS-ENU.exe') @('/q', '/norestart') '.NET Framework 4.8'
            if ($code -in @(3010, 1641)) { $restartRequired = $true }
            if (-not (Test-DotNetFramework48) -and -not $restartRequired) {
                throw '.NET Framework 4.8 安装程序未报告错误，但系统尚未检测到运行库。'
            }
        }

        if (-not (Test-WebView2Runtime)) {
            $code = Invoke-Prerequisite (Join-Path $prerequisiteRoot 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe') @('/silent', '/install') 'WebView2 Runtime'
            if ($code -in @(3010, 1641)) { $restartRequired = $true }
            if (-not (Test-WebView2Runtime)) {
                throw 'WebView2 Runtime 安装后仍未检测到运行库。'
            }
        }

        $appRoot = Join-Path $payloadRoot 'app'
        $appExecutable = Join-Path $appRoot 'AutoCreatCode.exe'
        if (-not (Test-Path -LiteralPath $appExecutable -PathType Leaf)) {
            throw '安装包中找不到 AutoCreatCode.exe。'
        }

        $installRoot = Join-Path $env:ProgramW6432 'AutoCreatCode'
        New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
        Copy-Item -Path (Join-Path $appRoot '*') -Destination $installRoot -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $payloadRoot 'Uninstall.ps1') -Destination (Join-Path $installRoot 'Uninstall.ps1') -Force

        $shell = New-Object -ComObject WScript.Shell
        $desktopPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)
        $startMenuPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)) 'AutoCreatCode'
        New-Item -ItemType Directory -Path $startMenuPath -Force | Out-Null

        foreach ($shortcutPath in @(
            (Join-Path $desktopPath 'AutoCreatCode.lnk'),
            (Join-Path $startMenuPath 'AutoCreatCode.lnk')
        )) {
            $shortcut = $shell.CreateShortcut($shortcutPath)
            $shortcut.TargetPath = Join-Path $installRoot 'AutoCreatCode.exe'
            $shortcut.WorkingDirectory = $installRoot
            $shortcut.IconLocation = (Join-Path $installRoot 'AutoCreatCode.exe') + ',0'
            $shortcut.Description = 'AutoCreatCode 浏览器流程编辑器'
            $shortcut.Save()
        }

        $uninstallKey = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AutoCreatCode')
        try {
            $uninstallKey.SetValue('DisplayName', 'AutoCreatCode V1.0')
            $uninstallKey.SetValue('DisplayVersion', '1.0')
            $uninstallKey.SetValue('InstallLocation', $installRoot)
            $uninstallKey.SetValue('DisplayIcon', (Join-Path $installRoot 'AutoCreatCode.exe'))
            $uninstallKey.SetValue('UninstallString', ('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $installRoot 'Uninstall.ps1') + '"'))
            $uninstallKey.SetValue('NoModify', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
            $uninstallKey.SetValue('NoRepair', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
        }
        finally { $uninstallKey.Dispose() }

        $message = 'AutoCreatCode 安装完成。桌面和开始菜单已创建快捷方式。'
        if ($restartRequired) { $message += "`r`n`r`n.NET 安装程序要求重启，请先重启 Windows 后再启动 AutoCreatCode。" }
        Show-InstallerMessage $message
    }
    finally {
        if (Test-Path -LiteralPath $payloadRoot) {
            Remove-Item -LiteralPath $payloadRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
catch {
    Show-InstallerMessage ("安装未完成：`r`n" + $_.Exception.Message) ([System.Windows.Forms.MessageBoxIcon]::Error)
    exit 1
}
