# TactixGlobalMCT on Open MCT

The operator UI now runs **inside NASA's Open MCT** framework. The existing
dashboard is preserved pixel-for-pixel and with all of its functionality — it is
hosted by Open MCT as a custom view (the "wrapper" approach). The whole system
is packaged with Docker so it runs on any machine with one command.

## Run it (any machine with Docker)

```bash
docker compose up --build
```

Then open **http://localhost:3001** — Open MCT loads and lands directly on the
**Mission Control** dashboard. **Vehicle Node** is also in the left-hand tree.

Login (inside the dashboard): `abdul` / `tactix123` or `admin` / `tactix2026`.

To stop: `Ctrl-C`, then `docker compose down` (add `-v` to wipe the DB volumes).

## Zip & send

```bash
# from the project root
git archive -o tactix-mct.zip HEAD     # or zip the folder, excluding node_modules
```

The recipient only needs Docker Desktop. `docker compose up --build` rebuilds
everything (Postgres+TimescaleDB, Valkey, Apache AGE, Node server, Open MCT) and
the seed SQL in `db/` populates the dashboard with demo events on first boot.
No Postgres/Jetson/camera required to see a fully populated UI.

## What's in the stack (docker-compose.yml)

| Service    | Image                              | Port  | Role                                   |
|------------|------------------------------------|-------|----------------------------------------|
| `postgres` | `timescale/timescaledb:latest-pg16`| 5432  | Events/assets store (+ TimescaleDB)    |
| `valkey`   | `valkey/valkey:latest`             | 6379  | Live cache, pub/sub, dedup, posture    |
| `age`      | `apache/age:release_PG16_1.6.0`    | 5434  | Mission context graph (Cypher)         |
| `server`   | built from `Dockerfile`            | 3001  | Express API + WebSocket + Open MCT UI  |

## How the wrapper works

```
Browser → http://localhost:3001
  └─ Open MCT shell            ← openmct-host/index.html  (+ /omct/openmct.js)
       └─ TactixWrapperPlugin  ← openmct-host/tactix-plugin.js
            ├─ "Mission Control" view → <iframe src="/legacy/">  (public/index.html)
            └─ "Vehicle Node"   view → <iframe src="/vehicle">   (public/vehicle.html)
```

The Node server (`server/index.js`) serves three things:

- `/`         → Open MCT host app (`openmct-host/`)
- `/omct/*`   → prebuilt Open MCT library (`node_modules/openmct/dist`)
- `/legacy/*` → the original dashboard (`public/`), embedded by the plugin

The legacy dashboard builds every API/WebSocket URL from `window.location`, so it
works unchanged inside the iframe — all calls stay same-origin against `/api`.

## Notes & limits

- **Microphone / voice commands** need a secure context. They work on
  `http://localhost:3001`; over a plain-HTTP LAN address the browser blocks
  `getUserMedia`. Put the server behind HTTPS (or a tunnel) for remote voice.
- **PTZ video**: set `RTSP_URL` in `docker-compose.yml` (server service) to your
  camera. The `server` image already includes `ffmpeg`.
- **Live Jetson data**: `JETSON_URL` defaults to a dead address so the bridge
  stays quiet. Point it at your Jetson (`http://<ip>:9090`) to get live counts.
- **Wrapper vs. native**: Open MCT here is the *host*. The dashboard does not yet
  use Open MCT's telemetry/time-conductor/inspector. Moving panels to native
  Open MCT views (the "idiomatic" path) is a separate, larger effort.
```
