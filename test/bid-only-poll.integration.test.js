'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { geometryBounds, geometryCovers } = require('../police-precincts');

const ROOT = path.join(__dirname, '..');
const BOUNDARIES = path.join(
  ROOT,
  'exports',
  'nyc-bid-boundaries-2026-04-28.geojson'
);
const FETCH_HOOK = path.join(ROOT, 'test-support', 'mock-node-fetch.js');

function runNode(arguments_, environment) {
  return execFileSync(process.execPath, arguments_, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${FETCH_HOOK}`]
        .filter(Boolean).join(' '),
      ...environment
    }
  });
}

function interiorPoint(feature) {
  const bounds = geometryBounds(feature.geometry.coordinates);
  for (let latitudeStep = 1; latitudeStep < 30; latitudeStep += 1) {
    for (let longitudeStep = 1; longitudeStep < 30; longitudeStep += 1) {
      const latitude = bounds.minLatitude
        + (bounds.maxLatitude - bounds.minLatitude) * latitudeStep / 30;
      const longitude = bounds.minLongitude
        + (bounds.maxLongitude - bounds.minLongitude) * longitudeStep / 30;
      if (geometryCovers(feature.geometry, longitude, latitude)) {
        return { latitude, longitude };
      }
    }
  }
  throw new Error('Could not find an interior point in the pinned BID feature');
}

function pin(srnumber, latitude, longitude) {
  return {
    id: `00000000-0000-0000-0000-${srnumber.slice(-8).padStart(12, '0')}`,
    latitude,
    longitude,
    label: 'Test complaint',
    sublabel: '1 TEST STREET, MANHATTAN, NY, 10001',
    data: {
      srnumber,
      problem: 'Test complaint',
      address: '1 TEST STREET, MANHATTAN, NY, 10001',
      submitteddate: '2026-08-06T10:00:00-04:00',
      status: 'In Progress'
    }
  };
}

test('the pinned BID importer initializes a genuinely fresh SQLite archive', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-bid-import-'));
  const databasePath = path.join(directory, 'fresh.sqlite');
  try {
    const arguments_ = [
      'import-business-improvement-districts.js',
      '--db', databasePath,
      '--file', BOUNDARIES
    ];
    runNode(arguments_, {});
    runNode(arguments_, {});
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM live_portal_requests
      `).get().count, 0);
      assert.deepEqual({ ...database.prepare(`
        SELECT version,source_sha256,feature_count
        FROM business_improvement_district_boundary_versions WHERE active=1
      `).get() }, {
        version: '2026-04-28',
        source_sha256: 'c8c06c9ecb8b733aa829c9907e918e153c9a4230fa796d228ad3f27042208a9f',
        feature_count: 78
      });
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM business_improvement_districts
      `).get().count, 78);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM schema_migrations
      `).get().count > 0, true);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh BID startup fails closed when the bundled boundary digest is wrong', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-bid-bootstrap-'));
  const databasePath = path.join(directory, 'fresh.sqlite');
  const tamperedBoundaries = path.join(directory, 'tampered.geojson');
  fs.writeFileSync(tamperedBoundaries, '{"type":"FeatureCollection","features":[]}');
  try {
    assert.throws(
      () => runNode(['live-311.js'], {
        DATABASE_PATH: databasePath,
        BID_BOUNDARY_BOOTSTRAP_FILE: tamperedBoundaries,
        LIVE_DURATION_SECONDS: '0.05',
        NYC311_TEST_PORTAL_PINS: '[]'
      }),
      error => /Boundary SHA-256 mismatch/.test(
        String(error && error.stderr || error && error.message)
      )
    );
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare(`
        SELECT value FROM live_monitor_state WHERE key='collector_scope'
      `).get().value, 'bid_only');
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM live_number_queue
      `).get().count, 0);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count
        FROM business_improvement_district_boundary_versions WHERE active=1
      `).get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('one BID-only poll admits exact matches and leaves citywide audit state untouched', {
  timeout: 45_000
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-bid-poll-'));
  const databasePath = path.join(directory, 'bid-only.sqlite');
  const baseEnvironment = {
    DATABASE_PATH: databasePath,
    LIVE_DURATION_SECONDS: '0.05',
    NYC311_TEST_FETCH_DELAY_MS: '75',
    POLL_INTERVAL_SECONDS: '60',
    EMAIL_SUBSCRIBE_ALL_NEW: '0',
    EMAIL_SUBSCRIBE_BID_IDS: '',
    EMAIL_SUBSCRIBE_PRECINCTS: '',
    NYC311_TEST_PORTAL_PINS: '[]'
  };

  try {
    // A genuinely fresh database defaults to BID-only and installs only the
    // tracked, checksummed boundary bundle before making its first Portal poll.
    const bootstrapOutput = runNode(['live-311.js'], baseEnvironment);
    const bootstrappedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const active = bootstrappedDatabase.prepare(`
        SELECT version,source_sha256,feature_count
        FROM business_improvement_district_boundary_versions WHERE active=1
      `).get();
      assert.deepEqual({ ...active }, {
        version: '2026-04-28',
        source_sha256: 'c8c06c9ecb8b733aa829c9907e918e153c9a4230fa796d228ad3f27042208a9f',
        feature_count: 78
      }, bootstrapOutput);
      assert.equal(bootstrappedDatabase.prepare(`
        SELECT COUNT(*) AS count FROM business_improvement_districts
        WHERE boundary_version='2026-04-28'
      `).get().count, 78);
      assert.equal(bootstrappedDatabase.prepare(`
        SELECT value FROM live_monitor_state WHERE key='collector_scope'
      `).get().value, 'bid_only');
      assert.equal(bootstrappedDatabase.prepare(`
        SELECT COUNT(*) AS count FROM live_number_queue
      `).get().count, 0);
    } finally {
      bootstrappedDatabase.close();
    }

    // Even internally self-consistent metadata must not make a partial
    // release eligible for BID-only collection.
    const partialDatabase = new DatabaseSync(databasePath);
    try {
      partialDatabase.prepare(`
        DELETE FROM business_improvement_districts
        WHERE boundary_version='2026-04-28' AND bid_id=(
          SELECT MAX(bid_id) FROM business_improvement_districts
          WHERE boundary_version='2026-04-28'
        )
      `).run();
      partialDatabase.prepare(`
        UPDATE business_improvement_district_boundary_versions
        SET feature_count=77 WHERE version='2026-04-28'
      `).run();
    } finally {
      partialDatabase.close();
    }
    assert.throws(
      () => runNode(['live-311.js'], {
        ...baseEnvironment,
        COLLECTOR_SCOPE: 'bid_only'
      }),
      error => /boundary release is incomplete/
        .test(String(error && error.stderr || error && error.message))
    );
    const resetPartialDatabase = new DatabaseSync(databasePath);
    try {
      resetPartialDatabase.prepare(`
        DELETE FROM business_improvement_districts WHERE boundary_version='2026-04-28'
      `).run();
      resetPartialDatabase.prepare(`
        DELETE FROM business_improvement_district_boundary_versions
        WHERE version='2026-04-28'
      `).run();
    } finally {
      resetPartialDatabase.close();
    }
    runNode(['live-311.js'], baseEnvironment);

    const collection = JSON.parse(fs.readFileSync(BOUNDARIES, 'utf8'));
    const point = interiorPoint(collection.features[0]);
    const early = pin('311-99000100', point.latitude, point.longitude);
    early.data.updateddate = '2026-08-06T10:00:01-04:00';
    const newerUnhyphenated = pin('31199000100', point.latitude, point.longitude);
    newerUnhyphenated.data.updateddate = '2026-08-06T10:00:02-04:00';
    newerUnhyphenated.data.status = 'Closed';
    const pins = [
      early,
      newerUnhyphenated,
      pin('311-99000103', point.latitude, point.longitude),
      pin('311-99000200', 40.717475691247614, -73.99280573458579),
      pin('311-99000104', 40.60, -74.20),
      pin('311-99000105', null, point.longitude)
    ];
    const bidCollectorOutput = runNode(['live-311.js'], {
      ...baseEnvironment,
      COLLECTOR_SCOPE: 'bid_only',
      BID_POLL_INTERVAL_SECONDS: '60',
      BID_QUERY_ZONE_TARGET: '12',
      BID_QUERY_CONCURRENCY: '3',
      NYC311_TEST_PORTAL_PINS: JSON.stringify(pins)
    });

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM live_portal_requests').get().count,
        3,
        bidCollectorOutput
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM live_detail_queue').get().count, 3);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM live_request_bid_assignment_versions
      `).get().count, 3);
      assert.equal(database.prepare(`
        SELECT status FROM live_portal_requests WHERE srnumber='311-99000100'
      `).get().status, 'Closed');
      assert.deepEqual(database.prepare(`
        SELECT bid_id FROM live_request_bid_memberships
        WHERE srnumber='311-99000200' ORDER BY bid_id
      `).all().map(row => row.bid_id), [2, 72]);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count
        FROM live_portal_requests AS request
        WHERE NOT EXISTS (
          SELECT 1 FROM live_request_bid_memberships AS membership
          WHERE membership.srnumber=request.srnumber
            AND membership.boundary_version=
              request.business_improvement_district_boundary_version
        )
      `).get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM live_number_queue').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM number_ledger').get().count, 0);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM live_monitor_state WHERE key='live_frontier'
      `).get().count, 0);
      assert.equal(database.prepare(`
        SELECT value FROM live_monitor_state WHERE key='collector_scope'
      `).get().value, 'bid_only');
      const zoneHealth = database.prepare(`
        SELECT COUNT(*) AS zones,
               SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed
        FROM bid_collector_zone_state
      `).get();
      assert.equal(zoneHealth.zones, 12);
      assert.equal(zoneHealth.failed, 0);
    } finally {
      database.close();
    }

    const beforeRecovery = new DatabaseSync(databasePath);
    const oldWatermark = new Date(Date.now() - 3 * 86_400_000).toISOString();
    let globalWatermark;
    try {
      beforeRecovery.prepare(`
        UPDATE bid_collector_zone_state
        SET last_successful_poll_at=?,last_error=NULL
      `).run(oldWatermark);
      globalWatermark = beforeRecovery.prepare(`
        SELECT value FROM live_monitor_state WHERE key='last_successful_poll_at'
      `).get().value;
    } finally {
      beforeRecovery.close();
    }

    runNode(['live-311.js'], {
      ...baseEnvironment,
      COLLECTOR_SCOPE: 'bid_only',
      BID_CATCHUP_MAX_DAYS: '2',
      NYC311_TEST_PORTAL_PINS: JSON.stringify(pins)
    });
    const afterRecovery = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const state = afterRecovery.prepare(`
        SELECT COUNT(*) AS zones,
          SUM(julianday(last_successful_poll_at)>julianday(?)) AS advanced,
          SUM(last_error IS NOT NULL) AS failed
        FROM bid_collector_zone_state
      `).get(oldWatermark);
      assert.equal(state.zones, 12);
      assert.equal(state.advanced, 12);
      assert.equal(state.failed, 0);
      assert.equal(afterRecovery.prepare(`
        SELECT value FROM live_monitor_state WHERE key='last_successful_poll_at'
      `).get().value, globalWatermark);
    } finally {
      afterRecovery.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
