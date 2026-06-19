#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
#  TactixGlobalMCT — Linux startup script
#  Linux equivalent of start-full.ps1. Loads .env, ensures the
#  supporting services are up, then launches the Node server.
# ════════════════════════════════════════════════════════════════
set -e
cd "$(dirname "$0")"

# ── Load .env ─────────────────────────────────────────────────────
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║  TactixGlobalMCT — Startup                       ║"
echo "  ╚══════════════════════════════════════════════════╝"

# ── Valkey (native) ───────────────────────────────────────────────
if ! valkey-cli -u "${VALKEY_URL:-redis://localhost:6379}" ping >/dev/null 2>&1; then
  echo "  [valkey]  starting native valkey-server..."
  valkey-server --daemonize yes --port 6379 || true
else
  echo "  [valkey]  ✓ up"
fi

# ── Apache AGE container (optional) ───────────────────────────────
if command -v docker >/dev/null 2>&1; then
  docker start tactix-age >/dev/null 2>&1 && echo "  [age]     ✓ container started" \
    || echo "  [age]     ⚠ container 'tactix-age' not found (graph endpoints will 503)"
else
  echo "  [age]     ⚠ docker not installed (graph endpoints will 503)"
fi

# ── FFmpeg check ──────────────────────────────────────────────────
command -v ffmpeg >/dev/null 2>&1 && echo "  [ffmpeg]  ✓ in PATH" || echo "  [ffmpeg]  ⚠ not found (RTSP→MJPEG disabled)"

echo ""
echo "  DATABASE_URL = ${DATABASE_URL}"
echo "  VALKEY_URL   = ${VALKEY_URL}"
echo "  AGE_URL      = ${AGE_URL}"
echo ""
echo "  Launching server on http://localhost:${PORT:-3001} ..."
echo ""

exec node server/index.js
