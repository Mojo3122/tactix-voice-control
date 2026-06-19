# TactixGlobalMCT — Running Guide

This document covers **every component** in the TactixGlobalMCT stack: what each does, how to install it on Windows from scratch, how to start it, how to verify it's alive, and what to do when it isn't.

Project root: `C:\Users\lanst\projects\tactix-mct`

---

## Contents

1. Quick diagnosis cheat-sheet
2. System map
3. Repository file layout
4. Required vs optional components
5. **Installation — one section per component**
6. First-time project setup
7. Daily startup sequence
8. Fixing `start.ps1`
9. Environment variables reference
10. Verification checklist
11. Common failure modes
12. Minimum path from cold boot
13. What was running in your last log

---

## 1. Quick Diagnosis Cheat-Sheet

When you start the server, look for these lines in the console banner:

| Line in console                                  | Meaning                          | Required? |
|--------------------------------------------------|----------------------------------|-----------|
| `🟢 TimescaleDB hypertable active on events`     | TimescaleDB extension installed  | Optional  |
| `🟢 Valkey connected at redis://localhost:6379`  | Live cache + pub/sub up          | Yes       |
| `🟢 Apache AGE graph: tactix_mission`            | Graph DB up                      | Optional  |
| `📦 Vehicle SQLite ready: ...vehicle.db`         | Vehicle Node module loaded       | Yes       |
| `🟢 WebSocket client connected`                  | Dashboard reached the backend    | —         |

If you see `⚠️` instead of `🟢` for Valkey or AGE → Docker Desktop is not running, or the containers don't exist yet. **The dashboard will still load** with auto-seeded demo events, but no live cache, no graph queries, and no dedup.

---

## 2. System Map — Every Process That Must Be Running

```
┌──────────────────────────── WINDOWS PC (your laptop) ────────────────────────────┐
│                                                                                    │
│  PostgreSQL Service         ──┐                                                    │
│    └─ DB: tactix_mct          │                                                    │
│       └─ TimescaleDB ext      │                                                    │
│                               │                                                    │
│  Docker Desktop               │                                                    │
│    ├─ Container: valkey       ├──▶  Node.js Server  (server/index.js, port 3001)  │
│    └─ Container: tactix-age   │       ├─ Express REST API                          │
│                               │       ├─ WebSocket on same port                    │
│  FFmpeg in PATH               │       ├─ FFmpeg subprocess (RTSP → MJPEG proxy)    │
│  whisper_server.py (port 9200)┘       ├─ Vehicle Node (better-sqlite3)             │
│                                       └─ Static: public/*.html                     │
│                                                                                    │
│  Browser: http://localhost:3001                                                    │
│    └─ public/index.html  +  public/vehicle.html                                    │
└──────────────────────────────────────────────────────────────────────────────────┘
                        ▲                                  ▲
                        │ RTSP                             │ HTTP /all + WS /ws
                        │                                  │ HTTP POST /api/events
                        │                                  │
┌────────────────────┐  │  ┌──────────────────────────────────────────────────────┐
│  PTZ Camera        │──┘  │  Jetson Orin Nano  (192.168.0.133  or HaLow .3.x)    │
│  RTSP @ 192.168... │     │   ├─ Topic server  (port 9090)  HTTP+WS              │
└────────────────────┘     │   │   └─ /awareness/person_count, /vehicle_count, …  │
                           │   └─ Detection pipeline (one of):                    │
                           │       • yolo_mct_pipeline.py  (standalone)           │
                           │       • mct_bridge.py         (ROS2 bridge)          │
                           └──────────────────────────────────────────────────────┘
        ▲
        │  WiFi HaLow 802.11ah
┌───────┴────────────┐
│  HaLow AP          │
│  AsiaRF ARFHL-AP   │
│  192.168.3.3       │
└────────────────────┘
```

---

## 3. All Files That Must Exist

### On the PC (project tree)

```
C:\Users\lanst\projects\tactix-mct\
├── package.json                ← npm dependencies
├── package-lock.json
├── start.ps1                   ← launcher (broken — replace with start-full.ps1)
├── server\
│   ├── index.js                ← MAIN Node.js server   (REQUIRED)
│   └── vehicle.js              ← Vehicle Node SQLite   (REQUIRED — referenced as ./vehicle)
├── public\
│   ├── index.html              ← Main dashboard        (REQUIRED)
│   └── vehicle.html            ← /vehicle dashboard    (REQUIRED)
├── db\
│   └── 001_schema.sql          ← DB schema             (REQUIRED — load once)
├── vehicle_data\               ← Auto-created by vehicle.js
│   ├── vehicle.db
│   └── images\
├── go2rtc.yaml                 ← Optional WebRTC layer
└── whisper_server.py           ← Optional — only for voice STT
```

### On the Jetson (`tdsjetson3`)

```
~/tactix-mct/ros2_bridge/
├── yolo_mct_pipeline.py        ← Standalone YOLO+ANPR  (use if no ROS2)
└── mct_bridge.py               ← ROS2 bridge node      (use if ROS2 pipeline exists)
```

Plus whatever publishes `/awareness/*` topics and exposes them over HTTP+WS at `:9090` (your existing TASS topic server). The server polls this every 1 second for live person/vehicle/plate counts.

---

## 4. Required vs Optional Components

### Tier 1 — Required for the server to even start

| # | Component        | Where           | Port | If missing                                  |
|---|------------------|-----------------|------|---------------------------------------------|
| 1 | PostgreSQL 16    | Windows service | 5432 | Server crashes on `pool.query()`            |
| 2 | DB schema        | `tactix_mct` DB | —    | `events`/`assets` tables don't exist → 500s |
| 3 | Node.js 18+      | PC              | —    | Can't run server                            |
| 4 | npm packages     | `node_modules/` | —    | `Cannot find module 'express'`              |

### Tier 2 — Required for the dashboard to be useful

| # | Component         | Where             | Port | If missing                                          |
|---|-------------------|-------------------|------|----------------------------------------------------|
| 5 | Docker Desktop    | PC                | —    | Containers 6 + 7 can't start                       |
| 6 | Valkey            | Docker container  | 6379 | No live cache, no dedup, no pub/sub, no posture    |
| 7 | Apache AGE        | Docker container  | 5434 | No graph queries (`/api/graph/*` returns 503)      |
| 8 | FFmpeg in PATH    | PC                | —    | RTSP→MJPEG proxy silently fails, PTZ panel blank   |

### Tier 3 — Required for live detection data

| #  | Component                | Where    | Port | Purpose                              |
|----|--------------------------|----------|------|--------------------------------------|
| 9  | PTZ camera on RTSP       | LAN      | 554  | Source of video                      |
| 10 | `RTSP_URL` env var       | PC       | —    | Tells MJPEG proxy where to connect   |
| 11 | Jetson topic server      | Jetson   | 9090 | Publishes awareness counts via HTTP + WS |
| 12 | Detection pipeline       | Jetson   | —    | `yolo_mct_pipeline.py` or `mct_bridge.py` |
| 13 | `JETSON_URL` env var     | PC       | —    | Set if Jetson IP differs from default |

### Tier 4 — Optional features

| #  | Component         | Where  | Port | Enables                       |
|----|-------------------|--------|------|-------------------------------|
| 14 | TimescaleDB ext   | DB     | —    | Hypertable + continuous aggregates |
| 15 | Python 3.10+      | PC     | —    | Required by Whisper           |
| 16 | Whisper STT       | PC     | 9200 | Voice commands via `/api/transcribe` |
| 17 | go2rtc            | PC     | 1984 | Sub-100 ms WebRTC streaming   |
| 18 | HaLow AP          | LAN    | —    | Long-range Jetson ↔ PC link (status pill only) |

---

## 5. Installation — One Section per Component

This section walks through installing every piece of software from a clean Windows machine. Do these in order — each component below depends on at least one earlier one.

> **Note on `winget`** — Windows 10 (1809+) and Windows 11 ship with the Windows Package Manager built in. If `winget` is missing, install **App Installer** from the Microsoft Store, or grab the latest `.msixbundle` from https://github.com/microsoft/winget-cli/releases. After install, close and reopen PowerShell so PATH refreshes.

> **Run PowerShell as Administrator** for all `winget install` commands. Right-click the Start menu → "Windows PowerShell (Admin)" or "Terminal (Admin)".

### 5.1 — Node.js 18+

**What it is:** JavaScript runtime that runs `server/index.js`. Includes `npm` for installing packages.

**Install:**
```powershell
winget install OpenJS.NodeJS.LTS
```
Or download the LTS `.msi` from https://nodejs.org/ and double-click.

**After install, close and reopen PowerShell** so `node`/`npm` appear on PATH.

**Verify:**
```powershell
node --version    # should print v20.x.x or v22.x.x
npm --version     # should print 10.x.x or 11.x.x
```

---

### 5.2 — PostgreSQL 16

**What it is:** The canonical truth store for events, assets, ingest audit, and (with TimescaleDB) time-series buckets.

**Install:**
```powershell
winget install PostgreSQL.PostgreSQL.16
```
Or download the EnterpriseDB Windows installer: https://www.postgresql.org/download/windows/ → "Download the installer".

**During installation:**
- **Password for `postgres` user**: pick something and write it down. Your `start.ps1` uses `tds25` — match it, or update `start.ps1` to whatever you set.
- **Port**: `5432` (default — keep it)
- **Locale**: default
- **Stack Builder**: skip — you don't need extras

**Add `psql` to PATH** (the installer doesn't always do this). Open "Edit the system environment variables" → System Properties → Environment Variables → edit `Path` → add:
```
C:\Program Files\PostgreSQL\16\bin
```
Close and reopen PowerShell.

**Verify:**
```powershell
psql --version                                # postgres (PostgreSQL) 16.x
Get-Service postgresql-x64-16                 # Status should be Running
```

If the service isn't running:
```powershell
Start-Service postgresql-x64-16
```

---

### 5.3 — Docker Desktop

**What it is:** Runs the Valkey and Apache AGE containers. Requires WSL2 backend on Windows 10/11.

**Install:**
```powershell
winget install Docker.DockerDesktop
```
Or download from https://www.docker.com/products/docker-desktop/ and double-click the `.exe`.

**During first launch:**
- Accept the license
- Choose **WSL2 backend** (not Hyper-V) when prompted
- If WSL2 isn't installed, the installer offers to install it — accept. Reboot when prompted.

**After install:**
- Docker Desktop creates a system tray icon (whale)
- **Wait for the whale icon to stop animating** before running any `docker` command. First-time engine boot takes 30–60 seconds.

**Verify:**
```powershell
docker --version                              # Docker version 27.x or later
docker info --format "{{.ServerVersion}}"     # prints version number, no errors
docker run --rm hello-world                   # downloads + runs test container
```

If `docker info` errors with "Cannot find npipe…" → Docker Desktop isn't running yet. Open it from the Start menu.

---

### 5.4 — FFmpeg

**What it is:** Decodes the camera's RTSP H.264/H.265 stream and re-encodes it as MJPEG that the browser `<img>` tag can consume. The server spawns it on demand.

**Install:**
```powershell
winget install Gyan.FFmpeg
```

**Close and reopen PowerShell** so `ffmpeg` appears on PATH.

**Verify:**
```powershell
ffmpeg -version    # ffmpeg version 7.x ...
```

**Quick functional test** (against your real camera):
```powershell
ffplay rtsp://192.168.1.64:554/stream1
```
A video window should open. Press `q` to close. If this fails, the issue is the camera, not FFmpeg.

---

### 5.5 — Python 3.10+ (only if using Whisper voice)

**What it is:** Required to run `whisper_server.py` for offline speech-to-text.

**Install:**
```powershell
winget install Python.Python.3.11
```

**Verify:**
```powershell
python --version    # Python 3.11.x
pip --version
```

---

### 5.6 — TimescaleDB extension (optional)

**What it is:** A PostgreSQL extension that turns the `events` table into a hypertable with automatic time-bucket aggregates. The server **degrades gracefully** without it — `/api/timescale/*` endpoints just fall back to plain Postgres `date_trunc`.

**If you want to skip TimescaleDB,** do nothing. The server prints a warning and keeps running.

**If you want it:**

1. Download the TimescaleDB Windows installer matching your PostgreSQL version (16):
   https://docs.timescale.com/self-hosted/latest/install/installation-windows/
2. Run the installer — it'll detect your existing Postgres 16 install and patch it.
3. After install, run `timescaledb-tune.exe` from the install directory to update `postgresql.conf` (it auto-adds `timescaledb` to `shared_preload_libraries`).
4. Restart Postgres:
   ```powershell
   Restart-Service postgresql-x64-16
   ```
5. Enable in your DB:
   ```powershell
   $env:PGPASSWORD = "tds25"
   psql -U postgres -d tactix_mct -c "CREATE EXTENSION timescaledb;"
   ```

**Verify:**
```powershell
psql -U postgres -d tactix_mct -c "SELECT extversion FROM pg_extension WHERE extname='timescaledb';"
```
Should print a version like `2.16.x`.

The server will print `🟢 TimescaleDB hypertable active on events` on next start.

> **Alternative path:** If the Windows installer is troublesome, you can run a separate Timescale container in Docker on a different port (e.g. 5433) and point `DATABASE_URL` at it. But that means migrating your data — not worth it just for the hypertable.

---

### 5.7 — Valkey (via Docker)

**What it is:** Redis-compatible in-memory store. Used for live event cache (last 100), per-asset status TTL, pub/sub, dedup, and posture state. Without it, the server still works but `/api/valkey/*` returns 503 and event dedup is Postgres-only.

**Pull and create the container** (one time):
```powershell
docker run -d --name valkey -p 6379:6379 valkey/valkey:latest
```

**Verify:**
```powershell
docker ps --filter "name=valkey"
# STATUS column should show "Up X minutes"

docker exec valkey valkey-cli PING
# expect: PONG
```

**Subsequent days:** `docker start valkey` (handled by `start-full.ps1`).

---

### 5.8 — Apache AGE (via Docker)

**What it is:** A PostgreSQL extension that adds a Cypher query layer for the mission graph (Assets, Missions, Zones, Events, Persons, Vehicles + their relationships). Server falls back to "graph unavailable" if absent — only `/api/graph/*` endpoints fail.

**Pull and create the container** (one time):
```powershell
docker run -d --name tactix-age -p 5434:5432 `
  -e POSTGRES_USER=tactix `
  -e POSTGRES_PASSWORD=tactix `
  -e POSTGRES_DB=tactix_graph `
  apache/age:PG16_latest
```

**Note the port:** `5434` on the host so it doesn't collide with your main Postgres on `5432`.

**Verify:**
```powershell
docker ps --filter "name=tactix-age"

# Confirm AGE extension loads
docker exec -e PGPASSWORD=tactix tactix-age psql -U tactix -d tactix_graph -c "CREATE EXTENSION IF NOT EXISTS age; LOAD 'age'; SELECT 'ok' AS status;"
```

The server will print `🟢 Apache AGE graph: tactix_mission` on next start and auto-seed the graph with assets.

---

### 5.9 — Whisper STT server (optional)

**What it is:** Offline speech-to-text running on port 9200. The Node server proxies `/api/transcribe` to it for voice commands.

**Depends on:** Python 3.10+ (§5.5).

**Install the typical dependencies** (your `whisper_server.py` may use any of these — adjust if it specifies different ones):
```powershell
pip install --upgrade pip
pip install openai-whisper        # original OpenAI implementation
# OR for faster CPU/GPU inference:
pip install faster-whisper

pip install flask flask-cors      # if whisper_server.py uses Flask
```

**FFmpeg is also required** for Whisper's audio decoding — already installed in §5.4.

**Start the server:**
```powershell
cd C:\Users\lanst\projects\tactix-mct
python whisper_server.py
```
Should bind to `http://localhost:9200`. Leave it running in its own PowerShell window.

**Verify from another window:**
```powershell
curl http://localhost:9200/health             # the whisper server directly
curl http://localhost:3001/api/whisper/health # via the Node proxy
```

---

### 5.10 — Jetson side install (Jetson Orin Nano, JetPack)

**What it is:** Edge perception node. Runs the YOLO/ANPR detection pipeline and publishes ROS2 awareness topics that the PC server polls.

**Assumed already installed on the Jetson** (per your existing TASS setup):
- JetPack with Ubuntu 22.04
- ROS2 Humble
- HailoRT runtime + Hailo-8 driver
- Python 3.10

**Install the bridge dependencies:**
```bash
# SSH into the Jetson
ssh abdul@192.168.0.133

cd ~/tactix-mct/ros2_bridge

# Python deps for the standalone pipeline
pip install ultralytics opencv-python requests numpy
pip install easyocr        # for ANPR (optional)

# If using the ROS2 bridge instead:
source /opt/ros/humble/setup.bash
source ~/ros2_ws/install/setup.bash
```

**Network reachability:** make sure the PC can reach the Jetson at whatever IP you set `JETSON_URL` to. Test from the PC:
```powershell
ping 192.168.0.133
Test-NetConnection 192.168.0.133 -Port 9090
```

**Start the topic server + detection pipeline:**

The topic server (your TASS pipeline that exposes `/awareness/*` topics over HTTP+WS at port 9090) is whatever node you already run for the OpenMCT dashboard. The Node.js server polls it once per second; nothing to change there.

For the detection-events pipeline:
```bash
# Option A: standalone YOLO+ANPR (no ROS2 needed)
python3 yolo_mct_pipeline.py \
    --rtsp rtsp://192.168.1.64:554/stream1 \
    --model yolov11s.hef \
    --api http://<YOUR_PC_LAN_IP>:3001/api \
    --asset sentry-1 --anpr

# Option B: ROS2 bridge (if you have ROS2 detection nodes already)
python3 mct_bridge.py --ros-args \
    -p api_url:=http://<YOUR_PC_LAN_IP>:3001/api \
    -p asset_id:=sentry-1
```

`<YOUR_PC_LAN_IP>` = whatever `ipconfig` on the PC shows for the interface on the same subnet as the Jetson (Ethernet, WiFi, or HaLow `192.168.3.x`).

---

### 5.11 — HaLow AP configuration (AsiaRF ARFHL-AP)

**What it is:** A WiFi HaLow (802.11ah, sub-GHz) access point used as the long-range link between the patrol vehicle's Jetson and the operator's PC. The dashboard only shows its status pill — it doesn't actively manage it.

**Initial setup** (do once):
1. Power the ARFHL-AP via USB-C.
2. Connect to its default WiFi SSID (`AsiaRF-xxxx`) or plug in via Ethernet.
3. Open its web UI at `http://192.168.3.3` (default IP).
4. Default credentials: `admin` / `admin` — **change the password immediately**.
5. Configure:
   - **Mode**: Access Point
   - **Channel**: pick one allowed in IN region (regional regulations apply for sub-GHz)
   - **SSID**: e.g. `tactix-halow`
   - **Security**: WPA2-PSK
   - **DHCP**: enable, range `192.168.3.10` – `192.168.3.100`
6. Save and reboot.

**Connect the Jetson:**
```bash
sudo nmcli device wifi connect tactix-halow password '<your-password>'
```
The Jetson should receive an IP like `192.168.3.20`. Update your `JETSON_URL` env var on the PC:
```powershell
$env:JETSON_URL = "http://192.168.3.20:9090"
```

**Dashboard status pill:** The Node server doesn't actively poll the HaLow AP — it relies on the Jetson reporting link state. If you want a live status pill, you'd need to expose RSSI/link-quality from the Jetson or scrape the AP's web UI. That's a separate feature, not implemented yet.

---

## 6. First-Time Project Setup

Once §5.1–§5.4 are done (Node, Postgres, Docker Desktop, FFmpeg), do this **once per machine** to bootstrap the repo:

```powershell
cd C:\Users\lanst\projects\tactix-mct

# 1. npm dependencies
npm install

# 2. Create the database
$env:PGPASSWORD = "tds25"
createdb -U postgres tactix_mct

# 3. Load the schema (events, assets, ingest_audit tables)
psql -U postgres -d tactix_mct -f db/001_schema.sql

# 4. (Optional) TimescaleDB extension — only if §5.6 done
psql -U postgres -d tactix_mct -c "CREATE EXTENSION timescaledb;"

# 5. Create the two Docker containers (Docker Desktop must be running)
docker run -d --name valkey -p 6379:6379 valkey/valkey:latest
docker run -d --name tactix-age -p 5434:5432 `
  -e POSTGRES_USER=tactix -e POSTGRES_PASSWORD=tactix `
  -e POSTGRES_DB=tactix_graph apache/age:PG16_latest
```

After this, the heavy lifting is done. Subsequent runs just need `docker start` + the Node server.

---

## 7. Daily Startup Sequence

### Step 1 — Open Docker Desktop
**From the Start menu, open Docker Desktop and wait until the whale icon stops animating.** This was your problem in the last run.

Verify:
```powershell
docker ps -a
# you should see: valkey      …   Up/Exited
#                 tactix-age  …   Up/Exited
```

### Step 2 — Start the two containers
```powershell
docker start valkey
docker start tactix-age
```

### Step 3 — Set environment variables
The original `start.ps1` only sets `DATABASE_URL`. Add the rest before launching:
```powershell
$env:DATABASE_URL = "postgresql://postgres:tds25@localhost:5432/tactix_mct"
$env:VALKEY_URL   = "redis://localhost:6379"
$env:AGE_URL      = "postgresql://tactix:tactix@localhost:5434/tactix_graph"
$env:RTSP_URL     = "rtsp://192.168.1.64:554/stream1"
$env:JETSON_URL   = "http://192.168.0.133:9090"
$env:WHISPER_URL  = "http://localhost:9200"
```

### Step 4 — Start the Node server
```powershell
node server/index.js
```
Or use `start-full.ps1` (see §8).

### Step 5 — Verify all 🟢 dots
You should see:
```
🟢 TimescaleDB hypertable active on events
🟢 Valkey connected at redis://localhost:6379
🟢 Apache AGE graph: tactix_mission
📦 Vehicle SQLite ready: ...vehicle.db
```

If anything is ⚠️, see §11.

### Step 6 — Open dashboard
http://localhost:3001 → login with `abdul` / `tactix123` (or `admin` / `tactix2026`).

### Step 7 — Start the Jetson side (separate machine)
SSH into the Jetson and start your topic server + detection pipeline as in §5.10.

### Step 8 — (Optional) Whisper voice
In a separate PowerShell window:
```powershell
cd C:\Users\lanst\projects\tactix-mct
python whisper_server.py
```

---

## 8. Fixing `start.ps1`

Your current `start.ps1` has three problems:
1. Calls `docker start` before checking Docker Desktop is up
2. Doesn't set `RTSP_URL` (so PTZ stream silently fails)
3. Doesn't set `JETSON_URL` (defaults to `192.168.0.133` which may not match your HaLow subnet)

Use `start-full.ps1` (provided separately) — it sanity-checks Docker, sets all six env vars, warns about missing FFmpeg, and gives you a confirmation prompt to continue in degraded mode.

---

## 9. Environment Variables Reference

| Variable        | Default                                                          | Set where        |
|-----------------|------------------------------------------------------------------|------------------|
| `PORT`          | `3001`                                                           | optional         |
| `DATABASE_URL`  | `postgresql://postgres:postgres@localhost:5432/tactix_mct`       | `start-full.ps1` |
| `VALKEY_URL`    | `redis://localhost:6379`                                         | optional         |
| `AGE_URL`       | `postgresql://tactix:tactix@localhost:5434/tactix_graph`         | optional         |
| `RTSP_URL`      | *(none)*                                                         | **must set**     |
| `RTSP_SENTRY_1` | *(none)* — falls back to `RTSP_URL`                              | optional         |
| `RTSP_SENTRY_2` | *(none)*                                                         | optional         |
| `RTSP_EAGLE_1`  | *(none)*                                                         | optional         |
| `JETSON_URL`    | `http://192.168.0.133:9090`                                      | set if IP differs |
| `WHISPER_URL`   | `http://localhost:9200`                                          | optional         |

---

## 10. Verification Checklist (curl one-liners)

Run from PowerShell to confirm each service is alive:

```powershell
# Server is up
curl http://localhost:3001/api/health

# Postgres has data
curl http://localhost:3001/api/events?limit=1

# Valkey cache
curl http://localhost:3001/api/valkey/status

# Apache AGE graph
curl http://localhost:3001/api/graph/status

# Jetson bridge
curl http://localhost:3001/api/jetson/topics

# Whisper STT (only if running)
curl http://localhost:3001/api/whisper/health

# MJPEG stream (open in browser, not curl)
# http://localhost:3001/api/stream/sentry-1
```

---

## 11. Common Failure Modes

### `failed to connect to the docker API at npipe://...`
**Docker Desktop is not running.** Open it from the Start menu. Wait ~30 seconds for the engine. Re-run.

### `[ioredis] Unhandled error event: AggregateError`
Valkey container isn't up.
```powershell
docker start valkey
docker logs valkey
```

### `⚠️  TimescaleDB extension not available`
Non-fatal — server falls back to plain Postgres. To fix, see §5.6.

### `⚠️  Apache AGE not available`
Non-fatal — only `/api/graph/*` endpoints stop working. To fix:
```powershell
docker start tactix-age
docker logs tactix-age
```

### `⚠️  Jetson WS error: connect ECONNREFUSED 192.168.0.133:9090`
Either the Jetson is off, on a different IP, or the topic server isn't running.
```powershell
ping 192.168.0.133
Test-NetConnection 192.168.0.133 -Port 9090
```
If the Jetson IP changed (HaLow vs Ethernet), set `JETSON_URL` accordingly. To silence the spam temporarily, set `JETSON_URL=http://127.0.0.1:0` — the server keeps trying but won't block anything else.

### PTZ panel shows blank / nothing
Most likely:
1. `RTSP_URL` not set → returns 404 silently
2. FFmpeg not in PATH → server can't spawn the proxy
3. Camera unreachable → `ffplay rtsp://192.168.1.64:554/stream1` to confirm

### Dashboard shows random events that don't match Jetson reality
That's the **auto-seed + auto-push demo mode** in `index.html` (lines ~1772–1810). To disable for production, comment out `seedDemoEvents()` and `startAutoPush()`.

### `psql: command not found`
PostgreSQL's `bin` dir isn't on PATH. Add `C:\Program Files\PostgreSQL\16\bin` to your `PATH` env var. See §5.2.

### `node : The term 'node' is not recognized`
Node didn't add itself to PATH, or PowerShell window was opened before install. Close and reopen PowerShell, or add `C:\Program Files\nodejs\` to PATH.

### `npm install` fails on `better-sqlite3`
That package compiles native bindings. You need either:
- The Node.js installer's "Tools for Native Modules" option (re-run the installer if you skipped it), or
- Visual Studio Build Tools with the "Desktop development with C++" workload.

---

## 12. Minimum Path to "Everything Green" From a Cold Boot

```powershell
# 1. Power on Jetson, wait for it to boot fully
# 2. Open Docker Desktop, wait until tray icon is steady
# 3. PowerShell:
cd C:\Users\lanst\projects\tactix-mct
docker start valkey tactix-age
$env:DATABASE_URL = "postgresql://postgres:tds25@localhost:5432/tactix_mct"
$env:RTSP_URL = "rtsp://192.168.1.64:554/stream1"
$env:JETSON_URL = "http://192.168.0.133:9090"
node server/index.js

# 4. Browser: http://localhost:3001 → login as abdul / tactix123
# 5. SSH to Jetson, start the topic server + yolo_mct_pipeline.py
```

When `/api/health` returns all `"connected"` and the dashboard `wsDot` is green, you're fully up.

---

## 13. What's Running In Your Last Log (for reference)

| Service             | State            | Reason                                     |
|---------------------|------------------|--------------------------------------------|
| Node server         | ✅ Up            | `start.ps1` worked                         |
| PostgreSQL          | ✅ Up            | Service was already running                |
| Vehicle SQLite      | ✅ Up            | Auto-initialized                           |
| Dashboard (browser) | ✅ Up            | You logged in as admin                     |
| WebSocket           | ✅ Up            | `WebSocket client connected (total: 1)`    |
| Valkey              | ❌ Down          | Docker Desktop not running                 |
| Apache AGE          | ❌ Down          | Docker Desktop not running                 |
| TimescaleDB ext     | ❌ Not installed | Need `CREATE EXTENSION timescaledb`        |
| Jetson topic server | ❌ Unreachable   | `192.168.0.133:9090` ECONNREFUSED          |
| RTSP MJPEG proxy    | ❌ Not configured | `RTSP_URL` not set                        |
| Whisper STT         | ❌ Not running   | `whisper_server.py` not started            |
| Detection pipeline  | ❌ Not running   | Jetson not connected                       |

What you saw in the UI was the **auto-seed demo events + auto-push timer** — synthetic data baked into `index.html`. The dashboard "worked" because of that fallback, not because the backend was healthy.
