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
const exampleEnvironment = fs.readFileSync(
  path.join(root, 'aws', 'lightsail-sqlite', '.env.example'),
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
const staticPublisher = fs.readFileSync(
  path.join(root, 'aws', 'lightsail-sqlite', 'publish-static-release.sh'),
  'utf8'
);
const backupService = fs.readFileSync(
  path.join(root, 'aws', 'lightsail-sqlite', 'systemd', 'nyc311-backup.service'),
  'utf8'
);
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile.sqlite'), 'utf8');
const legacyCompose = fs.readFileSync(
  path.join(root, 'aws', 'lightsail', 'compose.yml'),
  'utf8'
);
const legacyWorker = fs.readFileSync(path.join(root, 'cloud', 'worker.js'), 'utf8');
const legacyCollectorScope = fs.readFileSync(
  path.join(root, 'cloud', 'collector-scope.js'),
  'utf8'
);

test('the legacy PostgreSQL worker cannot silently fall back to citywide collection', () => {
  assert.match(
    legacyCompose,
    /COLLECTOR_SCOPE: "\$\{COLLECTOR_SCOPE:\?Set COLLECTOR_SCOPE=citywide/
  );
  assert.match(
    legacyWorker,
    /parseLegacyCollectorScope\(process\.env\)/
  );
  assert.doesNotMatch(
    `${legacyWorker}\n${legacyCollectorScope}`,
    /process\.env\.COLLECTOR_SCOPE \|\| 'citywide'/
  );
});

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
  assert.match(
    caddy,
    /handle @versioned_assets \{\s*uri strip_prefix \/_ui\s*root \* \/srv\/public-releases\/releases\s*header Cache-Control "public, max-age=31536000, immutable"\s*file_server\s*\}/
  );
  assert.match(caddy, /handle \{\s*root \* \/srv\/public-releases\/current\s*rewrite @root \/live\.html\s*file_server\s*\}/);
  assert.equal((caddy.match(/reverse_proxy web:10000/g) || []).length, 1);
  assert.equal((caddy.match(/reverse_proxy inbound-email:10001/g) || []).length, 1);
});

test('the proxy receives a stable static-release parent as a read-only bind mount', () => {
  const proxy = compose.slice(compose.indexOf('  proxy:'));
  assert.match(
    proxy,
    /source: \/var\/lib\/nyc-311-live-assets\s+target: \/srv\/public-releases\s+read_only: true/
  );
  assert.doesNotMatch(proxy, /source: \.\.\/\.\.\/public/);
});

test('web and background services have independent immutable image pointers', () => {
  assert.match(compose, /x-service-image: &service-image[\s\S]*image: nyc-311-sqlite:\$\{IMAGE_TAG:-local\}/);
  assert.match(compose, /x-web-image: &web-image[\s\S]*image: nyc-311-sqlite:\$\{WEB_IMAGE_TAG:\?Set WEB_IMAGE_TAG/);
  const collector = compose.slice(compose.indexOf('  collector:'), compose.indexOf('  web:'));
  const web = compose.slice(compose.indexOf('  web:'), compose.indexOf('  inbound-email:'));
  const inbound = compose.slice(compose.indexOf('  inbound-email:'), compose.indexOf('  backup:'));
  assert.match(collector, /\*service-image/);
  assert.match(web, /\*web-image/);
  assert.match(inbound, /\*service-image/);
});

test('the SQLite runtime image carries only the pinned BID bootstrap boundary', () => {
  assert.match(
    dockerfile,
    /COPY --chown=nyc311:nyc311 exports\/nyc-bid-boundaries-2026-04-28\.geojson \.\/exports\/nyc-bid-boundaries-2026-04-28\.geojson/
  );
  const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  assert.match(dockerignore, /!exports\/nyc-bid-boundaries-2026-04-28\.geojson/);
  assert.doesNotMatch(dockerfile, /COPY[^\n]*exports\/\s/);
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
  assert.equal((deploy.match(/--no-deps --force-recreate web proxy/g) || []).length, 0);
  assert.equal(
    (deploy.match(/--no-deps --force-recreate web(?:\n|; then)/g) || []).length,
    2
  );
  assert.match(deploy, /rollback_services=\(web inbound-email collector proxy\)/);
  assert.match(deploy, /docker compose stop inbound-email/);
  assert.match(deploy, /http:\/\/127\.0\.0\.1:10001\/health/);
  assert.match(deploy, /docker compose ps -q inbound-email/);
  assert.match(deploy, /public_shell_url="https:\/\/311\.georgelevine\.com\/"/);
  assert.match(deploy, /<title>NYC BID 311 Live<\/title>/);
  assert.match(deploy, /for _attempt in \$\(seq 1 30\)/);
  assert.match(
    deploy,
    /The public HTTPS health check and exact versioned assets did not become ready in time/
  );
});

test('assets publish atomically without rebuilding or restarting containers', () => {
  assert.match(deploy, /deployment_scope\}" != "assets"[\s\S]*docker compose build web/);
  assert.match(deploy, /static_publisher="\/usr\/local\/sbin\/nyc311-publish-static-release"/);
  assert.match(deploy, /"\$\{static_publisher\}" "\$\{current_directory\}\/public" "\$\{release_sha\}"/);
  assert.match(staticPublisher, /ln -s "releases\/\$\{release_sha\}" "\$\{switch_directory\}\/current"/);
  assert.match(staticPublisher, /mv -Tf -- "\$\{switch_directory\}\/current" "\$\{asset_root\}\/current"/);
  assert.match(staticPublisher, /Static releases cannot contain symbolic links/);
  assert.match(staticPublisher, /sha256sum --check --status SHA256SUMS/);
  assert.match(staticPublisher, /\/_ui\/\$\{release_sha\}/);
  assert.match(deploy, /A container started or restarted during the restart-free assets deployment/);
  assert.match(deploy, /Assets release \$\{release_sha\} is live\. No container restarted/);
  const environmentUpdate = deploy.slice(
    deploy.indexOf('set_env_value()'),
    deploy.indexOf('chmod 0600 "${staging_env}"')
  );
  assert.match(environmentUpdate, /deployment_scope\}" == "web"[\s\S]*set_env_value WEB_IMAGE_TAG/);
  assert.match(environmentUpdate, /deployment_scope\}" == "service"[\s\S]*set_env_value IMAGE_TAG[\s\S]*set_env_value WEB_IMAGE_TAG/);
  assert.doesNotMatch(environmentUpdate, /deployment_scope\}" == "assets"[\s\S]*set_env_value/);
});

test('commit-specific image metadata does not invalidate reusable Docker layers', () => {
  const runtimeStart = dockerfile.indexOf('FROM node:22.23.1-bookworm-slim AS runtime');
  const runtime = dockerfile.slice(runtimeStart);
  assert.ok(runtime.indexOf('RUN apt-get update') < runtime.indexOf('ARG APP_VERSION'));
  assert.ok(runtime.indexOf('COPY --from=dependencies') < runtime.indexOf('ARG APP_VERSION'));
  assert.ok(runtime.indexOf('COPY --chown=nyc311:nyc311 public ./public') < runtime.indexOf('ARG APP_VERSION'));
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
  assert.match(
    installSnapshot,
    /"\$\{static_publisher\}" "\$\{repository_directory\}\/public" "\$\{release_commit\}"/
  );
  assert.match(installSnapshot, /_ui\/\$\{release_commit\}\/js\/live-dashboard\.js/);
  assert.match(installSnapshot, /service_image_name="nyc-311-sqlite:\$\{IMAGE_TAG\}"/);
  assert.match(installSnapshot, /web_image_name="nyc-311-sqlite:\$\{WEB_IMAGE_TAG\}"/);
  assert.match(installSnapshot, /for _ in \$\(seq 1 300\)/);
  assert.doesNotMatch(installSnapshot, /for _ in \$\(seq 1 60\)/);
});

test('snapshot installation accepts and validates the complete BID-only environment', () => {
  for (const key of [
    'COLLECTOR_SCOPE',
    'DATABASE_PATH',
    'BID_POLL_INTERVAL_SECONDS',
    'BID_QUERY_CONCURRENCY',
    'BID_QUERY_ZONE_TARGET',
    'BID_CATCHUP_MAX_DAYS'
  ]) {
    assert.match(installSnapshot, new RegExp(`\\[${key}\\]=1`));
  }
  assert.match(installSnapshot, /COLLECTOR_SCOPE="\$\{COLLECTOR_SCOPE:-bid_only\}"/);
  assert.match(exampleEnvironment, /^COLLECTOR_SCOPE=bid_only$/m);
  assert.equal(
    (compose.match(/COLLECTOR_SCOPE: \$\{COLLECTOR_SCOPE:-bid_only\}/g) || []).length,
    3
  );
  assert.match(installSnapshot, /COLLECTOR_SCOPE must be citywide or bid_only/);
  assert.match(
    installSnapshot,
    /DATABASE_PATH must be a plain \.sqlite file directly inside \/data/
  );
  assert.match(installSnapshot, /require_integer_range BID_POLL_INTERVAL_SECONDS 30 3600/);
  assert.match(installSnapshot, /require_integer_range BID_QUERY_CONCURRENCY 1 8/);
  assert.match(installSnapshot, /require_integer_range BID_QUERY_ZONE_TARGET 5 30/);
  assert.match(installSnapshot, /require_integer_range BID_CATCHUP_MAX_DAYS 1 31/);
});

test('backup, snapshot restore, and deploy polling share the configured database path', () => {
  const backup = compose.slice(
    compose.indexOf('  backup:'),
    compose.indexOf('  verify:')
  );
  assert.match(backup, /- \$\{DATABASE_PATH:-\/data\/portal-archive\.sqlite\}/);
  assert.doesNotMatch(
    backupService,
    /ConditionPathExists=\/var\/lib\/nyc-311-live\/portal-archive\.sqlite/
  );
  assert.match(installSnapshot, /database_name="\$\{DATABASE_PATH#\/data\/\}"/);
  assert.match(installSnapshot, /target="\$\{data_directory\}\/\$\{database_name\}"/);
  assert.match(
    installSnapshot,
    /node verify-sqlite-snapshot\.js "\$\{DATABASE_PATH\}\.new"/
  );
  assert.match(
    deploy,
    /database_host_path="\/var\/lib\/nyc-311-live\/\$\{container_database_path#\/data\/\}"/
  );
  assert.equal(
    (deploy.match(/sqlite3 "\$\{database_host_path\}"/g) || []).length >= 4,
    true
  );
  assert.doesNotMatch(
    deploy,
    /sqlite3 \/var\/lib\/nyc-311-live\/portal-archive\.sqlite/
  );
});

test('service deployment proves the exact expected scope after a fresh collector poll', () => {
  assert.match(deploy, /expected_collector_scope="\$\{expected_collector_scope:-bid_only\}"/);
  assert.doesNotMatch(deploy, /expected_collector_scope\}" == "bid_only"/);
  assert.match(
    deploy,
    /SELECT value FROM live_monitor_state WHERE key='collector_scope'/
  );
  assert.match(
    deploy,
    /recorded_collector_scope\}" != "\$\{expected_collector_scope\}"/
  );
  assert.match(
    deploy,
    /rollback_scope\}" != "\$\{expected_collector_scope\}"/
  );
  assert.match(
    deploy,
    /recorded '\$\{recorded_collector_scope:-missing\}' scope; expected '\$\{expected_collector_scope\}'/
  );
  assert.equal(
    (deploy.match(/for _(?:rollback_)?attempt in \$\(seq 1 300\)/g) || []).length,
    2
  );
  assert.match(
    compose.slice(compose.indexOf('  collector:'), compose.indexOf('  web:')),
    /start_period: 600s/
  );
});

test('nightly backup priority, exclusive cleanup, and I/O limits apply inside the container', () => {
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
    /\n\s+- --exclusive\n/
  );
  assert.doesNotMatch(backup, /--page-rate|SQLITE_BACKUP_PAGE_RATE/);
  assert.match(
    backup,
    /blkio_config:\s+device_read_bps:\s+- path: \/dev\/nvme0n1\s+rate: 1mb\s+device_write_bps:\s+- path: \/dev\/nvme0n1\s+rate: 1mb/
  );
  const nonBackupServices = [
    compose.slice(compose.indexOf('  collector:'), compose.indexOf('  web:')),
    compose.slice(compose.indexOf('  web:'), compose.indexOf('  inbound-email:')),
    compose.slice(compose.indexOf('  inbound-email:'), compose.indexOf('  backup:')),
    compose.slice(compose.indexOf('  verify:'), compose.indexOf('  proxy:')),
    compose.slice(compose.indexOf('  proxy:'))
  ];
  for (const service of nonBackupServices) {
    assert.doesNotMatch(service, /blkio_config:/);
  }
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
  assert.ok(
    deploy.indexOf('trap rollback ERR')
      < deploy.indexOf('mv -- "${current_directory}" "${previous_directory}"')
  );
  assert.match(rollback, /rollback was incomplete; immediate operator attention is required/);
  assert.match(rollback, /rollback_poll_before/);
  assert.match(rollback, /rollback_runtime_ready/);
  assert.match(rollback, /previous runtime did not become healthy/);
});

test('public smoke checks exact versioned JavaScript, CSS, and vendor bytes', () => {
  assert.match(deploy, /public_js_url=.*\/_ui\/\$\{release_sha\}\/js\/live-dashboard\.js/);
  assert.match(deploy, /public_css_url=.*\/_ui\/\$\{release_sha\}\/css\/live-ui\.css/);
  assert.match(deploy, /public_vendor_url=.*\/_ui\/\$\{release_sha\}\/vendor\/leaflet\/leaflet\.js/);
  assert.match(deploy, /public_js_sha[\s\S]*expected_js_sha/);
  assert.match(deploy, /public_css_sha[\s\S]*expected_css_sha/);
  assert.match(deploy, /public_vendor_sha[\s\S]*expected_vendor_sha/);
  assert.match(deploy, /--connect-timeout 3 --max-time 5/);
});

test('local deployment cannot hang indefinitely on a stale SSH connection', () => {
  assert.match(localDeploy, /ConnectTimeout=10/);
  assert.match(localDeploy, /ServerAliveInterval=10/);
  assert.match(localDeploy, /ServerAliveCountMax=3/);
  assert.match(localDeploy, /ControlMaster=auto/);
  assert.match(localDeploy, /ControlPersist=60/);
  assert.match(localDeploy, /DEPLOY_SCOPE:-auto/);
});

test('the web fast path permits the read-only request email projection', () => {
  assert.match(deploy, /--exclude=nyc311-email-events\.js/);
  assert.match(deploy, /--exclude=sqlite-live-summary\.js/);
});
