/**
 * TactixGlobalMCT — Backend Server
 * 
 * ┌─────────────────────────────────────────────────────┐
 * │  PostgreSQL + TimescaleDB  →  Persistent truth       │
 * │  Valkey (Redis)            →  Real-time cache + pub  │
 * │  WebSocket                 →  Live dashboard stream   │
 * └─────────────────────────────────────────────────────┘
 * 
 * REST APIs:
 *   GET/POST   /api/events
 *   GET        /api/events/:id
 *   GET/POST   /api/assets
 *   PUT        /api/assets/:id
 *   GET/POST   /api/ingest
 *   GET        /api/stats
 *   GET        /api/valkey/status
 *   GET        /api/valkey/live
 *   GET        /api/valkey/posture
 *   GET        /api/timescale/buckets
 *   GET        /api/timescale/status
 * 
 * WebSocket:  ws://localhost:3001 — live event stream
 * Run: node server/index.js
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { randomUUID: uuidv4 } = require('crypto');
const { WebSocketServer } = require('ws');
const path = require('path');

// ── Vehicle Node (Edge SQLite) ────────────────────────────────
const vehicleNode = require('./vehicle');

// ── Report Assistant (offline LLM Q&A over .docx reports) ─────
const reportLLM = require('./report_llm');

// ── Stream Config ─────────────────────────────────────────────
const { spawn } = require('child_process');
const STREAMS = {
  'sentry-1': process.env.RTSP_SENTRY_1 || process.env.RTSP_URL || '',
  'sentry-2': process.env.RTSP_SENTRY_2 || '',
  'eagle-1':  process.env.RTSP_EAGLE_1 || '',
};
const activeStreams = {}; // assetId -> { ffmpeg, clients[] }

// ── Config ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/tactix_mct';
const VALKEY_URL = process.env.VALKEY_URL || 'redis://localhost:6379';
const AGE_URL = process.env.AGE_URL || 'postgresql://tactix:tactix@localhost:5434/tactix_graph';

const pool = new Pool({ connectionString: DB_URL });
const agePool = new Pool({ connectionString: AGE_URL });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Report Assistant endpoints: /api/reports*, /api/llm/*
app.use('/api', reportLLM.router);

// ══════════════════════════════════════════════════════════════
// FRONT-END: OpenMCT host shell  →  wraps the legacy dashboard
// ══════════════════════════════════════════════════════════════
//   /            → OpenMCT host app (openmct-host/index.html)
//   /omct/*      → prebuilt OpenMCT library (node_modules/openmct/dist)
//   /legacy/*    → original TactixGlobalMCT dashboard (public/), embedded
//                  by the OpenMCT plugin as a custom iframe view.
// The legacy dashboard builds every API/WS URL from window.location,
// so it works unchanged when served from /legacy inside an iframe.
app.use('/omct', express.static(path.join(__dirname, '..', 'node_modules', 'openmct', 'dist')));
app.use('/legacy', express.static(path.join(__dirname, '..', 'public')));
app.use(express.static(path.join(__dirname, '..', 'openmct-host')));

// Vehicle Node dashboard at /vehicle (also embedded as an OpenMCT view)
app.get('/vehicle', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'vehicle.html'));
});

// ══════════════════════════════════════════════════════════════
// RTSP → MJPEG Stream Proxy (via FFmpeg)
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// AUTHENTICATION — Operator Login
// ══════════════════════════════════════════════════════════════

const OPERATORS = {
  'admin':    { password: 'tactix2026',  name: 'Admin',          role: 'Supervisor',      id: 'OP-001', clearance: 'Level 5' },
  'abdul':    { password: 'tactix123',   name: 'Abdul',          role: 'CV Engineer',     id: 'OP-002', clearance: 'Level 4' },
  'sentry01': { password: 'watch2026',   name: 'Sentry Alpha',   role: 'Watch Officer',   id: 'OP-003', clearance: 'Level 3' },
  'sentry02': { password: 'watch2026',   name: 'Sentry Bravo',   role: 'Watch Officer',   id: 'OP-004', clearance: 'Level 3' },
  'cmd':      { password: 'command2026', name: 'Commander',       role: 'Mission Commander', id: 'OP-005', clearance: 'Level 5' },
};
const activeSessions = {}; // token -> { user, loginTime }

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = OPERATORS[username.toLowerCase()];
  if (!user || user.password !== password) {
    console.log(`  🔒 Login failed: ${username}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = require('crypto').randomBytes(24).toString('hex');
  const session = {
    username: username.toLowerCase(),
    name: user.name,
    role: user.role,
    id: user.id,
    clearance: user.clearance,
    loginTime: new Date().toISOString(),
  };
  activeSessions[token] = session;

  console.log(`  🔓 Login OK: ${user.name} (${user.role}) — ${user.id}`);
  res.json({ ok: true, token, ...session });
});

app.get('/api/auth/verify', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const session = activeSessions[token];
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  res.json({ ok: true, ...session });
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (activeSessions[token]) {
    console.log(`  🔒 Logout: ${activeSessions[token].name}`);
    delete activeSessions[token];
  }
  res.json({ ok: true });
});

app.get('/api/auth/operators', (req, res) => {
  // List active operators (no passwords)
  const active = Object.values(activeSessions).map(s => ({
    name: s.name, role: s.role, id: s.id, loginTime: s.loginTime,
  }));
  res.json({ operators: active, count: active.length });
});

// Configure stream URL at runtime
app.post('/api/stream/config', (req, res) => {
  const { asset_id, rtsp_url } = req.body;
  if (!asset_id || !rtsp_url) return res.status(400).json({ error: 'asset_id and rtsp_url required' });
  STREAMS[asset_id] = rtsp_url;
  // Kill existing stream if running
  if (activeStreams[asset_id]) {
    activeStreams[asset_id].ffmpeg.kill('SIGTERM');
    delete activeStreams[asset_id];
  }
  console.log(`  📹 Stream configured: ${asset_id} → ${rtsp_url}`);
  res.json({ ok: true, asset_id, rtsp_url });
});

// Get stream config
app.get('/api/stream/config', (req, res) => {
  const configs = {};
  for (const [id, url] of Object.entries(STREAMS)) {
    configs[id] = { url: url || null, active: !!activeStreams[id] };
  }
  res.json(configs);
});

// MJPEG stream endpoint — browser connects via <img src="/api/stream/sentry-1">
app.get('/api/stream/:assetId', (req, res) => {
  const assetId = req.params.assetId;
  const rtspUrl = STREAMS[assetId];

  if (!rtspUrl) {
    return res.status(404).json({ error: `No RTSP URL configured for ${assetId}. Set RTSP_URL env or POST /api/stream/config` });
  }

  console.log(`  📹 Stream request: ${assetId} → ${rtspUrl}`);

  // Set MJPEG response headers
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Pragma': 'no-cache',
  });

  // Spawn FFmpeg: RTSP → MJPEG pipe
  const ffmpeg = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-f', 'mjpeg',
    '-q:v', '5',             // Quality (2=best, 31=worst)
    '-r', '15',              // 15 fps
    '-vf', 'scale=960:-1',   // Scale to 960px wide
    '-an',                   // No audio
    '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let buffer = Buffer.alloc(0);
  const SOI = Buffer.from([0xFF, 0xD8]); // JPEG start
  const EOI = Buffer.from([0xFF, 0xD9]); // JPEG end

  ffmpeg.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Extract complete JPEG frames
    while (true) {
      const start = buffer.indexOf(SOI);
      const end = buffer.indexOf(EOI, start + 2);
      if (start === -1 || end === -1) break;

      const frame = buffer.slice(start, end + 2);
      buffer = buffer.slice(end + 2);

      // Write MJPEG frame
      try {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        res.write(frame);
        res.write('\r\n');
      } catch (e) {
        ffmpeg.kill('SIGTERM');
        return;
      }
    }

    // Prevent buffer overflow
    if (buffer.length > 2 * 1024 * 1024) {
      buffer = buffer.slice(-512 * 1024);
    }
  });

  ffmpeg.stderr.on('data', (data) => {
    // Uncomment for debug: console.log(`ffmpeg: ${data.toString().trim()}`);
  });

  ffmpeg.on('close', (code) => {
    console.log(`  📹 FFmpeg closed for ${assetId} (code: ${code})`);
    delete activeStreams[assetId];
    try { res.end(); } catch (e) {}
  });

  // Track active stream
  activeStreams[assetId] = { ffmpeg, startTime: Date.now() };

  // Clean up when client disconnects
  req.on('close', () => {
    console.log(`  📹 Client disconnected from ${assetId} stream`);
    ffmpeg.kill('SIGTERM');
    delete activeStreams[assetId];
  });
});

// ══════════════════════════════════════════════════════════════
// VALKEY (Redis-compatible) — Real-time cache + Pub/Sub
// ══════════════════════════════════════════════════════════════

let Redis;
let valkey = null;
let valkeyPub = null;
let valkeySub = null;
let valkeyConnected = false;

const VK = {
  LIVE_EVENTS:      'tactix:live:events',
  ASSET_STATUS:     'tactix:asset:',
  POSTURE:          'tactix:posture',
  EVENT_CHANNEL:    'tactix:events:new',
  FEEDBACK_CHANNEL: 'tactix:feedback',
  STATS:            'tactix:stats',
  EVENT_DEDUP:      'tactix:dedup:',
};

async function initValkey() {
  try {
    Redis = require('ioredis');
    const opts = {
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 500, 3000);
      },
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    };

    valkey = new Redis(VALKEY_URL, opts);
    valkeyPub = new Redis(VALKEY_URL, opts);
    valkeySub = new Redis(VALKEY_URL, opts);

    await valkey.connect();
    await valkeyPub.connect();
    await valkeySub.connect();
    valkeyConnected = true;
    console.log('  🟢 Valkey connected at', VALKEY_URL);

    await valkeySub.subscribe(VK.EVENT_CHANNEL, VK.FEEDBACK_CHANNEL);
    valkeySub.on('message', (channel, message) => {
      try {
        const data = JSON.parse(message);
        if (channel === VK.FEEDBACK_CHANNEL) {
          console.log('  📨 Feedback:', data);
          broadcastToWS({ type: 'feedback', data });
        }
      } catch (e) { }
    });

    await valkey.hmset(VK.POSTURE, {
      level: 'NORMAL', confidence: '0',
      reason: 'System initialized', updated_at: new Date().toISOString()
    });
    await valkey.hmset(VK.STATS, {
      events_total: '0', events_1min: '0', events_5min: '0',
      alerts_active: '0', last_event_at: ''
    });

  } catch (err) {
    valkeyConnected = false;
    console.log('  ⚠️  Valkey not available — running without real-time cache');
    console.log('     Install: docker run -d --name valkey -p 6379:6379 valkey/valkey:latest');
  }
}

async function valkeyPublishEvent(event) {
  if (!valkeyConnected) return;
  try {
    await valkey.lpush(VK.LIVE_EVENTS, JSON.stringify(event));
    await valkey.ltrim(VK.LIVE_EVENTS, 0, 99);

    await valkey.hmset(VK.ASSET_STATUS + event.asset_id, {
      last_event: event.event_type,
      last_confidence: String(event.confidence),
      last_seen: event.timestamp || new Date().toISOString(),
      status: 'active'
    });
    await valkey.expire(VK.ASSET_STATUS + event.asset_id, 300);

    await updatePosture(event);

    await valkey.hincrby(VK.STATS, 'events_total', 1);
    await valkey.hset(VK.STATS, 'last_event_at', new Date().toISOString());

    const minuteKey = 'tactix:counter:' + Math.floor(Date.now() / 60000);
    await valkey.incr(minuteKey);
    await valkey.expire(minuteKey, 300);

    await valkeyPub.publish(VK.EVENT_CHANNEL, JSON.stringify(event));
    await valkey.set(VK.EVENT_DEDUP + event.event_id, '1', 'EX', 300);
  } catch (err) {
    console.error('Valkey publish error:', err.message);
  }
}

async function updatePosture(event) {
  if (!valkeyConnected) return;
  try {
    const current = await valkey.hgetall(VK.POSTURE);
    const currentConf = parseFloat(current.confidence || '0');
    let level = 'NORMAL';
    let reason = current.reason || '';
    const suspiciousTypes = ['suspicious_vehicle', 'escalation_pending', 'thermal_anomaly'];

    if (suspiciousTypes.includes(event.event_type) || event.confidence > 0.85) {
      level = 'ALERT';
      reason = event.event_type + ' — confidence ' + (event.confidence * 100).toFixed(0) + '%';
    } else if (event.confidence > 0.7 || currentConf > 0.7) {
      level = 'ELEVATED';
      reason = event.event_type + ' — monitoring';
    }

    if (event.confidence > 0.7 && !['heartbeat', 'patrol_start'].includes(event.event_type)) {
      await valkey.hincrby(VK.STATS, 'alerts_active', 1);
      await valkey.set('tactix:alert:' + event.event_id, '1', 'EX', 900);
    }

    await valkey.hmset(VK.POSTURE, {
      level, confidence: String(Math.max(event.confidence, currentConf * 0.95)),
      reason, last_event_type: event.event_type, updated_at: new Date().toISOString()
    });
    await valkey.expire(VK.POSTURE, 1800);
  } catch (err) { }
}

async function valkeyCheckDedup(eventId) {
  if (!valkeyConnected) return false;
  try { return (await valkey.exists(VK.EVENT_DEDUP + eventId)) === 1; } catch { return false; }
}

// ══════════════════════════════════════════════════════════════
// TIMESCALEDB — Time-series queries
// ══════════════════════════════════════════════════════════════

let timescaleEnabled = false;

async function initTimescale() {
  try {
    const extCheck = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') AS available"
    );
    if (!extCheck.rows[0].available) {
      console.log('  ⚠️  TimescaleDB extension not available');
      console.log('     Install: https://docs.timescale.com/install/latest/');
      return;
    }
    await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE');

    try {
      await pool.query("SELECT create_hypertable('events', 'timestamp', if_not_exists => TRUE, migrate_data => TRUE)");
      timescaleEnabled = true;
      console.log('  🟢 TimescaleDB hypertable active on events');
    } catch (err) {
      if (err.message.includes('already a hypertable')) {
        timescaleEnabled = true;
        console.log('  🟢 TimescaleDB hypertable already active');
      } else {
        console.log('  ⚠️  TimescaleDB hypertable failed:', err.message.substring(0, 80));
      }
    }

    if (timescaleEnabled) {
      try {
        await pool.query("CREATE MATERIALIZED VIEW IF NOT EXISTS events_per_minute WITH (timescaledb.continuous) AS SELECT time_bucket('1 minute', timestamp) AS bucket, event_type, node_id, asset_id, COUNT(*) AS event_count, AVG(confidence) AS avg_confidence, MAX(confidence) AS max_confidence FROM events GROUP BY bucket, event_type, node_id, asset_id WITH NO DATA");
        console.log('  🟢 TimescaleDB continuous aggregate: events_per_minute');
      } catch (err) {
        if (!err.message.includes('already exists')) {
          console.log('  ⚠️  Continuous aggregate skipped:', err.message.substring(0, 80));
        }
      }
    }
  } catch (err) {
    console.log('  ⚠️  TimescaleDB not enabled:', err.message.substring(0, 80));
    console.log('     Running with standard PostgreSQL — all features work.');
  }
}

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW() AS server_time');
    let valkeyStatus = 'disconnected';
    if (valkeyConnected) {
      try { await valkey.ping(); valkeyStatus = 'connected'; } catch { valkeyStatus = 'error'; }
    }
    res.json({
      status: 'ok', server_time: dbResult.rows[0].server_time,
      postgresql: 'connected', timescaledb: timescaleEnabled ? 'enabled' : 'disabled',
      valkey: valkeyStatus, apache_age: ageConnected ? 'connected' : 'disconnected'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// 1️⃣  EVENTS API
// ══════════════════════════════════════════════════════════════

app.get('/api/events', async (req, res) => {
  try {
    const {
      event_type, node_id, asset_id, mission_id,
      min_confidence, since, until,
      limit = 100, offset = 0, sort = 'timestamp', order = 'DESC'
    } = req.query;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (event_type) { conditions.push('event_type = $' + paramIdx++); params.push(event_type); }
    if (node_id)    { conditions.push('node_id = $' + paramIdx++);    params.push(node_id); }
    if (asset_id)   { conditions.push('asset_id = $' + paramIdx++);   params.push(asset_id); }
    if (mission_id) { conditions.push('mission_id = $' + paramIdx++); params.push(mission_id); }
    if (min_confidence) { conditions.push('confidence >= $' + paramIdx++); params.push(parseFloat(min_confidence)); }
    if (since) { conditions.push('timestamp >= $' + paramIdx++); params.push(since); }
    if (until) { conditions.push('timestamp <= $' + paramIdx++); params.push(until); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const validSorts = ['timestamp', 'confidence', 'event_type', 'received_at'];
    const sortCol = validSorts.includes(sort) ? sort : 'timestamp';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = 'SELECT * FROM events ' + where + ' ORDER BY ' + sortCol + ' ' + sortOrder + ' LIMIT $' + paramIdx++ + ' OFFSET $' + paramIdx++;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(sql, params);
    const countResult = await pool.query('SELECT COUNT(*) FROM events ' + where, params.slice(0, conditions.length));

    res.json({
      events: result.rows, total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit), offset: parseInt(offset)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events WHERE event_id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events — Ingest event (dedup via Valkey + DB, audit, broadcast)
app.post('/api/events', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      event_id = uuidv4(), timestamp = new Date().toISOString(),
      event_type, confidence, node_id, asset_id, asset_type,
      mission_id, payload = {}, clip_id = null
    } = req.body;

    // Fast Valkey dedup
    const isDuplicate = await valkeyCheckDedup(event_id);
    if (isDuplicate) {
      await pool.query(
        "INSERT INTO ingest_audit (event_id, node_id, raw_payload, status, reason) VALUES ($1, $2, $3, 'duplicate', 'Valkey dedup hit')",
        [event_id, node_id || 'unknown', JSON.stringify(req.body)]
      );
      return res.status(409).json({ error: 'Duplicate (Valkey)', event_id, status: 'duplicate' });
    }

    await client.query('BEGIN');

    const existing = await client.query('SELECT event_id FROM events WHERE event_id = $1', [event_id]);
    if (existing.rows.length > 0) {
      await client.query("INSERT INTO ingest_audit (event_id, node_id, raw_payload, status, reason) VALUES ($1, $2, $3, 'duplicate', 'event_id in PostgreSQL')", [event_id, node_id, JSON.stringify(req.body)]);
      await client.query('COMMIT');
      return res.status(409).json({ error: 'Duplicate event', event_id, status: 'duplicate' });
    }

    if (!event_type || !node_id || !asset_id || !asset_type) {
      await client.query("INSERT INTO ingest_audit (event_id, node_id, raw_payload, status, reason) VALUES ($1, $2, $3, 'rejected', 'Missing required fields')", [event_id, node_id || 'unknown', JSON.stringify(req.body)]);
      await client.query('COMMIT');
      return res.status(400).json({ error: 'Missing required fields: event_type, node_id, asset_id, asset_type' });
    }

    const result = await client.query(
      'INSERT INTO events (event_id, timestamp, received_at, event_type, confidence, node_id, asset_id, asset_type, mission_id, payload, clip_id) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [event_id, timestamp, event_type, confidence, node_id, asset_id, asset_type, mission_id, JSON.stringify(payload), clip_id]
    );

    await client.query("INSERT INTO ingest_audit (event_id, node_id, raw_payload, status) VALUES ($1, $2, $3, 'accepted')", [event_id, node_id, JSON.stringify(req.body)]);
    await client.query('COMMIT');

    const newEvent = result.rows[0];
    await valkeyPublishEvent(newEvent);
    broadcastToWS({ type: 'event', data: newEvent });

    // Add to graph (non-blocking)
    ageAddEvent(newEvent).catch(() => {});

    res.status(201).json(newEvent);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════════════════
// 2️⃣  INGEST AUDIT API
// ══════════════════════════════════════════════════════════════

app.get('/api/ingest', async (req, res) => {
  try {
    const { status, node_id, event_id, limit = 100, offset = 0 } = req.query;
    const conditions = []; const params = []; let i = 1;
    if (status)   { conditions.push('status = $' + i++);   params.push(status); }
    if (node_id)  { conditions.push('node_id = $' + i++);  params.push(node_id); }
    if (event_id) { conditions.push('event_id = $' + i++); params.push(event_id); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(parseInt(limit), parseInt(offset));
    const result = await pool.query('SELECT * FROM ingest_audit ' + where + ' ORDER BY received_at DESC LIMIT $' + i++ + ' OFFSET $' + i++, params);
    res.json({ audit_logs: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ingest/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT status, COUNT(*) as count, MAX(received_at) as last_received FROM ingest_audit GROUP BY status');
    res.json({ stats: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// 3️⃣  ASSETS API
// ══════════════════════════════════════════════════════════════

app.get('/api/assets', async (req, res) => {
  try {
    const { node_id, asset_type, status } = req.query;
    const conditions = []; const params = []; let i = 1;
    if (node_id)    { conditions.push('node_id = $' + i++);    params.push(node_id); }
    if (asset_type) { conditions.push('asset_type = $' + i++); params.push(asset_type); }
    if (status)     { conditions.push('status = $' + i++);     params.push(status); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query('SELECT * FROM assets ' + where + ' ORDER BY asset_type, asset_id', params);

    const assets = result.rows;
    if (valkeyConnected) {
      for (const asset of assets) {
        try {
          const live = await valkey.hgetall(VK.ASSET_STATUS + asset.asset_id);
          if (live && live.last_event) asset.live = live;
        } catch { }
      }
    }
    res.json({ assets });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/assets/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM assets WHERE asset_id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Asset not found' });
    const asset = result.rows[0];
    if (valkeyConnected) { try { asset.live = await valkey.hgetall(VK.ASSET_STATUS + asset.asset_id); } catch { } }
    res.json(asset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/assets', async (req, res) => {
  try {
    const { asset_id, node_id, asset_type, display_name, capabilities = {}, status = 'online' } = req.body;
    if (!asset_id || !node_id || !asset_type || !display_name) return res.status(400).json({ error: 'Missing required fields' });
    const result = await pool.query('INSERT INTO assets (asset_id, node_id, asset_type, display_name, capabilities, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [asset_id, node_id, asset_type, display_name, JSON.stringify(capabilities), status]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Asset already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/assets/:id', async (req, res) => {
  try {
    const { display_name, capabilities, status, node_id, asset_type } = req.body;
    const sets = []; const params = []; let i = 1;
    if (display_name !== undefined) { sets.push('display_name = $' + i++); params.push(display_name); }
    if (capabilities !== undefined) { sets.push('capabilities = $' + i++); params.push(JSON.stringify(capabilities)); }
    if (status !== undefined)       { sets.push('status = $' + i++);       params.push(status); }
    if (node_id !== undefined)      { sets.push('node_id = $' + i++);      params.push(node_id); }
    if (asset_type !== undefined)   { sets.push('asset_type = $' + i++);   params.push(asset_type); }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id);
    const result = await pool.query('UPDATE assets SET ' + sets.join(', ') + ' WHERE asset_id = $' + i + ' RETURNING *', params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Asset not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/assets/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM assets WHERE asset_id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Asset not found' });
    res.json({ deleted: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// 4️⃣  DASHBOARD STATS API
// ══════════════════════════════════════════════════════════════

app.get('/api/stats', async (req, res) => {
  try {
    const [eventsResult, assetsResult, recentResult, typeResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as total, MAX(timestamp) as latest FROM events'),
      pool.query('SELECT status, COUNT(*) as count FROM assets GROUP BY status'),
      pool.query("SELECT COUNT(*) as count FROM events WHERE timestamp > NOW() - INTERVAL '30 minutes'"),
      pool.query('SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC LIMIT 10')
    ]);
    let valkeyStats = null;
    if (valkeyConnected) { try { valkeyStats = await valkey.hgetall(VK.STATS); } catch { } }
    res.json({
      total_events: parseInt(eventsResult.rows[0].total),
      latest_event: eventsResult.rows[0].latest,
      events_last_30min: parseInt(recentResult.rows[0].count),
      assets_by_status: assetsResult.rows,
      event_types: typeResult.rows,
      timescaledb: timescaleEnabled,
      valkey: valkeyConnected ? valkeyStats : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/timeline', async (req, res) => {
  try {
    const { minutes = 30 } = req.query;
    const result = await pool.query(
      "SELECT event_id, timestamp, event_type, confidence, node_id, asset_id, asset_type, payload->>'reason' as reason, payload->>'class' as detection_class FROM events WHERE timestamp > NOW() - ($1 || ' minutes')::INTERVAL ORDER BY timestamp ASC",
      [parseInt(minutes)]
    );
    res.json({ timeline: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// 5️⃣  VALKEY APIs — Real-time state
// ══════════════════════════════════════════════════════════════

app.get('/api/valkey/status', async (req, res) => {
  if (!valkeyConnected) return res.json({ connected: false, message: 'Valkey not available' });
  try {
    const stats = await valkey.hgetall(VK.STATS);
    const posture = await valkey.hgetall(VK.POSTURE);
    const liveCount = await valkey.llen(VK.LIVE_EVENTS);
    res.json({ connected: true, stats, posture, live_events_cached: liveCount });
  } catch (err) { res.status(500).json({ connected: false, error: err.message }); }
});

app.get('/api/valkey/live', async (req, res) => {
  if (!valkeyConnected) return res.status(503).json({ error: 'Valkey not available — use /api/events' });
  try {
    const { limit = 20 } = req.query;
    const raw = await valkey.lrange(VK.LIVE_EVENTS, 0, parseInt(limit) - 1);
    const events = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    res.json({ events, source: 'valkey_cache' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/valkey/posture', async (req, res) => {
  if (!valkeyConnected) return res.status(503).json({ error: 'Valkey not available' });
  try { res.json(await valkey.hgetall(VK.POSTURE)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/valkey/feedback', async (req, res) => {
  if (!valkeyConnected) return res.status(503).json({ error: 'Valkey not available' });
  try {
    const { action, event_id, operator, notes } = req.body;
    const feedback = { action, event_id, operator: operator || 'op-1', notes: notes || '', timestamp: new Date().toISOString() };
    await valkeyPub.publish(VK.FEEDBACK_CHANNEL, JSON.stringify(feedback));
    if (action === 'acknowledge' || action === 'dismiss') {
      await valkey.hmset(VK.POSTURE, { level: 'NORMAL', confidence: '0', reason: action + ' by ' + feedback.operator, updated_at: new Date().toISOString() });
    }
    res.json({ status: 'published', feedback });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// 6️⃣  TIMESCALEDB APIs — Time-series analytics
// ══════════════════════════════════════════════════════════════

app.get('/api/timescale/status', async (req, res) => {
  try {
    let info = { enabled: timescaleEnabled };
    if (timescaleEnabled) {
      const hypertables = await pool.query("SELECT hypertable_name, num_chunks, compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = 'events'");
      info.hypertable = hypertables.rows[0] || null;
      const chunks = await pool.query("SELECT COUNT(*) as chunk_count FROM timescaledb_information.chunks WHERE hypertable_name = 'events'");
      info.chunks = parseInt(chunks.rows[0].chunk_count);
    }
    res.json(info);
  } catch (err) { res.json({ enabled: timescaleEnabled, error: err.message }); }
});

app.get('/api/timescale/buckets', async (req, res) => {
  try {
    const { interval = '1 minute', hours = 1 } = req.query;
    const validIntervals = ['10 seconds', '30 seconds', '1 minute', '5 minutes', '15 minutes', '1 hour'];
    const safeInterval = validIntervals.includes(interval) ? interval : '1 minute';
    const bucketFn = timescaleEnabled ? "time_bucket('" + safeInterval + "', timestamp)" : "date_trunc('minute', timestamp)";
    const sql = 'SELECT ' + bucketFn + ' AS bucket, event_type, COUNT(*) AS event_count, AVG(confidence)::NUMERIC(4,3) AS avg_confidence, MAX(confidence)::NUMERIC(4,3) AS max_confidence, COUNT(DISTINCT asset_id) AS unique_assets FROM events WHERE timestamp > NOW() - ($1 || \' hours\')::INTERVAL GROUP BY bucket, event_type ORDER BY bucket DESC';
    const result = await pool.query(sql, [parseInt(hours)]);
    res.json({ buckets: result.rows, interval: safeInterval, hours: parseInt(hours), engine: timescaleEnabled ? 'timescaledb' : 'postgresql' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/timescale/confidence', async (req, res) => {
  try {
    const { minutes = 30 } = req.query;
    const bucketFn = timescaleEnabled ? "time_bucket('1 minute', timestamp)" : "date_trunc('minute', timestamp)";
    const result = await pool.query('SELECT ' + bucketFn + ' AS bucket, AVG(confidence)::NUMERIC(4,3) AS avg_confidence, MAX(confidence)::NUMERIC(4,3) AS max_confidence, COUNT(*) AS event_count FROM events WHERE timestamp > NOW() - ($1 || \' minutes\')::INTERVAL AND event_type NOT IN (\'heartbeat\', \'patrol_start\') GROUP BY bucket ORDER BY bucket ASC', [parseInt(minutes)]);
    res.json({ trend: result.rows, engine: timescaleEnabled ? 'timescaledb' : 'postgresql' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// 7️⃣  APACHE AGE — Cross-Mission Context Graph
// ══════════════════════════════════════════════════════════════

let ageConnected = false;
const GRAPH_NAME = 'tactix_mission';

async function ageQuery(cypher, params) {
  if (!ageConnected) throw new Error('AGE not connected');
  const client = await agePool.connect();
  try {
    await client.query("LOAD 'age'");
    await client.query("SET search_path = ag_catalog, public");
    const sql = "SELECT * FROM cypher('" + GRAPH_NAME + "', $$ " + cypher + " $$) as (result agtype)";
    const result = await client.query(sql);
    return result.rows.map(r => {
      try { return JSON.parse(r.result); } catch { return r.result; }
    });
  } finally {
    client.release();
  }
}

async function initAGE() {
  try {
    const client = await agePool.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS age");
    await client.query("LOAD 'age'");
    await client.query("SET search_path = ag_catalog, public");

    // Create graph if not exists
    const exists = await client.query("SELECT * FROM ag_graph WHERE name = $1", [GRAPH_NAME]);
    if (exists.rows.length === 0) {
      await client.query("SELECT create_graph($1)", [GRAPH_NAME]);
    }

    // Create labels (vertex types)
    const labels = ['Asset', 'Mission', 'Zone', 'DetectedObject', 'Event', 'Vehicle', 'Person'];
    for (const label of labels) {
      try {
        await client.query("SELECT create_vlabel('" + GRAPH_NAME + "', '" + label + "')");
      } catch (e) {
        if (!e.message.includes('already exists')) throw e;
      }
    }

    // Create edge labels
    const edges = ['DETECTED_BY', 'BELONGS_TO', 'PART_OF', 'OCCURRED_IN', 'CORROBORATED_BY', 'TRIGGERED', 'SEEN_AT'];
    for (const edge of edges) {
      try {
        await client.query("SELECT create_elabel('" + GRAPH_NAME + "', '" + edge + "')");
      } catch (e) {
        if (!e.message.includes('already exists')) throw e;
      }
    }

    client.release();
    ageConnected = true;
    console.log('  🟢 Apache AGE graph: ' + GRAPH_NAME);

    // Seed graph with assets
    await seedGraphAssets();

  } catch (err) {
    ageConnected = false;
    console.log('  ⚠️  Apache AGE not available:', err.message.substring(0, 80));
    console.log('     Install: docker run -d --name tactix-age -p 5434:5432 -e POSTGRES_USER=tactix -e POSTGRES_PASSWORD=tactix -e POSTGRES_DB=tactix_graph apache/age:PG16_latest');
  }
}

async function seedGraphAssets() {
  if (!ageConnected) return;
  try {
    // Add assets as vertices
    const assets = await pool.query('SELECT * FROM assets');
    for (const a of assets.rows) {
      try {
        await ageQuery("MERGE (n:Asset {id: '" + a.asset_id + "', name: '" + a.display_name + "', type: '" + a.asset_type + "', node_id: '" + a.node_id + "', status: '" + a.status + "'}) RETURN n");
      } catch (e) { }
    }
    // Add zone
    try {
      await ageQuery("MERGE (z:Zone {id: 'zone-b', name: 'Zone B', grid: 'GRID ZONE B'}) RETURN z");
    } catch (e) { }
    console.log('  🟢 Graph seeded with ' + assets.rows.length + ' assets');
  } catch (err) {
    console.error('  Graph seed error:', err.message);
  }
}

// Add event to graph (called on ingest)
async function ageAddEvent(event) {
  if (!ageConnected) return;
  try {
    const eid = event.event_id;
    const etype = event.event_type;
    const conf = event.confidence || 0;
    const aid = event.asset_id;
    const mid = event.mission_id || 'unknown';

    // Create event vertex
    await ageQuery("MERGE (e:Event {id: '" + eid + "', type: '" + etype + "', confidence: " + conf + ", timestamp: '" + (event.timestamp || new Date().toISOString()) + "'}) RETURN e");

    // Link event -> asset (DETECTED_BY)
    await ageQuery("MATCH (e:Event {id: '" + eid + "'}), (a:Asset {id: '" + aid + "'}) MERGE (e)-[:DETECTED_BY]->(a) RETURN e");

    // Create/link mission
    await ageQuery("MERGE (m:Mission {id: '" + mid + "'}) RETURN m");
    await ageQuery("MATCH (e:Event {id: '" + eid + "'}), (m:Mission {id: '" + mid + "'}) MERGE (e)-[:PART_OF]->(m) RETURN e");

    // If detection event, create detected object
    const payload = event.payload || {};
    const objClass = payload.class || null;
    if (objClass) {
      const objId = etype + '-' + eid.substring(0, 8);
      const label = objClass === 'person' ? 'Person' : 'Vehicle';
      await ageQuery("MERGE (o:" + label + " {id: '" + objId + "', class: '" + objClass + "'}) RETURN o");
      await ageQuery("MATCH (e:Event {id: '" + eid + "'}), (o:" + label + " {id: '" + objId + "'}) MERGE (e)-[:TRIGGERED]->(o) RETURN e");
    }

    // If corroborated, link to corroborating assets
    const corr = payload.corroborated_by;
    if (corr && Array.isArray(corr)) {
      for (const corrAsset of corr) {
        await ageQuery("MATCH (e:Event {id: '" + eid + "'}), (a:Asset {id: '" + corrAsset + "'}) MERGE (e)-[:CORROBORATED_BY]->(a) RETURN e");
      }
    }

  } catch (err) {
    // Non-critical — don't break ingest
  }
}

// ── AGE API Endpoints ─────────────────────────────────────────

// GET /api/graph/status
app.get('/api/graph/status', async (req, res) => {
  if (!ageConnected) return res.json({ connected: false, message: 'Apache AGE not available' });
  try {
    const vertices = await ageQuery("MATCH (n) RETURN count(n)");
    const edges = await ageQuery("MATCH ()-[r]->() RETURN count(r)");
    res.json({ connected: true, graph: GRAPH_NAME, vertices: vertices[0], edges: edges[0] });
  } catch (err) {
    res.status(500).json({ connected: true, error: err.message });
  }
});

// GET /api/graph/assets — All asset nodes + connections
app.get('/api/graph/assets', async (req, res) => {
  if (!ageConnected) return res.status(503).json({ error: 'AGE not available' });
  try {
    const nodes = await ageQuery("MATCH (a:Asset) RETURN a");
    res.json({ assets: nodes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/graph/events — Event nodes with relationships
app.get('/api/graph/events', async (req, res) => {
  if (!ageConnected) return res.status(503).json({ error: 'AGE not available' });
  try {
    const { limit = 20 } = req.query;
    const results = await ageQuery("MATCH (e:Event)-[r]->(target) RETURN e, type(r), target ORDER BY e.timestamp DESC LIMIT " + parseInt(limit));
    res.json({ events: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/graph/mission/:id — Full mission subgraph
app.get('/api/graph/mission/:id', async (req, res) => {
  if (!ageConnected) return res.status(503).json({ error: 'AGE not available' });
  try {
    const mid = req.params.id;
    const events = await ageQuery("MATCH (e:Event)-[:PART_OF]->(m:Mission {id: '" + mid + "'}) RETURN e ORDER BY e.timestamp");
    const assets = await ageQuery("MATCH (e:Event)-[:PART_OF]->(m:Mission {id: '" + mid + "'}), (e)-[:DETECTED_BY]->(a:Asset) RETURN DISTINCT a");
    const objects = await ageQuery("MATCH (e:Event)-[:PART_OF]->(m:Mission {id: '" + mid + "'}), (e)-[:TRIGGERED]->(o) RETURN DISTINCT o");
    res.json({ mission: mid, events, assets, detected_objects: objects });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/graph/asset/:id/history — What has this asset detected?
app.get('/api/graph/asset/:id/history', async (req, res) => {
  if (!ageConnected) return res.status(503).json({ error: 'AGE not available' });
  try {
    const aid = req.params.id;
    const events = await ageQuery("MATCH (e:Event)-[:DETECTED_BY]->(a:Asset {id: '" + aid + "'}) RETURN e ORDER BY e.timestamp DESC");
    const objects = await ageQuery("MATCH (e:Event)-[:DETECTED_BY]->(a:Asset {id: '" + aid + "'}), (e)-[:TRIGGERED]->(o) RETURN DISTINCT o");
    res.json({ asset: aid, events, detected_objects: objects });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/graph/correlated/:event_id — What corroborated this event?
app.get('/api/graph/correlated/:id', async (req, res) => {
  if (!ageConnected) return res.status(503).json({ error: 'AGE not available' });
  try {
    const eid = req.params.id;
    const corr = await ageQuery("MATCH (e:Event {id: '" + eid + "'})-[:CORROBORATED_BY]->(a:Asset) RETURN a");
    const related = await ageQuery("MATCH (e:Event {id: '" + eid + "'})-[:TRIGGERED]->(o)<-[:TRIGGERED]-(other:Event) WHERE other.id <> '" + eid + "' RETURN other");
    res.json({ event_id: eid, corroborated_by: corr, related_events: related });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/graph/query — Raw Cypher query (admin/debug)
app.post('/api/graph/query', async (req, res) => {
  if (!ageConnected) return res.status(503).json({ error: 'AGE not available' });
  try {
    const { cypher } = req.body;
    if (!cypher) return res.status(400).json({ error: 'Missing cypher query' });
    const results = await ageQuery(cypher);
    res.json({ results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// WebSocket — Live event stream
// ══════════════════════════════════════════════════════════════

// Forward-declared broadcast (set after WSS init)
let _wsClients = new Set();
function broadcastToWS(data) {
  const msg = JSON.stringify(data);
  _wsClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function broadcastEvent(event) { broadcastToWS({ type: 'event', data: event }); }

const server = app.listen(PORT, async () => {
  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log('  ║     TactixGlobalMCT — Mission Control             ║');
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log('  ║   Dashboard:  http://localhost:' + PORT + '                ║');
  console.log('  ║   Vehicle:    http://localhost:' + PORT + '/vehicle        ║');
  console.log('  ║   API:        http://localhost:' + PORT + '/api            ║');
  console.log('  ║   WebSocket:  ws://localhost:' + PORT + '                  ║');
  console.log('  ╠══════════════════════════════════════════════════╣');
  await initTimescale();
  await initValkey();
  await initAGE();
  // Vehicle Node (Edge SQLite)
  const vnOk = vehicleNode.initDB();
  if (vnOk) {
    vehicleNode.registerVehicleRoutes(app, broadcastToWS);
  }
  console.log('  ╚══════════════════════════════════════════════════╝\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  _wsClients.add(ws);
  console.log('  🟢 WebSocket client connected (total: ' + _wsClients.size + ')');
  ws.on('close', () => { _wsClients.delete(ws); console.log('  🔴 WebSocket disconnected (total: ' + _wsClients.size + ')'); });
  ws.send(JSON.stringify({ type: 'connected', message: 'TactixGlobalMCT live stream active', valkey: valkeyConnected, timescaledb: timescaleEnabled, apache_age: ageConnected }));
  // Send current Jetson detection counts immediately
  if (jetsonState.connected) {
    ws.send(JSON.stringify({ type: 'detection_counts', data: jetsonState.counts }));
    ws.send(JSON.stringify({ type: 'jetson_status', data: { connected: true, topics: jetsonState.topics } }));
  }
});

// ═══════════════════════════════════════════════════════
// JETSON BRIDGE — Connect to Jetson's own API
// HTTP: GET /all → all topic values as JSON
// WS:   ws://<host>/ws → real-time topic updates
// ═══════════════════════════════════════════════════════
const JETSON_URL = process.env.JETSON_URL || 'http://192.168.0.133:9090';
const JETSON_WS_URL = JETSON_URL.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';
const WebSocket = require('ws');

// Bridge is auto-disabled when no real Jetson is present: either set
// JETSON_ENABLED=false, or point JETSON_URL at the dead :0 sentinel
// (as docker-compose does by default). Keeps logs clean.
const JETSON_ENABLED = (process.env.JETSON_ENABLED || 'true').toLowerCase() !== 'false'
  && !/:0(\/|$)/.test(JETSON_URL);

const jetsonState = {
  connected: false,
  wsConnected: false,
  counts: { persons: 0, vehicles: 0, plates: 0, total: 0, lastUpdate: null },
  prevCounts: { persons: -1, vehicles: -1, plates: -1 },  // For change detection
  topics: {},
  rawIds: {},
};

let jetsonWs = null;
let lastLogTime = 0;
const LOG_DEBOUNCE_MS = 2000;  // Don't log more often than every 2 seconds

// ─── Auto-log detection changes to PostgreSQL ───
async function logDetectionChange(counts, source) {
  const now = Date.now();
  if (now - lastLogTime < LOG_DEBOUNCE_MS) return;
  lastLogTime = now;

  const timestamp = new Date().toISOString();
  const prev = jetsonState.prevCounts;

  try {
    // Log person count change
    if (counts.persons !== prev.persons && counts.persons >= 0) {
      const eid = uuidv4();
      await pool.query(
        'INSERT INTO events (event_id, timestamp, received_at, event_type, confidence, node_id, asset_id, asset_type, mission_id, payload) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9)',
        [eid, timestamp, 'person_detected', 0.9, 'jetson-01', 'sentry-1', 'ptz', 'patrol-001',
         JSON.stringify({ count: counts.persons, prev_count: prev.persons, source })]
      );
      broadcastToWS({ type: 'event', data: {
        event_id: eid, timestamp, event_type: 'person_detected', confidence: 0.9,
        asset_id: 'sentry-1', asset_type: 'ptz', node_id: 'jetson-01',
        payload: { count: counts.persons, prev_count: prev.persons, source }
      }});
    }

    // Log vehicle count change
    if (counts.vehicles !== prev.vehicles && counts.vehicles >= 0) {
      const eid = uuidv4();
      await pool.query(
        'INSERT INTO events (event_id, timestamp, received_at, event_type, confidence, node_id, asset_id, asset_type, mission_id, payload) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9)',
        [eid, timestamp, 'vehicle_detected', 0.9, 'jetson-01', 'sentry-1', 'ptz', 'patrol-001',
         JSON.stringify({ count: counts.vehicles, prev_count: prev.vehicles, source })]
      );
      broadcastToWS({ type: 'event', data: {
        event_id: eid, timestamp, event_type: 'vehicle_detected', confidence: 0.9,
        asset_id: 'sentry-1', asset_type: 'ptz', node_id: 'jetson-01',
        payload: { count: counts.vehicles, prev_count: prev.vehicles, source }
      }});
    }

    // Log plate count change
    if (counts.plates !== prev.plates && counts.plates > 0) {
      const eid = uuidv4();
      await pool.query(
        'INSERT INTO events (event_id, timestamp, received_at, event_type, confidence, node_id, asset_id, asset_type, mission_id, payload) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9)',
        [eid, timestamp, 'license_plate_detected', 0.7, 'jetson-01', 'sentry-1', 'ptz', 'patrol-001',
         JSON.stringify({ count: counts.plates, prev_count: prev.plates, source })]
      );
      broadcastToWS({ type: 'event', data: {
        event_id: eid, timestamp, event_type: 'license_plate_detected', confidence: 0.7,
        asset_id: 'sentry-1', asset_type: 'ptz', node_id: 'jetson-01',
        payload: { count: counts.plates, prev_count: prev.plates, source }
      }});
    }

    // Update prev counts
    jetsonState.prevCounts = { persons: counts.persons, vehicles: counts.vehicles, plates: counts.plates };

  } catch (e) {
    console.log('  ⚠️  Failed to log detection:', e.message);
  }
}

// ─── WebSocket: real-time updates from Jetson ───
function connectJetsonWS() {
  if (jetsonWs && jetsonWs.readyState === WebSocket.OPEN) return;
  console.log('  🔌 Connecting to Jetson WS:', JETSON_WS_URL);

  try {
    jetsonWs = new WebSocket(JETSON_WS_URL);

    jetsonWs.on('open', () => {
      console.log('  ✅ Jetson WebSocket CONNECTED');
      jetsonState.wsConnected = true;
      jetsonState.connected = true;
      broadcastToWS({ type: 'jetson_status', data: { connected: true } });
    });

    jetsonWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'topic_update') {
          const topic = msg.topic;
          const data = msg.data;

          // Store raw topic value
          jetsonState.topics[topic] = data;
          jetsonState.connected = true;

          // Extract counts from known topics
          let changed = false;

          if (topic === '/awareness/person_count') {
            const v = data.value ?? data;
            if (jetsonState.counts.persons !== v) {
              jetsonState.counts.persons = typeof v === 'number' ? v : parseInt(v) || 0;
              changed = true;
            }
          } else if (topic === '/awareness/vehicle_count') {
            const v = data.value ?? data;
            if (jetsonState.counts.vehicles !== v) {
              jetsonState.counts.vehicles = typeof v === 'number' ? v : parseInt(v) || 0;
              changed = true;
            }
          } else if (topic === '/awareness/plate_count' || topic === '/awareness/lp_count') {
            const v = data.value ?? data;
            if (jetsonState.counts.plates !== v) {
              jetsonState.counts.plates = typeof v === 'number' ? v : parseInt(v) || 0;
              changed = true;
            }
          }

          if (changed) {
            jetsonState.counts.total = jetsonState.counts.persons + jetsonState.counts.vehicles + jetsonState.counts.plates;
            jetsonState.counts.lastUpdate = new Date().toISOString();
            broadcastToWS({ type: 'detection_counts', data: jetsonState.counts });
            logDetectionChange(jetsonState.counts, 'jetson_ws');
          }
        }
      } catch (e) { /* ignore parse errors */ }
    });

    jetsonWs.on('close', () => {
      console.log('  ❌ Jetson WS disconnected, reconnecting in 3s...');
      jetsonState.wsConnected = false;
      setTimeout(connectJetsonWS, 3000);
    });

    jetsonWs.on('error', (err) => {
      console.log('  ⚠️  Jetson WS error:', err.message);
      jetsonState.wsConnected = false;
    });
  } catch (e) {
    console.log('  ⚠️  Jetson WS failed:', e.message);
    setTimeout(connectJetsonWS, 5000);
  }
}

// ─── HTTP: poll /all for all topic values (fallback + initial load) ───
async function pollJetsonAll() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(JETSON_URL + '/all', { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) return;

    const data = await r.json();
    const topics = data.topics || {};
    jetsonState.topics = topics;
    jetsonState.connected = true;

    // Extract person count
    let persons = 0, vehicles = 0, plates = 0;

    // Person count from /awareness/person_count
    if (topics['/awareness/person_count'] !== undefined) {
      const val = topics['/awareness/person_count'];
      persons = typeof val === 'object' ? (val.value ?? 0) : (parseInt(val) || 0);
    }

    // Vehicle count — try common topic names
    const vehicleTopics = ['/awareness/vehicle_count', '/awareness/vehicles', '/awareness/car_count'];
    for (const t of vehicleTopics) {
      if (topics[t] !== undefined) {
        const val = topics[t];
        vehicles = typeof val === 'object' ? (val.value ?? 0) : (parseInt(val) || 0);
        break;
      }
    }

    // Plate count
    const plateTopics = ['/awareness/plate_count', '/awareness/lp_count', '/awareness/plates'];
    for (const t of plateTopics) {
      if (topics[t] !== undefined) {
        const val = topics[t];
        plates = typeof val === 'object' ? (val.value ?? 0) : (parseInt(val) || 0);
        break;
      }
    }

    const changed = (
      jetsonState.counts.persons !== persons ||
      jetsonState.counts.vehicles !== vehicles ||
      jetsonState.counts.plates !== plates
    );

    jetsonState.counts = {
      persons, vehicles, plates,
      total: persons + vehicles + plates,
      lastUpdate: new Date().toISOString(),
    };

    if (changed) {
      broadcastToWS({ type: 'detection_counts', data: jetsonState.counts });
      logDetectionChange(jetsonState.counts, 'jetson_http');
    }

    // Build rawIds for debug
    jetsonState.rawIds = {};
    for (const [topic, val] of Object.entries(topics)) {
      jetsonState.rawIds[topic] = typeof val === 'object' ? JSON.stringify(val) : String(val);
    }
  } catch {
    if (jetsonState.connected) {
      jetsonState.connected = false;
      console.log('  ⚠️  Jetson /all unreachable');
    }
  }
}

// API endpoints
app.get('/api/jetson/topics', (req, res) => {
  res.json({
    connected: jetsonState.connected,
    ws_connected: jetsonState.wsConnected,
    jetson_url: JETSON_URL,
    jetson_ws: JETSON_WS_URL,
    counts: jetsonState.counts,
    all_topics: jetsonState.rawIds,
  });
});

app.get('/api/jetson/counts', (req, res) => {
  res.json(jetsonState.counts);
});

// ═══════════════════════════════════════════════════════
// WHISPER PROXY — Forward audio to local whisper_server.py
// ═══════════════════════════════════════════════════════
const WHISPER_URL = process.env.WHISPER_URL || 'http://localhost:9200';

app.post('/api/transcribe', async (req, res) => {
  try {
    // Collect raw body
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    // Forward to whisper server
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
    const whisperRes = await fetch(WHISPER_URL + '/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: audioBuffer,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!whisperRes.ok) {
      const err = await whisperRes.text();
      return res.status(whisperRes.status).json({ error: 'Whisper error: ' + err });
    }

    const result = await whisperRes.json();
    console.log('  🎤 Whisper:', result.text, '(' + result.processing_time + 's)');
    res.json(result);
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'Whisper server timeout (30s)' });
    }
    res.status(502).json({ error: 'Whisper server not available. Run: python whisper_server.py', detail: e.message });
  }
});

app.get('/api/whisper/health', async (req, res) => {
  try {
    const r = await fetch(WHISPER_URL + '/health', { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    res.json({ available: true, ...data });
  } catch {
    res.json({ available: false, message: 'Whisper server not running. Run: python whisper_server.py' });
  }
});

// Start: connect WS + poll /all every second (only if a Jetson is configured)
if (JETSON_ENABLED) {
  connectJetsonWS();
  pollJetsonAll();
  setInterval(pollJetsonAll, 1000);
  console.log('  🔄 Jetson bridge started (' + JETSON_URL + '/all + ' + JETSON_WS_URL + ')');
} else {
  console.log('  ⏸️  Jetson bridge disabled (no JETSON_URL configured) — set JETSON_URL to enable live counts');
}

process.on('SIGINT', async () => {
  console.log('\n  Shutting down...');
  if (valkeyConnected) { try { await valkeySub.unsubscribe(); await valkey.quit(); await valkeyPub.quit(); await valkeySub.quit(); } catch { } }
  await pool.end();
  await agePool.end();
  process.exit(0);
});