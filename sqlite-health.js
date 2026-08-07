'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_COLLECTOR_SCOPE } = require('./bid-collector-scope');

const MAX_FUTURE_SKEW_SECONDS = 60;
const EXPECTED_BID_FEATURE_COUNT = 78;

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
  `).get(name));
}

function stateValue(database, key) {
  const row = database.prepare(`
    SELECT value FROM live_monitor_state WHERE key=? LIMIT 1
  `).get(key);
  return row && row.value != null ? String(row.value) : null;
}

function bidCollectorIntegrity(database) {
  if (stateValue(database, 'bid_collector_startup_error')) return 'startup_failed';
  if (!tableExists(database, 'business_improvement_district_boundary_versions')
      || !tableExists(database, 'business_improvement_districts')) {
    return 'boundary_unavailable';
  }
  const active = database.prepare(`
    SELECT version,feature_count
    FROM business_improvement_district_boundary_versions
    WHERE active=1 LIMIT 1
  `).get();
  if (!active || Number(active.feature_count) !== EXPECTED_BID_FEATURE_COUNT) {
    return 'boundary_incomplete';
  }
  const installed = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM business_improvement_districts
    WHERE boundary_version=?
  `).get(active.version).count || 0);
  if (installed !== EXPECTED_BID_FEATURE_COUNT) return 'boundary_incomplete';

  const planHash = stateValue(database, 'bid_query_plan_hash');
  const expectedZones = Number(stateValue(database, 'bid_query_zone_count'));
  if (!planHash || !Number.isSafeInteger(expectedZones) || expectedZones < 1
      || !tableExists(database, 'bid_collector_zone_state')) {
    return 'zone_plan_incomplete';
  }
  const zones = database.prepare(`
    SELECT COUNT(*) AS count,
           SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed
    FROM bid_collector_zone_state WHERE plan_hash=?
  `).get(planHash);
  if (Number(zones && zones.count || 0) !== expectedZones) {
    return 'zone_plan_incomplete';
  }
  if (Number(zones && zones.failed || 0) > 0) return 'zone_failed';
  return 'ready';
}

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
      collector_scope: DEFAULT_COLLECTOR_SCOPE,
      collector_scope_recorded: false,
      collector_scope_integrity: 'unavailable',
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
    const scopeRow = hasState
      ? database.prepare(`
          SELECT value FROM live_monitor_state WHERE key='collector_scope'
        `).get()
      : null;
    const lastPoll = row && row.value ? String(row.value) : null;
    const recordedCollectorScope = scopeRow
      && ['citywide', 'bid_only'].includes(String(scopeRow.value).trim().toLowerCase())
      ? String(scopeRow.value).trim().toLowerCase()
      : null;
    const collectorScopeIntegrity = recordedCollectorScope === 'bid_only'
      ? bidCollectorIntegrity(database)
      : recordedCollectorScope === 'citywide' ? 'ready' : 'unrecorded';
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
      collector_scope: recordedCollectorScope || DEFAULT_COLLECTOR_SCOPE,
      collector_scope_recorded: Boolean(recordedCollectorScope),
      collector_scope_integrity: collectorScopeIntegrity,
      last_successful_poll_at: lastPoll,
      poll_age_seconds: ageSeconds == null ? null : Math.round(ageSeconds)
    };
  } catch (error) {
    return {
      ok: false,
      status: 'unavailable',
      database: 'unavailable',
      collector: 'unknown',
      collector_scope: DEFAULT_COLLECTOR_SCOPE,
      collector_scope_recorded: false,
      collector_scope_integrity: 'unavailable',
      last_successful_poll_at: null,
      error: error.message
    };
  } finally {
    if (database) database.close();
  }
}

module.exports = { MAX_FUTURE_SKEW_SECONDS, inspectSqliteHealth };
