'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createEmailMetricsBackground,
  readPersistedSnapshot
} = require('../email-metrics-background');

const silentLogger = { error() {} };

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = signal => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

function snapshot(
  databasePath,
  generatedAt,
  payload = { database_available: true, total: 12 },
  collectorScope = null
) {
  return {
    version: 1,
    database_path: path.resolve(databasePath),
    generated_at: generatedAt,
    ...(collectorScope ? { collector_scope: collectorScope } : {}),
    payload
  };
}

test('serves 202 immediately and starts only one metrics worker', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-metrics-background-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const children = [];
  let currentTime = Date.parse('2026-07-29T12:00:00.000Z');
  const background = createEmailMetricsBackground({
    refreshEnabled: true,
    cachePath: path.join(directory, 'metrics.json'),
    tempDirectory: path.join(directory, 'sqlite-tmp'),
    now: () => currentTime,
    logger: silentLogger,
    forkWorker: (_workerPath, _args, options) => {
      const child = fakeChild();
      child.options = options;
      children.push(child);
      return child;
    }
  });

  const first = background.get(databasePath);
  const second = background.get(databasePath);

  assert.equal(first.statusCode, 202);
  assert.equal(first.payload.refreshing, true);
  assert.equal(first.payload.retry_after_seconds, 3);
  assert.equal(second.statusCode, 202);
  assert.equal(children.length, 1);
  assert.equal(children[0].options.env.EMAIL_METRICS_DATABASE_PATH, path.resolve(databasePath));
  assert.equal(
    children[0].options.env.SQLITE_TMPDIR,
    path.join(directory, 'sqlite-tmp')
  );

  children[0].emit('message', {
    ok: true,
    snapshot: snapshot(databasePath, new Date(currentTime).toISOString())
  });
  const ready = background.get(databasePath);

  assert.equal(ready.statusCode, 200);
  assert.equal(ready.payload.total, 12);
  assert.equal(ready.payload.metrics_refreshing, false);
  assert.equal(ready.payload.metrics_stale, false);
  assert.equal(children.length, 1);
  background.close();
});

test('returns a stale snapshot immediately while refreshing it in the background', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-metrics-stale-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const cachePath = path.join(directory, 'metrics.json');
  const generatedAt = '2026-07-29T11:00:00.000Z';
  fs.writeFileSync(cachePath, JSON.stringify(snapshot(databasePath, generatedAt)));
  const children = [];
  const background = createEmailMetricsBackground({
    refreshEnabled: true,
    cachePath,
    cacheTtlMs: 300_000,
    now: () => Date.parse('2026-07-29T12:00:00.000Z'),
    logger: silentLogger,
    forkWorker: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    }
  });

  const result = background.get(databasePath);

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.total, 12);
  assert.equal(result.payload.metrics_stale, true);
  assert.equal(result.payload.metrics_refreshing, true);
  assert.equal(result.payload.metrics_generated_at, generatedAt);
  assert.equal(children.length, 1);
  background.close();
  assert.deepEqual(children[0].killCalls, ['SIGTERM']);
});

test('applies a failure cooldown without discarding the last good snapshot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-metrics-failure-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const cachePath = path.join(directory, 'metrics.json');
  fs.writeFileSync(cachePath, JSON.stringify(snapshot(
    databasePath,
    '2026-07-29T11:00:00.000Z'
  )));
  const children = [];
  let currentTime = Date.parse('2026-07-29T12:00:00.000Z');
  const background = createEmailMetricsBackground({
    refreshEnabled: true,
    cachePath,
    cacheTtlMs: 300_000,
    failureCooldownMs: 60_000,
    now: () => currentTime,
    logger: silentLogger,
    forkWorker: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    }
  });

  background.get(databasePath);
  children[0].emit('message', { ok: false, error: 'database or disk is full' });
  const duringCooldown = background.get(databasePath);

  assert.equal(duringCooldown.statusCode, 200);
  assert.equal(duringCooldown.payload.total, 12);
  assert.equal(duringCooldown.payload.metrics_stale, true);
  assert.equal(duringCooldown.payload.metrics_refreshing, false);
  assert.equal(
    duringCooldown.payload.metrics_refresh_error,
    'Background refresh failed; using the last saved metrics'
  );
  assert.equal(children.length, 1);

  currentTime += 60_001;
  const afterCooldown = background.get(databasePath);
  assert.equal(afterCooldown.statusCode, 200);
  assert.equal(afterCooldown.payload.metrics_refreshing, true);
  assert.equal(children.length, 2);
  background.close();
});

test('rejects persisted snapshots for another database or an invalid payload', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-metrics-cache-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const cachePath = path.join(directory, 'metrics.json');

  fs.writeFileSync(cachePath, JSON.stringify(snapshot(
    path.join(directory, 'other.sqlite'),
    '2026-07-29T12:00:00.000Z'
  )));
  assert.equal(readPersistedSnapshot(cachePath, databasePath), null);

  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    database_path: path.resolve(databasePath),
    generated_at: '2026-07-29T12:00:00.000Z',
    payload: null
  }));
  assert.equal(readPersistedSnapshot(cachePath, databasePath), null);
});

test('BID-only mode rejects legacy or citywide snapshots and serves only BID-tagged data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-metrics-bid-scope-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const cachePath = path.join(directory, 'metrics.json');
  const generatedAt = '2026-07-29T12:00:00.000Z';

  fs.writeFileSync(cachePath, JSON.stringify(snapshot(databasePath, generatedAt)));
  assert.equal(readPersistedSnapshot(cachePath, databasePath, 'bid_only'), null);
  const legacyBackground = createEmailMetricsBackground({
    collectorScope: 'bid_only',
    cachePath,
    now: () => Date.parse(generatedAt)
  });
  const legacyResult = legacyBackground.get(databasePath);
  assert.equal(legacyResult.statusCode, 503);
  assert.equal(legacyResult.payload.metrics_refresh_disabled, true);
  legacyBackground.close();

  fs.writeFileSync(cachePath, JSON.stringify(snapshot(
    databasePath,
    generatedAt,
    undefined,
    'citywide'
  )));
  assert.equal(readPersistedSnapshot(cachePath, databasePath, 'bid_only'), null);

  fs.writeFileSync(cachePath, JSON.stringify(snapshot(
    databasePath,
    generatedAt,
    undefined,
    'bid_only'
  )));
  const background = createEmailMetricsBackground({
    collectorScope: 'bid_only',
    cachePath,
    now: () => Date.parse(generatedAt)
  });
  const result = background.get(databasePath);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.total, 12);
  assert.equal(result.payload.collector_scope, 'bid_only');
  assert.equal(result.payload.metrics_refreshing, false);
  background.close();
});

test('metrics worker snapshots carry the durable collector scope', () => {
  const worker = fs.readFileSync(
    path.join(__dirname, '..', 'email-metrics-worker.js'),
    'utf8'
  );
  assert.match(worker, /collector_scope:\s*measuredCollectorScope/);
  assert.match(worker, /collector scope changed while metrics were calculated/i);
});

test('times out a stuck worker and enters cooldown instead of starting another', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-metrics-timeout-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const children = [];
  const background = createEmailMetricsBackground({
    refreshEnabled: true,
    cachePath: path.join(directory, 'metrics.json'),
    workerTimeoutMs: 10,
    failureCooldownMs: 60_000,
    logger: silentLogger,
    forkWorker: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    }
  });

  assert.equal(background.get(databasePath).statusCode, 202);
  await new Promise(resolve => setTimeout(resolve, 30));
  const failed = background.get(databasePath);

  assert.equal(failed.statusCode, 503);
  assert.equal(failed.payload.metrics_refreshing, false);
  assert.equal(failed.payload.metrics_refresh_error, 'Background refresh failed');
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].killCalls, ['SIGTERM']);
  background.close();
});

test('keeps expensive refresh disabled unless it is explicitly enabled', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-metrics-disabled-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  let workersStarted = 0;
  const background = createEmailMetricsBackground({
    cachePath: path.join(directory, 'metrics.json'),
    forkWorker: () => {
      workersStarted += 1;
      return fakeChild();
    }
  });

  const result = background.get(databasePath);

  assert.equal(result.statusCode, 503);
  assert.equal(result.payload.metrics_refreshing, false);
  assert.equal(result.payload.metrics_refresh_disabled, true);
  assert.equal(workersStarted, 0);
});

test('peek serves a saved snapshot without starting a refresh worker', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc311-metrics-peek-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const cachePath = path.join(directory, 'metrics.json');
  fs.writeFileSync(cachePath, JSON.stringify(snapshot(
    databasePath,
    '2026-07-29T11:00:00.000Z'
  )));
  let workersStarted = 0;
  const background = createEmailMetricsBackground({
    refreshEnabled: true,
    cachePath,
    cacheTtlMs: 300_000,
    now: () => Date.parse('2026-07-29T12:00:00.000Z'),
    logger: silentLogger,
    forkWorker: () => {
      workersStarted += 1;
      return fakeChild();
    }
  });

  const result = background.peek(databasePath);

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.metrics_stale, true);
  assert.equal(result.payload.metrics_refreshing, false);
  assert.equal(result.payload.metrics_refresh_disabled, false);
  assert.equal(workersStarted, 0);
});
