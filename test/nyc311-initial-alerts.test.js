'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  initialPayload,
  sendInitialAlert
} = require('../nyc311-initial-alerts');

test('builds an initial alert from loaded Portal details', () => {
  assert.deepEqual(initialPayload({
    srnumber: '311-28334446',
    bid_id: 68,
    problem: 'Homeless Person Assistance',
    problem_details: 'Request outreach',
    additional_details: null,
    address: '575 GREENWICH STREET, MANHATTAN, NY, 10014',
    status: 'In Progress',
    date_reported: '2026-07-23T12:00:00.000Z',
    updated_on: null,
    date_closed: null,
    next_update: '24 Hours',
    portal_url: 'https://portal.311.nyc.gov/example'
  }), {
    kind: 'initial_request',
    srnumber: '311-28334446',
    bid_id: 68,
    scope_type: 'bid',
    scope_id: 68,
    scope_label: 'Hudson Square BID',
    problem: 'Homeless Person Assistance',
    problem_details: 'Request outreach',
    additional_details: null,
    address: '575 GREENWICH STREET, MANHATTAN, NY, 10014',
    status: 'In Progress',
    submitted_at: '2026-07-23T12:00:00.000Z',
    updated_at: null,
    closed_at: null,
    next_update: '24 Hours',
    portal_url: 'https://portal.311.nyc.gov/example'
  });
});

test('signs and sends the initial alert to the configured HTTPS endpoint', async () => {
  let call;
  const secret = 'test-secret';
  await sendInitialAlert({
    srnumber: '311-28334446',
    bid_id: 68,
    problem: 'Noise',
    address: 'HUDSON STREET',
    status: 'In Progress'
  }, {
    endpoint: 'https://example.test/initial',
    secret,
    now: new Date('2026-07-23T17:00:00.000Z'),
    fetchImpl: async (url, options) => {
      call = { url, options };
      return { ok: true, status: 200 };
    }
  });
  assert.equal(call.url, 'https://example.test/initial');
  const timestamp = call.options.headers['x-nyc311-alert-timestamp'];
  const expected = crypto.createHmac('sha256', secret)
    .update(`v1\n${timestamp}\n${call.options.body}`, 'utf8')
    .digest('hex');
  assert.equal(call.options.headers['x-nyc311-alert-signature'], `v1=${expected}`);
});
