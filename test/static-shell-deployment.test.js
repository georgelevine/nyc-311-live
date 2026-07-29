'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const caddy = fs.readFileSync(
  path.join(root, 'aws', 'lightsail-sqlite', 'Caddyfile'),
  'utf8'
);
const compose = fs.readFileSync(
  path.join(root, 'aws', 'lightsail-sqlite', 'compose.yml'),
  'utf8'
);
const deploy = fs.readFileSync(
  path.join(root, 'aws', 'lightsail-sqlite', 'deploy-ui-release.sh'),
  'utf8'
);

test('Caddy serves the dashboard shell directly and proxies only API requests', () => {
  assert.equal(caddy.includes('redir @root /live.html'), false);
  assert.match(caddy, /@api path \/api \/api\/\*/);
  assert.match(caddy, /handle @api \{\s*reverse_proxy web:10000\s*\}/);
  assert.match(caddy, /@root path \//);
  assert.match(caddy, /handle \{\s*root \* \/srv\/public\s*rewrite @root \/live\.html\s*file_server\s*\}/);
  assert.equal((caddy.match(/reverse_proxy web:10000/g) || []).length, 1);
});

test('the proxy receives the release public directory as a read-only bind mount', () => {
  const proxy = compose.slice(compose.indexOf('  proxy:'));
  assert.match(
    proxy,
    /source: \.\.\/\.\.\/public\s+target: \/srv\/public\s+read_only: true/
  );
});

test('activation and rollback recreate the proxy against the selected release', () => {
  assert.equal(
    (deploy.match(/--force-recreate web collector proxy/g) || []).length,
    2
  );
  assert.equal(
    (deploy.match(/--force-recreate web proxy/g) || []).length,
    2
  );
  assert.match(deploy, /public_shell_url="https:\/\/311\.georgelevine\.com\/"/);
  assert.match(deploy, /The public dashboard shell did not reach the new static release/);
});
