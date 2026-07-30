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

function swappedCollection() {
  const swapped = collection();
  swapped.features[0].properties.Precinct = 5;
  swapped.features[1].properties.Precinct = 1;
  return swapped;
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
    PRAGMA foreign_keys=ON;
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
  assert.deepEqual(
    database.prepare(`
      SELECT srnumber,police_precinct,police_precinct_boundary_version
      FROM live_portal_requests ORDER BY suffix
    `).all().map(row => [row.srnumber, row.police_precinct, row.police_precinct_boundary_version]),
    [
      ['311-00000001', null, null],
      ['311-00000002', null, null],
      ['311-00000003', null, null],
      ['311-00000004', null, null]
    ],
    'staged precinct assignments must remain invisible until activation'
  );
  assert.deepEqual(
    database.prepare(`
      SELECT srnumber,boundary_version,precinct_number
      FROM live_request_police_precinct_assignments ORDER BY srnumber
    `).all().map(row => [row.srnumber, row.boundary_version, row.precinct_number]),
    [
      ['311-00000001', '26B', 1],
      ['311-00000002', '26B', 5],
      ['311-00000003', '26B', null]
    ]
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
  assert.deepEqual(
    installBoundaries(
      database,
      options,
      { sha256: 'a'.repeat(64) },
      precincts,
      importedAt
    ),
    { unchanged: true }
  );
  assert.throws(
    () => installBoundaries(
      database,
      options,
      { sha256: 'b'.repeat(64) },
      precincts,
      importedAt
    ),
    /immutable.*different SHA-256/
  );
  database.close();
});

test('keeps active precinct assignments coherent through interrupted staging and activation rollback', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE live_portal_requests (
        srnumber TEXT PRIMARY KEY,
        suffix INTEGER NOT NULL UNIQUE,
        latitude REAL,
        longitude REAL
      );
      CREATE TABLE live_monitor_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO live_portal_requests VALUES
        ('311-00000001',1,40.71,-74.01),
        ('311-00000002',2,40.71,-73.99);
    `);
    ensureSqlitePolicePrecinctSchema(database);

    const firstPrecincts = normalizePrecinctCollection(collection(), { expectedCount: 2 });
    const firstOptions = {
      version: '26A',
      file: null,
      url: 'https://example.test/precincts-26a',
      sourceDate: 'January 2026',
      batchSize: 1
    };
    const firstImportedAt = '2026-01-01T12:00:00.000Z';
    installBoundaries(
      database,
      firstOptions,
      { sha256: 'a'.repeat(64) },
      firstPrecincts,
      firstImportedAt
    );
    const firstResult = backfill(
      database,
      firstOptions,
      new PolicePrecinctMatcher('26A', matcherRows(firstPrecincts)),
      firstImportedAt
    );
    activateBoundaries(database, firstOptions.version, firstResult.completedAt);

    const replacementPrecincts = normalizePrecinctCollection(
      swappedCollection(),
      { expectedCount: 2 }
    );
    const replacementOptions = {
      version: '26B',
      file: null,
      url: 'https://example.test/precincts-26b',
      sourceDate: 'May 2026',
      batchSize: 1
    };
    const replacementImportedAt = '2026-05-01T12:00:00.000Z';
    installBoundaries(
      database,
      replacementOptions,
      { sha256: 'b'.repeat(64) },
      replacementPrecincts,
      replacementImportedAt
    );
    const replacementMatcher = new PolicePrecinctMatcher(
      '26B',
      matcherRows(replacementPrecincts)
    );
    let matchCalls = 0;
    const interruptedMatcher = {
      match(latitude, longitude) {
        matchCalls += 1;
        if (matchCalls === 2) throw new Error('simulated mid-backfill interruption');
        return replacementMatcher.match(latitude, longitude);
      }
    };
    assert.throws(
      () => backfill(
        database,
        replacementOptions,
        interruptedMatcher,
        replacementImportedAt
      ),
      /simulated mid-backfill interruption/
    );
    assert.deepEqual(database.prepare(`
      SELECT srnumber,police_precinct,police_precinct_boundary_version AS version
      FROM live_portal_requests ORDER BY suffix
    `).all().map(row => [row.srnumber, row.police_precinct, row.version]), [
      ['311-00000001', 1, '26A'],
      ['311-00000002', 5, '26A']
    ], 'a committed staging batch must not leak into live assignments');
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM live_request_police_precinct_assignments
      WHERE boundary_version='26B'
    `).get().count, 1);

    const replacementResult = backfill(
      database,
      replacementOptions,
      replacementMatcher,
      replacementImportedAt
    );
    assert.equal(replacementResult.remaining, 0);
    assert.deepEqual(database.prepare(`
      SELECT srnumber,police_precinct,police_precinct_boundary_version AS version
      FROM live_portal_requests ORDER BY suffix
    `).all().map(row => [row.srnumber, row.police_precinct, row.version]), [
      ['311-00000001', 1, '26A'],
      ['311-00000002', 5, '26A']
    ], 'even a complete inactive release must remain invisible before activation');
    database.prepare(`
      UPDATE live_portal_requests SET latitude=40.711 WHERE srnumber='311-00000001'
    `).run();
    assert.throws(
      () => activateBoundaries(
        database,
        replacementOptions.version,
        replacementResult.completedAt
      ),
      /1 coordinate records remain/
    );
    assert.equal(
      backfill(
        database,
        replacementOptions,
        replacementMatcher,
        replacementImportedAt
      ).processed,
      1,
      'a changed coordinate must invalidate and refresh its staged assignment'
    );

    database.exec(`
      CREATE TRIGGER fail_obsolete_precinct_assignment_cleanup
      BEFORE DELETE ON live_request_police_precinct_assignments
      WHEN OLD.boundary_version='26A'
      BEGIN
        SELECT RAISE(ABORT, 'simulated precinct cleanup failure');
      END;
    `);
    assert.throws(
      () => activateBoundaries(
        database,
        replacementOptions.version,
        replacementResult.completedAt
      ),
      /simulated precinct cleanup failure/
    );
    assert.equal(database.prepare(`
      SELECT version FROM police_precinct_boundary_versions WHERE active=1
    `).get().version, '26A');
    assert.deepEqual(database.prepare(`
      SELECT srnumber,police_precinct,police_precinct_boundary_version AS version
      FROM live_portal_requests ORDER BY suffix
    `).all().map(row => [row.srnumber, row.police_precinct, row.version]), [
      ['311-00000001', 1, '26A'],
      ['311-00000002', 5, '26A']
    ], 'activation failure must roll back both the catalog and live assignments');

    database.exec('DROP TRIGGER fail_obsolete_precinct_assignment_cleanup');
    activateBoundaries(
      database,
      replacementOptions.version,
      replacementResult.completedAt
    );
    assert.equal(database.prepare(`
      SELECT version FROM police_precinct_boundary_versions WHERE active=1
    `).get().version, '26B');
    assert.deepEqual(database.prepare(`
      SELECT srnumber,police_precinct,police_precinct_boundary_version AS version
      FROM live_portal_requests ORDER BY suffix
    `).all().map(row => [row.srnumber, row.police_precinct, row.version]), [
      ['311-00000001', 5, '26B'],
      ['311-00000002', 1, '26B']
    ]);
    assert.deepEqual(database.prepare(`
      SELECT DISTINCT boundary_version
      FROM live_request_police_precinct_assignments
      ORDER BY boundary_version
    `).all().map(row => row.boundary_version), ['26B']);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('import arguments keep the official release pinned by version and digest', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.version, '26B');
  assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => parseArgs(['--version', 'latest']), /version/);
  assert.throws(() => parseArgs(['--sha256', 'bad']), /sha256/);
});
