# BlissNova local demo without Docker (eSIM style): needs only Node.js 20 or newer.
# Starts the API (with its own built-in database), the website and the demo
# publisher site in three small windows, then opens the browser.
# Data lives in %LOCALAPPDATA%\BlissNova-demo, outside OneDrive.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
if (-not $env:LOCAL_DATA_DIR) { $env:LOCAL_DATA_DIR = Join-Path $env:LOCALAPPDATA 'BlissNova-demo' }
New-Item -ItemType Directory -Force -Path $env:LOCAL_DATA_DIR | Out-Null

function Fail($msg) { Write-Host ""; Write-Host $msg -ForegroundColor Red; Write-Host ""; Read-Host 'Press Enter to close'; exit 1 }

# 1. Node.js
try { $nodeVersion = (node -v) } catch { Fail 'Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.' }
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) { Fail "Node.js $nodeVersion is too old. Install version 20 or newer from https://nodejs.org." }

# 2. Ports must be free
foreach ($port in 3000, 4000, 3100) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Fail "Port $port is already in use. If the BlissNova demo is already running, use it or run 'Stop BlissNova demo' first. Another local demo (for example the eSIM demo) may be using it: stop that one first."
  }
}

# 3. pnpm: use an installed one, otherwise run the pinned version through npx.
# Look for a real program only (-CommandType Application): PowerShell names are
# case-insensitive, so a plain Get-Command would find this helper itself.
$pnpmExe = Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
function Invoke-Pnpm {
  if ($pnpmExe) { & $pnpmExe.Source @args } else { & npx.cmd --yes pnpm@10.28.0 @args }
  if ($LASTEXITCODE -ne 0) { Fail "pnpm $($args -join ' ') failed. Scroll up for the error." }
}

# 4. Install and build when the code changed since the last start.
$lockHash = (Get-FileHash pnpm-lock.yaml).Hash
$head = try { (git rev-parse HEAD 2>$null) } catch { '' }
$stamp = "$lockHash|$head"
$stampFile = Join-Path $env:LOCAL_DATA_DIR 'build-stamp.txt'
$built = (Test-Path $stampFile) -and ((Get-Content $stampFile -Raw).Trim() -eq $stamp) -and (Test-Path 'apps\web\.next\BUILD_ID') -and (Test-Path 'apps\api\dist\local.js')
if (-not $built) {
  Write-Host 'Installing packages and building BlissNova. The first time takes several minutes...' -ForegroundColor Cyan
  Invoke-Pnpm install --frozen-lockfile
  Invoke-Pnpm --filter '@blissnova/ad-tag' build
  Invoke-Pnpm --filter '@blissnova/api' build
  $env:API_INTERNAL_URL = 'http://127.0.0.1:4000'; $env:NEXT_PUBLIC_DEMO_MODE = 'true'; Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
  Invoke-Pnpm --filter '@blissnova/web' build
  Set-Content -Path $stampFile -Value $stamp
}

# 5. Start the three windows. Each closes when its program stops; on an error it stays open so you can read it.
function Start-Window($title, $dir, $cmd) {
  Start-Process cmd.exe -WorkingDirectory (Join-Path $root $dir) -WindowStyle Minimized -ArgumentList '/c', "title $title && $cmd || pause"
}
Start-Window 'BlissNova API' 'apps\api' 'node dist\local.js'
Write-Host 'Starting the API and its database...' -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 150; $i++) {
  try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:4000/ready).StatusCode -eq 200) { $ready = $true; break } } catch { }
  Start-Sleep -Seconds 2
}
if (-not $ready) { Fail 'The API did not start within 5 minutes. Open the "BlissNova API" window from the taskbar to see why.' }
Start-Window 'BlissNova website' 'apps\web' 'node node_modules\next\dist\bin\next start --port 3000'
Start-Window 'BlissNova demo site' 'apps\demo-site' 'node server.mjs'
$webReady = $false
for ($i = 0; $i -lt 60; $i++) {
  try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3000).StatusCode -eq 200) { $webReady = $true; break } } catch { }
  Start-Sleep -Seconds 2
}
if (-not $webReady) { Fail 'The website did not start within 2 minutes. Open the "BlissNova website" window from the taskbar to see why, then run "Stop BlissNova demo".' }

$secrets = Get-Content (Join-Path $env:LOCAL_DATA_DIR 'secrets.json') -Raw | ConvertFrom-Json
Write-Host ''
Write-Host 'BlissNova demo is running.' -ForegroundColor Green
Write-Host '  Website and dashboards  http://localhost:3000'
Write-Host '  Demo publisher site     http://localhost:3100'
Write-Host '  API reference           http://localhost:3000/api/docs'
Write-Host '  Logins                  admin@example.com, advertiser@example.com, publisher@example.com'
Write-Host "  Password                $($secrets.seedPassword)"
Write-Host "  Emails the demo sends   $(Join-Path $env:LOCAL_DATA_DIR 'emails')"
Write-Host ''
Write-Host 'Everything shown is fictional demo data. To stop, run "Stop BlissNova demo".'
Start-Process 'http://localhost:3000'
Start-Process 'http://localhost:3100'
Read-Host 'Press Enter to close this window (the demo keeps running)'
