# Stops the BlissNova local demo started by start-local.ps1. Demo data is kept.
# Only BlissNova's own windows are closed, so other local demos keep running.
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if (-not $env:LOCAL_DATA_DIR) { $env:LOCAL_DATA_DIR = Join-Path $env:LOCALAPPDATA 'BlissNova-demo' }

# 1. Stop the built-in database cleanly first.
$runner = Join-Path $root 'apps\api\dist\local.js'
if (Test-Path $runner) {
  Push-Location (Join-Path $root 'apps\api')
  node dist\local.js stop
  Pop-Location
}

# 2. Close the three windows start-local.ps1 opened (titles "BlissNova API",
#    "BlissNova website", "BlissNova demo site") and the programs in them.
foreach ($title in 'BlissNova API', 'BlissNova website', 'BlissNova demo site') {
  taskkill /F /T /FI "WINDOWTITLE eq $title*" 2>$null | Out-Null
}
Write-Host 'BlissNova demo stopped. Your demo data is kept.' -ForegroundColor Green
Start-Sleep -Seconds 3
