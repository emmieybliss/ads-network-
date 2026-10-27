# Delete ALL local demo data (database, Redis, uploaded creatives) and start
# again from a fresh seed. Only affects the blissnova-demo Docker project.
param([switch]$Yes)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not $Yes) {
  $a = Read-Host 'This deletes all local demo data and re-seeds it. Continue? [y/N]'
  if ($a -notmatch '^(y|yes)$') { Write-Host 'Cancelled.'; exit 0 }
}
if (Test-Path .env.demo) { docker compose --env-file .env.demo down -v --remove-orphans }
& (Join-Path $PSScriptRoot 'start-demo.ps1')
