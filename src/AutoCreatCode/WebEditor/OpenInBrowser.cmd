@echo off
setlocal
set "LAUNCHER=%~dp0WebEditorLocalServer.ps1"
if not exist "%LAUNCHER%" (
  echo Equipment Flow Web UI was not found beside this launcher.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%"
if errorlevel 1 pause
endlocal
