'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { readStoredPortalDetail } = require('../stored-portal-detail');

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
    address: '198-08 53 AVENUE, QUEENS (FRESH MEADOWS), NY, 11365',
    nextUpdate: '24 Hours',
    dateReported: '2026-07-20T22:20:36.000Z',
    updatedOn: '2026-07-20T22:21:05.000Z',
    dateClosed: null,
    fields: {
      'Problem Details': 'Catch Basin Clogged',
      Agency: 'DEP'
    }
  });
});

test('keeps the stored detail usable when fields_json is malformed', t => {
  const databasePath = fixture(t);
  insertDetail(databasePath, '{not valid JSON');

  const detail = readStoredPortalDetail(databasePath, PORTAL_ID);

  assert.equal(detail.problemDetails, 'Catch Basin Clogged');
  assert.deepEqual(detail.fields, {});
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
