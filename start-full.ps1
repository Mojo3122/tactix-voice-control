# ════════════════════════════════════════════════════════════════
#  TactixGlobalMCT — Full Startup Script
#  Drop-in replacement for start.ps1
# ════════════════════════════════════════════════════════════════
#  Edit the env-var section below if your IPs / passwords change.
# ════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

# ─── EDIT THESE FOR YOUR ENVIRONMENT ──────────────────────────────
$env:DATABASE_URL = "postgresql://postgres:tds25@localhost:5432/tactix_mct"
$env:VALKEY_URL   = "redis://localhost:6379"
$env:AGE_URL      = "postgresql://tactix:tactix@localhost:5434/tactix_graph"
$env:RTSP_URL     = "rtsp://192.168.1.64:554/stream1"
$env:JETSON_URL   = "http://192.168.0.133:9090"
$env:WHISPER_URL  = "http://localhost:9200"
# ──────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║  TactixGlobalMCT — Startup Checks                ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ─── Check Docker Desktop is running ──────────────────────────────
Write-Host "  [1/5] Checking Docker..." -NoNewline
try {
    docker info --format "{{.ServerVersion}}" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Docker engine not responding" }
    Write-Host " ✓" -ForegroundColor Green
} catch {
    Write-Host " ✗" -ForegroundColor Red
    Write-Host "    Docker Desktop is not running." -ForegroundColor Yellow
    Write-Host "    Open Docker Desktop from the Start menu and wait for the tray icon to stop animating." -ForegroundColor Yellow
    Write-Host "    Then re-run this script." -ForegroundColor Yellow
    Write-Host ""
    $continue = Read-Host "    Continue anyway (degraded mode, no Valkey / AGE)? [y/N]"
    if ($continue -ne "y") { exit 1 }
}

# ─── Start Valkey + AGE containers ────────────────────────────────
Write-Host "  [2/5] Starting Valkey container..." -NoNewline
try {
    docker start valkey 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "valkey container missing" }
    Write-Host " ✓" -ForegroundColor Green
} catch {
    Write-Host " ✗ (container missing — see RUNNING.md §5)" -ForegroundColor Yellow
}

Write-Host "  [3/5] Starting Apache AGE container..." -NoNewline
try {
    docker start tactix-age 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tactix-age container missing" }
    Write-Host " ✓" -ForegroundColor Green
} catch {
    Write-Host " ✗ (container missing — see RUNNING.md §5)" -ForegroundColor Yellow
}

Write-Host "  [4/5] Waiting 4s for AGE to be ready..." -NoNewline
Start-Sleep -Seconds 4
Write-Host " ✓" -ForegroundColor Green

# ─── Check FFmpeg is in PATH ──────────────────────────────────────
Write-Host "  [5/5] Checking FFmpeg..." -NoNewline
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) {
    Write-Host " ✓" -ForegroundColor Green
} else {
    Write-Host " ✗" -ForegroundColor Yellow
    Write-Host "    FFmpeg not in PATH — PTZ MJPEG stream will not work." -ForegroundColor Yellow
    Write-Host "    Install: winget install Gyan.FFmpeg  (then reopen this terminal)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Environment:" -ForegroundColor Cyan
Write-Host "    DATABASE_URL = $env:DATABASE_URL"
Write-Host "    VALKEY_URL   = $env:VALKEY_URL"
Write-Host "    AGE_URL      = $env:AGE_URL"
Write-Host "    RTSP_URL     = $env:RTSP_URL"
Write-Host "    JETSON_URL   = $env:JETSON_URL"
Write-Host "    WHISPER_URL  = $env:WHISPER_URL"
Write-Host ""
Write-Host "  Launching server..." -ForegroundColor Cyan
Write-Host ""

# ─── Launch the Node server ───────────────────────────────────────
node server/index.js
