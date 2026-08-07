'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_COLLECTOR_SCOPE } = require('./bid-collector-scope');

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeSnapshotAtomically(cachePath, snapshot) {
  const directory = path.dirname(cachePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(cachePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
      encoding: 'utf8',
      mode: 0o640,
      flag: 'wx'
    });
    fs.renameSync(temporaryPath, cachePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function monitorStateValue(databasePath, key, fallback = 'unknown') {
  if (!fs.existsSync(databasePath)) return 'unknown';
  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const table = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='live_monitor_state'
    `).get();
    if (!table) return 'unknown';
    const row = database.prepare(`
      SELECT value FROM live_monitor_state
      WHERE key=?
    `).get(key);
    return row && row.value ? String(row.value) : fallback;
  } catch (_) {
    return 'unknown';
  } finally {
    if (database) database.close();
  }
}

function statusMonitoringMode(databasePath) {
  return monitorStateValue(databasePath, 'status_monitoring_mode');
}

function collectorScope(databasePath) {
  const scope = monitorStateValue(databasePath, 'collector_scope', DEFAULT_COLLECTOR_SCOPE)
    .trim().toLowerCase();
  return ['citywide', 'bid_only'].includes(scope) ? scope : 'unknown';
}

function run() {
  const databasePath = path.resolve(requiredEnvironment('EMAIL_METRICS_DATABASE_PATH'));
  const cachePath = path.resolve(requiredEnvironment('EMAIL_METRICS_CACHE_PATH'));
  const tempDirectory = path.resolve(requiredEnvironment('EMAIL_METRICS_TEMP_DIRECTORY'));

  fs.mkdirSync(tempDirectory, { recursive: true, mode: 0o750 });
  process.env.SQLITE_TMPDIR = tempDirectory;
  try {
    os.setPriority(0, 10);
  } catch (_) {
    // Best effort only; an unprivileged container may reject priority changes.
  }

  // Load the expensive SQLite implementation only inside this worker process.
  const { loadSqliteEmailMetrics } = require('./sqlite-email-metrics');
  const { presentEmailMetrics } = require('./email-metrics-presentation');
  const measuredCollectorScope = collectorScope(databasePath);
  if (!['citywide', 'bid_only'].includes(measuredCollectorScope)) {
    throw new Error('The collector scope is unavailable');
  }
  const measuredAt = new Date();
  const metrics = loadSqliteEmailMetrics(databasePath, {
    now: measuredAt,
    minimumGroupSample: 5,
    maxGroups: 50
  });
  const payload = presentEmailMetrics(metrics, statusMonitoringMode(databasePath));
  if (!payload.database_available) {
    throw new Error('The live archive database is unavailable');
  }
  if (collectorScope(databasePath) !== measuredCollectorScope) {
    throw new Error('The collector scope changed while metrics were calculated');
  }
  const generatedAt = new Date();
  const snapshot = {
    version: 1,
    database_path: databasePath,
    collector_scope: measuredCollectorScope,
    generated_at: generatedAt.toISOString(),
    payload
  };
  writeSnapshotAtomically(cachePath, snapshot);
  return snapshot;
}

try {
  const snapshot = run();
  if (typeof process.send === 'function') {
    process.send({ ok: true, snapshot }, error => {
      process.exit(error ? 1 : 0);
    });
  } else {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  }
} catch (error) {
  const message = String(error && error.message ? error.message : error).slice(0, 1000);
  if (typeof process.send === 'function') {
    process.send({ ok: false, error: message }, () => process.exit(1));
  } else {
    process.stderr.write(`Email metrics worker failed: ${message}\n`);
    process.exit(1);
  }
}
