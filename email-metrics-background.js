'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const CACHE_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_WORKER_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_RETRY_AFTER_SECONDS = 3;

function enabledValue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultCachePath(databasePath) {
  return path.join(path.dirname(databasePath), 'email-metrics-cache.json');
}

function defaultTempDirectory(databasePath) {
  return path.join(path.dirname(databasePath), 'sqlite-email-metrics-tmp');
}

function normalizedCollectorScope(value) {
  const scope = String(value || '').trim().toLowerCase();
  return ['citywide', 'bid_only'].includes(scope) ? scope : null;
}

function normalizeSnapshot(candidate, databasePath, expectedCollectorScope = 'citywide') {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  if (candidate.version !== CACHE_VERSION) return null;
  if (candidate.database_path !== path.resolve(databasePath)) return null;
  if (!candidate.payload || typeof candidate.payload !== 'object' || Array.isArray(candidate.payload)) {
    return null;
  }
  const taggedCollectorScope = normalizedCollectorScope(candidate.collector_scope);
  if (candidate.collector_scope != null && !taggedCollectorScope) return null;
  const expectedScope = normalizedCollectorScope(expectedCollectorScope) || 'citywide';
  // Legacy snapshots were generated before scope tagging and therefore can
  // only be trusted by the legacy citywide dashboard. BID-only mode must never
  // display one: it may contain tens of thousands of retained citywide rows.
  if (expectedScope === 'bid_only' && taggedCollectorScope !== 'bid_only') return null;
  if (expectedScope === 'citywide' && taggedCollectorScope === 'bid_only') return null;
  const generatedAtMs = Date.parse(candidate.generated_at);
  if (!Number.isFinite(generatedAtMs)) return null;
  return {
    generatedAt: new Date(generatedAtMs).toISOString(),
    generatedAtMs,
    collectorScope: taggedCollectorScope,
    payload: candidate.payload
  };
}

function readPersistedSnapshot(
  cachePath,
  databasePath,
  expectedCollectorScope = 'citywide'
) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const stats = fs.statSync(cachePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > 5 * 1024 * 1024) return null;
    return normalizeSnapshot(
      JSON.parse(fs.readFileSync(cachePath, 'utf8')),
      databasePath,
      expectedCollectorScope
    );
  } catch (error) {
    console.error('Email metrics cache read error:', error.message);
    return null;
  }
}

function publicPayload(snapshot, state = {}) {
  return {
    ...snapshot.payload,
    ...(snapshot.collectorScope ? { collector_scope: snapshot.collectorScope } : {}),
    metrics_generated_at: snapshot.generatedAt,
    metrics_refreshing: Boolean(state.refreshing),
    metrics_stale: Boolean(state.stale),
    ...(state.lastError ? {
      metrics_refresh_error: 'Background refresh failed; using the last saved metrics'
    } : {})
  };
}

function createEmailMetricsBackground(options = {}) {
  const refreshEnabled = options.refreshEnabled == null
    ? enabledValue(process.env.EMAIL_METRICS_BACKGROUND_ENABLED)
    : Boolean(options.refreshEnabled);
  const workerPath = options.workerPath || path.join(__dirname, 'email-metrics-worker.js');
  const cacheTtlMs = positiveInteger(
    options.cacheTtlMs || process.env.EMAIL_METRICS_CACHE_TTL_MS,
    DEFAULT_CACHE_TTL_MS
  );
  const failureCooldownMs = positiveInteger(
    options.failureCooldownMs || process.env.EMAIL_METRICS_FAILURE_COOLDOWN_MS,
    DEFAULT_FAILURE_COOLDOWN_MS
  );
  const workerTimeoutMs = positiveInteger(
    options.workerTimeoutMs || process.env.EMAIL_METRICS_WORKER_TIMEOUT_MS,
    DEFAULT_WORKER_TIMEOUT_MS
  );
  const retryAfterSeconds = positiveInteger(
    options.retryAfterSeconds || process.env.EMAIL_METRICS_RETRY_AFTER_SECONDS,
    DEFAULT_RETRY_AFTER_SECONDS
  );
  const collectorScope = normalizedCollectorScope(
    options.collectorScope || process.env.COLLECTOR_SCOPE
  ) || 'citywide';
  const forkWorker = options.forkWorker || fork;
  const now = options.now || (() => Date.now());
  const logger = options.logger || console;

  let databasePath = null;
  let cachePath = null;
  let tempDirectory = null;
  let snapshot = null;
  let activeWorker = null;
  let retryAtMs = 0;
  let lastError = null;

  function terminateWorker(worker) {
    worker.child.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      if (!worker.exited) worker.child.kill('SIGKILL');
    }, 5_000);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
  }

  function configure(nextDatabasePath) {
    const resolvedDatabasePath = path.resolve(nextDatabasePath);
    if (databasePath === resolvedDatabasePath) return;
    if (activeWorker) {
      terminateWorker(activeWorker);
      clearTimeout(activeWorker.timeout);
      activeWorker = null;
    }
    databasePath = resolvedDatabasePath;
    cachePath = options.cachePath || defaultCachePath(databasePath);
    tempDirectory = options.tempDirectory || defaultTempDirectory(databasePath);
    snapshot = readPersistedSnapshot(cachePath, databasePath, collectorScope);
    retryAtMs = 0;
    lastError = null;
  }

  function finishWorker(worker, error, message) {
    if (activeWorker !== worker) return;
    clearTimeout(worker.timeout);
    activeWorker = null;

    if (error) {
      lastError = String(error.message || error).slice(0, 300);
      retryAtMs = now() + failureCooldownMs;
      logger.error('Email metrics worker error:', lastError);
      return;
    }

    const normalized = normalizeSnapshot(
      message && message.snapshot,
      databasePath,
      collectorScope
    );
    if (!normalized) {
      lastError = 'The metrics worker returned an invalid snapshot';
      retryAtMs = now() + failureCooldownMs;
      logger.error('Email metrics worker error:', lastError);
      return;
    }

    snapshot = normalized;
    retryAtMs = 0;
    lastError = null;
  }

  function startWorker() {
    if (!refreshEnabled || activeWorker || now() < retryAtMs) return false;

    let child;
    try {
      child = forkWorker(workerPath, [], {
        env: {
          ...process.env,
          EMAIL_METRICS_DATABASE_PATH: databasePath,
          EMAIL_METRICS_CACHE_PATH: cachePath,
          EMAIL_METRICS_TEMP_DIRECTORY: tempDirectory,
          SQLITE_TMPDIR: tempDirectory
        },
        execArgv: [],
        silent: true
      });
    } catch (error) {
      lastError = String(error.message || error).slice(0, 300);
      retryAtMs = now() + failureCooldownMs;
      logger.error('Email metrics worker start error:', lastError);
      return false;
    }

    const worker = {
      child,
      exited: false,
      settled: false,
      stderr: '',
      timeout: null
    };
    activeWorker = worker;

    worker.timeout = setTimeout(() => {
      if (activeWorker !== worker) return;
      worker.settled = true;
      terminateWorker(worker);
      finishWorker(worker, new Error(`timed out after ${workerTimeoutMs}ms`));
    }, workerTimeoutMs);
    if (typeof worker.timeout.unref === 'function') worker.timeout.unref();

    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        worker.stderr = `${worker.stderr}${chunk}`.slice(-16_384);
      });
    }
    child.once('message', message => {
      if (worker.settled) return;
      worker.settled = true;
      if (message && message.ok) {
        finishWorker(worker, null, message);
      } else {
        finishWorker(worker, new Error(
          message && message.error
            ? message.error
            : worker.stderr.trim() || 'metrics worker failed'
        ));
      }
    });
    child.once('error', error => {
      if (worker.settled) return;
      worker.settled = true;
      finishWorker(worker, error);
    });
    child.once('exit', (code, signal) => {
      worker.exited = true;
      if (worker.settled) return;
      worker.settled = true;
      finishWorker(worker, new Error(
        worker.stderr.trim()
          || `exited before returning metrics (${signal || `code ${code}`})`
      ));
    });
    return true;
  }

  function get(nextDatabasePath) {
    configure(nextDatabasePath);
    const currentTime = now();
    const fresh = snapshot && currentTime - snapshot.generatedAtMs < cacheTtlMs;
    if (!fresh) startWorker();

    if (snapshot) {
      return {
        statusCode: snapshot.payload.database_available === false ? 503 : 200,
        payload: publicPayload(snapshot, {
          refreshing: Boolean(activeWorker),
          stale: !fresh,
          lastError
        })
      };
    }

    if (currentTime < retryAtMs && lastError) {
      return {
        statusCode: 503,
        payload: {
          error: 'Email monitoring metrics are temporarily unavailable',
          metrics_refreshing: false,
          metrics_refresh_error: 'Background refresh failed',
          retry_after_seconds: Math.max(1, Math.ceil((retryAtMs - currentTime) / 1000))
        }
      };
    }

    if (!refreshEnabled) {
      return {
        statusCode: 503,
        payload: {
          error: 'Email monitoring metrics are temporarily unavailable',
          metrics_refreshing: false,
          metrics_refresh_disabled: true
        }
      };
    }

    return {
      statusCode: 202,
      payload: {
        refreshing: true,
        metrics_refreshing: true,
        message: 'Calculating email monitoring metrics',
        retry_after_seconds: retryAfterSeconds
      }
    };
  }

  // Read the small persisted snapshot without ever launching analytics work.
  // Operational health uses this path so checking health cannot itself make
  // the live site unhealthy.
  function peek(nextDatabasePath) {
    configure(nextDatabasePath);
    const currentTime = now();
    const fresh = snapshot && currentTime - snapshot.generatedAtMs < cacheTtlMs;
    if (snapshot) {
      return {
        statusCode: snapshot.payload.database_available === false ? 503 : 200,
        payload: {
          ...publicPayload(snapshot, {
            refreshing: Boolean(activeWorker),
            stale: !fresh,
            lastError
          }),
          metrics_refresh_disabled: !refreshEnabled
        },
        refreshEnabled
      };
    }
    return {
      statusCode: 503,
      payload: {
        error: 'Email monitoring metrics are temporarily unavailable',
        metrics_refreshing: Boolean(activeWorker),
        metrics_refresh_disabled: !refreshEnabled
      },
      refreshEnabled
    };
  }

  function close() {
    if (!activeWorker) return;
    const worker = activeWorker;
    worker.settled = true;
    clearTimeout(worker.timeout);
    activeWorker = null;
    terminateWorker(worker);
  }

  return {
    close,
    get,
    peek,
    isRefreshing: () => Boolean(activeWorker)
  };
}

module.exports = {
  CACHE_VERSION,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_FAILURE_COOLDOWN_MS,
  DEFAULT_RETRY_AFTER_SECONDS,
  DEFAULT_WORKER_TIMEOUT_MS,
  createEmailMetricsBackground,
  enabledValue,
  normalizeSnapshot,
  readPersistedSnapshot
};
