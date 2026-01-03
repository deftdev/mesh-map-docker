import express from 'express';
import Database from 'better-sqlite3';
import cors from 'cors';
import bodyParser from 'body-parser';
import { geohash8, geohash6, parseLocation, ageInDays, truncateTime, definedOr, pushMap } from './content/shared.js';

const app = express();
const port = 3000;
const dbPath = process.env.DB_PATH || '/data/mesh.db';

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('.'));

// Initialize Database
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Simple elevation mock/proxy
async function getElevation(lat, lon) {
    try {
        const apiUrl = `https://api.opentopodata.org/v1/ned10m?locations=${lat},${lon}`;
        const resp = await fetch(apiUrl);
        const data = await resp.json();
        return data.results[0].elevation;
    } catch (e) {
        console.log(`Error getting elevation for [${lat},${lon}]. ${e}`);
        return null;
    }
}

// --- Database Schema Initialization ---

db.prepare(`
CREATE TABLE IF NOT EXISTS samples (
  hash TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  rssi REAL CHECK (rssi IS NULL OR typeof(rssi) = 'real'),
  snr  REAL CHECK (snr  IS NULL OR typeof(snr)  = 'real'),
  observed  INTEGER NOT NULL DEFAULT 0 CHECK (observed IN (0, 1)),
  repeaters TEXT NOT NULL DEFAULT '[]'
);
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_samples_time ON samples(time);`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS sample_archive (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  time INTEGER NOT NULL,
  data TEXT NOT NULL
);
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS repeaters (
  id TEXT NOT NULL,
  hash TEXT NOT NULL,
  time INTEGER NOT NULL,
  name TEXT NOT NULL,
  elevation REAL CHECK (elevation IS NULL OR typeof(elevation) = 'real'),
  PRIMARY KEY (id, hash)
);
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_repeaters_time ON repeaters(time);`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS coverage (
  hash TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  lastObserved INTEGER NOT NULL DEFAULT 0,
  lastHeard INTEGER NOT NULL DEFAULT 0,
  observed INTEGER NOT NULL DEFAULT 0,
  heard INTEGER NOT NULL DEFAULT 0,
  lost INTEGER NOT NULL DEFAULT 0,
  rssi REAL CHECK (rssi IS NULL OR typeof(rssi) = 'real'),
  snr  REAL CHECK (snr  IS NULL OR typeof(snr)  = 'real'),
  repeaters TEXT NOT NULL DEFAULT '[]',
  entries TEXT NOT NULL DEFAULT '[]'
);
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_coverage_time ON coverage(time);`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS senders (
  hash TEXT NOT NULL,
  name TEXT NOT NULL,
  time INTEGER NOT NULL,
  PRIMARY KEY (hash, name, time)
);
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_senders_hash ON senders(hash);`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_senders_name ON senders(name);`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_senders_time ON senders(time);`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS rx_samples (
  hash TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  samples TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(samples) AND json_type(samples)='array')
);
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_rx_samples_time ON rx_samples(time);`).run();


// --- Helper Functions ---

function addCoverageItem(map, id, observed, heard, time) {
    const value = {
        o: observed ? 1 : 0,
        h: heard ? 1 : 0,
        a: Math.round(ageInDays(time) * 10) / 10
    };
    const prevValue = map.get(id);

    // If the id doesn't exist, add it.
    if (!prevValue) {
        map.set(id, value);
        return;
    }

    // Update the previous entry in-place.
    prevValue.o = Math.max(value.o, prevValue.o);
    prevValue.h = Math.max(value.h, prevValue.h);
    prevValue.a = Math.min(value.a, prevValue.a);
}


// --- API Endpoints ---

// POST /put-sample
app.post('/put-sample', async (req, res) => {
    try {
        const data = req.body;
        const [lat, lon] = parseLocation(data.lat, data.lon);
        const hash = geohash8(lat, lon);
        const time = Date.now();
        const rssi = data.rssi ?? null;
        const snr = data.snr ?? null;
        const path = (data.path ?? []).map(p => p.toLowerCase());
        const observed = data.observed ?? false;
        const sender = data.sender ?? null;

        const stmt = db.prepare(`
          INSERT INTO samples (hash, time, rssi, snr, observed, repeaters)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(hash) DO UPDATE SET
            time = excluded.time,
            rssi = CASE
              WHEN samples.rssi IS NULL THEN excluded.rssi
              WHEN excluded.rssi IS NULL THEN samples.rssi
              ELSE MAX(samples.rssi, excluded.rssi)
            END,
            snr = CASE
              WHEN samples.snr IS NULL THEN excluded.snr
              WHEN excluded.snr IS NULL THEN samples.snr
              ELSE MAX(samples.snr, excluded.snr)
            END,
            observed = MAX(samples.observed, excluded.observed),
            repeaters = (
              SELECT json_group_array(value) FROM (
                SELECT value FROM json_each(samples.repeaters)
                UNION
                SELECT value FROM json_each(excluded.repeaters)
              )
            )
        `);

        stmt.run(hash, time, rssi, snr, observed ? 1 : 0, JSON.stringify(path));

        if (sender) {
            const todayStart = (new Date()).setHours(0, 0, 0, 0);
            db.prepare("INSERT OR IGNORE INTO senders (hash, name, time) VALUES (?, ?, ?)")
                .run(geohash6(lat, lon), sender.substring(0, 32), todayStart);
        }

        res.send('OK');
    } catch (e) {
        console.error(e);
        res.status(500).send(e.toString());
    }
});

// POST /put-repeater
app.post('/put-repeater', async (req, res) => {
    try {
        const data = req.body;
        const [lat, lon] = parseLocation(data.lat, data.lon);
        const hash = geohash8(lat, lon);
        const time = Date.now();
        const id = data.id.toLowerCase();
        const name = data.name;
        let elevation = data.elevation ?? null;

        if (elevation === null) {
            const row = db.prepare("SELECT elevation FROM repeaters WHERE id = ? AND hash = ?")
                .get(id, hash);
            elevation = row?.elevation ?? await getElevation(lat, lon);
        }

        db.prepare(`
          INSERT OR REPLACE INTO repeaters
            (id, hash, time, name, elevation)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, hash, time, name, elevation);

        res.send('OK');
    } catch (e) {
        console.error(e);
        res.status(500).send(e.toString());
    }
});

// GET /get-wardrive-coverage
app.get('/get-wardrive-coverage', async (req, res) => {
    try {
        const tiles = new Map();

        const coverage = db.prepare("SELECT hash, time, observed, heard FROM coverage").all();
        coverage.forEach(c => {
            addCoverageItem(tiles, c.hash, c.observed, c.heard, c.time);
        });

        const samples = db.prepare("SELECT hash, time, repeaters, observed FROM samples").all();
        samples.forEach(s => {
            const id = s.hash.substring(0, 6);
            const path = JSON.parse(s.repeaters || '[]');
            const observed = s.observed;
            const heard = path.length > 0;
            const time = s.time;
            addCoverageItem(tiles, id, observed, heard, time);
        });

        res.json(Array.from(tiles));
    } catch (e) {
        console.error(e);
        res.status(500).send(e.toString());
    }
});

// GET /get-samples
app.get('/get-samples', async (req, res) => {
    try {
        const prefix = req.query.p ?? '';
        const results = db.prepare("SELECT * FROM samples WHERE hash LIKE ?")
            .all(`${prefix}%`);

        results.forEach(r => { r.repeaters = JSON.parse(r.repeaters); });
        res.json(results);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.toString());
    }
});

// GET /get-nodes (Main consolidated data endpoint)
app.get('/get-nodes', async (req, res) => {
    try {
        const responseData = {
            coverage: [],
            samples: [],
            repeaters: []
        };

        // Coverage
        const coverage = db.prepare(`
        SELECT hash, time, lastObserved, lastHeard, observed,
            heard, lost, rssi, snr, repeaters FROM coverage`).all();

        coverage.forEach(c => {
            const rptr = JSON.parse(c.repeaters || '[]');
            const item = {
                id: c.hash,
                obs: c.observed,
                hrd: c.heard,
                lost: c.lost,
                ut: truncateTime(c.time),
                lot: truncateTime(c.lastObserved),
                lht: truncateTime(c.lastHeard),
            };

            if (rptr.length > 0) {
                item.rptr = rptr
            };
            if (c.snr != null) item.snr = c.snr;
            if (c.rssi != null) item.rssi = c.rssi;

            responseData.coverage.push(item);
        });

        // Samples
        const samples = db.prepare("SELECT * FROM samples").all();
        samples.forEach(s => {
            const path = JSON.parse(s.repeaters || '[]');
            const item = {
                id: s.hash,
                time: truncateTime(s.time ?? 0),
                obs: s.observed
            };

            if (path.length > 0) {
                item.path = path
            };
            if (s.snr != null) item.snr = s.snr;
            if (s.rssi != null) item.rssi = s.rssi;

            responseData.samples.push(item);
        });

        // Repeaters
        const repeaters = db.prepare("SELECT * FROM repeaters").all();
        repeaters.forEach(r => {
            const item = {
                id: r.id,
                hash: r.hash,
                name: r.name,
                time: truncateTime(r.time ?? 0),
                elev: Math.round(r.elevation ?? 0)
            };
            responseData.repeaters.push(item);
        });

        res.json(responseData);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.toString());
    }
});

// GET /get-senders
app.get('/get-senders', async (req, res) => {
    try {
        const after = Number(req.query.after ?? 0);
        const results = db.prepare(`
          SELECT name, count(hash) as tiles FROM senders
          WHERE time > ? GROUP BY name ORDER BY tiles DESC`)
            .all(after);

        res.json(results);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.toString());
    }
});

// GET /get-rx-samples
app.get('/get-rx-samples', async (req, res) => {
    try {
        const results = db.prepare(`
          SELECT
            hash,
            time,
            COUNT(hash) as count,
            AVG(json_extract(s.value, "$.rssi")) as rssi,
            AVG(json_extract(s.value, "$.snr")) as snr,
            json_group_array(DISTINCT json_extract(s.value, "$.repeater")) as repeaters
          FROM rx_samples, json_each(rx_samples.samples) AS s
          GROUP BY hash
        `).all();

        results.forEach(r => { r.repeaters = JSON.parse(r.repeaters); });
        res.json(results);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.toString());
    }
});

// GET /get-repeaters (Simple list)
app.get('/get-repeaters', async (req, res) => {
    try {
        const results = db.prepare("SELECT * FROM repeaters").all();
        res.json(results);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.toString());
    }
});

app.listen(port, () => {
    console.log(`Mesh Map API listening on port ${port}`);
});
