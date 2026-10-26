@echo off
setlocal
cd /d "%~dp0"

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo Windows PowerShell was not found.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
set "exitCode=%errorlevel%"

if not "%exitCode%"=="0" (
  echo.
  echo Budget Cal stopped with an error.
  pause
)

endlocal & exit /b %exitCode%
