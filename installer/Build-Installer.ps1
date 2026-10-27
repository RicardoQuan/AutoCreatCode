[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+(\.\d+)?$')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Invoke-DotNet([string[]]$Arguments, [string]$Description) {
    & dotnet @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description 失败，dotnet 返回代码：$LASTEXITCODE"
    }
}

function Get-SignedMicrosoftFile([string]$Uri, [string]$Path, [string]$Description) {
    Write-Host "下载 $Description ..."
    Invoke-WebRequest -Uri $Uri -OutFile $Path -UseBasicParsing
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description 下载失败。"
    }

    $signature = Get-AuthenticodeSignature -FilePath $Path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
        throw "$Description 的 Microsoft Authenticode 签名无效，已停止打包。"
    }
}

function Copy-ReleaseSources([string]$SourceRoot, [string]$DestinationRoot) {
    $excludedSegments = @('.git', '.vs', 'bin', 'obj', 'artifacts', 'dist', 'csharpier')
    $sourcePrefix = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $files = Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force | Where-Object {
        $relative = $_.FullName.Substring($sourcePrefix.Length)
        $segments = $relative -split '[\\/]'
        $excluded = $false
        foreach ($segment in $segments) {
            if ($excludedSegments -contains $segment) { $excluded = $true; break }
        }
        if (-not $excluded -and $relative -match '(^|[\\/])WebEditor[\\/]tools[\\/]csharpier([\\/]|$)') { $excluded = $true }
        -not $excluded
    }

    foreach ($file in $files) {
        $relative = $file.FullName.Substring($sourcePrefix.Length)
        $target = Join-Path $DestinationRoot $relative
        $parent = Split-Path -Parent $target
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$hostProject = Join-Path $repositoryRoot 'src\AutoCreatCode\AutoCreatCode.csproj'
$formatterProject = Join-Path $repositoryRoot 'src\AutoCreatCode\WebEditor\tools\csharpier-formatter\CSharpierFormatter.csproj'
$installScript = Join-Path $PSScriptRoot 'Install.ps1'
$uninstallScript = Join-Path $PSScriptRoot 'Uninstall.ps1'
$distRoot = Join-Path $repositoryRoot 'dist'

if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
    throw '离线 Windows 安装包只能在 Windows 上生成。'
}
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw '构建需要 .NET SDK。请安装 .NET 8 SDK 后重新运行。'
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('AutoCreatCodeBuild-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

try {
    $appOutput = Join-Path $workRoot 'app'
    $formatterOutput = Join-Path $workRoot 'formatter'
    $formatterBuildRoot = Join-Path $workRoot 'formatter-build'
    $payloadRoot = Join-Path $workRoot 'payload'
    $prerequisiteRoot = Join-Path $payloadRoot 'prerequisites'
    $appRoot = Join-Path $payloadRoot 'app'
    New-Item -ItemType Directory -Path $appOutput, $formatterOutput, $formatterBuildRoot, $prerequisiteRoot, $appRoot -Force | Out-Null

    $stagedInstallScript = Join-Path $workRoot 'Install.ps1'
    $installScriptContent = [System.IO.File]::ReadAllText($installScript).Replace('__VERSION__', $Version)
    if ($installScriptContent -match '__VERSION__') {
        throw '安装脚本版本占位符未能替换。'
    }
    [System.IO.File]::WriteAllText($stagedInstallScript, $installScriptContent, [System.Text.UTF8Encoding]::new($false))

    Invoke-DotNet @('build', $hostProject, '--configuration', 'Release', "-p:Version=$Version.0") '桌面宿主构建'
    $hostOutput = Join-Path $repositoryRoot 'src\AutoCreatCode\bin\Release\net48'
    if (-not (Test-Path -LiteralPath (Join-Path $hostOutput 'AutoCreatCode.exe'))) {
        throw '桌面宿主构建成功，但没有找到 AutoCreatCode.exe。'
    }
    Copy-Item -Path (Join-Path $hostOutput '*') -Destination $appOutput -Recurse -Force

    Invoke-DotNet @(
        'publish', $formatterProject,
        '--configuration', 'Release',
        '--runtime', 'win-x64',
        '--self-contained', 'true',
        '-p:PublishSingleFile=true',
        '-p:IncludeNativeLibrariesForSelfExtract=true',
        "-p:BaseOutputPath=$formatterBuildRoot\",
        '-p:DebugType=None',
        '-p:DebugSymbols=false',
        '--output', $formatterOutput
    ) 'CSharpier 自包含格式化器发布'
    $appFormatter = Join-Path $appOutput 'EquipmentFlowEditor\tools\csharpier'
    New-Item -ItemType Directory -Path $appFormatter -Force | Out-Null
    Copy-Item -Path (Join-Path $formatterOutput '*') -Destination $appFormatter -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $appOutput 'EquipmentFlowEditor\tools\csharpier\CSharpierFormatter.exe'))) {
        throw 'CSharpier 自包含格式化器没有生成。'
    }

    Copy-Item -Path (Join-Path $appOutput '*') -Destination $appRoot -Recurse -Force
    Copy-Item -LiteralPath $uninstallScript -Destination (Join-Path $payloadRoot 'Uninstall.ps1') -Force

    $dotNetInstaller = Join-Path $prerequisiteRoot 'NDP48-x86-x64-AllOS-ENU.exe'
    $webViewInstaller = Join-Path $prerequisiteRoot 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
    Get-SignedMicrosoftFile 'https://go.microsoft.com/fwlink/?linkid=2088631' $dotNetInstaller '.NET Framework 4.8 离线安装程序'
    Get-SignedMicrosoftFile 'https://go.microsoft.com/fwlink/?LinkId=2124701' $webViewInstaller 'WebView2 Evergreen x64 离线安装程序'

    $payloadZip = Join-Path $workRoot 'payload.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $payloadRoot,
        $payloadZip,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    $iexpressSource = Join-Path $workRoot 'iexpress-source'
    New-Item -ItemType Directory -Path $iexpressSource -Force | Out-Null
    Copy-Item -LiteralPath $stagedInstallScript -Destination $iexpressSource -Force
    Copy-Item -LiteralPath $payloadZip -Destination $iexpressSource -Force

    $setupPath = Join-Path $distRoot "AutoCreatCode-Setup-v$Version.exe"
    $setupStagingPath = Join-Path $workRoot "AutoCreatCode-Setup-v$Version.exe"
    if (Test-Path -LiteralPath $setupPath) {
        Remove-Item -LiteralPath $setupPath -Force
    }
    $sedPath = Join-Path $workRoot 'AutoCreatCode-Setup.sed'
    $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=1
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$setupStagingPath
FriendlyName=AutoCreatCode V$Version
AppLaunched=powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File Install.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=$iexpressSource
[SourceFiles0]
%FILE0%=
%FILE1%=
[Strings]
FILE0="Install.ps1"
FILE1="payload.zip"
"@
    Set-Content -LiteralPath $sedPath -Value $sed -Encoding ASCII

    $iexpressPath = Join-Path $env:WINDIR 'System32\iexpress.exe'
    if (-not (Test-Path -LiteralPath $iexpressPath -PathType Leaf)) {
        throw '找不到 Windows IExpress，无法生成单文件 EXE 安装包。'
    }
    $sedPathForIExpress = $sedPath
    $mappedDrive = $null
    if ($sedPath -match '\s') {
        try {
            $shortSedPath = (New-Object -ComObject Scripting.FileSystemObject).GetFile($sedPath).ShortPath
            if (-not [string]::IsNullOrWhiteSpace($shortSedPath) -and $shortSedPath -notmatch '\s' -and (Test-Path -LiteralPath $shortSedPath -PathType Leaf)) {
                $sedPathForIExpress = $shortSedPath
            }
        }
        catch {
            # Fall back to a temporary drive mapping when 8.3 paths are unavailable.
        }

        if ($sedPathForIExpress -match '\s') {
            foreach ($driveLetter in @('Z', 'Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R', 'Q', 'P', 'O', 'N', 'M', 'L', 'K', 'J', 'I', 'H', 'G', 'F', 'E', 'D')) {
                $candidateDrive = '{0}:' -f $driveLetter
                if (Test-Path -LiteralPath ($candidateDrive + '\')) { continue }

                & subst.exe $candidateDrive $workRoot
                if ($LASTEXITCODE -eq 0) {
                    $mappedDrive = $candidateDrive
                    $sedPathForIExpress = Join-Path ($candidateDrive + '\') ([System.IO.Path]::GetFileName($sedPath))
                    break
                }
            }

            if (-not $mappedDrive) {
                throw 'IExpress 无法访问含空格的临时路径，且系统没有可用的短路径或临时盘符。'
            }
        }
    }

    try {
        $iexpress = Start-Process -FilePath $iexpressPath -ArgumentList @('/N', '/Q', $sedPathForIExpress) -Wait -PassThru
        $stagedSetup = Get-Item -LiteralPath $setupStagingPath -ErrorAction SilentlyContinue
        if ($iexpress.ExitCode -ne 0 -or $null -eq $stagedSetup -or $stagedSetup.Length -le 0) {
            throw "IExpress 安装包生成失败，返回代码：$($iexpress.ExitCode)。"
        }
    }
    finally {
        if ($mappedDrive) {
            & subst.exe $mappedDrive /D
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "IExpress 临时盘符 $mappedDrive 未能自动移除。"
            }
        }
    }
    Copy-Item -LiteralPath $setupStagingPath -Destination $setupPath -Force

    $sourceStage = Join-Path $workRoot 'source'
    New-Item -ItemType Directory -Path $sourceStage -Force | Out-Null
    Copy-ReleaseSources $repositoryRoot $sourceStage
    $sourceFormatter = Join-Path $sourceStage 'src\AutoCreatCode\WebEditor\tools\csharpier'
    New-Item -ItemType Directory -Path $sourceFormatter -Force | Out-Null
    Copy-Item -Path (Join-Path $formatterOutput '*') -Destination $sourceFormatter -Recurse -Force

    $sourceArchive = Join-Path $distRoot "AutoCreatCode-Source-v$Version.zip"
    if (Test-Path -LiteralPath $sourceArchive) {
        Remove-Item -LiteralPath $sourceArchive -Force
    }
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $sourceStage,
        $sourceArchive,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    Get-Item -LiteralPath $setupPath, $sourceArchive | Select-Object Name, Length
}
finally {
    $safeTempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $fullWorkRoot = [System.IO.Path]::GetFullPath($workRoot)
    if ($fullWorkRoot.StartsWith($safeTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $fullWorkRoot)) {
        Remove-Item -LiteralPath $fullWorkRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
