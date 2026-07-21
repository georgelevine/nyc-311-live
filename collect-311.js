const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { DatabaseSync } = require('node:sqlite');

const PORTAL_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const NYC = { west: -74.2591, south: 40.4774, east: -73.7002, north: 40.9176 };
const DELAY_MS = Math.max(0, Number(process.env.QUERY_DELAY_MS || 2000));
const DATABASE_PATH = path.join(__dirname, 'data', 'nyc311.sqlite');

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS service_requests (
    portal_id TEXT PRIMARY KEY,
    srnumber TEXT UNIQUE,
    problem TEXT,
    address TEXT,
    latitude REAL,
    longitude REAL,
    submitted_at TEXT,
    status TEXT,
    portal_url TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS query_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queried_at TEXT NOT NULL,
    tile_name TEXT NOT NULL,
    west REAL NOT NULL,
    south REAL NOT NULL,
    east REAL NOT NULL,
    north REAL NOT NULL,
    record_count INTEGER NOT NULL,
    hit_cap INTEGER NOT NULL
  );
`);

const upsertRequest = db.prepare(`
  INSERT INTO service_requests (
    portal_id, srnumber, problem, address, latitude, longitude,
    submitted_at, status, portal_url, first_seen_at, last_seen_at, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(portal_id) DO UPDATE SET
    srnumber = excluded.srnumber,
    problem = excluded.problem,
    address = excluded.address,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    submitted_at = excluded.submitted_at,
    status = excluded.status,
    portal_url = excluded.portal_url,
    last_seen_at = excluded.last_seen_at,
    raw_json = excluded.raw_json
`);

const insertQuery = db.prepare(`
  INSERT INTO query_results (
    queried_at, tile_name, west, south, east, north, record_count, hit_cap
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

function quadrants(box) {
  const middleLongitude = (box.west + box.east) / 2;
  const middleLatitude = (box.south + box.north) / 2;
  return [
    { name: 'southwest', west: box.west, south: box.south, east: middleLongitude, north: middleLatitude },
    { name: 'southeast', west: middleLongitude, south: box.south, east: box.east, north: middleLatitude },
    { name: 'northwest', west: box.west, south: middleLatitude, east: middleLongitude, north: box.north },
    { name: 'northeast', west: middleLongitude, south: middleLatitude, east: box.east, north: box.north }
  ];
}

function namedChildren(tile) {
  return quadrants(tile).map(child => ({
    ...child,
    name: `${tile.name}/${child.name}`
  }));
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchTile(tile) {
  const params = new URLSearchParams({
    minlatitude: String(tile.south),
    minlongitude: String(tile.west),
    maxlatitude: String(tile.north),
    maxlongitude: String(tile.east)
  });
  const response = await fetch(`${PORTAL_URL}?${params}`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Explorer/1.0)',
      Referer: 'https://portal.311.nyc.gov/check-status/',
      Origin: 'https://portal.311.nyc.gov'
    },
    timeout: 120000
  });
  if (!response.ok) throw new Error(`Portal returned HTTP ${response.status}`);
  const text = await response.text();
  let records;
  try {
    records = JSON.parse(text);
  } catch (_) {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Portal response was not a record list');
    records = JSON.parse(match[0]);
  }
  if (!Array.isArray(records)) throw new Error('Portal response was not a record list');
  return records;
}

function save(tile, records) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const pin of records) {
      const portalId = pin.id || `sr:${pin.data && pin.data.srnumber}`;
      if (!portalId || portalId === 'sr:undefined') continue;
      const details = pin.data || {};
      upsertRequest.run(
        portalId,
        details.srnumber || null,
        details.problem || pin.label || null,
        details.address || pin.sublabel || null,
        Number.isFinite(Number(pin.latitude)) ? Number(pin.latitude) : null,
        Number.isFinite(Number(pin.longitude)) ? Number(pin.longitude) : null,
        details.submitteddate || null,
        details.status || null,
        pin.id ? `https://portal.311.nyc.gov/sr-details/?id=${pin.id}` : null,
        now,
        now,
        JSON.stringify(pin)
      );
    }
    insertQuery.run(
      now, tile.name, tile.west, tile.south, tile.east, tile.north,
      records.length, records.length >= 100 ? 1 : 0
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function main() {
  const queue = quadrants(NYC);
  const maxQueries = 5;
  console.log(`Saving results to ${DATABASE_PATH}`);
  for (let index = 0; index < maxQueries && queue.length > 0; index += 1) {
    const tile = queue.shift();
    if (index > 0) await sleep(DELAY_MS);
    try {
      const records = await fetchTile(tile);
      save(tile, records);
      const hitCap = records.length >= 100;
      console.log(`${index + 1}/${maxQueries} ${tile.name}: ${records.length} records${hitCap ? ' (hit cap; split again)' : ' (under cap)'}`);
      if (hitCap) queue.push(...namedChildren(tile));
    } catch (error) {
      console.error(`${index + 1}/${maxQueries} ${tile.name}: failed (${error.message})`);
    }
  }
  const total = db.prepare('SELECT COUNT(*) AS count FROM service_requests').get().count;
  console.log(`Database now contains ${total} unique service requests.`);
}

main()
  .catch(error => {
    console.error(`Collection failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
