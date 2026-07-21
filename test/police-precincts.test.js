'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  PolicePrecinctMatcher,
  ensureSqlitePolicePrecinctSchema,
  geometryCovers,
  normalizePrecinctCollection,
  ordinal
} = require('../police-precincts');
const {
  activateBoundaries,
  backfill,
  installBoundaries,
  parseArgs
} = require('../import-police-precincts');

function polygon(minLongitude, minLatitude, maxLongitude, maxLatitude) {
  return {
    type: 'Polygon',
    coordinates: [[
      [minLongitude, minLatitude], [maxLongitude, minLatitude],
      [maxLongitude, maxLatitude], [minLongitude, maxLatitude],
      [minLongitude, minLatitude]
    ]]
  };
}

function collection() {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { Precinct: 1 }, geometry: polygon(-74.02, 40.70, -74.00, 40.72) },
      { type: 'Feature', properties: { Precinct: 5 }, geometry: polygon(-74.00, 40.70, -73.98, 40.72) }
    ]
  };
}

function matcherRows(precincts) {
  return precincts.map(precinct => ({
    precinct_number: precinct.precinctNumber,
    geometry: precinct.geometry,
    min_longitude: precinct.minLongitude,
    min_latitude: precinct.minLatitude,
    max_longitude: precinct.maxLongitude,
    max_latitude: precinct.maxLatitude
  }));
}

test('normalizes official-style precinct features and labels ordinals', () => {
  const precincts = normalizePrecinctCollection(collection(), { expectedCount: 2 });
  assert.deepEqual(precincts.map(item => [item.precinctNumber, item.label]), [
    [1, '1st Precinct'], [5, '5th Precinct']
  ]);
  assert.equal(ordinal(22), '22nd Precinct');
  assert.equal(ordinal(113), '113th Precinct');
  assert.throws(
    () => normalizePrecinctCollection({ ...collection(), features: [] }, { expectedCount: 2 }),
    /Expected 2/
  );
});

test('point-in-polygon covers interiors and shared boundaries', () => {
  const first = polygon(-74.02, 40.70, -74.00, 40.72);
  assert.equal(geometryCovers(first, -74.01, 40.71), true);
  assert.equal(geometryCovers(first, -74.00, 40.71), true);
  assert.equal(geometryCovers(first, -73.99, 40.71), false);

  const precincts = normalizePrecinctCollection(collection(), { expectedCount: 2 });
  const matcher = new PolicePrecinctMatcher('TEST', matcherRows(precincts));
  assert.deepEqual(matcher.match(40.71, -74.01), {
    precinctNumber: 1, boundaryVersion: 'TEST', ambiguous: false
  });
  assert.deepEqual(matcher.match(40.71, -74.00), {
    precinctNumber: 1, boundaryVersion: 'TEST', ambiguous: true
  });
  assert.equal(matcher.match(41, -74), null);
});

test('installs versioned boundaries and backfills only coordinate-bearing requests', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY, suffix INTEGER UNIQUE,
      latitude REAL, longitude REAL
    );
    CREATE TABLE live_monitor_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO live_portal_requests VALUES
      ('311-00000001',1,40.71,-74.01),
      ('311-00000002',2,40.71,-73.99),
      ('311-00000003',3,41,-74),
      ('311-00000004',4,NULL,NULL);
  `);
  ensureSqlitePolicePrecinctSchema(database);
  const precincts = normalizePrecinctCollection(collection(), { expectedCount: 2 });
  const importedAt = '2026-07-21T20:00:00.000Z';
  const options = {
    version: '26B', file: null, url: 'https://example.test/precincts',
    sourceDate: 'May 2026', batchSize: 1
  };
  installBoundaries(database, options, { sha256: 'a'.repeat(64) }, precincts, importedAt);
  const result = backfill(
    database,
    options,
    new PolicePrecinctMatcher('26B', matcherRows(precincts)),
    importedAt
  );
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS count FROM police_precinct_boundary_versions WHERE active=1`).get().count,
    0
  );
  activateBoundaries(database, options.version, result.completedAt);
  assert.deepEqual(
    database.prepare(`
      SELECT srnumber,police_precinct,police_precinct_boundary_version
      FROM live_portal_requests ORDER BY suffix
    `).all().map(row => [row.srnumber, row.police_precinct, row.police_precinct_boundary_version]),
    [
      ['311-00000001', 1, '26B'],
      ['311-00000002', 5, '26B'],
      ['311-00000003', null, '26B'],
      ['311-00000004', null, null]
    ]
  );
  assert.deepEqual(
    { processed: result.processed, matched: result.matched, unmatched: result.unmatched, remaining: result.remaining },
    { processed: 3, matched: 2, unmatched: 1, remaining: 0 }
  );
  assert.equal(
    JSON.parse(database.prepare(`
      SELECT value FROM live_monitor_state WHERE key='police_precinct_backfill'
    `).get().value).status,
    'complete'
  );
  assert.equal(
    database.prepare(`SELECT version FROM police_precinct_boundary_versions WHERE active=1`).get().version,
    options.version
  );
  database.close();
});

test('import arguments keep the official release pinned by version and digest', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.version, '26B');
  assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => parseArgs(['--version', 'latest']), /version/);
  assert.throws(() => parseArgs(['--sha256', 'bad']), /sha256/);
});
