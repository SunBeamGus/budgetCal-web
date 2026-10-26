[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("local", "lan", "host", "mysql")]
  [string]$Mode = "local",
  [switch]$NoBrowser
)

$projectRoot = $PSScriptRoot
$launchArguments = @($Mode)
if ($NoBrowser) {
  $launchArguments += "--no-browser"
}

Push-Location $projectRoot
try {
  & node ".\scripts\run.mjs" @launchArguments
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
