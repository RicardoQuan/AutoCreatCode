$ErrorActionPreference = 'Stop'

$buildRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$webEditorRoot = [System.IO.Path]::GetFullPath((Join-Path $buildRoot '..\..'))
$monacoPackage = Join-Path $buildRoot 'node_modules\monaco-editor'
$runtimeRoot = Join-Path $webEditorRoot 'vendor\monaco'
$esbuild = Join-Path $buildRoot 'node_modules\.pnpm\@esbuild+win32-x64@0.27.7\node_modules\@esbuild\win32-x64\esbuild.exe'

if (-not [System.IO.File]::Exists($esbuild)) {
    throw "esbuild binary was not found at '$esbuild'. Run pnpm install in tools\monaco-build first."
}
if (-not [System.IO.Directory]::Exists($monacoPackage)) {
    throw "monaco-editor package was not found at '$monacoPackage'. Run pnpm install in tools\monaco-build first."
}

[System.IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
Push-Location $buildRoot
try {
    & $esbuild 'monaco-entry.js' '--bundle' '--format=esm' '--target=es2022' '--minify' "--outfile=$(Join-Path $runtimeRoot 'monaco-runtime.js')"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to bundle the Monaco editor runtime.' }

    & $esbuild 'monaco-editor/editor/editor.worker.js' '--bundle' '--format=esm' '--target=es2022' '--minify' "--outfile=$(Join-Path $runtimeRoot 'editor.worker.js')"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to bundle the Monaco editor worker.' }
}
finally {
    Pop-Location
}

foreach ($runtimeFile in @('monaco-runtime.js', 'monaco-runtime.css', 'editor.worker.js')) {
    if (-not [System.IO.File]::Exists((Join-Path $runtimeRoot $runtimeFile))) {
        throw "Expected Monaco runtime output '$runtimeFile' was not generated."
    }
}

Copy-Item -LiteralPath (Join-Path $monacoPackage 'LICENSE') -Destination (Join-Path $runtimeRoot 'LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $monacoPackage 'ThirdPartyNotices.txt') -Destination (Join-Path $runtimeRoot 'ThirdPartyNotices.txt') -Force
Set-Content -LiteralPath (Join-Path $runtimeRoot 'VERSION.txt') -Value 'monaco-editor 0.57.0 (ESM; bundled with esbuild 0.27.7; MIT)' -Encoding utf8
