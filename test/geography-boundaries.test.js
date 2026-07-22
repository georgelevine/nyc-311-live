'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  BoundaryLookupError,
  loadActiveBusinessImprovementDistrictFeature,
  loadActivePolicePrecinctFeature
} = require('../geography-boundaries');

function databaseFor(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  return database;
}

function createPrecinctTables(database) {
  database.exec(`
    CREATE TABLE police_precinct_boundary_versions (
      version TEXT PRIMARY KEY,
      feature_count INTEGER NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE police_precincts (
      boundary_version TEXT NOT NULL,
      precinct_number INTEGER NOT NULL,
      label TEXT NOT NULL,
      geometry_json TEXT NOT NULL CHECK(json_valid(geometry_json)),
      min_longitude REAL NOT NULL,
      min_latitude REAL NOT NULL,
      max_longitude REAL NOT NULL,
      max_latitude REAL NOT NULL,
      PRIMARY KEY(boundary_version, precinct_number)
    );
  `);
}

function createBidTables(database) {
  database.exec(`
    CREATE TABLE business_improvement_district_boundary_versions (
      version TEXT PRIMARY KEY,
      feature_count INTEGER NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE business_improvement_districts (
      boundary_version TEXT NOT NULL,
      bid_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      borough_code INTEGER NOT NULL,
      borough_name TEXT NOT NULL,
      geometry_json TEXT NOT NULL CHECK(json_valid(geometry_json)),
      min_longitude REAL NOT NULL,
      min_latitude REAL NOT NULL,
      max_longitude REAL NOT NULL,
      max_latitude REAL NOT NULL,
      PRIMARY KEY(boundary_version, bid_id)
    );
  `);
}

function ring(minLongitude, minLatitude, maxLongitude, maxLatitude) {
  return [
    [minLongitude, minLatitude],
    [maxLongitude, minLatitude],
    [maxLongitude, maxLatitude],
    [minLongitude, maxLatitude],
    [minLongitude, minLatitude]
  ];
}

function assertLookupStatus(action, statusCode, messagePattern) {
  assert.throws(action, error => {
    assert.equal(error instanceof BoundaryLookupError, true);
    assert.equal(error.statusCode, statusCode);
    if (messagePattern) assert.match(error.message, messagePattern);
    return true;
  });
}

test('returns the active police precinct Polygon as one GeoJSON Feature', t => {
  const database = databaseFor(t);
  createPrecinctTables(database);
  const geometry = {
    type: 'Polygon',
    coordinates: [ring(-73.90, 40.86, -73.84, 40.91)]
  };
  database.prepare(`
    INSERT INTO police_precinct_boundary_versions(version,feature_count,active) VALUES(?,1,1)
  `).run('26B');
  database.prepare(`
    INSERT INTO police_precincts(
      boundary_version,precinct_number,label,geometry_json,
      min_longitude,min_latitude,max_longitude,max_latitude
    ) VALUES(?,?,?,?,?,?,?,?)
  `).run('26B', 52, '52nd Precinct', JSON.stringify(geometry), -73.90, 40.86, -73.84, 40.91);

  assert.deepEqual(loadActivePolicePrecinctFeature(database, '52'), {
    type: 'Feature',
    id: 'police-precinct:52',
    bbox: [-73.90, 40.86, -73.84, 40.91],
    properties: {
      boundary_type: 'police_precinct',
      boundary_version: '26B',
      precinct_number: 52,
      label: '52nd Precinct'
    },
    geometry
  });
});

test('returns the active BID MultiPolygon as one GeoJSON Feature', t => {
  const database = databaseFor(t);
  createBidTables(database);
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [
      [[...ring(-74.010, 40.751, -74.000, 40.758)]],
      [[...ring(-73.999, 40.752, -73.992, 40.760)]]
    ]
  };
  database.prepare(`
    INSERT INTO business_improvement_district_boundary_versions(version,feature_count,active) VALUES(?,1,1)
  `).run('2026-04-28');
  database.prepare(`
    INSERT INTO business_improvement_districts(
      boundary_version,bid_id,name,borough_code,borough_name,geometry_json,
      min_longitude,min_latitude,max_longitude,max_latitude
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    '2026-04-28', 8, 'Bryant Park BID', 1, 'Manhattan', JSON.stringify(geometry),
    -74.010, 40.751, -73.992, 40.760
  );

  assert.deepEqual(loadActiveBusinessImprovementDistrictFeature(database, 8), {
    type: 'Feature',
    id: 'bid:8',
    bbox: [-74.010, 40.751, -73.992, 40.760],
    properties: {
      boundary_type: 'business_improvement_district',
      boundary_version: '2026-04-28',
      bid_id: 8,
      name: 'Bryant Park BID',
      borough_code: 1,
      borough_name: 'Manhattan'
    },
    geometry
  });
});

test('rejects invalid precinct and BID identifiers with status 400', t => {
  const database = databaseFor(t);
  const cases = [
    [loadActivePolicePrecinctFeature, 'abc'],
    [loadActivePolicePrecinctFeature, ' 52 '],
    [loadActivePolicePrecinctFeature, '0'],
    [loadActivePolicePrecinctFeature, '-1'],
    [loadActivePolicePrecinctFeature, '1.5'],
    [loadActivePolicePrecinctFeature, '1234'],
    [loadActiveBusinessImprovementDistrictFeature, ''],
    [loadActiveBusinessImprovementDistrictFeature, '0'],
    [loadActiveBusinessImprovementDistrictFeature, '1e2'],
    [loadActiveBusinessImprovementDistrictFeature, '1234567']
  ];
  for (const [lookup, value] of cases) {
    assertLookupStatus(() => lookup(database, value), 400, /positive integer/);
  }
});

test('returns status 404 for valid identifiers absent from the active release', t => {
  const database = databaseFor(t);
  createPrecinctTables(database);
  createBidTables(database);
  database.exec(`
    INSERT INTO police_precinct_boundary_versions(version,feature_count,active) VALUES
      ('26B',1,1),('25D',1,0);
    INSERT INTO business_improvement_district_boundary_versions(version,feature_count,active) VALUES
      ('2026-04-28',1,1),('2025-07-01',1,0);
  `);
  const precinctGeometry = JSON.stringify({
    type: 'Polygon', coordinates: [ring(-74.01, 40.70, -74.00, 40.71)]
  });
  database.prepare(`
    INSERT INTO police_precincts VALUES(?,?,?,?,?,?,?,?)
  `).run('26B', 1, '1st Precinct', precinctGeometry, -74.01, 40.70, -74.00, 40.71);
  database.prepare(`
    INSERT INTO police_precincts VALUES(?,?,?,?,?,?,?,?)
  `).run('25D', 9, '9th Precinct', precinctGeometry, -74.01, 40.70, -74.00, 40.71);
  const bidGeometry = JSON.stringify({
    type: 'Polygon', coordinates: [ring(-74.02, 40.72, -74.01, 40.73)]
  });
  database.prepare(`
    INSERT INTO business_improvement_districts VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    '2026-04-28', 1, 'Active BID', 1, 'Manhattan', bidGeometry,
    -74.02, 40.72, -74.01, 40.73
  );
  database.prepare(`
    INSERT INTO business_improvement_districts VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    '2025-07-01', 8, 'Inactive BID', 1, 'Manhattan', bidGeometry,
    -74.02, 40.72, -74.01, 40.73
  );

  assertLookupStatus(
    () => loadActivePolicePrecinctFeature(database, 9),
    404,
    /not in the active boundary release/
  );
  assertLookupStatus(
    () => loadActiveBusinessImprovementDistrictFeature(database, 8),
    404,
    /not in the active boundary release/
  );
  assertLookupStatus(
    () => loadActivePolicePrecinctFeature(database, 52),
    404,
    /not in the active boundary release/
  );
});

test('returns status 503 when boundary tables or an active release are unavailable', t => {
  const missingTables = databaseFor(t);
  assertLookupStatus(
    () => loadActivePolicePrecinctFeature(missingTables, 52),
    503,
    /temporarily unavailable/
  );

  const noActiveBidRelease = databaseFor(t);
  createBidTables(noActiveBidRelease);
  noActiveBidRelease.prepare(`
    INSERT INTO business_improvement_district_boundary_versions(version,feature_count,active) VALUES(?,1,0)
  `).run('2026-04-28');
  assertLookupStatus(
    () => loadActiveBusinessImprovementDistrictFeature(noActiveBidRelease, 8),
    503,
    /temporarily unavailable/
  );

  const incompletePrecinctRelease = databaseFor(t);
  createPrecinctTables(incompletePrecinctRelease);
  incompletePrecinctRelease.prepare(`
    INSERT INTO police_precinct_boundary_versions(version,feature_count,active) VALUES(?,1,1)
  `).run('26B');
  assertLookupStatus(
    () => loadActivePolicePrecinctFeature(incompletePrecinctRelease, 52),
    503,
    /temporarily unavailable/
  );
});

test('returns status 503 for corrupt geometry and a geometry/bbox mismatch', t => {
  const corruptPrecinct = databaseFor(t);
  createPrecinctTables(corruptPrecinct);
  corruptPrecinct.prepare(`
    INSERT INTO police_precinct_boundary_versions(version,feature_count,active) VALUES(?,1,1)
  `).run('26B');
  corruptPrecinct.prepare(`
    INSERT INTO police_precincts VALUES(?,?,?,?,?,?,?,?)
  `).run(
    '26B', 52, '52nd Precinct',
    JSON.stringify({
      type: 'Polygon',
      coordinates: [[
        [-73.90, 40.86, 'bad'], [-73.84, 40.86], [-73.84, 40.91],
        [-73.90, 40.91], [-73.90, 40.86, 'bad']
      ]]
    }),
    -73.90, 40.86, -73.84, 40.91
  );
  assertLookupStatus(
    () => loadActivePolicePrecinctFeature(corruptPrecinct, 52),
    503,
    /temporarily unavailable/
  );

  const mismatchedBid = databaseFor(t);
  createBidTables(mismatchedBid);
  mismatchedBid.prepare(`
    INSERT INTO business_improvement_district_boundary_versions(version,feature_count,active) VALUES(?,1,1)
  `).run('2026-04-28');
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [[ring(-74.010, 40.751, -74.000, 40.758)]]
  };
  mismatchedBid.prepare(`
    INSERT INTO business_improvement_districts VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    '2026-04-28', 8, 'Bryant Park BID', 1, 'Manhattan', JSON.stringify(geometry),
    -74.010, 40.751, -73.990, 40.758
  );
  assertLookupStatus(
    () => loadActiveBusinessImprovementDistrictFeature(mismatchedBid, 8),
    503,
    /temporarily unavailable/
  );
});
