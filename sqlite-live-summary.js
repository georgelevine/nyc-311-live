'use strict';

const { buildLiveSummary } = require('./live-summary');
const { normalizePortalTimestamp } = require('./portal-timestamp');
const { MAX_FUTURE_SKEW_SECONDS } = require('./sqlite-health');

const DEFAULT_WINDOW_MINUTES = 15;
const DEFAULT_AUDIT_DELAY_MINUTES = 35;
const DEFAULT_MATURITY_BUFFER_MINUTES = 10;
const DEFAULT_HISTORY_TARGET_DAYS = 14;
const DEFAULT_STALE_AFTER_SECONDS = 300;

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name));
}

function columnExists(database, table, column) {
  return tableExists(database, table)
    && database.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
}

function validDate(value) {
  const normalized = normalizePortalTimestamp(value);
  return normalized ? new Date(normalized) : null;
}

function stateValue(database, key) {
  if (!tableExists(database, 'live_monitor_state')) return null;
  const row = database.prepare(`
    SELECT value FROM live_monitor_state WHERE key=?
  `).get(key);
  return row && row.value != null ? String(row.value) : null;
}

function collectorAsOf(database) {
  return validDate(stateValue(database, 'last_successful_poll_at'));
}

function collectorFreshness(database, now, staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS) {
  const current = validDate(now);
  if (!current) throw new TypeError('now must be a valid timestamp');
  if (!Number.isFinite(Number(staleAfterSeconds)) || Number(staleAfterSeconds) < 0) {
    throw new TypeError('staleAfterSeconds must be a non-negative number');
  }
  const raw = stateValue(database, 'last_successful_poll_at');
  const lastPoll = validDate(raw);
  const materiallyFuture = lastPoll
    && lastPoll.getTime() > current.getTime() + MAX_FUTURE_SKEW_SECONDS * 1000;
  const ageSeconds = lastPoll && !materiallyFuture
    ? Math.max(0, (current.getTime() - lastPoll.getTime()) / 1000)
    : null;
  const state = raw && (!lastPoll || materiallyFuture)
    ? 'invalid'
    : ageSeconds == null
      ? 'starting'
      : ageSeconds <= staleAfterSeconds ? 'fresh' : 'stale';
  return {
    state,
    last_successful_poll_at: lastPoll && !materiallyFuture ? lastPoll.toISOString() : raw,
    poll_age_seconds: ageSeconds == null ? null : Math.round(ageSeconds),
    stale_after_seconds: staleAfterSeconds
  };
}

function configuredNumber(database, key, fallback) {
  const value = stateValue(database, key);
  if (value == null || value.trim() === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function detailSql(hasDetails) {
  return hasDetails
    ? {
        hasDetails: true,
        join: 'LEFT JOIN portal_requests AS details ON details.srnumber=live.srnumber',
        submitted: "COALESCE(NULLIF(TRIM(live.submitted_at),''),NULLIF(TRIM(details.date_reported),''))",
        problem: "COALESCE(NULLIF(TRIM(live.problem),''),NULLIF(TRIM(details.problem),''))",
        address: "COALESCE(NULLIF(TRIM(live.address),''),NULLIF(TRIM(details.address),''))",
        loaded: 'CASE WHEN details.srnumber IS NULL THEN 0 ELSE 1 END'
      }
    : {
        hasDetails: false,
        join: '',
        submitted: "NULLIF(TRIM(live.submitted_at),'')",
        problem: "NULLIF(TRIM(live.problem),'')",
        address: "NULLIF(TRIM(live.address),'')",
        loaded: '0'
      };
}

function archiveTimeQuality(
  database,
  sql,
  policePrecinct = null,
  policePrecinctBoundaryVersion = null
) {
  if (policePrecinct != null && !columnExists(database, 'live_portal_requests', 'police_precinct')) {
    return {
      archive_requests: 0,
      missing_submitted_time: 0,
      invalid_submitted_time: 0,
      oldest_submitted_at: null
    };
  }
  if (policePrecinctBoundaryVersion != null
      && !columnExists(database, 'live_portal_requests', 'police_precinct_boundary_version')) {
    return {
      archive_requests: 0,
      missing_submitted_time: 0,
      invalid_submitted_time: 0,
      oldest_submitted_at: null
    };
  }
  const precinctWhere = policePrecinct == null
    ? ''
    : `WHERE live.police_precinct=@police_precinct${
      policePrecinctBoundaryVersion == null
        ? ''
        : ' AND live.police_precinct_boundary_version=@police_precinct_boundary_version'
    }`;
  const canonical = `LENGTH(submitted_at)=24 AND submitted_at GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`;
  const statement = database.prepare(`
    SELECT COUNT(*) AS archive_requests,
      SUM(CASE WHEN submitted_at IS NULL OR TRIM(submitted_at)='' THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN submitted_at IS NOT NULL AND TRIM(submitted_at)<>''
        AND NOT (${canonical}) THEN 1 ELSE 0 END) AS invalid,
      MIN(CASE WHEN ${canonical} THEN submitted_at END) AS oldest_submitted_at
    FROM (
      SELECT ${sql.submitted} AS submitted_at
      FROM live_portal_requests AS live
      ${sql.join}
      ${precinctWhere}
    )
  `);
  const row = policePrecinct == null
    ? statement.get()
    : statement.get({
      police_precinct: policePrecinct,
      ...(policePrecinctBoundaryVersion == null
        ? {}
        : { police_precinct_boundary_version: policePrecinctBoundaryVersion })
    });
  return {
    archive_requests: Number(row.archive_requests || 0),
    missing_submitted_time: Number(row.missing || 0),
    invalid_submitted_time: Number(row.invalid || 0),
    oldest_submitted_at: row.oldest_submitted_at || null
  };
}

function summaryRowsQuery(sql, scopedToPrecinct = false, scopedToBoundaryVersion = false) {
  const precinctAnd = scopedToPrecinct ? ' AND live.police_precinct=@police_precinct' : '';
  const boundaryVersionAnd = scopedToBoundaryVersion
    ? ' AND live.police_precinct_boundary_version=@police_precinct_boundary_version'
    : '';
  const select = `SELECT live.srnumber,live.suffix,
      ${sql.submitted} AS submitted_at,
      ${sql.problem} AS problem,
      ${sql.address} AS address,
      live.latitude,live.longitude,
      ${sql.loaded} AS details_loaded,
      CASE WHEN json_valid(live.raw_json)=1 THEN
        CASE WHEN json_extract(live.raw_json,'$.source')='number_audit'
          THEN 'number_audit' ELSE 'map' END
      ELSE 'map' END AS source
    FROM live_portal_requests AS live
    ${sql.join}`;
  return sql.hasDetails
    ? `SELECT * FROM (
        ${select}
        WHERE live.submitted_at>=@start AND live.submitted_at<@end${precinctAnd}${boundaryVersionAnd}
        UNION ALL
        ${select}
        WHERE (live.submitted_at IS NULL OR TRIM(live.submitted_at)='')
          AND details.date_reported>=@start AND details.date_reported<@end
          ${precinctAnd}${boundaryVersionAnd}
      ) ORDER BY suffix`
    : `${select}
       WHERE live.submitted_at>=@start AND live.submitted_at<@end
       ${precinctAnd}${boundaryVersionAnd}
       ORDER BY live.suffix`;
}

function summaryRows(
  database,
  sql,
  start,
  end,
  policePrecinct = null,
  policePrecinctBoundaryVersion = null
) {
  const scoped = policePrecinct != null;
  if (scoped && !columnExists(database, 'live_portal_requests', 'police_precinct')) return [];
  const scopedToBoundaryVersion = policePrecinctBoundaryVersion != null;
  if (scopedToBoundaryVersion
      && !columnExists(database, 'live_portal_requests', 'police_precinct_boundary_version')) return [];
  const statement = database.prepare(summaryRowsQuery(sql, scoped, scopedToBoundaryVersion));
  const rows = scoped
    ? statement.all({
      start,
      end,
      police_precinct: policePrecinct,
      ...(scopedToBoundaryVersion
        ? { police_precinct_boundary_version: policePrecinctBoundaryVersion }
        : {})
    })
    : statement.all({ start, end });
  return rows.map(row => ({
    ...row,
    details_loaded: Boolean(row.details_loaded)
  }));
}

function auditQueueStatus(database, asOf) {
  if (!tableExists(database, 'live_number_queue')) {
    return { state: 'unavailable', overdue_suffixes: null, verified_complete: false };
  }
  const row = database.prepare(`
    SELECT COUNT(*) AS overdue
    FROM live_number_queue
    WHERE audit_outcome='pending' AND audit_after<=?
  `).get(asOf);
  const overdue = Number(row.overdue || 0);
  return {
    state: overdue ? 'backlogged' : 'no_overdue_queue',
    overdue_suffixes: overdue,
    verified_complete: false
  };
}

function loadSqliteLiveSummary(database, {
  asOf = null,
  now = new Date(),
  windowMinutes = DEFAULT_WINDOW_MINUTES,
  auditDelayMinutes = null,
  maturityBufferMinutes = DEFAULT_MATURITY_BUFFER_MINUTES,
  historyTargetDays = DEFAULT_HISTORY_TARGET_DAYS,
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
  archiveQuality = null,
  policePrecinct = null,
  policePrecinctBoundaryVersion = null
} = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A readable SQLite database is required');
  }
  const explicitAsOf = asOf == null ? null : validDate(asOf);
  if (asOf != null && !explicitAsOf) throw new TypeError('asOf must be an explicit valid timestamp');
  const fallbackNow = validDate(now);
  if (!fallbackNow) throw new TypeError('now must be a valid timestamp');
  const capture = collectorFreshness(database, fallbackNow, staleAfterSeconds);
  const collectorAnchor = explicitAsOf || capture.state === 'invalid'
    ? null
    : collectorAsOf(database);
  const resolvedAsOf = explicitAsOf || collectorAnchor || fallbackNow;
  const effectiveAuditDelay = auditDelayMinutes == null
    ? configuredNumber(database, 'audit_delay_minutes', DEFAULT_AUDIT_DELAY_MINUTES)
    : auditDelayMinutes;
  const precinct = policePrecinct == null || policePrecinct === '' ? null : Number(policePrecinct);
  if (precinct != null && (!Number.isInteger(precinct) || precinct <= 0)) {
    throw new TypeError('policePrecinct must be a positive integer');
  }
  const boundaryVersion = policePrecinctBoundaryVersion == null
    || String(policePrecinctBoundaryVersion).trim() === ''
    ? null
    : String(policePrecinctBoundaryVersion).trim();
  if (boundaryVersion != null && precinct == null) {
    throw new TypeError('policePrecinctBoundaryVersion requires policePrecinct');
  }

  if (!tableExists(database, 'live_portal_requests')) {
    const summary = buildLiveSummary([], {
      asOf: resolvedAsOf,
      windowMinutes,
      auditDelayMinutes: effectiveAuditDelay,
      maturityBufferMinutes,
      historyTargetDays,
      oldestSubmittedAt: null
    });
    summary.delayed.audit_queue = auditQueueStatus(database, resolvedAsOf.toISOString());
    return {
      ...summary,
      as_of_source: explicitAsOf ? 'explicit' : 'clock',
      capture,
      data_quality: {
        archive_requests: 0,
        missing_submitted_time: 0,
        invalid_submitted_time: 0,
        excluded_from_time_statistics: 0,
        oldest_submitted_at: null
      }
    };
  }

  const hasDetails = tableExists(database, 'portal_requests');
  const sql = detailSql(hasDetails);
  const quality = (precinct == null ? archiveQuality : null)
    || archiveTimeQuality(database, sql, precinct, boundaryVersion);
  const lookbackMinutes = Math.max(
    windowMinutes * 2,
    effectiveAuditDelay + maturityBufferMinutes + windowMinutes
  );
  const start = new Date(resolvedAsOf.getTime() - lookbackMinutes * 60_000).toISOString();
  const end = resolvedAsOf.toISOString();
  const rows = summaryRows(database, sql, start, end, precinct, boundaryVersion);
  const summary = buildLiveSummary(rows, {
    asOf: resolvedAsOf,
    windowMinutes,
    auditDelayMinutes: effectiveAuditDelay,
    maturityBufferMinutes,
    historyTargetDays,
    oldestSubmittedAt: quality.oldest_submitted_at
  });
  summary.delayed.audit_queue = auditQueueStatus(database, resolvedAsOf.toISOString());
  return {
    ...summary,
    scope: {
      police_precinct: precinct,
      police_precinct_boundary_version: boundaryVersion
    },
    as_of_source: explicitAsOf ? 'explicit' : collectorAnchor ? 'collector' : 'clock',
    capture,
    data_quality: {
      archive_requests: quality.archive_requests,
      missing_submitted_time: quality.missing_submitted_time,
      invalid_submitted_time: quality.invalid_submitted_time,
      excluded_from_time_statistics: quality.missing_submitted_time + quality.invalid_submitted_time,
      oldest_submitted_at: quality.oldest_submitted_at || null
    }
  };
}

module.exports = {
  DEFAULT_AUDIT_DELAY_MINUTES,
  DEFAULT_HISTORY_TARGET_DAYS,
  DEFAULT_MATURITY_BUFFER_MINUTES,
  DEFAULT_STALE_AFTER_SECONDS,
  DEFAULT_WINDOW_MINUTES,
  archiveTimeQuality,
  auditQueueStatus,
  collectorAsOf,
  collectorFreshness,
  detailSql,
  loadSqliteLiveSummary,
  summaryRows,
  summaryRowsQuery,
  tableExists
};
