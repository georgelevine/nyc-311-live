'use strict';

const express = require('express');
const {
  MAX_RAW_EMAIL_BYTES,
  createNyc311EmailHandler
} = require('./nyc311-email-inbound');
const { parseNyc311Notification } = require('./nyc311-notification-email');

function inboundEmailHealth(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'nyc311-email-ingress'
  });
}

function createInboundEmailApp({
  env = process.env,
  parseNotification = parseNyc311Notification
} = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Keep process health independent of SQLite lock availability. A busy
  // inbound write may occupy this service, but it must never make the
  // dashboard web process unresponsive.
  app.get('/health', inboundEmailHealth);

  // The signature covers the exact MIME bytes, so this parser and handler
  // must remain ahead of every structured body parser.
  app.post(
    '/api/inbound/nyc311-email',
    express.raw({
      type: ['message/rfc822', 'application/octet-stream'],
      limit: MAX_RAW_EMAIL_BYTES
    }),
    createNyc311EmailHandler({
      env,
      parseNotification
    })
  );

  return app;
}

function startInboundEmailServer({
  env = process.env,
  app = createInboundEmailApp({ env })
} = {}) {
  const port = Number(env.PORT || 10001);
  const host = env.HOST || null;
  const onListen = () => {
    console.log(`NYC311 email ingress running at http://localhost:${port}`);
  };
  return host
    ? app.listen(port, host, onListen)
    : app.listen(port, onListen);
}

if (require.main === module) {
  startInboundEmailServer();
}

module.exports = {
  createInboundEmailApp,
  inboundEmailHealth,
  startInboundEmailServer
};
