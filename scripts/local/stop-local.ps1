# Stops the BlissNova local demo started by start-local.ps1. Demo data is kept.
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if (-not $env:LOCAL_DATA_DIR) { $env:LOCAL_DATA_DIR = Join-Path $env:LOCALAPPDATA 'BlissNova-demo' }
foreach ($port in 3000, 4000, 3100) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
# The API's built-in database runs as its own process; stop it cleanly.
Push-Location (Join-Path $root 'apps\api')
node dist\local.js stop
Pop-Location
Write-Host 'BlissNova demo stopped. Your demo data is kept.' -ForegroundColor Green
Start-Sleep -Seconds 3
