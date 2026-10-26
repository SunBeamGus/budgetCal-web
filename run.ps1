[CmdletBinding()]
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = $PSScriptRoot
$serverScript = Join-Path $projectRoot "scripts\serve.mjs"
$port = if ($env:PORT) { $env:PORT } else { "4173" }
$url = "http://localhost:$port"

Set-Location $projectRoot

function Test-BudgetCalRunning {
  $healthCheck = 'fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then(async (response) => { const body = await response.text(); process.exit(response.ok && /Budget Cal<\/title>/.test(body) ? 0 : 1); }).catch(() => process.exit(1));'
  & node -e $healthCheck $url
  return $LASTEXITCODE -eq 0
}

function Test-PortOpen {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect("127.0.0.1", [int]$port)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Start-AppBrowser {
  if (-not $NoBrowser) {
    Start-Process $url
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "Budget Cal needs Node.js 20 or newer." -ForegroundColor Red
  Write-Host "Install it from https://nodejs.org, then run this script again."
  Write-Host ""
  exit 1
}

if (-not (Test-Path -LiteralPath $serverScript)) {
  Write-Host "Cannot find $serverScript." -ForegroundColor Red
  exit 1
}

if (Test-BudgetCalRunning) {
  Write-Host ""
  Write-Host "Budget Cal is already running." -ForegroundColor Green
  Write-Host $url
  Write-Host ""
  Start-AppBrowser
  exit 0
}

if (Test-PortOpen) {
  Write-Host ""
  Write-Host "Port $port is already being used by another application." -ForegroundColor Red
  Write-Host "Choose a different port from PowerShell, for example:"
  Write-Host '  $env:PORT="4174"; .\run.ps1'
  Write-Host ""
  exit 1
}

Write-Host ""
Write-Host "Starting Budget Cal..." -ForegroundColor Cyan
Write-Host "The app will open at $url"
Write-Host "Keep this window open while you use it."
Write-Host "Press Ctrl+C to stop the app."
Write-Host ""

if (-not $NoBrowser) {
  $launcherCommand = @"
for (`$attempt = 0; `$attempt -lt 40; `$attempt++) {
  `$client = `$null
  try {
    `$client = New-Object System.Net.Sockets.TcpClient
    `$client.Connect('127.0.0.1', $port)
    Start-Process '$url'
    exit 0
  } catch {
  } finally {
    if (`$client) { `$client.Dispose() }
  }
  Start-Sleep -Milliseconds 250
}
"@
  $encodedCommand = [Convert]::ToBase64String(
    [Text.Encoding]::Unicode.GetBytes($launcherCommand)
  )
  $shellExecutable = (Get-Process -Id $PID).Path
  Start-Process `
    -FilePath $shellExecutable `
    -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", $encodedCommand) `
    -WindowStyle Hidden
}

& node $serverScript
$serverExitCode = $LASTEXITCODE

if ($serverExitCode -ne 0 -and $serverExitCode -ne 130) {
  Write-Host ""
  Write-Host "Budget Cal could not start." -ForegroundColor Red
  exit 1
}
