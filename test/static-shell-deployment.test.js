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
const localDeploy = fs.readFileSync(
  path.join(root, 'scripts', 'deploy-ui.sh'),
  'utf8'
);
const installSnapshot = fs.readFileSync(
  path.join(root, 'aws', 'lightsail-sqlite', 'install-snapshot.sh'),
  'utf8'
);
const backupService = fs.readFileSync(
  path.join(root, 'aws', 'lightsail-sqlite', 'systemd', 'nyc311-backup.service'),
  'utf8'
);

test('Caddy isolates inbound email before routing dashboard APIs', () => {
  assert.equal(caddy.includes('redir @root /live.html'), false);
  assert.match(
    caddy,
    /@inbound_email path \/api\/inbound\/nyc311-email \/api\/inbound\/nyc311-email\/\s+handle @inbound_email \{\s*reverse_proxy inbound-email:10001\s*\}/
  );
  assert.match(caddy, /@api path \/api \/api\/\*/);
  assert.match(caddy, /handle @api \{\s*reverse_proxy web:10000\s*\}/);
  assert.ok(caddy.indexOf('@inbound_email path') < caddy.indexOf('@api path'));
  assert.match(caddy, /@root path \//);
  assert.match(caddy, /handle \{\s*root \* \/srv\/public\s*rewrite @root \/live\.html\s*file_server\s*\}/);
  assert.equal((caddy.match(/reverse_proxy web:10000/g) || []).length, 1);
  assert.equal((caddy.match(/reverse_proxy inbound-email:10001/g) || []).length, 1);
});

test('the proxy receives the release public directory as a read-only bind mount', () => {
  const proxy = compose.slice(compose.indexOf('  proxy:'));
  assert.match(
    proxy,
    /source: \.\.\/\.\.\/public\s+target: \/srv\/public\s+read_only: true/
  );
});

test('Compose runs inbound email separately and gates the proxy on its health', () => {
  const ingress = compose.slice(
    compose.indexOf('  inbound-email:'),
    compose.indexOf('  backup:')
  );
  const proxy = compose.slice(compose.indexOf('  proxy:'));
  assert.match(ingress, /command: \["node", "inbound-email-server\.js"\]/);
  assert.match(ingress, /PORT: "10001"/);
  assert.match(ingress, /127\.0\.0\.1:10001:10001/);
  assert.match(ingress, /http:\/\/127\.0\.0\.1:10001\/health/);
  assert.match(proxy, /inbound-email:\s+condition: service_healthy/);
});

test('service activation and rollback include inbound email without changing it on web releases', () => {
  const ingressStart = deploy.indexOf(
    'docker compose up -d --no-build --force-recreate inbound-email'
  );
  const proxyCutover = deploy.indexOf(
    'docker compose up -d --no-build --no-deps --force-recreate proxy',
    ingressStart
  );
  const applicationRestart = deploy.indexOf(
    'docker compose up -d --no-build --no-deps --force-recreate web collector',
    proxyCutover
  );
  assert.ok(ingressStart > 0);
  assert.ok(proxyCutover > ingressStart);
  assert.ok(applicationRestart > proxyCutover);
  assert.match(
    deploy.slice(ingressStart, proxyCutover),
    /http:\/\/127\.0\.0\.1:10001\/health/
  );
  assert.equal(
    (deploy.match(/--no-deps --force-recreate web proxy/g) || []).length,
    2
  );
  assert.match(deploy, /rollback_services=\(web inbound-email collector proxy\)/);
  assert.match(deploy, /docker compose stop inbound-email/);
  assert.match(deploy, /http:\/\/127\.0\.0\.1:10001\/health/);
  assert.match(deploy, /docker compose ps -q inbound-email/);
  assert.match(deploy, /public_shell_url="https:\/\/311\.georgelevine\.com\/"/);
  assert.match(deploy, /for _attempt in \$\(seq 1 30\)/);
  assert.match(
    deploy,
    /The public HTTPS health check and dashboard shell did not become ready in time/
  );
});

test('snapshot replacement stops the isolated database writer and checks it after restart', () => {
  assert.match(
    installSnapshot,
    /docker compose stop collector inbound-email web proxy/
  );
  assert.match(
    installSnapshot,
    /docker compose up -d web inbound-email proxy/
  );
  assert.match(installSnapshot, /http:\/\/127\.0\.0\.1:10001\/health/);
});

test('nightly backup priority and SQLite batching apply inside the container', () => {
  const backup = compose.slice(
    compose.indexOf('  backup:'),
    compose.indexOf('  verify:')
  );
  assert.match(
    backup,
    /command:\s+- ionice\s+- -c\s+- "3"\s+- nice\s+- -n\s+- "19"\s+- flock/
  );
  assert.match(
    backup,
    /- --page-rate\s+- \$\{SQLITE_BACKUP_PAGE_RATE:-64\}/
  );
  assert.match(backupService, /Nice=19/);
  assert.match(backupService, /IOSchedulingClass=idle/);
});

test('rollback cannot recurse or continue a failed deployment', () => {
  const rollback = deploy.slice(
    deploy.indexOf('rollback() {'),
    deploy.indexOf('trap rollback ERR')
  );
  assert.match(rollback, /trap - ERR/);
  assert.match(rollback, /exit 1/);
});

test('local deployment cannot hang indefinitely on a stale SSH connection', () => {
  assert.match(localDeploy, /ConnectTimeout=10/);
  assert.match(localDeploy, /ServerAliveInterval=10/);
  assert.match(localDeploy, /ServerAliveCountMax=3/);
});

test('the web fast path permits the read-only request email projection', () => {
  assert.match(deploy, /--exclude=nyc311-email-events\.js/);
  assert.match(deploy, /--exclude=sqlite-live-summary\.js/);
});
