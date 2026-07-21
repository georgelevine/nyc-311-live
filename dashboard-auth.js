'use strict';

const crypto = require('crypto');

function enabledValue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function secureEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function credentialsFromHeader(header) {
  const match = String(header || '').match(/^Basic\s+([^\s]+)$/i);
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch (_) {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1)
  };
}

function dashboardAuthConfig(env = process.env) {
  const username = String(env.DASHBOARD_USERNAME || '').trim();
  const password = String(env.DASHBOARD_PASSWORD || '');
  const required = enabledValue(env.REQUIRE_DASHBOARD_AUTH);
  const hasUsername = username.length > 0;
  const hasPassword = password.length > 0;

  if (hasUsername !== hasPassword) {
    throw new Error('DASHBOARD_USERNAME and DASHBOARD_PASSWORD must be set together');
  }
  if (required && !hasUsername) {
    throw new Error('Dashboard authentication is required but credentials are missing');
  }
  return {
    enabled: hasUsername && hasPassword,
    required,
    username,
    password
  };
}

function createDashboardAuth(config, {
  publicPaths = ['/api/health', '/api/health/collector']
} = {}) {
  const paths = new Set(publicPaths);
  if (!config || !config.enabled) return (_req, _res, next) => next();

  return (req, res, next) => {
    if (paths.has(req.path)) return next();
    const supplied = credentialsFromHeader(req.get('authorization'));
    if (supplied
        && secureEqual(supplied.username, config.username)
        && secureEqual(supplied.password, config.password)) {
      return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="NYC 311 Live", charset="UTF-8"');
    res.set('Cache-Control', 'no-store');
    return res.status(401).send('Authentication required');
  };
}

module.exports = {
  createDashboardAuth,
  credentialsFromHeader,
  dashboardAuthConfig,
  enabledValue,
  secureEqual
};
