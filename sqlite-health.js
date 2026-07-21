'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const MAX_FUTURE_SKEW_SECONDS = 60;

function inspectSqliteHealth(databasePath, {
  now = new Date(),
  staleAfterSeconds = 300
} = {}) {
  if (!fs.existsSync(databasePath)) {
    return {
      ok: false,
      status: 'starting',
      database: 'missing',
      collector: 'unknown',
      last_successful_poll_at: null
    };
  }

  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA busy_timeout = 1000');
    database.prepare('SELECT 1').get();
    const hasState = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'live_monitor_state'
    `).get();
    const row = hasState
      ? database.prepare(`
          SELECT value FROM live_monitor_state
          WHERE key = 'last_successful_poll_at'
        `).get()
      : null;
    const lastPoll = row && row.value ? String(row.value) : null;
    const lastPollMs = lastPoll ? Date.parse(lastPoll) : NaN;
    const materiallyFuture = Number.isFinite(lastPollMs)
      && lastPollMs > now.getTime() + MAX_FUTURE_SKEW_SECONDS * 1000;
    const ageSeconds = Number.isFinite(lastPollMs) && !materiallyFuture
      ? Math.max(0, (now.getTime() - lastPollMs) / 1000)
      : null;
    const collector = materiallyFuture
      ? 'invalid'
      : ageSeconds == null
      ? 'starting'
      : ageSeconds <= staleAfterSeconds ? 'fresh' : 'stale';
    return {
      ok: true,
      status: collector === 'fresh' ? 'ok' : 'degraded',
      database: 'ok',
      collector,
      last_successful_poll_at: lastPoll,
      poll_age_seconds: ageSeconds == null ? null : Math.round(ageSeconds)
    };
  } catch (error) {
    return {
      ok: false,
      status: 'unavailable',
      database: 'unavailable',
      collector: 'unknown',
      last_successful_poll_at: null,
      error: error.message
    };
  } finally {
    if (database) database.close();
  }
}

module.exports = { MAX_FUTURE_SKEW_SECONDS, inspectSqliteHealth };
