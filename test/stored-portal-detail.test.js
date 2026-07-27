'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  readStoredPortalDetail,
  storedPortalDetailFromRow
} = require('../stored-portal-detail');

const PORTAL_ID = '7b9074fa-8e64-4c6d-ab01-6eb36bf62a80';

function fixture(t, { withTable = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-portal-detail-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const database = new DatabaseSync(databasePath);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (withTable) {
    database.exec(`
      CREATE TABLE portal_requests (
        srnumber TEXT PRIMARY KEY,
        portal_id TEXT UNIQUE,
        status TEXT,
        problem TEXT,
        problem_details TEXT,
        additional_details TEXT,
        address TEXT,
        next_update TEXT,
        date_reported TEXT,
        updated_on TEXT,
        date_closed TEXT,
        fields_json TEXT
      )
    `);
  }
  database.close();
  return databasePath;
}

function insertDetail(databasePath, fieldsJson = JSON.stringify({
  'Problem Details': 'Catch Basin Clogged',
  'Agency Response': 'The agency inspected the location and corrected the condition.',
  Agency: 'DEP'
})) {
  const database = new DatabaseSync(databasePath);
  database.prepare(`
    INSERT INTO portal_requests (
      srnumber, portal_id, status, problem, problem_details, additional_details,
      address, next_update, date_reported, updated_on, date_closed, fields_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '311-28303724',
    PORTAL_ID,
    'In Progress',
    'Sewer Maintenance',
    'Catch Basin Clogged',
    'Near the northwest corner',
    '198-08 53 AVENUE, QUEENS (FRESH MEADOWS), NY, 11365',
    '24 Hours',
    '2026-07-20T22:20:36.000Z',
    '2026-07-20T22:21:05.000Z',
    null,
    fieldsJson
  );
  database.close();
}

test('loads a stored row using the same camelCase contract as a Portal detail', t => {
  const databasePath = fixture(t);
  insertDetail(databasePath);

  assert.deepEqual(readStoredPortalDetail(databasePath, PORTAL_ID), {
    srnumber: '311-28303724',
    status: 'In Progress',
    problem: 'Sewer Maintenance',
    problemDetails: 'Catch Basin Clogged',
    additionalDetails: 'Near the northwest corner',
    agencyResponse: 'The agency inspected the location and corrected the condition.',
    agencyResponseSource: 'NYC311 Portal',
    agencyResponseUpdatedAt: null,
    address: '198-08 53 AVENUE, QUEENS (FRESH MEADOWS), NY, 11365',
    nextUpdate: '24 Hours',
    dateReported: '2026-07-20T22:20:36.000Z',
    updatedOn: '2026-07-20T22:21:05.000Z',
    dateClosed: null,
    fields: {
      'Problem Details': 'Catch Basin Clogged',
      'Agency Response': 'The agency inspected the location and corrected the condition.',
      Agency: 'DEP'
    }
  });
});

test('keeps the stored detail usable when fields_json is malformed', t => {
  const databasePath = fixture(t);
  insertDetail(databasePath, '{not valid JSON');

  const detail = readStoredPortalDetail(databasePath, PORTAL_ID);

  assert.equal(detail.problemDetails, 'Catch Basin Clogged');
  assert.equal(detail.agencyResponse, null);
  assert.deepEqual(detail.fields, {});
});

test('preserves one-time official API provenance without calling it Portal data', t => {
  const databasePath = fixture(t);
  insertDetail(databasePath, JSON.stringify({
    'Problem Details': 'Non-Chronic',
    'Agency Response': 'The outreach team contacted the person.',
    'Agency Response Source': 'NYC311 Public API · one-time reconciliation',
    'Agency Response Updated At': '2026-07-23T16:39:05.000Z',
    Agency: 'Department of Homeless Services'
  }));

  const detail = readStoredPortalDetail(databasePath, PORTAL_ID);

  assert.equal(detail.agencyResponse, 'The outreach team contacted the person.');
  assert.equal(
    detail.agencyResponseSource,
    'NYC311 Public API · one-time reconciliation'
  );
  assert.equal(detail.agencyResponseUpdatedAt, '2026-07-23T16:39:05.000Z');
});

test('projects PostgreSQL rows without reparsing JSONB objects', () => {
  const fields = {
    'Problem Details': 'Loud Music/Party',
    'Agency Response': 'Officers responded and the condition was corrected.',
    Agency: 'NYPD'
  };
  assert.deepEqual(storedPortalDetailFromRow({
    srnumber: '311-28367645',
    status: 'Closed',
    problem: 'Noise - Street/Sidewalk',
    problem_details: 'Loud Music/Party',
    additional_details: null,
    address: '1 CENTRE STREET, MANHATTAN, NY, 10007',
    next_update: null,
    date_reported: new Date('2026-07-26T05:45:00.000Z'),
    updated_on: new Date('2026-07-26T05:52:04.000Z'),
    date_closed: new Date('2026-07-26T05:52:04.000Z'),
    fields_json: fields
  }), {
    srnumber: '311-28367645',
    status: 'Closed',
    problem: 'Noise - Street/Sidewalk',
    problemDetails: 'Loud Music/Party',
    additionalDetails: null,
    agencyResponse: 'Officers responded and the condition was corrected.',
    agencyResponseSource: 'NYC311 Portal',
    agencyResponseUpdatedAt: null,
    address: '1 CENTRE STREET, MANHATTAN, NY, 10007',
    nextUpdate: null,
    dateReported: '2026-07-26T05:45:00.000Z',
    updatedOn: '2026-07-26T05:52:04.000Z',
    dateClosed: '2026-07-26T05:52:04.000Z',
    fields
  });
});

test('returns null when the database, table, or portal row is absent', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-portal-detail-missing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missingDatabase = path.join(directory, 'missing.sqlite');

  assert.equal(readStoredPortalDetail(missingDatabase, PORTAL_ID), null);
  assert.equal(fs.existsSync(missingDatabase), false);
  assert.equal(readStoredPortalDetail(fixture(t, { withTable: false }), PORTAL_ID), null);
  assert.equal(readStoredPortalDetail(fixture(t), PORTAL_ID), null);
});

test('opens read-only and closes the database when a read fails', () => {
  let openOptions;
  let closeCalls = 0;
  const failure = new Error('simulated read failure');

  assert.throws(() => readStoredPortalDetail('/archive.sqlite', PORTAL_ID, {
    existsSync: () => true,
    openDatabase: (_filename, options) => {
      openOptions = options;
      return {
        prepare() {
          throw failure;
        },
        close() {
          closeCalls += 1;
        }
      };
    }
  }), failure);

  assert.deepEqual(openOptions, { readOnly: true });
  assert.equal(closeCalls, 1);
});
