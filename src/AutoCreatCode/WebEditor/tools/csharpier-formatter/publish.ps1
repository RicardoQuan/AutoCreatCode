$ErrorActionPreference = 'Stop'

$projectPath = Join-Path $PSScriptRoot 'CSharpierFormatter.csproj'
$outputPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'csharpier'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\..'))
$buildOutputPath = Join-Path $repositoryRoot 'artifacts\csharpier-build'

dotnet publish $projectPath `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    "-p:BaseOutputPath=$buildOutputPath\" `
    --output $outputPath

if ($LASTEXITCODE -ne 0) {
    throw "CSharpier formatter publish failed with exit code $LASTEXITCODE."
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'CSharpier.LICENSE.txt') -Destination $outputPath -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.txt') -Destination $outputPath -Force
