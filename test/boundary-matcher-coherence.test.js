'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  refreshActiveBoundaryMatchers
} = require('../boundary-matcher-coherence');

function databaseWithVersions({
  policePrecinct = '26A',
  businessImprovementDistrict = '2026-01-01'
} = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE police_precinct_boundary_versions (
      version TEXT PRIMARY KEY,
      active INTEGER NOT NULL
    );
    CREATE TABLE business_improvement_district_boundary_versions (
      version TEXT PRIMARY KEY,
      active INTEGER NOT NULL
    );
  `);
  if (policePrecinct) {
    database.prepare(`
      INSERT INTO police_precinct_boundary_versions(version,active) VALUES (?,1)
    `).run(policePrecinct);
  }
  if (businessImprovementDistrict) {
    database.prepare(`
      INSERT INTO business_improvement_district_boundary_versions(version,active)
      VALUES (?,1)
    `).run(businessImprovementDistrict);
  }
  return database;
}

function activate(database, table, version) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`UPDATE ${table} SET active=0`).run();
    if (version) {
      database.prepare(`
        INSERT INTO ${table}(version,active) VALUES (?,1)
        ON CONFLICT(version) DO UPDATE SET active=1
      `).run(version);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function loaders(database, calls, overrides = {}) {
  return {
    loadPolicePrecinctMatcher: overrides.loadPolicePrecinctMatcher || (() => {
      calls.policePrecinct += 1;
      const row = database.prepare(`
        SELECT version FROM police_precinct_boundary_versions
        WHERE active=1 LIMIT 1
      `).get();
      return row ? { version: row.version, kind: 'precinct' } : null;
    }),
    loadBusinessImprovementDistrictMatcher:
      overrides.loadBusinessImprovementDistrictMatcher || (() => {
        calls.businessImprovementDistrict += 1;
        const row = database.prepare(`
          SELECT version FROM business_improvement_district_boundary_versions
          WHERE active=1 LIMIT 1
        `).get();
        return row ? { version: row.version, kind: 'bid' } : null;
      })
  };
}

test('keeps current matchers without reloading unchanged active releases', t => {
  const database = databaseWithVersions();
  t.after(() => database.close());
  const current = {
    policePrecinctMatcher: { version: '26A', marker: 'current-precinct' },
    businessImprovementDistrictMatcher: {
      version: '2026-01-01',
      marker: 'current-bid'
    }
  };
  const calls = { policePrecinct: 0, businessImprovementDistrict: 0 };

  const result = refreshActiveBoundaryMatchers(
    database,
    current,
    loaders(database, calls)
  );

  assert.equal(result.policePrecinctMatcher, current.policePrecinctMatcher);
  assert.equal(
    result.businessImprovementDistrictMatcher,
    current.businessImprovementDistrictMatcher
  );
  assert.deepEqual(result.reloaded, {
    policePrecinct: false,
    businessImprovementDistrict: false
  });
  assert.deepEqual(calls, { policePrecinct: 0, businessImprovementDistrict: 0 });
});

test('reloads only the matcher whose active boundary release changed', t => {
  const database = databaseWithVersions();
  t.after(() => database.close());
  activate(database, 'police_precinct_boundary_versions', '26B');
  const calls = { policePrecinct: 0, businessImprovementDistrict: 0 };

  const result = refreshActiveBoundaryMatchers(database, {
    policePrecinctMatcher: { version: '26A' },
    businessImprovementDistrictMatcher: { version: '2026-01-01' }
  }, loaders(database, calls));

  assert.deepEqual(result.activeVersions, {
    policePrecinct: '26B',
    businessImprovementDistrict: '2026-01-01'
  });
  assert.equal(result.policePrecinctMatcher.version, '26B');
  assert.equal(result.businessImprovementDistrictMatcher.version, '2026-01-01');
  assert.deepEqual(result.reloaded, {
    policePrecinct: true,
    businessImprovementDistrict: false
  });
  assert.deepEqual(calls, { policePrecinct: 1, businessImprovementDistrict: 0 });
});

test('detects a new active BID release independently of the precinct release', t => {
  const database = databaseWithVersions();
  t.after(() => database.close());
  activate(
    database,
    'business_improvement_district_boundary_versions',
    '2026-07-30'
  );
  const calls = { policePrecinct: 0, businessImprovementDistrict: 0 };

  const result = refreshActiveBoundaryMatchers(database, {
    policePrecinctMatcher: { version: '26A' },
    businessImprovementDistrictMatcher: { version: '2026-01-01' }
  }, loaders(database, calls));

  assert.equal(result.policePrecinctMatcher.version, '26A');
  assert.equal(
    result.businessImprovementDistrictMatcher.version,
    '2026-07-30'
  );
  assert.deepEqual(result.reloaded, {
    policePrecinct: false,
    businessImprovementDistrict: true
  });
  assert.deepEqual(calls, { policePrecinct: 0, businessImprovementDistrict: 1 });
});

test('drops a cached matcher when its boundary release is deactivated', t => {
  const database = databaseWithVersions();
  t.after(() => database.close());
  activate(database, 'business_improvement_district_boundary_versions', null);
  const calls = { policePrecinct: 0, businessImprovementDistrict: 0 };

  const result = refreshActiveBoundaryMatchers(database, {
    policePrecinctMatcher: { version: '26A' },
    businessImprovementDistrictMatcher: { version: '2026-01-01' }
  }, loaders(database, calls));

  assert.equal(result.businessImprovementDistrictMatcher, null);
  assert.deepEqual(result.reloaded, {
    policePrecinct: false,
    businessImprovementDistrict: true
  });
  assert.deepEqual(calls, { policePrecinct: 0, businessImprovementDistrict: 1 });
});

test('rejects a loader result that does not match the observed active release', t => {
  const database = databaseWithVersions();
  t.after(() => database.close());
  activate(database, 'police_precinct_boundary_versions', '26B');
  const calls = { policePrecinct: 0, businessImprovementDistrict: 0 };

  assert.throws(
    () => refreshActiveBoundaryMatchers(database, {
      policePrecinctMatcher: { version: '26A' },
      businessImprovementDistrictMatcher: { version: '2026-01-01' }
    }, loaders(database, calls, {
      loadPolicePrecinctMatcher: () => ({ version: '26A' })
    })),
    /expected 26B, loaded 26A/
  );
});

test('collector refreshes matchers under its write lock before processing poll rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'live-311.js'), 'utf8');
  const savePollStart = source.indexOf('function savePoll(records)');
  const savePollEnd = source.indexOf('\nfunction runArchiveRange(', savePollStart);
  const savePoll = source.slice(savePollStart, savePollEnd);
  const lock = savePoll.indexOf("db.exec('BEGIN IMMEDIATE')");
  const refresh = savePoll.indexOf('refreshActiveBoundaryMatchers(');
  const processRows = savePoll.indexOf('for (const { pin, suffix } of numbered)');

  assert.ok(lock >= 0, 'poll processing must take an immediate write lock');
  assert.ok(
    lock < refresh && refresh < processRows,
    'active releases must be refreshed after locking and before processing rows'
  );
});
