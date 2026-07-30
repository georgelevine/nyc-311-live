'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createInboundEmailApp,
  inboundEmailHealth
} = require('../inbound-email-server');

test('dedicated inbound-email app exposes process health and the signed MIME route', () => {
  const secret = 'a'.repeat(64);
  const app = createInboundEmailApp({
    env: {
      NODE_ENV: 'production',
      INBOUND_EMAIL_WEBHOOK_SECRET: secret
    },
    parseNotification: async () => {
      throw new Error('invalid authentication must be rejected before parsing');
    }
  });
  const routes = app._router.stack
    .filter(layer => layer.route)
    .map(layer => layer.route);
  const healthRoute = routes.find(route => route.path === '/health');
  const inboundRoute = routes.find(
    route => route.path === '/api/inbound/nyc311-email'
  );
  assert.equal(healthRoute.methods.get, true);
  assert.equal(inboundRoute.methods.post, true);
  assert.equal(inboundRoute.stack.length, 2);
  assert.equal(inboundRoute.stack[0].name, 'rawParser');
  assert.equal(inboundRoute.stack[1].name, 'receiveNyc311Email');
  assert.equal(app.disabled('x-powered-by'), true);

  const headers = {};
  let body;
  inboundEmailHealth({}, {
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    json(value) {
      body = value;
    }
  });
  assert.deepEqual(body, {
    ok: true,
    service: 'nyc311-email-ingress'
  });
  assert.equal(headers['cache-control'], 'no-store');
});

test('dashboard server no longer imports or registers the inbound writer', () => {
  const serverSource = fs.readFileSync(
    path.join(__dirname, '..', 'server.js'),
    'utf8'
  );
  const ingressSource = fs.readFileSync(
    path.join(__dirname, '..', 'inbound-email-server.js'),
    'utf8'
  );
  assert.equal(serverSource.includes('/api/inbound/nyc311-email'), false);
  assert.equal(serverSource.includes("require('./nyc311-email-inbound')"), false);
  assert.match(ingressSource, /\/api\/inbound\/nyc311-email/);
  assert.match(ingressSource, /express\.raw\(/);
});
