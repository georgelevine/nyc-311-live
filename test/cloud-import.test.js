const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
const {
  booleanValue,
  jsonObject,
  liveSource,
  requireSourceSchema,
  sourceManifest,
  timestamp
} = require('../cloud/import-sqlite');

test('cloud importer normalizes Portal timestamps and rejects corrupt values', () => {
  assert.equal(timestamp('7/20/2026 7:38:17 PM', 'submitted'), '2026-07-20T19:38:17.000Z');
  assert.equal(timestamp('2026-07-20T19:38:17.000Z', 'submitted'), '2026-07-20T19:38:17.000Z');
  assert.equal(timestamp(null, 'optional'), null);
  assert.throws(() => timestamp(null, 'required', true), /required is required/);
  assert.throws(() => timestamp('not-a-date', 'submitted'), /not a valid timestamp/);
});
test('cloud importer keeps JSON strict and derives record provenance', () => {
  assert.deepEqual(jsonObject('{"source":"number_audit"}', 'raw'), { source: 'number_audit' });
  assert.throws(() => jsonObject('{bad', 'raw'), /not valid JSON/);
  assert.equal(liveSource({ latitude: null, longitude: null }, { coordinate_free: true }), 'number_audit');
  assert.equal(liveSource({ latitude: 40.7, longitude: -74 }, {}), 'map');
  assert.equal(booleanValue(1), true);
  assert.equal(booleanValue('0'), false);
});

test('source manifest requires every lifecycle table and records key ranges', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-import-'));
  const filename = path.join(directory, 'snapshot.sqlite');
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE live_portal_requests (srnumber TEXT PRIMARY KEY, suffix INTEGER);
    CREATE TABLE portal_requests (srnumber TEXT PRIMARY KEY, suffix INTEGER);
    CREATE TABLE live_detail_queue (srnumber TEXT PRIMARY KEY);
    CREATE TABLE live_number_queue (suffix INTEGER PRIMARY KEY);
    CREATE TABLE number_ledger (suffix INTEGER PRIMARY KEY);
    CREATE TABLE live_monitor_state (key TEXT PRIMARY KEY);
    CREATE TABLE request_status_history (id INTEGER PRIMARY KEY);
    CREATE TABLE request_closure_snapshots (id INTEGER PRIMARY KEY);
    CREATE TABLE request_followup_queue (srnumber TEXT PRIMARY KEY);
    INSERT INTO live_portal_requests VALUES ('311-00000001',1);
    INSERT INTO portal_requests VALUES ('311-00000001',1),('311-00000002',2);
  `);
  assert.doesNotThrow(() => requireSourceSchema(database));
  const manifest = sourceManifest(database);
  assert.deepEqual(manifest.live_portal_requests, {
    count: 1,
    minimum: '311-00000001',
    maximum: '311-00000001'
  });
  assert.equal(manifest.archive_only_promotions, 1);
  database.close();
  fs.rmSync(directory, { recursive: true });
});
