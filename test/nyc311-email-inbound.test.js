'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  MIGRATIONS,
  applyMigrations
} = require('../sqlite-finalization');
const {
  buildAlias,
  createRequestAlias
} = require('../nyc311-email-aliases');
const {
  createNyc311EmailHandler,
  hmacHex,
  persistInboundEmail,
  verifyRawSignature
} = require('../nyc311-email-inbound');

const NOW = new Date('2026-07-23T14:00:00.000Z');
const SECRET = 'a'.repeat(64);
const DOMAIN = 'track.opendata.support';

function createDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-inbound-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,
      suffix INTEGER UNIQUE,
      portal_id TEXT UNIQUE,
      status TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE live_number_queue (
      suffix INTEGER PRIMARY KEY,
      srnumber TEXT NOT NULL UNIQUE,
      audit_outcome TEXT NOT NULL DEFAULT 'pending',
      audit_after TEXT NOT NULL
    );
  `);
  database.prepare(`
    INSERT INTO live_portal_requests (
      srnumber,suffix,portal_id,status,first_seen_at,last_seen_at
    ) VALUES (?,?,?,?,?,?)
  `).run(
    '311-28327449',
    28327449,
    'portal-one',
    'In Progress',
    '2026-07-22T22:46:35.000Z',
    '2026-07-23T13:59:00.000Z'
  );
  database.prepare(`
    INSERT INTO live_portal_requests (
      srnumber,suffix,portal_id,status,first_seen_at,last_seen_at
    ) VALUES (?,?,?,?,?,?)
  `).run(
    '311-28327195',
    28327195,
    'portal-two',
    'In Progress',
    '2026-07-22T22:26:04.000Z',
    '2026-07-23T13:59:00.000Z'
  );
  applyMigrations(database, NOW.toISOString());
  return { database, databasePath };
}

function deterministicRandom() {
  return Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
}

function parsedClosed(overrides = {}) {
  return {
    isNyc311Notification: true,
    deliveryMode: 'direct',
    eventKind: 'Closed',
    serviceRequestNumber: '311-28327449',
    agencyName: 'New York City Police Department',
    agencyAcronym: 'NYPD',
    requestTypeRaw: 'Drug Activity - Use Outside',
    requestType: 'Drug Activity',
    requestSubtype: 'Use Outside',
    location: '124 EAST 15 STREET, MANHATTAN (NEW YORK), NY, 10003',
    submittedAtRaw: '7/22/2026 6:46:35 PM',
    submittedAt: '2026-07-22T18:46:35',
    responseText: 'The agency responded to the complaint.',
    nextUpdateText: null,
    messageId: '<notice-one@customercare.nyc.gov>',
    sender: 'SRNotice@customercare.nyc.gov',
    senderName: 'SRNotice',
    subject: 'SR Closed # 311-28327449',
    bodySource: 'text',
    recipient: null,
    recipientLocalPart: null,
    recipients: [],
    sourceRecipient: null,
    sourceRecipients: [],
    authentication: {
      source: 'direct-message',
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      rawResults: []
    },
    outerMessage: null,
    ...overrides
  };
}

function signedMetadata(recipient, overrides = {}) {
  return {
    version: 1,
    messageId: 'ses-message-one',
    bucket: 'raw-email-bucket',
    key: 'raw/ses-message-one',
    receivedAt: '2026-07-23T13:59:59.000Z',
    source: 'SRNotice@customercare.nyc.gov',
    destinations: [recipient],
    recipients: [recipient],
    verdicts: {
      spamVerdict: 'PASS',
      virusVerdict: 'PASS',
      spfVerdict: 'PASS',
      dkimVerdict: 'PASS',
      dmarcVerdict: 'PASS'
    },
    ...overrides
  };
}

function mockRequest(raw, headers = {}, contentType = 'message/rfc822') {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    body: raw,
    secure: true,
    get(name) {
      return normalizedHeaders[String(name).toLowerCase()] || null;
    },
    is(type) {
      return type === contentType;
    }
  };
}

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
}

function signedHeaders(raw, recipient, metadata = signedMetadata(recipient), {
  now = NOW,
  secret = SECRET
} = {}) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const encoded = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
  const bodyHex = hmacHex(secret, raw);
  const envelopeHex = hmacHex(
    secret,
    Buffer.from(`v1\n${timestamp}\n${encoded}\n${bodyHex}`, 'utf8')
  );
  return {
    'x-nyc311-email-version': '1',
    'x-nyc311-email-timestamp': timestamp,
    'x-nyc311-email-metadata': encoded,
    'x-nyc311-email-signature': `v1=${bodyHex}`,
    'x-nyc311-email-envelope-signature': `v1=${envelopeHex}`,
    'x-nyc311-recipient': recipient
  };
}

test('email migrations create durable event, alias, and subscription job tables', t => {
  const { database } = createDatabase(t);
  t.after(() => database.close());
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(MIGRATIONS.some(item => item.name === 'add_nyc311_email_ingestion'), true);
  assert.equal(MIGRATIONS.some(
    item => item.name === 'add_nyc311_email_subscription_jobs'
  ), true);
  assert.equal(MIGRATIONS.some(item => item.name === 'add_nyc311_initial_email_jobs'), true);
  assert.equal(MIGRATIONS.at(-1).name, 'generalize_nyc311_email_monitoring_scopes');
  const tables = new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table'
  `).all().map(row => row.name));
  assert.equal(tables.has('nyc311_email_aliases'), true);
  assert.equal(tables.has('nyc311_email_events'), true);
  assert.equal(tables.has('nyc311_email_subscription_jobs'), true);
  assert.equal(tables.has('nyc311_initial_email_jobs'), true);
  const eventColumns = new Set(
    database.prepare('PRAGMA table_info(nyc311_email_events)').all().map(row => row.name)
  );
  assert.equal(eventColumns.has('raw_sha256'), true);
  assert.equal(eventColumns.has('raw_mime'), false);
});

test('creates an unguessable alias without provisioning a mailbox and reuses it per SR', t => {
  const { database } = createDatabase(t);
  t.after(() => database.close());
  const first = createRequestAlias(database, {
    srnumber: '311-28327449',
    domain: DOMAIN,
    now: NOW,
    randomBytes: deterministicRandom
  });
  assert.equal(first.created, true);
  assert.match(first.recipient_address, /^r28327449-[a-z0-9_-]{16,}@track\.opendata\.support$/);
  const second = createRequestAlias(database, {
    srnumber: '311-28327449',
    domain: DOMAIN,
    now: new Date(NOW.getTime() + 1000)
  });
  assert.equal(second.created, false);
  assert.equal(second.recipient_address, first.recipient_address);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM nyc311_email_aliases').get().count,
    1
  );
  const generated = buildAlias({
    srnumber: '311-28327195',
    domain: DOMAIN,
    randomBytes: deterministicRandom
  });
  assert.equal(generated.token_hash.length, 64);
});

test('persists parsed events idempotently and wakes closure verification without changing status', t => {
  const { database } = createDatabase(t);
  t.after(() => database.close());
  const alias = createRequestAlias(database, {
    srnumber: '311-28327449',
    domain: DOMAIN,
    now: NOW,
    randomBytes: deterministicRandom
  });
  const raw = Buffer.from('From: SRNotice@customercare.nyc.gov\r\n\r\nclosed');
  const metadata = signedMetadata(alias.recipient_address);
  const first = persistInboundEmail(database, {
    raw,
    parsed: parsedClosed({ recipient: alias.recipient_address }),
    metadata,
    envelopeRecipient: alias.recipient_address,
    inboundDomain: DOMAIN,
    now: NOW
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.closure_wake_queued, 1);
  assert.equal(first.forward.recipient_address, alias.recipient_address);
  assert.equal(first.forward.srnumber, '311-28327449');
  assert.equal(first.forward.event_kind, 'Closed');
  assert.equal(first.forward.response_text, 'The agency responded to the complaint.');
  const event = database.prepare('SELECT * FROM nyc311_email_events').get();
  assert.equal(event.parse_outcome, 'parsed');
  assert.equal(event.alias_match_status, 'matched');
  assert.equal(event.reconciled_srnumber, '311-28327449');
  assert.equal(event.closure_wake_queued, 1);
  assert.equal(event.raw_bytes, raw.length);
  assert.equal(event.s3_key, metadata.key);
  assert.equal(event.spam_verdict, 'PASS');
  assert.equal(event.response_text, 'The agency responded to the complaint.');
  assert.equal(
    database.prepare('SELECT status FROM live_portal_requests WHERE srnumber=?')
      .get('311-28327449').status,
    'In Progress'
  );
  const followup = database.prepare(`
    SELECT state,next_check_at FROM request_followup_queue WHERE srnumber=?
  `).get('311-28327449');
  assert.equal(followup.state, 'closing');
  assert.equal(followup.next_check_at, NOW.toISOString());

  const second = persistInboundEmail(database, {
    raw,
    parsed: parsedClosed({ recipient: alias.recipient_address }),
    metadata: { ...metadata, messageId: 'a-retry-id' },
    envelopeRecipient: alias.recipient_address,
    inboundDomain: DOMAIN,
    now: new Date(NOW.getTime() + 1000)
  });
  assert.equal(second.duplicate, true);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM nyc311_email_events').get().count,
    1
  );
});

test('flags alias/SR mismatches and does not wake either request', t => {
  const { database } = createDatabase(t);
  t.after(() => database.close());
  const alias = createRequestAlias(database, {
    srnumber: '311-28327449',
    domain: DOMAIN,
    now: NOW,
    randomBytes: deterministicRandom
  });
  const result = persistInboundEmail(database, {
    raw: Buffer.from('mismatched raw message'),
    parsed: parsedClosed({
      serviceRequestNumber: '311-28327195',
      messageId: '<mismatch@customercare.nyc.gov>',
      recipient: alias.recipient_address
    }),
    metadata: signedMetadata(alias.recipient_address, { messageId: 'ses-mismatch' }),
    envelopeRecipient: alias.recipient_address,
    inboundDomain: DOMAIN,
    now: NOW
  });
  assert.equal(result.alias_match_status, 'mismatch');
  assert.equal(result.closure_wake_queued, 0);
  assert.equal(result.forward, null);
  const event = database.prepare('SELECT * FROM nyc311_email_events').get();
  assert.equal(event.srnumber_mismatch, 1);
  assert.equal(event.reconciled_srnumber, null);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name='request_followup_queue'
    `).get().count,
    0
  );
});

test('stores parser failures without raw MIME and leaves official records untouched', t => {
  const { database } = createDatabase(t);
  t.after(() => database.close());
  const alias = createRequestAlias(database, {
    srnumber: '311-28327449',
    domain: DOMAIN,
    now: NOW,
    randomBytes: deterministicRandom
  });
  const raw = Buffer.from('malformed but authenticated MIME bytes');
  const result = persistInboundEmail(database, {
    raw,
    parseError: new Error('test parser failure'),
    metadata: signedMetadata(alias.recipient_address, { messageId: 'ses-parse-error' }),
    envelopeRecipient: alias.recipient_address,
    inboundDomain: DOMAIN,
    now: NOW
  });
  assert.equal(result.parse_outcome, 'error');
  const event = database.prepare(`
    SELECT parse_outcome,parse_error,raw_sha256,raw_bytes,parsed_json
    FROM nyc311_email_events
  `).get();
  assert.equal(event.parse_outcome, 'error');
  assert.equal(event.parse_error, 'test parser failure');
  assert.equal(event.raw_bytes, raw.length);
  assert.equal(event.raw_sha256, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(event.parsed_json, null);
  assert.equal(
    database.prepare('SELECT status FROM live_portal_requests WHERE srnumber=?')
      .get('311-28327449').status,
    'In Progress'
  );
});

test('handler verifies both signed layers, SES verdicts, timestamp, and idempotency', async t => {
  const { database, databasePath } = createDatabase(t);
  const alias = createRequestAlias(database, {
    srnumber: '311-28327449',
    domain: DOMAIN,
    now: NOW,
    randomBytes: deterministicRandom
  });
  database.prepare(`
    INSERT INTO nyc311_email_subscription_jobs (
      srnumber,alias_id,bid_id,state,attempts,next_attempt_at,last_error,
      created_at,updated_at,subscribed_at,scope_type,scope_id,scope_label
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    '311-28327449', alias.id, 68, 'subscribed', 1, NOW.toISOString(), null,
    NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    'bid', 68, 'Hudson Square BID'
  );
  database.close();
  const raw = Buffer.from('From: SRNotice@customercare.nyc.gov\r\n\r\nclosed');
  const handler = createNyc311EmailHandler({
    env: {
      INBOUND_EMAIL_WEBHOOK_SECRET: SECRET,
      INBOUND_EMAIL_DOMAIN: DOMAIN
    },
    databasePath,
    parseNotification: async () => parsedClosed({ recipient: alias.recipient_address }),
    now: () => new Date(NOW),
    requireHttps: true
  });
  const headers = signedHeaders(raw, alias.recipient_address);
  const accepted = mockResponse();
  await handler(mockRequest(raw, headers), accepted);
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(accepted.body, {
    accepted: true,
    duplicate: false,
    event_id: 1,
    forward: {
      recipient_address: alias.recipient_address,
      srnumber: '311-28327449',
      event_kind: 'Closed',
      subject: 'SR Closed # 311-28327449',
      agency_name: 'New York City Police Department',
      agency_acronym: 'NYPD',
      request_type: 'Drug Activity',
      request_subtype: 'Use Outside',
      location: '124 EAST 15 STREET, MANHATTAN (NEW YORK), NY, 10003',
      submitted_at: '2026-07-22T18:46:35',
      response_text: 'The agency responded to the complaint.',
      next_update_text: null,
      received_at: '2026-07-23T13:59:59.000Z',
      scope_type: 'bid',
      scope_id: 68,
      scope_label: 'Hudson Square BID'
    }
  });

  const duplicate = mockResponse();
  await handler(mockRequest(raw, headers), duplicate);
  assert.equal(duplicate.statusCode, 202);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.forward, null);

  const badSignature = mockResponse();
  await handler(mockRequest(Buffer.from(`${raw}tampered`), headers), badSignature);
  assert.equal(badSignature.statusCode, 401);
  assert.deepEqual(badSignature.body, { error: 'invalid webhook authentication' });

  const staleHeaders = signedHeaders(raw, alias.recipient_address, signedMetadata(
    alias.recipient_address,
    { messageId: 'ses-stale' }
  ), { now: new Date(NOW.getTime() - 301_000) });
  const stale = mockResponse();
  await handler(mockRequest(raw, staleHeaders), stale);
  assert.equal(stale.statusCode, 401);

  const failedMetadata = signedMetadata(alias.recipient_address, {
    messageId: 'ses-spam',
    verdicts: {
      spamVerdict: 'FAIL',
      virusVerdict: 'PASS'
    }
  });
  const failedVerdict = mockResponse();
  await handler(
    mockRequest(raw, signedHeaders(raw, alias.recipient_address, failedMetadata)),
    failedVerdict
  );
  assert.equal(failedVerdict.statusCode, 422);

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => verified.close());
  assert.equal(
    verified.prepare('SELECT COUNT(*) AS count FROM nyc311_email_events').get().count,
    1
  );
});

test('missing secret is unavailable and legacy sha256 signature remains testable', async () => {
  const raw = Buffer.from('exact raw bytes');
  const sha256Signature = `sha256=${hmacHex(SECRET, raw)}`;
  assert.equal(verifyRawSignature(raw, sha256Signature, SECRET), true);
  assert.equal(verifyRawSignature(Buffer.from('different'), sha256Signature, SECRET), false);

  const handler = createNyc311EmailHandler({
    env: {},
    parseNotification: async () => parsedClosed(),
    requireHttps: false
  });
  const response = mockResponse();
  await handler(mockRequest(raw), response);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: 'inbound email receiver unavailable' });
});
