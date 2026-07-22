'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  BusinessImprovementDistrictMatcher,
  ensureSqliteBusinessImprovementDistrictSchema,
  normalizeBusinessImprovementDistrictCollection
} = require('../business-improvement-districts');
const {
  DEFAULT_SHA256,
  DEFAULT_SOURCE_DATE,
  DEFAULT_VERSION,
  OFFICIAL_GEOJSON_URL,
  activateBoundaries,
  backfill,
  installBoundaries,
  parseArgs
} = require('../import-business-improvement-districts');

function square(west, south, east, north) {
  return [[
    [west, south], [east, south], [east, north], [west, north], [west, south]
  ]];
}

function collection() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { BIDID: 8, BID: ' Bryant\u00a0 Park   BID ', BOROUGH: '1' },
        geometry: { type: 'Polygon', coordinates: square(-74.01, 40.70, -74.00, 40.71) }
      },
      {
        type: 'Feature',
        properties: { BIDID: 10, BID: 'Times Square BID', BOROUGH: '1' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [square(-74.005, 40.705, -73.995, 40.715)]
        }
      }
    ]
  };
}

function matcherRows(districts) {
  return districts.map(district => ({
    bid_id: district.bidId,
    name: district.name,
    borough_code: district.boroughCode,
    borough_name: district.boroughName,
    geometry: district.geometry,
    min_longitude: district.minLongitude,
    min_latitude: district.minLatitude,
    max_longitude: district.maxLongitude,
    max_latitude: district.maxLatitude
  }));
}

test('normalizes official BID fields, Unicode whitespace, and borough codes', () => {
  const districts = normalizeBusinessImprovementDistrictCollection(collection(), {
    expectedCount: 2
  });
  assert.deepEqual(districts.map(district => ({
    id: district.bidId,
    name: district.name,
    borough: district.boroughName,
    geometry: district.geometry.type
  })), [
    { id: 8, name: 'Bryant Park BID', borough: 'Manhattan', geometry: 'Polygon' },
    { id: 10, name: 'Times Square BID', borough: 'Manhattan', geometry: 'MultiPolygon' }
  ]);

  const duplicate = collection();
  duplicate.features[1].properties.BIDID = 8;
  assert.throws(
    () => normalizeBusinessImprovementDistrictCollection(duplicate, { expectedCount: 2 }),
    /Duplicate BIDID 8/
  );
  const invalidBorough = collection();
  invalidBorough.features[0].properties.BOROUGH = '9';
  assert.throws(
    () => normalizeBusinessImprovementDistrictCollection(invalidBorough, { expectedCount: 2 }),
    /invalid BOROUGH code/
  );
});

test('returns every covering BID in stable ID order', () => {
  const districts = normalizeBusinessImprovementDistrictCollection(collection(), {
    expectedCount: 2
  });
  const matcher = new BusinessImprovementDistrictMatcher('2026-04-28', matcherRows(districts));
  assert.deepEqual(matcher.match(40.707, -74.003), {
    boundaryVersion: '2026-04-28',
    ambiguous: true,
    districts: [
      { bidId: 8, name: 'Bryant Park BID', boroughCode: 1, boroughName: 'Manhattan' },
      { bidId: 10, name: 'Times Square BID', boroughCode: 1, boroughName: 'Manhattan' }
    ]
  });
  assert.deepEqual(matcher.match(40.702, -74.007).districts.map(item => item.bidId), [8]);
  assert.deepEqual(matcher.match(40.8, -73.9).districts, []);
  assert.equal(matcher.match(null, null), null);
});

test('installs, backfills, and activates zero-to-many BID memberships idempotently', () => {
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
        ('311-00000001',1,40.702,-74.007),
        ('311-00000002',2,40.707,-74.003),
        ('311-00000003',3,40.800,-73.900),
        ('311-00000004',4,NULL,NULL);
    `);
    ensureSqliteBusinessImprovementDistrictSchema(database);
    const districts = normalizeBusinessImprovementDistrictCollection(collection(), {
      expectedCount: 2
    });
    const options = {
      version: '2026-04-28',
      sourceDate: 'April 28, 2026',
      url: 'https://example.test/bids.geojson',
      file: null,
      batchSize: 2
    };
    const importedAt = '2026-07-21T21:00:00.000Z';
    const sha256 = 'a'.repeat(64);
    installBoundaries(database, options, { sha256 }, districts, importedAt);
    const matcher = new BusinessImprovementDistrictMatcher(
      options.version,
      matcherRows(districts)
    );
    const result = backfill(database, options, matcher, importedAt);
    assert.deepEqual({
      processed: result.processed,
      matched: result.matched,
      unmatched: result.unmatched,
      multiple_memberships: result.multiple_memberships,
      memberships: result.memberships,
      remaining: result.remaining
    }, {
      processed: 3,
      matched: 2,
      unmatched: 1,
      multiple_memberships: 1,
      memberships: 3,
      remaining: 0
    });
    assert.deepEqual(database.prepare(`
      SELECT srnumber,business_improvement_district_boundary_version AS version,
             business_improvement_district_matched_at AS matched_at
      FROM live_portal_requests ORDER BY suffix
    `).all().map(row => [row.srnumber, row.version, row.matched_at]), [
      ['311-00000001', '2026-04-28', importedAt],
      ['311-00000002', '2026-04-28', importedAt],
      ['311-00000003', '2026-04-28', importedAt],
      ['311-00000004', null, null]
    ]);
    assert.deepEqual(database.prepare(`
      SELECT srnumber,bid_id FROM live_request_bid_memberships ORDER BY srnumber,bid_id
    `).all().map(row => [row.srnumber, row.bid_id]), [
      ['311-00000001', 8],
      ['311-00000002', 8],
      ['311-00000002', 10]
    ]);
    activateBoundaries(database, options.version, result.completedAt);
    assert.equal(database.prepare(`
      SELECT version FROM business_improvement_district_boundary_versions WHERE active=1
    `).get().version, '2026-04-28');
    assert.equal(backfill(database, options, matcher, importedAt).processed, 0);
    assert.doesNotThrow(() => {
      installBoundaries(database, options, { sha256 }, districts, importedAt);
    });
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM live_request_bid_memberships').get().count,
      3
    );
    assert.throws(
      () => installBoundaries(database, options, { sha256: 'b'.repeat(64) }, districts, importedAt),
      /immutable.*different SHA-256/
    );
  } finally {
    database.close();
  }
});

test('import arguments pin the official ordered GeoJSON release and digest', () => {
  const options = parseArgs([]);
  assert.equal(options.url, OFFICIAL_GEOJSON_URL);
  assert.equal(options.version, DEFAULT_VERSION);
  assert.equal(options.sourceDate, DEFAULT_SOURCE_DATE);
  assert.equal(options.sha256, DEFAULT_SHA256);
  assert.equal(DEFAULT_SHA256, 'a6600c7561dbfc0b077d80c1e4bbf981771a074e371952e7882fef8d93169d6b');
  assert.match(OFFICIAL_GEOJSON_URL, /orderByFields=BIDID/);
});
