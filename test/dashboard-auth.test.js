'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createDashboardAuth,
  credentialsFromHeader,
  dashboardAuthConfig
} = require('../dashboard-auth');

function request(path, authorization = null) {
  return {
    path,
    get(name) {
      return name.toLowerCase() === 'authorization' ? authorization : null;
    }
  };
}

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    }
  };
}

test('requires a complete credential pair when cloud authentication is enabled', () => {
  assert.throws(
    () => dashboardAuthConfig({ REQUIRE_DASHBOARD_AUTH: '1' }),
    /credentials are missing/
  );
  assert.throws(
    () => dashboardAuthConfig({ DASHBOARD_USERNAME: 'admin' }),
    /must be set together/
  );
});

test('remains disabled for the local app when no credentials are configured', () => {
  const config = dashboardAuthConfig({});
  assert.equal(config.enabled, false);
  let continued = false;
  createDashboardAuth(config)(request('/live.html'), response(), () => { continued = true; });
  assert.equal(continued, true);
});

test('accepts only the exact configured Basic credentials', () => {
  const config = dashboardAuthConfig({
    REQUIRE_DASHBOARD_AUTH: 'true',
    DASHBOARD_USERNAME: 'admin',
    DASHBOARD_PASSWORD: 'a:long password'
  });
  const middleware = createDashboardAuth(config);
  const header = `Basic ${Buffer.from('admin:a:long password').toString('base64')}`;
  let continued = false;
  middleware(request('/live.html', header), response(), () => { continued = true; });
  assert.equal(continued, true);

  const denied = response();
  middleware(
    request('/live.html', `Basic ${Buffer.from('admin:wrong').toString('base64')}`),
    denied,
    () => assert.fail('invalid credentials must not continue')
  );
  assert.equal(denied.statusCode, 401);
  assert.match(denied.headers['WWW-Authenticate'], /^Basic /);
  assert.equal(denied.headers['Cache-Control'], 'no-store');
});

test('leaves only the liveness and collector-readiness paths public', () => {
  const middleware = createDashboardAuth({
    enabled: true,
    username: 'admin',
    password: 'secret'
  });
  let continued = false;
  middleware(request('/api/health'), response(), () => { continued = true; });
  assert.equal(continued, true);
  continued = false;
  middleware(request('/api/health/collector'), response(), () => { continued = true; });
  assert.equal(continued, true);

  const denied = response();
  middleware(request('/api/live-dashboard'), denied, () => assert.fail('API must be protected'));
  assert.equal(denied.statusCode, 401);
});

test('rejects malformed Basic headers', () => {
  assert.equal(credentialsFromHeader('Bearer token'), null);
  assert.equal(credentialsFromHeader('Basic bm9jb2xvbg=='), null);
});
