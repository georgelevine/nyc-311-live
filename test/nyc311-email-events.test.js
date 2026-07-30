'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  MAX_NEXT_UPDATE_TEXT,
  MAX_RESPONSE_TEXT,
  readRequestEmailUpdates
} = require('../nyc311-email-events');

const SRNUMBER = '311-28327449';

function fixture(t, { aliases = true, events = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-email-events-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const database = new DatabaseSync(databasePath);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (aliases) {
    database.exec(`
      CREATE TABLE nyc311_email_aliases (
        srnumber TEXT,
        state TEXT,
        subscribed_at TEXT,
        last_received_at TEXT,
        recipient_address TEXT,
        token_hash TEXT
      )
    `);
  }
  if (events) {
    database.exec(`
      CREATE TABLE nyc311_email_events (
        id INTEGER PRIMARY KEY,
        reconciled_srnumber TEXT,
        parse_outcome TEXT,
        srnumber_mismatch INTEGER,
        alias_match_status TEXT,
        event_kind TEXT,
        agency_name TEXT,
        agency_acronym TEXT,
        request_type TEXT,
        request_subtype TEXT,
        response_text TEXT,
        next_update_text TEXT,
        received_at TEXT,
        closure_wake_queued INTEGER,
        raw_sha256 TEXT,
        s3_bucket TEXT,
        s3_key TEXT,
        ses_message_id TEXT,
        sender TEXT,
        parsed_json TEXT
      )
    `);
    database.exec(`
      CREATE INDEX nyc311_email_events_request_idx
        ON nyc311_email_events(reconciled_srnumber,received_at);
      CREATE INDEX nyc311_email_events_outcome_idx
        ON nyc311_email_events(parse_outcome,received_at);
    `);
  }
  database.close();
  return databasePath;
}

function insertAlias(database, overrides = {}) {
  database.prepare(`
    INSERT INTO nyc311_email_aliases (
      srnumber,state,subscribed_at,last_received_at,recipient_address,token_hash
    ) VALUES (@srnumber,@state,@subscribed_at,@last_received_at,@recipient_address,@token_hash)
  `).run({
    srnumber: SRNUMBER,
    state: 'active',
    subscribed_at: '2026-07-23T13:00:00.000Z',
    last_received_at: '2026-07-23T14:02:00.000Z',
    recipient_address: 'secret-alias@track.opendata.support',
    token_hash: 'sensitive-token-hash',
    ...overrides
  });
}

function insertEvent(database, overrides = {}) {
  database.prepare(`
    INSERT INTO nyc311_email_events (
      reconciled_srnumber,parse_outcome,srnumber_mismatch,alias_match_status,
      event_kind,agency_name,agency_acronym,request_type,request_subtype,
      response_text,next_update_text,received_at,closure_wake_queued,
      raw_sha256,s3_bucket,s3_key,ses_message_id,sender,parsed_json
    ) VALUES (
      @reconciled_srnumber,@parse_outcome,@srnumber_mismatch,@alias_match_status,
      @event_kind,@agency_name,@agency_acronym,@request_type,@request_subtype,
      @response_text,@next_update_text,@received_at,@closure_wake_queued,
      @raw_sha256,@s3_bucket,@s3_key,@ses_message_id,@sender,@parsed_json
    )
  `).run({
    reconciled_srnumber: SRNUMBER,
    parse_outcome: 'parsed',
    srnumber_mismatch: 0,
    alias_match_status: 'matched',
    event_kind: 'Updated',
    agency_name: 'Department of Consumer and Worker Protection',
    agency_acronym: 'DCWP',
    request_type: 'Consumer Complaint',
    request_subtype: 'Tobacco Sales',
    response_text: 'The agency is reviewing the request.',
    next_update_text: 'The next update is due within 35 days.',
    received_at: '2026-07-23T14:01:00.000Z',
    closure_wake_queued: 0,
    raw_sha256: 'sensitive-raw-hash',
    s3_bucket: 'sensitive-bucket',
    s3_key: 'sensitive-key',
    ses_message_id: 'sensitive-ses-id',
    sender: 'sensitive-sender@example.com',
    parsed_json: '{"sensitive":true}',
    ...overrides
  });
}

test('returns a safe subscription summary and parsed request updates newest first', t => {
  const databasePath = fixture(t);
  const database = new DatabaseSync(databasePath);
  insertAlias(database);
  insertEvent(database);
  insertEvent(database, {
    alias_match_status: 'attached',
    event_kind: 'Closed',
    agency_name: 'New York City Police Department',
    agency_acronym: 'NYPD',
    response_text: 'The complaint was investigated.',
    next_update_text: null,
    received_at: '2026-07-23T14:02:00.000Z',
    closure_wake_queued: 1,
    raw_sha256: 'another-sensitive-raw-hash',
    ses_message_id: 'another-sensitive-ses-id'
  });
  database.close();

  const result = readRequestEmailUpdates(databasePath, SRNUMBER);

  assert.deepEqual(result.subscription, {
    state: 'active',
    subscribed_at: '2026-07-23T13:00:00.000Z',
    last_received_at: '2026-07-23T14:02:00.000Z'
  });
  assert.equal(result.total, 2);
  assert.deepEqual(result.updates.map(update => update.event_kind), ['Closed', 'Updated']);
  assert.equal(result.updates[0].closure_wake_queued, true);
  assert.deepEqual(Object.keys(result.updates[0]), [
    'id',
    'event_kind',
    'agency_name',
    'agency_acronym',
    'request_type',
    'request_subtype',
    'response_text',
    'next_update_text',
    'received_at',
    'closure_wake_queued'
  ]);
  assert.equal(JSON.stringify(result).includes('secret-alias'), false);
  assert.equal(JSON.stringify(result).includes('sensitive-'), false);
});

test('excludes mismatches, parser failures, unregistered messages, and other requests', t => {
  const databasePath = fixture(t);
  const database = new DatabaseSync(databasePath);
  insertEvent(database);
  insertEvent(database, {
    srnumber_mismatch: 1,
    alias_match_status: 'mismatch',
    received_at: '2026-07-23T14:02:00.000Z',
    raw_sha256: 'mismatch'
  });
  insertEvent(database, {
    parse_outcome: 'error',
    received_at: '2026-07-23T14:03:00.000Z',
    raw_sha256: 'parser-error'
  });
  insertEvent(database, {
    reconciled_srnumber: null,
    alias_match_status: 'unregistered',
    received_at: '2026-07-23T14:04:00.000Z',
    raw_sha256: 'unregistered'
  });
  insertEvent(database, {
    reconciled_srnumber: '311-28327195',
    received_at: '2026-07-23T14:05:00.000Z',
    raw_sha256: 'other-request'
  });
  database.close();

  const result = readRequestEmailUpdates(databasePath, SRNUMBER);

  assert.equal(result.total, 1);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].received_at, '2026-07-23T14:01:00.000Z');
});

test('limits update count and bounds displayed response fields', t => {
  const databasePath = fixture(t);
  const database = new DatabaseSync(databasePath);
  for (let index = 0; index < 3; index += 1) {
    insertEvent(database, {
      response_text: ` ${'r'.repeat(MAX_RESPONSE_TEXT + 100)} `,
      next_update_text: ` ${'n'.repeat(MAX_NEXT_UPDATE_TEXT + 100)} `,
      received_at: `2026-07-23T14:0${index}:00.000Z`,
      raw_sha256: `hash-${index}`
    });
  }
  database.close();

  const result = readRequestEmailUpdates(databasePath, SRNUMBER, { limit: 2 });

  assert.equal(result.total, 3);
  assert.equal(result.updates.length, 2);
  assert.equal(result.updates[0].received_at, '2026-07-23T14:02:00.000Z');
  assert.equal(result.updates[0].response_text.length, MAX_RESPONSE_TEXT - 1);
  assert.equal(result.updates[0].next_update_text.length, MAX_NEXT_UPDATE_TEXT - 1);
});

test('pins request reads to the request-number index', t => {
  const databasePath = fixture(t);
  const database = new DatabaseSync(databasePath);
  insertEvent(database);
  database.close();
  const prepared = [];
  const result = readRequestEmailUpdates(databasePath, SRNUMBER, {
    openDatabase(filename, options) {
      const opened = new DatabaseSync(filename, options);
      return {
        prepare(sql) {
          prepared.push(sql);
          return opened.prepare(sql);
        },
        close() {
          opened.close();
        }
      };
    }
  });

  assert.equal(result.total, 1);
  const eventReads = prepared.filter(sql => /FROM nyc311_email_events\b/.test(sql));
  assert.equal(eventReads.length, 2);
  assert.equal(eventReads.every(sql => (
    /INDEXED BY nyc311_email_events_request_idx/.test(sql)
  )), true);
});

test('returns an empty result when the database or email tables are absent', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-email-events-missing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missingDatabase = path.join(directory, 'missing.sqlite');
  const withoutTables = fixture(t, { aliases: false, events: false });

  assert.deepEqual(readRequestEmailUpdates(missingDatabase, SRNUMBER), {
    srnumber: SRNUMBER,
    subscription: null,
    updates: [],
    total: 0
  });
  assert.equal(fs.existsSync(missingDatabase), false);
  assert.deepEqual(readRequestEmailUpdates(withoutTables, SRNUMBER), {
    srnumber: SRNUMBER,
    subscription: null,
    updates: [],
    total: 0
  });
});

test('opens read-only and closes the database when a read fails', () => {
  let openOptions;
  let closeCalls = 0;
  const failure = new Error('simulated read failure');

  assert.throws(() => readRequestEmailUpdates('/archive.sqlite', SRNUMBER, {
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
