'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  formPayload,
  modalUrl,
  parseBidIds,
  subscribeRequest
} = require('../nyc311-portal-subscriptions');

test('parses a distinct configured BID list', () => {
  assert.deepEqual(parseBidIds('68, 12,68,bad'), [68, 12]);
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
    return { ok: true, status: 200, text: async () => '<div>Thank you</div>' };
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
