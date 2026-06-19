/**
 * TactixGlobalMCT — Vehicle Node (Edge Module)
 * 
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  SQLite           →  Local event + image storage (offline-first) │
 * │  Disk Storage     →  Detection snapshots (JPEG)                  │
 * │  Valkey Sync      →  Store-and-forward to Control Room           │
 * └──────────────────────────────────────────────────────────────────┘
 * 
 * Vehicle API (under /api/vehicle/...):
 *   POST   /api/vehicle/detect      — Save detection + image
 *   GET    /api/vehicle/events       — Query local events
 *   GET    /api/vehicle/events/:id   — Single event + image path
 *   GET    /api/vehicle/images/:id   — Serve detection image
 *   GET    /api/vehicle/stats        — Detection summary
 *   GET    /api/vehicle/sync/status  — Sync queue status
 *   POST   /api/vehicle/sync/flush   — Force sync to CR
 *   POST   /api/vehicle/sync/config  — Set CR address
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Paths ────────────────────────────────────────────────────────
const DATA_DIR = process.env.VN_DATA_DIR || path.join(process.cwd(), 'vehicle_data');
const IMG_DIR = path.join(DATA_DIR, 'images');
const DB_PATH = path.join(DATA_DIR, 'vehicle.db');

// Create directories
fs.mkdirSync(IMG_DIR, { recursive: true });

// ── SQLite ───────────────────────────────────────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.log('  ⚠️  better-sqlite3 not installed. Run: npm install better-sqlite3');
  console.log('     Vehicle Node SQLite features disabled.');
}

let db = null;

function initDB() {
  if (!Database) return false;

  db = new Database(DB_PATH, { verbose: null });
  db.pragma('journal_mode = WAL');       // Fast concurrent reads
  db.pragma('synchronous = NORMAL');      // Balance speed/safety
  db.pragma('cache_size = -64000');       // 64MB cache
  db.pragma('foreign_keys = ON');

  // ── Schema ──────────────────────────────────────────────
  db.exec(`
    -- Detection events
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      timestamp   TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      confidence  REAL DEFAULT 0,
      asset_id    TEXT DEFAULT 'sentry-1',
      asset_type  TEXT DEFAULT 'ptz',
      node_id     TEXT DEFAULT 'veh-01',
      mission_id  TEXT DEFAULT 'patrol-001',
      operator_id TEXT,
      payload     TEXT,          -- JSON
      image_id    TEXT,          -- FK to images
      synced      INTEGER DEFAULT 0,  -- 0=pending, 1=synced to CR
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- Detection images/snapshots
    CREATE TABLE IF NOT EXISTS images (
      id          TEXT PRIMARY KEY,
      event_id    TEXT,
      filename    TEXT NOT NULL,
      filepath    TEXT NOT NULL,
      size_bytes  INTEGER DEFAULT 0,
      width       INTEGER,
      height      INTEGER,
      mime_type   TEXT DEFAULT 'image/jpeg',
      created_at  TEXT DEFAULT (datetime('now')),
      synced      INTEGER DEFAULT 0
    );

    -- Persons tracking (re-ID)
    CREATE TABLE IF NOT EXISTS persons (
      id          TEXT PRIMARY KEY,
      track_id    TEXT,
      first_seen  TEXT,
      last_seen   TEXT,
      total_detections INTEGER DEFAULT 1,
      best_confidence  REAL DEFAULT 0,
      best_image_id    TEXT,
      metadata    TEXT  -- JSON
    );

    -- License plates
    CREATE TABLE IF NOT EXISTS plates (
      id          TEXT PRIMARY KEY,
      plate_text  TEXT NOT NULL UNIQUE,
      confidence  REAL DEFAULT 0,
      first_seen  TEXT,
      last_seen   TEXT,
      total_sightings INTEGER DEFAULT 1,
      image_id    TEXT,
      flagged     INTEGER DEFAULT 0,
      metadata    TEXT
    );

    -- Sync log
    CREATE TABLE IF NOT EXISTS sync_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      synced_at   TEXT DEFAULT (datetime('now')),
      events_sent INTEGER DEFAULT 0,
      images_sent INTEGER DEFAULT 0,
      cr_address  TEXT,
      status      TEXT DEFAULT 'ok',
      error       TEXT
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_synced ON events(synced);
    CREATE INDEX IF NOT EXISTS idx_events_asset ON events(asset_id);
    CREATE INDEX IF NOT EXISTS idx_images_synced ON images(synced);
    CREATE INDEX IF NOT EXISTS idx_plates_text ON plates(plate_text);
  `);

  // Prepared statements
  db._stmts = {
    insertEvent: db.prepare(`
      INSERT INTO events (id, timestamp, event_type, confidence, asset_id, asset_type, node_id, mission_id, operator_id, payload, image_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertImage: db.prepare(`
      INSERT INTO images (id, event_id, filename, filepath, size_bytes, width, height, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getEvents: db.prepare(`
      SELECT e.*, i.filename as image_file FROM events e
      LEFT JOIN images i ON e.image_id = i.id
      ORDER BY e.timestamp DESC LIMIT ?
    `),
    getEventsByType: db.prepare(`
      SELECT e.*, i.filename as image_file FROM events e
      LEFT JOIN images i ON e.image_id = i.id
      WHERE e.event_type = ? ORDER BY e.timestamp DESC LIMIT ?
    `),
    getEvent: db.prepare(`
      SELECT e.*, i.filename as image_file, i.filepath as image_path FROM events e
      LEFT JOIN images i ON e.image_id = i.id
      WHERE e.id = ?
    `),
    getUnsynced: db.prepare(`
      SELECT e.*, i.filename as image_file, i.filepath as image_path FROM events e
      LEFT JOIN images i ON e.image_id = i.id
      WHERE e.synced = 0 ORDER BY e.timestamp ASC LIMIT ?
    `),
    getUnsyncedImages: db.prepare(`
      SELECT * FROM images WHERE synced = 0 LIMIT ?
    `),
    markSynced: db.prepare(`UPDATE events SET synced = 1 WHERE id = ?`),
    markImageSynced: db.prepare(`UPDATE images SET synced = 1 WHERE id = ?`),
    upsertPlate: db.prepare(`
      INSERT INTO plates (id, plate_text, confidence, first_seen, last_seen, image_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(plate_text) DO UPDATE SET
        last_seen = excluded.last_seen,
        total_sightings = total_sightings + 1,
        confidence = MAX(confidence, excluded.confidence),
        image_id = CASE WHEN excluded.confidence > confidence THEN excluded.image_id ELSE image_id END
    `),
    getPlates: db.prepare(`SELECT * FROM plates ORDER BY last_seen DESC LIMIT ?`),
    stats: db.prepare(`
      SELECT
        COUNT(*) as total_events,
        SUM(CASE WHEN event_type = 'person_detected' THEN 1 ELSE 0 END) as persons,
        SUM(CASE WHEN event_type IN ('vehicle_detected','suspicious_vehicle') THEN 1 ELSE 0 END) as vehicles,
        SUM(CASE WHEN event_type = 'license_plate_detected' THEN 1 ELSE 0 END) as plates,
        SUM(CASE WHEN event_type = 'thermal_anomaly' THEN 1 ELSE 0 END) as thermal,
        SUM(CASE WHEN synced = 0 THEN 1 ELSE 0 END) as unsynced
      FROM events
    `),
    imageStats: db.prepare(`
      SELECT COUNT(*) as total, SUM(size_bytes) as total_bytes, SUM(CASE WHEN synced = 0 THEN 1 ELSE 0 END) as unsynced
      FROM images
    `),
  };

  const count = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  console.log(`  📦 Vehicle SQLite ready: ${DB_PATH} (${count} events)`);
  return true;
}

// ── Save Detection + Image ───────────────────────────────────────

function saveDetection(eventData, imageBase64) {
  if (!db) return null;

  const eventId = eventData.id || crypto.randomUUID();
  let imageId = null;

  // Save image if provided
  if (imageBase64) {
    imageId = crypto.randomUUID();
    const ext = 'jpg';
    const filename = `${eventData.event_type}_${Date.now()}.${ext}`;
    const filepath = path.join(IMG_DIR, filename);

    // Decode base64 and write
    const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    fs.writeFileSync(filepath, buffer);

    db._stmts.insertImage.run(
      imageId, eventId, filename, filepath,
      buffer.length, null, null, 'image/jpeg'
    );
  }

  // Save event
  db._stmts.insertEvent.run(
    eventId,
    eventData.timestamp || new Date().toISOString(),
    eventData.event_type,
    eventData.confidence || 0,
    eventData.asset_id || 'sentry-1',
    eventData.asset_type || 'ptz',
    eventData.node_id || 'veh-01',
    eventData.mission_id || 'patrol-001',
    eventData.operator_id || null,
    JSON.stringify(eventData.payload || {}),
    imageId
  );

  // Track plates
  if (eventData.event_type === 'license_plate_detected' && eventData.payload?.plate) {
    const now = new Date().toISOString();
    db._stmts.upsertPlate.run(
      crypto.randomUUID(),
      eventData.payload.plate,
      eventData.confidence || 0,
      now, now, imageId
    );
  }

  return { id: eventId, image_id: imageId };
}

// ── Sync Agent (Store-and-Forward to CR) ─────────────────────────

let crAddress = '';
let syncInterval = null;
let syncStats = { lastSync: null, totalSent: 0, errors: 0 };

async function syncToCR(maxEvents = 20) {
  if (!db || !crAddress) return { sent: 0, error: 'No CR address' };

  const unsyncedEvents = db._stmts.getUnsynced.all(maxEvents);
  if (unsyncedEvents.length === 0) return { sent: 0 };

  let sent = 0;
  const errors = [];

  for (const evt of unsyncedEvents) {
    try {
      const eventPayload = {
        id: evt.id,
        timestamp: evt.timestamp,
        event_type: evt.event_type,
        confidence: evt.confidence,
        asset_id: evt.asset_id,
        asset_type: evt.asset_type,
        node_id: evt.node_id,
        mission_id: evt.mission_id,
        operator_id: evt.operator_id,
        payload: JSON.parse(evt.payload || '{}'),
        source: 'vehicle_node',
      };

      // Send event to CR
      const resp = await fetch(`${crAddress}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventPayload),
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok) {
        db._stmts.markSynced.run(evt.id);
        sent++;

        // Sync image if exists
        if (evt.image_path && fs.existsSync(evt.image_path)) {
          try {
            const imgData = fs.readFileSync(evt.image_path);
            const imgB64 = imgData.toString('base64');
            await fetch(`${crAddress}/api/vehicle/image`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event_id: evt.id,
                filename: evt.image_file,
                data: imgB64,
              }),
              signal: AbortSignal.timeout(10000),
            });
            if (evt.image_id) db._stmts.markImageSynced.run(evt.image_id);
          } catch (imgErr) {
            // Image sync failed — will retry next cycle
          }
        }
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  syncStats.totalSent += sent;
  syncStats.lastSync = new Date().toISOString();
  if (errors.length) syncStats.errors += errors.length;

  // Log sync
  try {
    db.prepare(`INSERT INTO sync_log (events_sent, images_sent, cr_address, status, error) VALUES (?, 0, ?, ?, ?)`)
      .run(sent, crAddress, errors.length ? 'partial' : 'ok', errors.join('; ') || null);
  } catch (e) {}

  return { sent, total: unsyncedEvents.length, errors };
}

function startSyncAgent(intervalMs = 15000) {
  stopSyncAgent();
  syncInterval = setInterval(async () => {
    if (crAddress) {
      const result = await syncToCR();
      if (result.sent > 0) {
        console.log(`  🔄 Synced ${result.sent}/${result.total} events to CR`);
      }
    }
  }, intervalMs);
  console.log(`  🔄 Sync agent started (every ${intervalMs / 1000}s)`);
}

function stopSyncAgent() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

// ── Register Routes ──────────────────────────────────────────────

function registerVehicleRoutes(app, wsBroadcast) {

  // POST /api/vehicle/detect — Main detection ingest with image
  app.post('/api/vehicle/detect', (req, res) => {
    if (!db) return res.status(503).json({ error: 'SQLite not initialized' });

    const { event, image } = req.body;
    if (!event || !event.event_type) {
      return res.status(400).json({ error: 'event.event_type required' });
    }

    const result = saveDetection(event, image || null);
    if (!result) return res.status(500).json({ error: 'Save failed' });

    // Broadcast via WebSocket for live dashboard
    if (wsBroadcast) {
      wsBroadcast({
        type: 'event',
        data: { ...event, id: result.id, image_id: result.image_id },
      });
    }

    res.json({ ok: true, ...result });
  });

  // GET /api/vehicle/events
  app.get('/api/vehicle/events', (req, res) => {
    if (!db) return res.status(503).json({ error: 'SQLite not initialized' });

    const limit = parseInt(req.query.limit) || 50;
    const type = req.query.type;

    let rows;
    if (type) {
      rows = db._stmts.getEventsByType.all(type, limit);
    } else {
      rows = db._stmts.getEvents.all(limit);
    }

    const events = rows.map(r => ({
      ...r,
      payload: JSON.parse(r.payload || '{}'),
      image_url: r.image_file ? `/api/vehicle/images/${r.image_file}` : null,
    }));

    res.json({ events, count: events.length });
  });

  // GET /api/vehicle/events/:id
  app.get('/api/vehicle/events/:id', (req, res) => {
    if (!db) return res.status(503).json({ error: 'SQLite not initialized' });

    const row = db._stmts.getEvent.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    res.json({
      ...row,
      payload: JSON.parse(row.payload || '{}'),
      image_url: row.image_file ? `/api/vehicle/images/${row.image_file}` : null,
    });
  });

  // GET /api/vehicle/images/:filename — Serve detection images
  app.get('/api/vehicle/images/:filename', (req, res) => {
    const filepath = path.join(IMG_DIR, req.params.filename);
    if (!fs.existsSync(filepath)) return res.status(404).send('Image not found');
    res.sendFile(filepath);
  });

  // GET /api/vehicle/stats
  app.get('/api/vehicle/stats', (req, res) => {
    if (!db) return res.status(503).json({ error: 'SQLite not initialized' });

    const stats = db._stmts.stats.get();
    const imgStats = db._stmts.imageStats.get();

    res.json({
      events: stats,
      images: {
        total: imgStats.total,
        size_mb: Math.round((imgStats.total_bytes || 0) / 1024 / 1024 * 100) / 100,
        unsynced: imgStats.unsynced,
      },
      sync: {
        cr_address: crAddress || null,
        connected: !!crAddress,
        last_sync: syncStats.lastSync,
        total_sent: syncStats.totalSent,
        queue_size: stats.unsynced,
      },
    });
  });

  // GET /api/vehicle/plates — All detected plates
  app.get('/api/vehicle/plates', (req, res) => {
    if (!db) return res.status(503).json({ error: 'SQLite not initialized' });
    const limit = parseInt(req.query.limit) || 50;
    const plates = db._stmts.getPlates.all(limit);
    res.json({ plates, count: plates.length });
  });

  // ── Sync endpoints ──────────────────────────────────────

  // GET /api/vehicle/sync/status
  app.get('/api/vehicle/sync/status', (req, res) => {
    if (!db) return res.status(503).json({ error: 'SQLite not initialized' });

    const stats = db._stmts.stats.get();
    const imgStats = db._stmts.imageStats.get();

    res.json({
      cr_address: crAddress || null,
      connected: !!crAddress,
      last_sync: syncStats.lastSync,
      total_sent: syncStats.totalSent,
      errors: syncStats.errors,
      queue: {
        events: stats.unsynced,
        images: imgStats.unsynced,
      },
    });
  });

  // POST /api/vehicle/sync/config — Set CR address
  app.post('/api/vehicle/sync/config', (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'address required' });
    crAddress = address.replace(/\/+$/, '');
    console.log(`  🔗 CR address set: ${crAddress}`);
    startSyncAgent();
    res.json({ ok: true, cr_address: crAddress });
  });

  // POST /api/vehicle/sync/flush — Force sync now
  app.post('/api/vehicle/sync/flush', async (req, res) => {
    if (!crAddress) return res.json({ error: 'No CR address configured' });
    const result = await syncToCR(50);
    res.json({ ok: true, ...result });
  });

  // POST /api/vehicle/image — CR receives images from vehicle (for CR-side)
  app.post('/api/vehicle/image', (req, res) => {
    const { event_id, filename, data } = req.body;
    if (!data || !filename) return res.status(400).json({ error: 'filename and data required' });

    const dir = path.join(DATA_DIR, 'received_images');
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(filepath, buffer);

    res.json({ ok: true, event_id, filepath });
  });

  // Serve received images (CR side)
  app.use('/api/vehicle/received', require('express').static(path.join(DATA_DIR, 'received_images')));

  console.log(`  📦 Vehicle Node routes registered`);
  console.log(`  📁 Data dir: ${DATA_DIR}`);
  console.log(`  🖼️  Images: ${IMG_DIR}`);
}

module.exports = {
  initDB,
  registerVehicleRoutes,
  saveDetection,
  syncToCR,
  startSyncAgent,
  stopSyncAgent,
  DATA_DIR,
  IMG_DIR,
};