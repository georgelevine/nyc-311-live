'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  claimSubscription,
  enqueueAllSubscriptions,
  enqueuePrecinctSubscriptions,
  formPayload,
  modalUrl,
  parseBidIds, precinctLabel,
  recoverStaleProcessingSubscriptions,
  subscribeRequest
} = require('../nyc311-portal-subscriptions');

test('parses a distinct configured BID list', () => {
  assert.deepEqual(parseBidIds('68, 12,68,bad'), [68, 12]);
});

test('labels police precincts with their ordinal', () => {
  assert.equal(precinctLabel(1), 'NYPD 1st Precinct');
  assert.equal(precinctLabel(11), 'NYPD 11th Precinct');
  assert.equal(precinctLabel(23), 'NYPD 23rd Precinct');
});

test('precinct enrollment honors the immutable first-seen cutoff', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,portal_id TEXT,police_precinct INTEGER,
      first_seen_at TEXT NOT NULL,suffix INTEGER
    );
    CREATE TABLE nyc311_email_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,local_part TEXT UNIQUE,domain TEXT,
      recipient_address TEXT UNIQUE,srnumber TEXT UNIQUE,token_hash TEXT UNIQUE,
      state TEXT,created_at TEXT,subscribed_at TEXT,last_received_at TEXT,updated_at TEXT
    );
    CREATE TABLE nyc311_email_subscription_jobs (
      srnumber TEXT PRIMARY KEY,alias_id INTEGER UNIQUE,bid_id INTEGER,state TEXT,
      attempts INTEGER,next_attempt_at TEXT,last_error TEXT,created_at TEXT,
      updated_at TEXT,subscribed_at TEXT,scope_type TEXT,scope_id INTEGER,scope_label TEXT
    );
    INSERT INTO live_portal_requests VALUES
      ('311-28300001','11111111-1111-1111-1111-111111111111',1,'2026-07-23T19:29:59.000Z',1),
      ('311-28300002','22222222-2222-2222-2222-222222222222',1,'2026-07-23T19:30:11.000Z',2),
      ('311-28300003','33333333-3333-3333-3333-333333333333',2,'2026-07-23T19:31:00.000Z',3);
  `);
  assert.equal(enqueuePrecinctSubscriptions(database, [1], {
    startAt: '2026-07-23T19:30:11.000Z',
    now: new Date('2026-07-23T19:32:00.000Z')
  }), 1);
  assert.equal(enqueuePrecinctSubscriptions(database, [1], {
    startAt: '2026-07-23T19:30:11.000Z',
    now: new Date('2026-07-23T19:33:00.000Z')
  }), 0);
  const job = database.prepare(`
    SELECT srnumber,scope_type,scope_id,scope_label
    FROM nyc311_email_subscription_jobs
  `).get();
  assert.deepEqual({ ...job }, {
    srnumber: '311-28300002',
    scope_type: 'police_precinct',
    scope_id: 1,
    scope_label: 'NYPD 1st Precinct'
  });
  database.close();
});

test('all-request enrollment includes only records at or after its immutable cutoff', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,portal_id TEXT,police_precinct INTEGER,
      first_seen_at TEXT NOT NULL,suffix INTEGER
    );
    CREATE TABLE nyc311_email_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,local_part TEXT UNIQUE,domain TEXT,
      recipient_address TEXT UNIQUE,srnumber TEXT UNIQUE,token_hash TEXT UNIQUE,
      state TEXT,created_at TEXT,subscribed_at TEXT,last_received_at TEXT,updated_at TEXT
    );
    CREATE TABLE nyc311_email_subscription_jobs (
      srnumber TEXT PRIMARY KEY,alias_id INTEGER UNIQUE,bid_id INTEGER,state TEXT,
      attempts INTEGER,next_attempt_at TEXT,last_error TEXT,created_at TEXT,
      updated_at TEXT,subscribed_at TEXT,scope_type TEXT,scope_id INTEGER,scope_label TEXT
    );
    INSERT INTO live_portal_requests VALUES
      ('311-28300001','11111111-1111-1111-1111-111111111111',1,'2026-07-24T20:00:00.000Z',1),
      ('311-28300002','22222222-2222-2222-2222-222222222222',2,'2026-07-24T20:00:01.000Z',2),
      ('311-28300003',NULL,3,'2026-07-24T20:00:02.000Z',3);
  `);
  assert.equal(enqueueAllSubscriptions(database, {
    startAt: '2026-07-24T20:00:01.000Z',
    now: new Date('2026-07-24T20:01:00.000Z')
  }), 1);
  assert.equal(enqueueAllSubscriptions(database, {
    startAt: '2026-07-24T20:00:01.000Z',
    now: new Date('2026-07-24T20:02:00.000Z')
  }), 0);
  const job = database.prepare(`
    SELECT srnumber,scope_type,scope_id,scope_label
    FROM nyc311_email_subscription_jobs
  `).get();
  assert.deepEqual({ ...job }, {
    srnumber: '311-28300002',
    scope_type: 'all',
    scope_id: 0,
    scope_label: 'All NYC311'
  });
  database.close();
});

test('builds the NYC311 modal URL for the request', () => {
  const id = 'a1704b26-ad86-f111-ab0f-000d3a154b1d';
  const url = new URL(modalUrl(id));
  assert.equal(url.hostname, 'portal.311.nyc.gov');
  assert.equal(url.searchParams.get('id'), id);
  assert.equal(url.searchParams.get('refid'), id);
});

test('preserves WebForms tokens and fills the subscription fields', () => {
  const body = formPayload(`
    <input type="hidden" name="__VIEWSTATE" value="state">
    <input type="hidden" name="__EVENTVALIDATION" value="validation">
  `, 'r28334446-token@track.opendata.support');
  assert.equal(body.get('__VIEWSTATE'), 'state');
  assert.equal(body.get('__EVENTVALIDATION'), 'validation');
  assert.equal(body.get('__EVENTTARGET'),
    'ctl00$ContentContainer$MainContent$EntityFormControl$InsertButton');
  assert.equal(body.get(
    'ctl00$ContentContainer$MainContent$EntityFormControl$EntityFormControl_EntityFormView$n311_email'
  ), 'r28334446-token@track.opendata.support');
});

test('submits the subscription with cookies from the form response', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return {
        ok: true,
        status: 200,
        headers: { raw: () => ({ 'set-cookie': ['session=abc; Path=/'] }) },
        text: async () => `
          <input type="hidden" name="__VIEWSTATE" value="state">
          <input type="hidden" name="__EVENTVALIDATION" value="validation">
        `
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '<span id="MessageLabel">\n  Saved \n</span>'
    };
  };
  await subscribeRequest({
    portalId: 'a1704b26-ad86-f111-ab0f-000d3a154b1d',
    email: 'r28334446-token@track.opendata.support',
    fetchImpl
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers.Cookie, 'session=abc');
});

test('treats an already-subscribed Portal response as success', async () => {
  let callCount = 0;
  const result = await subscribeRequest({
    portalId: 'a1704b26-ad86-f111-ab0f-000d3a154b1d',
    email: 'r28334446-token@track.opendata.support',
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          headers: { raw: () => ({ 'set-cookie': [] }) },
          text: async () => `
            <input type="hidden" name="__VIEWSTATE" value="state">
            <input type="hidden" name="__EVENTVALIDATION" value="validation">
          `
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `
          <div class="validation-summary-errors">
            This email address already exists for this service request.
          </div>
        `
      };
    }
  });

  assert.equal(result, true);
  assert.equal(callCount, 2);
});

test('rejects a successful HTTP response without the Portal success marker', async () => {
  let callCount = 0;
  await assert.rejects(
    subscribeRequest({
      portalId: 'a1704b26-ad86-f111-ab0f-000d3a154b1d',
      email: 'r28334446-token@track.opendata.support',
      fetchImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            headers: { raw: () => ({ 'set-cookie': [] }) },
            text: async () => `
              <input type="hidden" name="__VIEWSTATE" value="state">
              <input type="hidden" name="__EVENTVALIDATION" value="validation">
            `
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => '<div>Request received</div>'
        };
      }
    }),
    /NYC311 did not confirm the subscription/
  );
  assert.equal(callCount, 2);
});

test('aborts a Portal subscription request after its timeout', async () => {
  await assert.rejects(
    subscribeRequest({
      portalId: 'a1704b26-ad86-f111-ab0f-000d3a154b1d',
      email: 'r28334446-token@track.opendata.support',
      timeoutMs: 10,
      fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('request aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    }),
    error => error && error.name === 'AbortError'
  );
});

test('recovers only stale processing subscriptions and can claim the recovered job', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,portal_id TEXT
    );
    CREATE TABLE nyc311_email_aliases (
      id INTEGER PRIMARY KEY,recipient_address TEXT
    );
    CREATE TABLE nyc311_email_subscription_jobs (
      srnumber TEXT PRIMARY KEY,alias_id INTEGER,bid_id INTEGER,state TEXT,
      attempts INTEGER,next_attempt_at TEXT,last_error TEXT,created_at TEXT,
      updated_at TEXT,subscribed_at TEXT,scope_type TEXT,scope_id INTEGER,scope_label TEXT
    );
    INSERT INTO live_portal_requests VALUES
      ('311-28300001','11111111-1111-1111-1111-111111111111'),
      ('311-28300002','22222222-2222-2222-2222-222222222222');
    INSERT INTO nyc311_email_aliases VALUES
      (1,'first@track.opendata.support'),
      (2,'second@track.opendata.support');
    INSERT INTO nyc311_email_subscription_jobs VALUES
      ('311-28300001',1,0,'processing',1,'2026-07-24T19:00:00.000Z',NULL,
       '2026-07-24T19:00:00.000Z','2026-07-24T19:00:00.000Z',NULL,'all',0,'All NYC311'),
      ('311-28300002',2,0,'processing',1,'2026-07-24T19:59:00.000Z',NULL,
       '2026-07-24T19:59:00.000Z','2026-07-24T19:59:00.000Z',NULL,'all',0,'All NYC311');
  `);
  const now = new Date('2026-07-24T20:00:00.000Z');

  assert.equal(recoverStaleProcessingSubscriptions(database, { now }), 1);
  assert.deepEqual(database.prepare(`
    SELECT srnumber,state,last_error FROM nyc311_email_subscription_jobs ORDER BY srnumber
  `).all().map(row => ({ ...row })), [
    {
      srnumber: '311-28300001',
      state: 'retry',
      last_error: 'Recovered a stale subscription attempt'
    },
    {
      srnumber: '311-28300002',
      state: 'processing',
      last_error: null
    }
  ]);

  const claimed = claimSubscription(database, now);
  assert.equal(claimed.srnumber, '311-28300001');
  assert.equal(claimed.state, 'retry');
  assert.equal(database.prepare(`
    SELECT state,attempts FROM nyc311_email_subscription_jobs WHERE srnumber=?
  `).get(claimed.srnumber).state, 'processing');
  assert.equal(database.prepare(`
    SELECT state,attempts FROM nyc311_email_subscription_jobs WHERE srnumber=?
  `).get(claimed.srnumber).attempts, 2);
  database.close();
});

test('newest subscription claims keep live arrivals ahead of an older catch-up backlog', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,portal_id TEXT,suffix INTEGER
    );
    CREATE TABLE nyc311_email_aliases (
      id INTEGER PRIMARY KEY,recipient_address TEXT
    );
    CREATE TABLE nyc311_email_subscription_jobs (
      srnumber TEXT PRIMARY KEY,alias_id INTEGER,bid_id INTEGER,state TEXT,
      attempts INTEGER,next_attempt_at TEXT,last_error TEXT,created_at TEXT,
      updated_at TEXT,subscribed_at TEXT,scope_type TEXT,scope_id INTEGER,scope_label TEXT
    );
    INSERT INTO live_portal_requests VALUES
      ('311-28300001','11111111-1111-1111-1111-111111111111',28300001),
      ('311-28300002','22222222-2222-2222-2222-222222222222',28300002),
      ('311-28300003','33333333-3333-3333-3333-333333333333',28300003);
    INSERT INTO nyc311_email_aliases VALUES
      (1,'first@track.opendata.support'),
      (2,'second@track.opendata.support'),
      (3,'third@track.opendata.support');
    INSERT INTO nyc311_email_subscription_jobs VALUES
      ('311-28300001',1,0,'pending',0,'2026-07-24T19:00:00.000Z',NULL,
       '2026-07-24T19:00:00.000Z','2026-07-24T19:00:00.000Z',NULL,'all',0,'All NYC311'),
      ('311-28300002',2,0,'pending',0,'2026-07-24T19:00:00.000Z',NULL,
       '2026-07-24T19:01:00.000Z','2026-07-24T19:01:00.000Z',NULL,'all',0,'All NYC311'),
      ('311-28300003',3,0,'pending',0,'2026-07-24T19:00:00.000Z',NULL,
       '2026-07-24T19:02:00.000Z','2026-07-24T19:02:00.000Z',NULL,'all',0,'All NYC311');
  `);
  const now = new Date('2026-07-24T20:00:00.000Z');

  assert.equal(claimSubscription(database, now, { order: 'newest' }).srnumber,
    '311-28300003');
  assert.equal(claimSubscription(database, now, { order: 'oldest' }).srnumber,
    '311-28300001');
  assert.throws(
    () => claimSubscription(database, now, { order: 'sideways' }),
    /order must be oldest or newest/
  );
  database.close();
});
