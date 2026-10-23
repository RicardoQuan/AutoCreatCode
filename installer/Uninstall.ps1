$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

function Show-UninstallMessage([string]$Text, [System.Windows.Forms.MessageBoxIcon]$Icon = [System.Windows.Forms.MessageBoxIcon]::Information) {
    [void][System.Windows.Forms.MessageBox]::Show(
        $Text,
        'AutoCreatCode 卸载程序',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        $Icon
    )
}

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        $arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
        $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
        exit $process.ExitCode
    }

    $installRoot = Split-Path -Parent $PSCommandPath
    $appProcesses = @(Get-Process -Name 'AutoCreatCode' -ErrorAction SilentlyContinue)
    if ($appProcesses.Count -gt 0) {
        Show-UninstallMessage '请先关闭 AutoCreatCode，再重新运行卸载程序。' ([System.Windows.Forms.MessageBoxIcon]::Warning)
        exit 1
    }

    $desktopPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)
    $startMenuPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)) 'AutoCreatCode'
    Remove-Item -LiteralPath (Join-Path $desktopPath 'AutoCreatCode.lnk') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $startMenuPath -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AutoCreatCode' -Recurse -Force -ErrorAction SilentlyContinue

    Set-Location ([System.IO.Path]::GetTempPath())
    Remove-Item -LiteralPath $installRoot -Recurse -Force
    Show-UninstallMessage 'AutoCreatCode 已卸载。项目文件和 WebView2 用户数据均已保留。'
}
catch {
    Show-UninstallMessage ("卸载未完成：`r`n" + $_.Exception.Message) ([System.Windows.Forms.MessageBoxIcon]::Error)
    exit 1
}
