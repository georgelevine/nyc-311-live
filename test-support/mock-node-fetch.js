'use strict';

const Module = require('node:module');

const originalLoad = Module._load;

function response({ status = 200, body = '[]' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { raw: () => ({}) },
    async text() { return body; },
    async buffer() { return Buffer.from(body); }
  };
}

async function mockFetch(url) {
  const delay = Math.max(0, Number(process.env.NYC311_TEST_FETCH_DELAY_MS || 5));
  await new Promise(resolve => setTimeout(resolve, delay));
  const address = String(url);
  if (address.includes('/entity-pin-fetch-service-requests/')) {
    return response({ body: process.env.NYC311_TEST_PORTAL_PINS || '[]' });
  }
  return response({ status: 404, body: 'not found' });
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'node-fetch') return mockFetch;
  return originalLoad.call(this, request, parent, isMain);
};
