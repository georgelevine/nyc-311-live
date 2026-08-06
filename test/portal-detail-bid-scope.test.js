'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

process.env.NYC311_SERVER_NO_LISTEN = '1';
process.env.COLLECTOR_SCOPE = 'bid_only';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-portal-bid-scope-'));
const databasePath = path.join(directory, 'archive.sqlite');
process.env.DATABASE_PATH = databasePath;

const MEMBER_PORTAL_ID = '11111111-1111-4111-8111-111111111111';
const OUTSIDE_PORTAL_ID = '22222222-2222-4222-8222-222222222222';

const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE live_monitor_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE live_portal_requests (
    srnumber TEXT PRIMARY KEY,
    portal_id TEXT UNIQUE
  );
  CREATE TABLE business_improvement_district_boundary_versions (
    version TEXT PRIMARY KEY,
    active INTEGER NOT NULL
  );
  CREATE TABLE live_request_bid_memberships (
    srnumber TEXT NOT NULL,
    boundary_version TEXT NOT NULL,
    bid_id INTEGER NOT NULL
  );
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
    fields_json TEXT NOT NULL
  );
  INSERT INTO live_monitor_state VALUES (
    'collector_scope','bid_only','2026-08-06T12:00:00.000Z'
  );
  INSERT INTO business_improvement_district_boundary_versions VALUES ('bids-v1',1);
  INSERT INTO live_portal_requests VALUES ('311-00000061','${MEMBER_PORTAL_ID}');
  INSERT INTO live_portal_requests VALUES ('311-00000062','${OUTSIDE_PORTAL_ID}');
  INSERT INTO live_request_bid_memberships VALUES ('311-00000061','bids-v1',1);
  INSERT INTO portal_requests VALUES (
    '311-00000061','${MEMBER_PORTAL_ID}','In Progress','Noise','Loud Music',NULL,
    '1 TEST STREET',NULL,'2026-08-06T11:00:00.000Z',NULL,NULL,'{}'
  );
  INSERT INTO portal_requests VALUES (
    '311-00000062','${OUTSIDE_PORTAL_ID}','In Progress','Noise','Loud Music',NULL,
    '2 TEST STREET',NULL,'2026-08-06T11:00:00.000Z',NULL,NULL,'{}'
  );
`);
database.close();

const { app } = require('../server');
let server;
let baseUrl;

before(async () => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.close();
    await once(server, 'close');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

async function archivedDetail(portalId) {
  const response = await fetch(
    `${baseUrl}/api/portal-detail?id=${portalId}&preferArchive=1`
  );
  return { status: response.status, body: await response.json() };
}

test('BID-only detail endpoint serves stored active members', async () => {
  const result = await archivedDetail(MEMBER_PORTAL_ID);
  assert.equal(result.status, 200);
  assert.equal(result.body.srnumber, '311-00000061');
});

test('BID-only detail endpoint hides retained citywide records before archive or fetch', async () => {
  const result = await archivedDetail(OUTSIDE_PORTAL_ID);
  assert.equal(result.status, 404);
  assert.match(result.body.error, /outside the active BID collection scope/i);
});

test('BID-only detail endpoint fails closed when web and durable scope disagree', async () => {
  const writable = new DatabaseSync(databasePath);
  writable.prepare(`
    UPDATE live_monitor_state SET value='citywide' WHERE key='collector_scope'
  `).run();
  writable.close();
  const result = await archivedDetail(MEMBER_PORTAL_ID);
  assert.equal(result.status, 503);
  assert.match(result.body.error, /scope is temporarily unavailable/i);
});
