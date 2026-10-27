# Stop the local demo. Data is kept; scripts/start-demo.ps1 brings it back.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Test-Path .env.demo)) { Write-Host 'No .env.demo found; nothing to stop.'; exit 0 }
docker compose --env-file .env.demo stop
Write-Host 'Demo stopped. Data is kept in Docker volumes.'
