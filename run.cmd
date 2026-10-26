@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Budget Cal needs Node.js 20 or newer.
  echo Install it from https://nodejs.org, then run this script again.
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\run.mjs" %*
set "exitCode=%errorlevel%"

if not "%exitCode%"=="0" (
  echo.
  echo Budget Cal stopped with an error.
  pause
)

endlocal & exit /b %exitCode%
