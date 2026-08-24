const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cheerio = require('cheerio');
const {
  createClosureTracker,
  isClosedStatus,
  statusesMatch
} = require('./closure-tracking');
const {
  assessRecordAvailability,
  currentLifecycleProjection,
  hasText
} = require('./record-availability');
const {
  buildLiveMapPayload,
  businessImprovementDistrictIds,
  mapSubmittedSince,
  validTimestampValue
} = require('./live-map-data');
const { buildCatchupStatus, parseState } = require('./catchup-status');
const { reconcileStoredDetails } = require('./detail-queue');
const { createDashboardAuth, dashboardAuthConfig } = require('./dashboard-auth');
const { inspectSqliteHealth } = require('./sqlite-health');
const { resolveBusyTimeoutMs } = require('./sqlite-runtime');
const { originMatchesHost } = require('./request-security');
const { normalizePortalTimestamp } = require('./portal-timestamp');
const { DEFAULT_COLLECTOR_SCOPE } = require('./bid-collector-scope');
const { createBidPortalClient } = require('./bid-portal-recovery');
const { geometryCovers } = require('./police-precincts');
const { attachPortalAgencyResponse } = require('./portal-agency-response');
const { loadSqliteLiveSummary } = require('./sqlite-live-summary');
const { createEmailMetricsBackground } = require('./email-metrics-background');
const { loadOperationalHealth } = require('./operational-health');
const { readStoredPortalDetail } = require('./stored-portal-detail');
const { readRequestEmailUpdates } = require('./nyc311-email-events');
const {
  BoundaryLookupError,
  loadActiveBusinessImprovementDistrictFeature,
  loadActivePolicePrecinctFeature,
  strictPositiveId
} = require('./geography-boundaries');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || null;
const dashboardAuth = dashboardAuthConfig();
const dashboardSettingsAuth = createDashboardAuth(dashboardAuth, { publicPaths: [] });
const LIVE_SUMMARY_CACHE_TTL_MS = 15_000;
const ARCHIVE_QUALITY_CACHE_TTL_MS = 5 * 60_000;
const OPERATIONAL_HEALTH_CACHE_TTL_MS = 15_000;
const SQLITE_BUSY_TIMEOUT_MS = resolveBusyTimeoutMs(process.env.SQLITE_BUSY_TIMEOUT_MS);
const liveSummaryCache = new Map();
const archiveQualityCache = new Map();
const emailMetricsBackground = createEmailMetricsBackground();
let operationalHealthCache = null;

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name));
}

function requestedBoundaryVersion(req, name) {
  const raw = req.query && req.query[name];
  if (raw == null || String(raw).trim() === '') return null;
  if (Array.isArray(raw) || typeof raw === 'object') {
    const error = new Error(`${name} must be a single boundary version`);
    error.statusCode = 400;
    throw error;
  }
  const version = String(raw).trim();
  if (version.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(version)) {
    const error = new Error(`${name} is not a valid boundary version`);
    error.statusCode = 400;
    throw error;
  }
  return version;
}

function activeBoundaryVersion(database, tableName) {
  if (![
    'police_precinct_boundary_versions',
    'business_improvement_district_boundary_versions'
  ].includes(tableName)) {
    throw new TypeError('Unsupported boundary version table');
  }
  if (!tableExists(database, tableName)) return null;
  const row = database.prepare(`
    SELECT version FROM ${tableName} WHERE active=1 LIMIT 1
  `).get();
  return row && row.version ? String(row.version) : null;
}

function policePrecinctFilter(req, database) {
  const raw = req.query && req.query.police_precinct;
  if (raw == null || String(raw).trim() === '') return null;
  if (!/^\d{1,3}$/.test(String(raw).trim())) {
    const error = new Error('police_precinct must be a valid precinct number');
    error.statusCode = 400;
    throw error;
  }
  const precinct = Number(raw);
  const expectedVersion = requestedBoundaryVersion(req, 'precinct_boundary_version');
  const boundaryVersion = activeBoundaryVersion(
    database,
    'police_precinct_boundary_versions'
  );
  if (boundaryVersion && expectedVersion && expectedVersion !== boundaryVersion) {
    const error = new Error('Police precinct boundary release changed; reload the filter');
    error.statusCode = 409;
    throw error;
  }
  const exists = boundaryVersion
    && tableExists(database, 'police_precincts')
    && database.prepare(`
      SELECT 1
      FROM police_precincts
      WHERE boundary_version=? AND precinct_number=?
    `).get(boundaryVersion, precinct);
  if (!exists) {
    const error = new Error(`Police precinct ${precinct} is not in the active boundary release`);
    error.statusCode = 400;
    throw error;
  }
  return { precinct, boundaryVersion };
}

function businessImprovementDistrictFilter(req, database) {
  const raw = req.query && req.query.bid_id;
  if (raw == null || String(raw).trim() === '') return null;
  if (!/^\d{1,6}$/.test(String(raw).trim())) {
    const error = new Error('bid_id must be a valid business improvement district ID');
    error.statusCode = 400;
    throw error;
  }
  const bidId = Number(raw);
  const expectedVersion = requestedBoundaryVersion(req, 'bid_boundary_version');
  const boundaryVersion = activeBoundaryVersion(
    database,
    'business_improvement_district_boundary_versions'
  );
  if (boundaryVersion && expectedVersion && expectedVersion !== boundaryVersion) {
    const error = new Error('Business improvement district boundary release changed; reload the filter');
    error.statusCode = 409;
    throw error;
  }
  const boundary = boundaryVersion
    && tableExists(database, 'business_improvement_districts')
    && database.prepare(`
      SELECT name
      FROM business_improvement_districts
      WHERE boundary_version=? AND bid_id=?
    `).get(boundaryVersion, bidId);
  if (!boundary) {
    const error = new Error(`BID ${bidId} is not in the active boundary release`);
    error.statusCode = 400;
    throw error;
  }
  return { bidId, name: boundary.name, boundaryVersion };
}

function requestGeographyScope(req, database) {
  const collectorScope = requireCollectorScope(database);
  return {
    precinct: policePrecinctFilter(req, database),
    bid: businessImprovementDistrictFilter(req, database),
    collectorBidOnly: collectorScope === 'bid_only'
  };
}

function normalizedCollectorScope(value) {
  const scope = String(value || '').trim().toLowerCase();
  return ['citywide', 'bid_only'].includes(scope) ? scope : null;
}

function effectiveCollectorScope(value) {
  return normalizedCollectorScope(value) || DEFAULT_COLLECTOR_SCOPE;
}

function configuredCollectorScope(environment = process.env) {
  const rawValue = environment && environment.COLLECTOR_SCOPE;
  if (rawValue == null || String(rawValue).trim() === '') {
    return DEFAULT_COLLECTOR_SCOPE;
  }
  return normalizedCollectorScope(rawValue);
}

function durableCollectorScope(database) {
  if (!tableExists(database, 'live_monitor_state')) return null;
  const row = database.prepare(`
    SELECT value FROM live_monitor_state WHERE key='collector_scope' LIMIT 1
  `).get();
  return normalizedCollectorScope(row && row.value);
}

function collectorScopePolicy(database, environment = process.env) {
  const configuredScope = configuredCollectorScope(environment);
  const durableScope = durableCollectorScope(database);
  if (!configuredScope) {
    return {
      ready: false,
      scope: DEFAULT_COLLECTOR_SCOPE,
      configuredScope: null,
      durableScope,
      disposition: 'scope_env_invalid'
    };
  }
  if (!durableScope) {
    return {
      ready: false,
      scope: configuredScope,
      configuredScope,
      durableScope: null,
      disposition: 'scope_state_missing'
    };
  }
  if (configuredScope !== durableScope) {
    return {
      ready: false,
      scope: configuredScope === 'bid_only' || durableScope === 'bid_only'
        ? 'bid_only'
        : configuredScope,
      configuredScope,
      durableScope,
      disposition: 'scope_mismatch'
    };
  }
  return {
    ready: true,
    scope: durableScope,
    configuredScope,
    durableScope,
    disposition: 'in_scope'
  };
}

function requireCollectorScope(database, environment = process.env) {
  const policy = collectorScopePolicy(database, environment);
  if (policy.ready) return policy.scope;
  const error = new Error('Collector scope is temporarily unavailable');
  error.statusCode = 503;
  error.collectorScopeDisposition = policy.disposition;
  throw error;
}

function requestHasActiveBidMembership(database, srnumber) {
  if (!tableExists(database, 'live_portal_requests')
      || !tableExists(database, 'live_request_bid_memberships')
      || !tableExists(database, 'business_improvement_district_boundary_versions')) {
    const error = new Error('BID collection scope is temporarily unavailable');
    error.statusCode = 503;
    throw error;
  }
  return Boolean(database.prepare(`
    SELECT 1
    FROM live_portal_requests AS live
    JOIN live_request_bid_memberships AS membership
      ON membership.srnumber=live.srnumber
    JOIN business_improvement_district_boundary_versions AS boundary
      ON boundary.version=membership.boundary_version AND boundary.active=1
    WHERE live.srnumber=?
    LIMIT 1
  `).get(srnumber));
}

function requireRequestCollectorAccess(database, srnumber) {
  const scope = requireCollectorScope(database);
  if (scope === 'citywide' || requestHasActiveBidMembership(database, srnumber)) {
    return scope;
  }
  const error = new Error('Request is outside the active BID collection scope');
  error.statusCode = 404;
  throw error;
}

function verifyArchiveCollectorScope(databasePath) {
  if (!require('fs').existsSync(databasePath)) {
    const error = new Error('Live archive is not available yet');
    error.statusCode = 503;
    throw error;
  }
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return requireCollectorScope(database);
  } finally {
    database.close();
  }
}

function portalDetailAccess(portalId) {
  const databasePath = process.env.DATABASE_PATH
    || path.join(__dirname, 'data', 'portal-archive.sqlite');
  if (!require('fs').existsSync(databasePath)) {
    return { allowed: false, unavailable: true };
  }

  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const policy = collectorScopePolicy(database);
    if (!policy.ready) {
      return { allowed: false, unavailable: true };
    }
    if (policy.scope === 'citywide') return { allowed: true };
    if (!tableExists(database, 'live_portal_requests')) {
      return { allowed: false, unavailable: true };
    }
    const request = database.prepare(`
      SELECT srnumber FROM live_portal_requests WHERE portal_id=? LIMIT 1
    `).get(portalId);
    const member = request && requestHasActiveBidMembership(database, request.srnumber);
    return member
      ? { allowed: true }
      : { allowed: false, unavailable: false };
  } catch (error) {
    console.error('Portal detail scope check error:', error.message);
    return { allowed: false, unavailable: true };
  } finally {
    if (database) database.close();
  }
}

function scopeIsEmpty(scope) {
  return !scope || (!scope.precinct && !scope.bid && !scope.collectorBidOnly);
}

function scopeParameters(scope) {
  return {
    ...(scope && scope.precinct ? {
      precinct: scope.precinct.precinct,
      precinct_boundary_version: scope.precinct.boundaryVersion
    } : {}),
    ...(scope && scope.bid ? {
      bid_id: scope.bid.bidId,
      bid_boundary_version: scope.bid.boundaryVersion
    } : {})
  };
}

function scopePredicates(alias, scope, bidAlias = null) {
  const predicates = [];
  if (scope && scope.precinct) {
    predicates.push(
      `${alias}.police_precinct=@precinct`,
      `${alias}.police_precinct_boundary_version=@precinct_boundary_version`
    );
  }
  if (scope && scope.bid) {
    if (bidAlias) {
      predicates.push(
        `${bidAlias}.boundary_version=@bid_boundary_version`,
        `${bidAlias}.bid_id=@bid_id`
      );
    } else {
      predicates.push(`EXISTS (
        SELECT 1 FROM live_request_bid_memberships AS bid_membership
        WHERE bid_membership.srnumber=${alias}.srnumber
          AND bid_membership.boundary_version=@bid_boundary_version
          AND bid_membership.bid_id=@bid_id
      )`);
    }
  } else if (scope && scope.collectorBidOnly) {
    // Keep newest-record pages suffix ordered. Materializing every active
    // membership before applying ORDER BY/LIMIT made a ten-row first paint
    // scale with the full BID archive. This indexed membership lookup lets
    // SQLite stop as soon as the requested page is full.
    predicates.push(`EXISTS (
      SELECT 1
      FROM live_request_bid_memberships AS collector_bid_membership
      JOIN business_improvement_district_boundary_versions AS collector_bid_boundary
        ON collector_bid_boundary.version=collector_bid_membership.boundary_version
       AND collector_bid_boundary.active=1
      WHERE collector_bid_membership.srnumber=${alias}.srnumber
    )`);
  }
  return predicates;
}

function scopedLiveRequestSource(alias, scope, bidAlias = `${alias}_scope_bid`) {
  if (!scope || !scope.bid) {
    // Unfiltered BID-only reads are constrained by scopePredicates(). Starting
    // from the request table preserves its suffix-ordered LIMIT fast path.
    return `live_portal_requests AS ${alias}`;
  }
  // Start BID-scoped reads at the small, indexed membership set. The former
  // correlated EXISTS predicate scanned the large request table in suffix
  // order and performed a membership lookup for every row it encountered.
  return `live_request_bid_memberships AS ${bidAlias}
    JOIN live_portal_requests AS ${alias}
      ON ${alias}.srnumber=${bidAlias}.srnumber`;
}

function businessImprovementDistrictIdsSql(alias = 'live') {
  return `COALESCE((
    SELECT json_group_array(ordered.bid_id)
    FROM (
      SELECT membership.bid_id
      FROM live_request_bid_memberships AS membership
      WHERE membership.srnumber=${alias}.srnumber
        AND membership.boundary_version=${alias}.business_improvement_district_boundary_version
      ORDER BY membership.bid_id
    ) AS ordered
  ),'[]')`;
}

function liveSummaryRevision(database) {
  try {
    const row = database.prepare(`
      SELECT value FROM live_monitor_state WHERE key='last_successful_poll_at'
    `).get();
    return row && row.value ? String(row.value) : 'starting';
  } catch (_) {
    return 'starting';
  }
}

function cachedLiveSummary(database, databasePath, scope = null) {
  const now = Date.now();
  const revision = liveSummaryRevision(database);
  const scoped = !scopeIsEmpty(scope);
  const cacheKey = scoped
    ? `${databasePath}|precinct:${scope.precinct ? scope.precinct.precinct : 'all'}`
      + `:${scope.precinct ? scope.precinct.boundaryVersion : 'none'}`
      + `|bid:${scope.bid ? scope.bid.bidId : 'all'}`
      + `:${scope.bid ? scope.bid.boundaryVersion : 'none'}`
      + `|collector:${scope.collectorBidOnly ? 'bid_only' : 'citywide'}`
    : `${databasePath}|geography:all`;
  const cached = liveSummaryCache.get(cacheKey);
  if (cached && cached.revision === revision && now - cached.created_at < LIVE_SUMMARY_CACHE_TTL_MS) {
    return cached.summary;
  }
  const qualityEntry = !scoped ? archiveQualityCache.get(databasePath) : null;
  const archiveQuality = qualityEntry && now - qualityEntry.created_at < ARCHIVE_QUALITY_CACHE_TTL_MS
    ? qualityEntry.quality
    : null;
  const summary = loadSqliteLiveSummary(database, {
    now: new Date(now),
    archiveQuality,
    policePrecinct: scope && scope.precinct && scope.precinct.precinct,
    policePrecinctBoundaryVersion: scope && scope.precinct && scope.precinct.boundaryVersion,
    businessImprovementDistrictId: scope && scope.bid && scope.bid.bidId,
    businessImprovementDistrictBoundaryVersion: scope && scope.bid && scope.bid.boundaryVersion,
    requireBidMembership: Boolean(scope && scope.collectorBidOnly)
  });
  if (!scoped && !archiveQuality) {
    archiveQualityCache.set(databasePath, {
      created_at: now,
      quality: {
        archive_requests: summary.data_quality.archive_requests,
        missing_submitted_time: summary.data_quality.missing_submitted_time,
        invalid_submitted_time: summary.data_quality.invalid_submitted_time,
        oldest_submitted_at: summary.data_quality.oldest_submitted_at
      }
    });
  }
  liveSummaryCache.set(cacheKey, { created_at: now, revision, summary });
  return summary;
}

const LEGACY_RECONCILIATION_STATUSES = new Set([
  'pending',
  'running',
  'paused_rate_limit',
  'applying',
  'subscribing',
  'complete',
  'failed'
]);

function reconciliationCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : 0;
}

function reconciliationTimestamp(value, fallback = null) {
  const candidate = typeof value === 'string' && value.length <= 64
    ? value.trim()
    : '';
  if (!candidate || !/^\d{4}-\d{2}-\d{2}T/.test(candidate)) return fallback;
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : fallback;
}

function reconciliationMessage(value) {
  if (typeof value !== 'string') return null;
  const message = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return message ? message.slice(0, 300) : null;
}

function sanitizeLegacyReconciliation(value, stateUpdatedAt = null) {
  if (typeof value === 'string' && value.length > 32_768) return null;
  const parsed = parseState(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.version !== 1 || !LEGACY_RECONCILIATION_STATUSES.has(parsed.status)) return null;

  const total = reconciliationCount(parsed.total_candidates);
  const checked = reconciliationCount(parsed.checked, total || Number.MAX_SAFE_INTEGER);
  const apiReturned = reconciliationCount(parsed.api_returned, checked);
  const apiOmitted = reconciliationCount(parsed.api_omitted, checked);
  const apiClosed = reconciliationCount(parsed.api_closed, apiReturned);
  const apiOpen = reconciliationCount(parsed.api_open, apiReturned);
  const closuresCorrected = reconciliationCount(parsed.closures_corrected, apiClosed);
  const updatedAt = reconciliationTimestamp(
    parsed.updated_at,
    reconciliationTimestamp(stateUpdatedAt)
  );

  return {
    version: 1,
    status: parsed.status,
    started_at: reconciliationTimestamp(parsed.started_at),
    updated_at: updatedAt,
    finished_at: reconciliationTimestamp(parsed.finished_at),
    total_candidates: total,
    checked,
    percent: total > 0
      ? Number(((checked / total) * 100).toFixed(1))
      : parsed.status === 'complete' ? 100 : 0,
    api_calls: reconciliationCount(parsed.api_calls),
    api_returned: apiReturned,
    api_omitted: apiOmitted,
    api_closed: apiClosed,
    api_open: apiOpen,
    closures_corrected: closuresCorrected,
    open_subscriptions_queued: reconciliationCount(
      parsed.open_subscriptions_queued,
      apiOpen + apiOmitted
    ),
    errors: reconciliationCount(parsed.errors),
    retry_after_seconds: parsed.retry_after_seconds == null
      ? null
      : reconciliationCount(parsed.retry_after_seconds, 86_400),
    estimated_seconds_remaining: parsed.estimated_seconds_remaining == null
      ? null
      : reconciliationCount(parsed.estimated_seconds_remaining, 31_536_000),
    message: reconciliationMessage(parsed.message)
  };
}

function liveDashboardCompactMode(req) {
  if (!req.query || !Object.prototype.hasOwnProperty.call(req.query, 'compact')) {
    return true;
  }
  const value = req.query.compact;
  if (value !== '0' && value !== '1') {
    const error = new Error('compact must be 0 or 1');
    error.statusCode = 400;
    throw error;
  }
  return value === '1';
}

function liveDashboardIncludeTotals(req) {
  if (!req.query || !Object.prototype.hasOwnProperty.call(req.query, 'include_totals')) {
    return true;
  }
  const value = req.query.include_totals;
  if (value !== '0' && value !== '1') {
    const error = new Error('include_totals must be 0 or 1');
    error.statusCode = 400;
    throw error;
  }
  return value === '1';
}

function liveMapIncludeTotals(req) {
  if (!req.query || !Object.prototype.hasOwnProperty.call(req.query, 'include_totals')) {
    return false;
  }
  const value = req.query.include_totals;
  if (value !== '0' && value !== '1') {
    const error = new Error('include_totals must be 0 or 1');
    error.statusCode = 400;
    throw error;
  }
  return value === '1';
}

function liveMapPaginationMode(req) {
  if (!req.query || !Object.prototype.hasOwnProperty.call(req.query, 'paginate')) {
    return false;
  }
  if (req.query.paginate !== '1') {
    const error = new Error('paginate must be 1 when pagination is requested');
    error.statusCode = 400;
    throw error;
  }
  return true;
}

function positiveSuffixQuery(req, name) {
  const raw = req.query && req.query[name];
  if (raw == null || String(raw).trim() === '') return null;
  if (Array.isArray(raw) || typeof raw === 'object'
      || !/^\d{1,12}$/.test(String(raw).trim())) {
    const error = new Error(`${name} must be a positive request suffix`);
    error.statusCode = 400;
    throw error;
  }
  const suffix = Number(raw);
  if (!Number.isSafeInteger(suffix) || suffix < 1) {
    const error = new Error(`${name} must be a positive request suffix`);
    error.statusCode = 400;
    throw error;
  }
  return suffix;
}

function isoTimestampQuery(req, name) {
  const raw = req.query && req.query[name];
  if (raw == null || String(raw).trim() === '') return null;
  try {
    return mapSubmittedSince(raw);
  } catch (_) {
    const error = new Error(`${name} must be an ISO UTC timestamp`);
    error.statusCode = 400;
    throw error;
  }
}

function archiveSnapshotAt() {
  // The collector and web process share the same host clock. A wall-clock
  // boundary avoids an archive-wide MAX() scan on every first page while
  // excluding records first observed after pagination began.
  return new Date().toISOString();
}

function optionalRecordFilters(req) {
  function read(name, maximumLength) {
    const raw = req.query && req.query[name];
    if (raw == null || String(raw).trim() === '') return null;
    if (Array.isArray(raw) || typeof raw === 'object') {
      const error = new Error(`${name} must be a single text value`);
      error.statusCode = 400;
      throw error;
    }
    const value = String(raw).trim();
    if (value.length > maximumLength) {
      const error = new Error(`${name} must be ${maximumLength} characters or fewer`);
      error.statusCode = 400;
      throw error;
    }
    return value;
  }
  return {
    status: read('status', 100),
    query: read('q', 200),
    requestType: read('request_type', 200),
    requestSubtype: read('request_subtype', 300)
  };
}

function effectiveTextSql(alias, column, detailsAlias = null, detailColumn = column) {
  const liveColumn = `${alias}.${column}`;
  if (!detailsAlias) return `NULLIF(TRIM(${liveColumn}),'')`;
  return `COALESCE(
    NULLIF(TRIM(${liveColumn}),''),
    NULLIF(TRIM(${detailsAlias}.${detailColumn}),'')
  )`;
}

function effectiveStatusSql(alias, {
  detailsAlias = null,
  followupAlias = null
} = {}) {
  return `nyc311_effective_status(
    ${alias}.status,
    ${detailsAlias ? `${detailsAlias}.status` : 'NULL'},
    ${followupAlias ? `${followupAlias}.state` : 'NULL'},
    ${detailsAlias ? `${detailsAlias}.date_closed` : 'NULL'}
  )`;
}

function effectiveSubmittedJulianDaySql(alias, detailsAlias = null) {
  return `COALESCE(
    julianday(${alias}.submitted_at),
    ${detailsAlias ? `julianday(${detailsAlias}.date_reported)` : 'NULL'}
  )`;
}

function registerEffectiveRecordSqlFunctions(database) {
  database.function('nyc311_effective_status', { deterministic: true }, (
    liveStatus,
    detailStatus,
    followupState,
    detailDateClosed
  ) => {
    const status = hasText(liveStatus)
      ? liveStatus
      : hasText(detailStatus) ? detailStatus : null;
    return currentLifecycleProjection({
      status,
      followup_state: followupState,
      date_closed: detailDateClosed
    }).status;
  });
}

function recordFilterPredicates(alias, filters, {
  detailsAlias = null,
  followupAlias = null
} = {}) {
  const predicates = [];
  const effectiveStatus = effectiveStatusSql(alias, { detailsAlias, followupAlias });
  if (filters.status) {
    predicates.push(
      `${effectiveStatus}=@filter_status COLLATE NOCASE`
    );
  }
  if (filters.requestType) {
    predicates.push(
      `${effectiveTextSql(alias, 'problem', detailsAlias)}=@filter_request_type COLLATE NOCASE`
    );
  }
  if (filters.requestSubtype) {
    predicates.push(detailsAlias
      ? `NULLIF(TRIM(${detailsAlias}.problem_details),'')=@filter_request_subtype COLLATE NOCASE`
      : '0');
  }
  if (filters.query) {
    const exactSrnumber = /^311-\d{8}$/i.test(filters.query);
    if (exactSrnumber) {
      predicates.push(`${alias}.srnumber=@filter_srnumber COLLATE NOCASE`);
    } else {
      const expressions = [
        `${alias}.srnumber`,
        effectiveTextSql(alias, 'problem', detailsAlias),
        effectiveTextSql(alias, 'address', detailsAlias),
        effectiveStatus
      ];
      predicates.push(`(${expressions
        .map(expression => `INSTR(LOWER(COALESCE(${expression},'')),@filter_query)>0`)
        .join(' OR ')})`);
    }
  }
  return predicates;
}

function recordFilterParameters(filters) {
  return {
    ...(filters.status ? { filter_status: filters.status } : {}),
    ...(filters.requestType ? { filter_request_type: filters.requestType } : {}),
    ...(filters.requestSubtype ? { filter_request_subtype: filters.requestSubtype } : {}),
    ...(filters.query && /^311-\d{8}$/i.test(filters.query)
      ? { filter_srnumber: filters.query.toUpperCase() }
      : {}),
    ...(filters.query && !/^311-\d{8}$/i.test(filters.query)
      ? { filter_query: filters.query.toLowerCase() }
      : {})
  };
}

function sqlWhere(predicates) {
  return predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
}

function quoteSqliteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function liveRequestIndexWithColumns(database, expectedColumns) {
  const indexes = database.prepare(`
    SELECT name FROM pragma_index_list(?)
  `).all('live_portal_requests');
  const indexColumns = database.prepare(`
    SELECT name FROM pragma_index_info(?) ORDER BY seqno
  `);
  for (const row of indexes) {
    const columns = indexColumns.all(row.name).map(column => column.name);
    if (columns.length === expectedColumns.length
        && columns.every((column, index) => column === expectedColumns[index])) {
      return row.name;
    }
  }
  return null;
}

function liveMapRequestIndexClause(database, scope, { exactSrnumber = false } = {}) {
  // BID scopes begin at the indexed membership set, and exact request-number
  // searches must remain free to use the request primary key. Precinct queries
  // have their own suffix-ordered index; unscoped pages use the UNIQUE suffix
  // index and scan it backward without a temporary sort.
  if (exactSrnumber || (scope && scope.bid && !scope.precinct)) return '';
  const preferredColumns = scope && scope.precinct
    ? ['police_precinct', 'suffix']
    : ['suffix'];
  const preferred = liveRequestIndexWithColumns(database, preferredColumns);
  const fallback = preferred || (
    preferredColumns.length > 1
      ? liveRequestIndexWithColumns(database, ['suffix'])
      : null
  );
  return fallback ? `INDEXED BY ${quoteSqliteIdentifier(fallback)}` : '';
}

function emptyCompactDashboardStats() {
  return {
    compact: true,
    frontier: null,
    last_successful_poll_at: null,
    last_attempt_at: null,
    last_seen_at: null,
    poll_interval_seconds: 60,
    collector_scope: DEFAULT_COLLECTOR_SCOPE,
    number_audit_mode: 'not_applicable_bid_only',
    bid_collector: null,
    legacy_reconciliation: null
  };
}

function compactLiveDashboardStats(database) {
  const stats = emptyCompactDashboardStats();
  if (!tableExists(database, 'live_monitor_state')) return stats;

  // These primary-key lookups deliberately avoid all archive-wide counts. The
  // compact dashboard is the first-paint path, so it must remain responsive
  // even while the collector is writing or analytics are being refreshed.
  const stateByKey = database.prepare(`
    SELECT value,updated_at
    FROM live_monitor_state
    WHERE key=?
  `);
  const frontierRow = stateByKey.get('live_frontier');
  const lastPollRow = stateByKey.get('last_successful_poll_at');
  const lastAttemptRow = stateByKey.get('bid_collector_last_attempt_at');
  const pollIntervalRow = stateByKey.get('poll_interval_seconds');
  const collectorScopeRow = stateByKey.get('collector_scope');
  const numberAuditModeRow = stateByKey.get('number_audit_mode');
  const bidPollIntervalRow = stateByKey.get('bid_poll_interval_seconds');
  const bidBoundaryVersionRow = stateByKey.get('bid_boundary_version');
  const bidBoundaryHashRow = stateByKey.get('bid_boundary_sha256');
  const bidPlanHashRow = stateByKey.get('bid_query_plan_hash');
  const bidZoneCountRow = stateByKey.get('bid_query_zone_count');
  const bidCatchingUpRow = stateByKey.get('bid_collector_catching_up_zones');
  const reconciliationRow = stateByKey.get('legacy_reconciliation');

  stats.collector_scope = effectiveCollectorScope(collectorScopeRow && collectorScopeRow.value);
  stats.number_audit_mode = numberAuditModeRow && numberAuditModeRow.value
    || (stats.collector_scope === 'bid_only'
      ? 'not_applicable_bid_only'
      : 'citywide_suffix_gap');
  const frontier = stats.collector_scope === 'bid_only'
    ? Number.NaN
    : frontierRow ? Number(frontierRow.value) : Number.NaN;
  if (Number.isSafeInteger(frontier) && frontier >= 0) {
    stats.frontier = frontier;
  }
  const lastSuccessfulPollAt = reconciliationTimestamp(lastPollRow && lastPollRow.value);
  const lastAttemptAt = reconciliationTimestamp(lastAttemptRow && lastAttemptRow.value);
  stats.last_successful_poll_at = lastSuccessfulPollAt;
  stats.last_attempt_at = stats.collector_scope === 'bid_only' ? lastAttemptAt : null;
  // Keep the existing dashboard field during the compact-mode transition.
  // A successful Portal poll is the lightweight freshness signal stored by
  // the collector; finding MAX(last_seen_at) would scan the request archive.
  stats.last_seen_at = stats.collector_scope === 'bid_only'
    ? lastAttemptAt || lastSuccessfulPollAt
    : lastSuccessfulPollAt;
  const selectedIntervalRow = stats.collector_scope === 'bid_only'
    ? bidPollIntervalRow
    : pollIntervalRow;
  const pollInterval = selectedIntervalRow
    ? Number(selectedIntervalRow.value)
    : Number.NaN;
  if (Number.isSafeInteger(pollInterval) && pollInterval > 0 && pollInterval <= 3_600) {
    stats.poll_interval_seconds = pollInterval;
  }
  stats.legacy_reconciliation = stats.collector_scope === 'bid_only'
    ? null
    : sanitizeLegacyReconciliation(
      reconciliationRow && reconciliationRow.value,
      reconciliationRow && reconciliationRow.updated_at
    );
  if (stats.collector_scope === 'bid_only') {
    const planHash = bidPlanHashRow && bidPlanHashRow.value;
    let failedZones = 0;
    let saturatedZones = 0;
    let recordedZones = 0;
    if (planHash && tableExists(database, 'bid_collector_zone_state')) {
      const health = database.prepare(`
        SELECT
          COUNT(*) AS recorded,
          SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN saturation_count>0 THEN 1 ELSE 0 END) AS saturated
        FROM bid_collector_zone_state
        WHERE plan_hash=?
      `).get(planHash);
      recordedZones = Number(health && health.recorded || 0);
      failedZones = Number(health && health.failed || 0);
      saturatedZones = Number(health && health.saturated || 0);
    }
    stats.bid_collector = {
      boundary_version: bidBoundaryVersionRow && bidBoundaryVersionRow.value || null,
      boundary_sha256: bidBoundaryHashRow && bidBoundaryHashRow.value || null,
      plan_hash: planHash || null,
      zone_count: Number(bidZoneCountRow && bidZoneCountRow.value || 0),
      failed_zones: failedZones,
      saturated_zones: saturatedZones,
      catching_up_zones: Math.max(
        0,
        Number(bidCatchingUpRow && bidCatchingUpRow.value || 0),
        Number(bidZoneCountRow && bidZoneCountRow.value || 0) - recordedZones
      )
    };
  }
  return stats;
}

function releaseInfoPath(databasePath) {
  return process.env.RELEASE_INFO_PATH
    || path.join(path.dirname(databasePath), 'release-info.json');
}

function readReleaseInfo(databasePath) {
  const fs = require('fs');
  const infoPath = releaseInfoPath(databasePath);
  if (!fs.existsSync(infoPath)) {
    return {
      available: false,
      message: 'No timed deployment has been recorded yet'
    };
  }
  const parsed = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  return {
    available: true,
    ...parsed
  };
}

app.use(express.json({ limit: '16kb' }));

const immutableVendorAssets = {
  immutable: true,
  maxAge: '1y'
};
app.use(
  '/vendor/leaflet',
  express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), immutableVendorAssets)
);
app.use(
  '/vendor/leaflet-markercluster',
  express.static(
    path.join(__dirname, 'node_modules', 'leaflet.markercluster', 'dist'),
    immutableVendorAssets
  )
);

// Always revalidate the app shell so mobile browsers pick up versioned assets.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ============================================================
// Portal fetch helpers
// ============================================================

const PORTAL_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const PORTAL_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Explorer/1.0)',
  'Referer': 'https://portal.311.nyc.gov/check-status/',
  'Origin': 'https://portal.311.nyc.gov'
};
const PORTAL_CAP = 100;       // Hard limit per request
const CONCURRENCY = 8;        // Max parallel portal calls
const CACHE_TTL = 10 * 60 * 1000; // 10-minute cache

// Simple in-memory cache: key → { data, timestamp }
const cache = new Map();

function cacheKey(params) {
  return JSON.stringify(params);
}

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  // Evict old entries if cache grows too large
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function portalTimestampDay(value) {
  const normalized = normalizePortalTimestamp(value);
  const match = normalized && normalized.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizePortalPin(pin) {
  return {
    id: pin.id || null,
    srnumber: (pin.data && pin.data.srnumber) || null,
    problem: (pin.data && pin.data.problem) || pin.label || null,
    address: (pin.data && pin.data.address) || pin.sublabel || null,
    latitude: parseFloat(pin.latitude) || null,
    longitude: parseFloat(pin.longitude) || null,
    submitteddate: normalizePortalTimestamp(pin.data && pin.data.submitteddate),
    status: (pin.data && pin.data.status) || null,
    portalUrl: pin.id ? `https://portal.311.nyc.gov/sr-details/?id=${pin.id}` : null
  };
}

/**
 * Fetch a single portal window. Returns normalized pins array.
 */
async function fetchPortalWindow(bbox, fromdate, todate) {
  const params = new URLSearchParams();
  if (bbox.minlatitude) params.append('minlatitude', bbox.minlatitude);
  if (bbox.minlongitude) params.append('minlongitude', bbox.minlongitude);
  if (bbox.maxlatitude) params.append('maxlatitude', bbox.maxlatitude);
  if (bbox.maxlongitude) params.append('maxlongitude', bbox.maxlongitude);
  params.append('fromdate', fromdate);
  params.append('todate', todate);

  const url = `${PORTAL_URL}?${params.toString()}`;
  const response = await fetch(url, { headers: PORTAL_HEADERS });
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      data = JSON.parse(jsonMatch[0]);
    } else {
      return { pins: [], hitCap: false };
    }
  }

  const rawPins = Array.isArray(data) ? data : [];
  const pins = rawPins.map(normalizePortalPin);

  return { pins, rawPins, hitCap: pins.length >= PORTAL_CAP };
}

/**
 * Run promises with concurrency limit
 */
async function parallelLimit(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = task().then(result => {
      executing.delete(p);
      return result;
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * Generate date pairs: split a range into daily windows.
 * Returns array of { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 */
function dailyWindows(fromDate, toDate) {
  const windows = [];
  const start = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');

  const cursor = new Date(start);
  while (cursor <= end) {
    const dayStr = cursor.toISOString().split('T')[0];
    windows.push({ from: dayStr, to: dayStr });
    cursor.setDate(cursor.getDate() + 1);
  }
  return windows;
}

function portalQueryScope(req) {
  const databasePath = process.env.DATABASE_PATH
    || path.join(__dirname, 'data', 'portal-archive.sqlite');
  if (!require('fs').existsSync(databasePath)) {
    const error = new Error('BID collection scope is temporarily unavailable');
    error.statusCode = 503;
    throw error;
  }
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const scope = requireCollectorScope(database);
    if (scope === 'citywide') {
      return {
        scope,
        bbox: {
          minlatitude: req.query.minlatitude,
          minlongitude: req.query.minlongitude,
          maxlatitude: req.query.maxlatitude,
          maxlongitude: req.query.maxlongitude
        },
        bidFeature: null
      };
    }
    if (req.query.bid_id == null || String(req.query.bid_id).trim() === '') {
      const error = new Error('bid_id is required for BID-scoped Portal retrieval');
      error.statusCode = 400;
      throw error;
    }
    const bidFeature = loadActiveBusinessImprovementDistrictFeature(
      database,
      req.query.bid_id
    );
    const expectedBoundaryVersion = requestedBoundaryVersion(
      req,
      'bid_boundary_version'
    );
    if (expectedBoundaryVersion
        && expectedBoundaryVersion !== bidFeature.properties.boundary_version) {
      const error = new Error('Business improvement district boundary release changed; reload the BID');
      error.statusCode = 409;
      throw error;
    }
    return {
      scope,
      bbox: {
        minlongitude: bidFeature.bbox[0],
        minlatitude: bidFeature.bbox[1],
        maxlongitude: bidFeature.bbox[2],
        maxlatitude: bidFeature.bbox[3]
      },
      bidFeature
    };
  } finally {
    database.close();
  }
}

function filterPortalPinsToFeature(pins, feature) {
  if (!feature) return pins;
  return pins.filter(pin => {
    if (pin == null || pin.latitude == null || pin.longitude == null
        || String(pin.latitude).trim() === '' || String(pin.longitude).trim() === '') {
      return false;
    }
    const latitude = Number(pin && pin.latitude);
    const longitude = Number(pin && pin.longitude);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      && geometryCovers(feature.geometry, longitude, latitude);
  });
}

function requireCitywidePortalProxy() {
  const databasePath = process.env.DATABASE_PATH
    || path.join(__dirname, 'data', 'portal-archive.sqlite');
  const scope = verifyArchiveCollectorScope(databasePath);
  if (scope === 'citywide') return;
  const error = new Error('Use the BID-scoped Portal endpoint with an explicit bid_id');
  error.statusCode = 404;
  throw error;
}

// ============================================================
// Adaptive portal endpoint
// ============================================================

app.get('/api/portal-pins-adaptive', async (req, res) => {
  const { fromdate, todate, refresh } = req.query;

  if (!fromdate || !todate) {
    return res.status(400).json({ error: 'fromdate and todate required' });
  }

  let queryScope;
  try {
    queryScope = portalQueryScope(req);
  } catch (error) {
    return res.status(error.statusCode || 503).json({
      error: error.message,
      pins: [],
      stats: {}
    });
  }
  const { bbox, bidFeature } = queryScope;

  // Check cache — skip entirely if the client requested a fresh pull
  const ck = cacheKey({
    bbox,
    fromdate,
    todate,
    endpoint: 'adaptive',
    bid_id: bidFeature && bidFeature.properties.bid_id,
    bid_boundary_version: bidFeature && bidFeature.properties.boundary_version
  });
  if (!refresh) {
    const cached = getCached(ck);
    if (cached) return res.json(cached);
  } else {
    cache.delete(ck);
  }

  try {
    // Phase 1: Daily windows
    const days = dailyWindows(fromdate, todate);
    console.log(`[adaptive] Phase 1: ${days.length} daily windows for ${fromdate} to ${todate}`);

    const dayTasks = days.map(day => () => fetchPortalWindow(bbox, day.from, day.to));
    const dayResults = await parallelLimit(dayTasks, CONCURRENCY);

    // Collect results and identify capped days
    let allPins = [];
    const cappedDays = [];

    for (let i = 0; i < dayResults.length; i++) {
      const { pins, hitCap } = dayResults[i];
      allPins = allPins.concat(pins);
      if (hitCap) {
        cappedDays.push(days[i]);
      }
    }

    const phase1Count = allPins.length;
    const phase1Calls = days.length;

    // Phase 2: Recover capped days recursively. The shared BID recovery client
    // quarters saturated boxes to depth seven and falls back to Portal problem
    // filters for pathological same-coordinate caps. It throws rather than
    // returning a silently truncated result if those filters remain capped.
    let phase2Calls = 0;
    let phase2Diagnostics = {
      retries: 0,
      cappedQueries: 0,
      spatialSplits: 0,
      problemSplits: 0
    };
    if (cappedDays.length > 0) {
      console.log(`[adaptive] Phase 2: ${cappedDays.length} capped days, entering recursive recovery`);
      const recoveryClient = createBidPortalClient({
        fetchImpl: fetch,
        headers: PORTAL_HEADERS,
        concurrency: CONCURRENCY
      });
      const cappedIndexes = cappedDays.map(day => days.findIndex(candidate =>
        candidate.from === day.from && candidate.to === day.to));
      const recoveryTasks = cappedDays.map((day, index) => async () => {
        const original = dayResults[cappedIndexes[index]];
        const rawPins = await recoveryClient.collectRange({
          bbox,
          from: day.from,
          to: day.to,
          initialPins: original && original.rawPins
        });
        return rawPins.map(normalizePortalPin);
      });
      const recoveredDays = await parallelLimit(recoveryTasks, CONCURRENCY);
      phase2Diagnostics = { ...recoveryClient.diagnostics };
      phase2Calls = phase2Diagnostics.portalCalls;

      // Remove the capped-day pins (we're replacing them with tile results)
      const cappedDateSet = new Set(cappedDays.map(d => d.from));
      allPins = allPins.filter(pin => {
        // Keep pin if its date is NOT in a capped day
        if (!pin.submitteddate) return true;
        const dayStr = portalTimestampDay(pin.submitteddate);
        if (!dayStr) return true;
        return !cappedDateSet.has(dayStr);
      });

      // Add the complete recursively recovered days.
      for (const pins of recoveredDays) {
        allPins = allPins.concat(pins);
      }
    }

    // Phase 3: Deduplicate by srnumber (tiles may overlap at edges)
    const seen = new Set();
    let deduped = [];
    for (const pin of allPins) {
      const key = pin.srnumber || pin.id || `${pin.latitude}-${pin.longitude}-${pin.submitteddate}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(pin);
      }
    }
    deduped = filterPortalPinsToFeature(deduped, bidFeature);

    const result = {
      pins: deduped,
      count: deduped.length,
      scope: queryScope.scope,
      bid_id: bidFeature ? bidFeature.properties.bid_id : null,
      bid_boundary_version: bidFeature
        ? bidFeature.properties.boundary_version
        : null,
      stats: {
        phase1_days: days.length,
        phase1_calls: phase1Calls,
        phase2_capped_days: cappedDays.length,
        phase2_calls: phase2Calls,
        total_calls: phase1Calls + phase2Calls,
        total_pins: deduped.length,
        capped_days: cappedDays.map(d => d.from),
        recovery_retries: phase2Diagnostics.retries,
        recursive_spatial_splits: phase2Diagnostics.spatialSplits,
        problem_filter_splits: phase2Diagnostics.problemSplits,
        unresolved_caps: 0,
        ...(bidFeature ? {} : {
          phase1_pins: phase1Count,
          phase2_pins_after_dedup:
            deduped.length - (phase1Count - cappedDays.length * PORTAL_CAP)
        })
      }
    };

    // Cache the result
    setCache(ck, result);

    console.log(`[adaptive] Done: ${deduped.length} pins from ${phase1Calls + phase2Calls} calls (${cappedDays.length} days re-split)`);
    res.json(result);

  } catch (err) {
    console.error('Adaptive portal error:', err.message);
    res.status(500).json({ error: err.message, pins: [], stats: {} });
  }
});

// ============================================================
// Original simple portal endpoint (kept for backward compat)
// ============================================================

app.get('/api/portal-pins', async (req, res) => {
  try {
    requireCitywidePortalProxy();
    const params = new URLSearchParams();
    if (req.query.borough) params.append('borough', req.query.borough);
    if (req.query.fromdate) params.append('fromdate', req.query.fromdate);
    if (req.query.todate) params.append('todate', req.query.todate);
    if (req.query.minlatitude) params.append('minlatitude', req.query.minlatitude);
    if (req.query.minlongitude) params.append('minlongitude', req.query.minlongitude);
    if (req.query.maxlatitude) params.append('maxlatitude', req.query.maxlatitude);
    if (req.query.maxlongitude) params.append('maxlongitude', req.query.maxlongitude);
    if (req.query.problemarea) params.append('problemarea', req.query.problemarea);
    if (req.query.problem) params.append('problem', req.query.problem);

    const url = `https://portal.311.nyc.gov/entity-pin-fetch-service-requests/?${params.toString()}`;
    const response = await fetch(url, { headers: PORTAL_HEADERS });
    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        return res.json({ error: 'Could not parse portal response', pins: [] });
      }
    }

    const pins = Array.isArray(data) ? data.map(normalizePortalPin) : [];

    res.json({ pins, count: pins.length, raw_count: Array.isArray(data) ? data.length : 0 });
  } catch (err) {
    console.error('Portal proxy error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message, pins: [] });
  }
});

// Proxy: 311 Portal SR number lookup
app.get('/api/portal-sr', async (req, res) => {
  try {
    const number = String(req.query.number || '').trim().toUpperCase();
    if (!/^311-\d{8}$/.test(number)) {
      return res.status(400).json({ error: 'valid number parameter required' });
    }
    const databasePath = process.env.DATABASE_PATH
      || path.join(__dirname, 'data', 'portal-archive.sqlite');
    if (!require('fs').existsSync(databasePath)) {
      return res.status(503).json({ error: 'Live archive is not available yet' });
    }
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      requireRequestCollectorAccess(database, number);
    } finally {
      database.close();
    }

    const url = `https://portal.311.nyc.gov/check-status/?number=${encodeURIComponent(number)}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Explorer/1.0)',
        'Referer': 'https://portal.311.nyc.gov/check-status/'
      }
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        return res.json({ error: 'Could not parse SR lookup response' });
      }
    }

    res.json(data);
  } catch (err) {
    console.error('SR lookup proxy error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

function parsePortalDetail(html) {
  const $ = cheerio.load(html);
  const fields = {};

  $('.info label').each((_, label) => {
    const name = $(label).text().replace(/\s+/g, ' ').trim();
    const field = $(label).closest('[class*="col-"]');
    const value = field.find('.control span').first().text()
      .replace(/\s+/g, ' ').trim();
    if (name && value && value !== '-') fields[name] = value;
  });
  const agencyResponse = attachPortalAgencyResponse($, fields);

  const scripts = $('script').map((_, script) => $(script).html() || '').get().join('\n');
  const scriptDate = (id) => {
    const pattern = new RegExp(`\\$\\(["']#${id}["']\\)\\.text\\(getESTDate\\(["']([^"']+)["']\\)\\)`);
    const match = scripts.match(pattern);
    return match ? normalizePortalTimestamp(match[1]) : null;
  };

  return {
    srnumber: fields['SR Number'] || null,
    status: fields['SR Status'] || null,
    problem: fields.Problem || null,
    problemDetails: fields['Problem Details'] || null,
    additionalDetails: fields['Additional Details'] || null,
    agencyResponse,
    address: fields['SR Address'] || null,
    nextUpdate: fields['Time To Next Update'] || null,
    dateReported: scriptDate('srdatereported'),
    updatedOn: scriptDate('srupdatedon'),
    dateClosed: scriptDate('srdateclosed'),
    fields
  };
}

function persistLivePortalDetail(portalId, detail) {
  if (!detail || !detail.srnumber) return;
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  if (!require('fs').existsSync(databasePath)) return;
  const suffixMatch = String(detail.srnumber).match(/^311-(\d{8})$/);
  if (!suffixMatch) return;

  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
      CREATE TABLE IF NOT EXISTS portal_requests (
        srnumber TEXT PRIMARY KEY,
        suffix INTEGER NOT NULL UNIQUE,
        portal_id TEXT UNIQUE,
        status TEXT,
        problem TEXT,
        problem_details TEXT,
        additional_details TEXT,
        address TEXT,
        next_update TEXT,
        date_reported TEXT,
        updated_on TEXT,
        date_closed TEXT,
        fields_json TEXT NOT NULL,
        portal_url TEXT NOT NULL,
        archived_at TEXT NOT NULL
      );
    `);
    const closureTracker = createClosureTracker(database);
    const hasDetailQueue = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'live_detail_queue'
    `).get();
    const now = new Date().toISOString();
    const archivalStatus = detail.dateClosed && !isClosedStatus(detail.status)
      ? 'Closed'
      : detail.status;
    database.exec('BEGIN');
    try {
      database.prepare(`
        INSERT INTO portal_requests (
          srnumber, suffix, portal_id, status, problem, problem_details,
          additional_details, address, next_update, date_reported, updated_on,
          date_closed, fields_json, portal_url, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(srnumber) DO UPDATE SET
          portal_id = COALESCE(excluded.portal_id, portal_requests.portal_id),
          status = CASE
            WHEN portal_requests.date_closed IS NOT NULL AND excluded.date_closed IS NULL
              THEN portal_requests.status
            ELSE COALESCE(excluded.status, portal_requests.status)
          END,
          problem = COALESCE(excluded.problem, portal_requests.problem),
          problem_details = COALESCE(excluded.problem_details, portal_requests.problem_details),
          additional_details = COALESCE(excluded.additional_details, portal_requests.additional_details),
          address = COALESCE(excluded.address, portal_requests.address),
          next_update = COALESCE(excluded.next_update, portal_requests.next_update),
          date_reported = COALESCE(excluded.date_reported, portal_requests.date_reported),
          updated_on = COALESCE(excluded.updated_on, portal_requests.updated_on),
          date_closed = COALESCE(excluded.date_closed, portal_requests.date_closed),
          fields_json = json_patch(
            COALESCE(portal_requests.fields_json, '{}'),
            COALESCE(excluded.fields_json, '{}')
          ),
          portal_url = COALESCE(excluded.portal_url, portal_requests.portal_url),
          archived_at = excluded.archived_at
      `).run(
        detail.srnumber,
        Number(suffixMatch[1]),
        portalId,
        archivalStatus,
        detail.problem,
        detail.problemDetails,
        detail.additionalDetails,
        detail.address,
        detail.nextUpdate,
        detail.dateReported,
        detail.updatedOn,
        detail.dateClosed,
        JSON.stringify(detail.fields || {}),
        `https://portal.311.nyc.gov/sr-details/?id=${portalId}`,
        now
      );

      if (hasDetailQueue) {
        reconcileStoredDetails(database, {
          srnumber: detail.srnumber,
          updatedAt: now
        });
      }

      // A fresh UI fetch may notice a closure before the next map poll. Record
      // that transition and wake the monitor, but leave retries/finalization to
      // the background collector. Cached UI reads never enter this function.
      const current = database.prepare(`
        SELECT status, portal_id FROM live_portal_requests WHERE srnumber = ?
      `).get(detail.srnumber);
      if (current && archivalStatus && isClosedStatus(archivalStatus)
          && !statusesMatch(current.status, archivalStatus)) {
        closureTracker.observeStatus({
          srnumber: detail.srnumber,
          previousStatus: current.status,
          status: archivalStatus,
          source: 'manual_detail',
          effectiveAt: detail.dateClosed || detail.updatedOn,
          observedAt: now,
          snapshot: detail
        });
        database.prepare(`
          UPDATE live_portal_requests SET status = ? WHERE srnumber = ?
        `).run(archivalStatus, detail.srnumber);
        closureTracker.queueMapStatusChange({
          srnumber: detail.srnumber,
          portalId: portalId || current.portal_id,
          previousStatus: current.status,
          status: archivalStatus,
          observedAt: now
        });
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.warn('Could not persist Portal detail:', error.message);
  } finally {
    if (database) database.close();
  }
}

// The live dashboard can prefer the durable archived detail. Other consumers
// retain the endpoint's original live-Portal behavior.
app.get('/api/portal-detail', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'valid id parameter required' });
  }

  res.setHeader('Cache-Control', 'no-store');
  const detailAccess = portalDetailAccess(id);
  if (!detailAccess.allowed) {
    return detailAccess.unavailable
      ? res.status(503).json({ error: 'BID collection scope is temporarily unavailable' })
      : res.status(404).json({ error: 'Request is outside the active BID collection scope' });
  }
  if (req.query.preferArchive === '1') {
    const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
    let storedDetail;
    try {
      storedDetail = readStoredPortalDetail(databasePath, id);
    } catch (error) {
      console.error('Stored Portal detail read error:', error.message);
      return res.status(503).json({ error: 'Archived request details are temporarily unavailable' });
    }
    if (storedDetail) {
      res.setHeader('X-Detail-Source', 'archive');
      return res.json(storedDetail);
    }
    return res.status(404).json({ error: 'Submitted details are still being saved' });
  }

  const ck = cacheKey({ endpoint: 'portal-detail', id });
  const cached = getCached(ck);
  if (cached) {
    res.setHeader('X-Detail-Source', 'memory');
    return res.json(cached);
  }

  const controller = new AbortController();
  // Portal detail pages occasionally take longer than seven seconds even when
  // the map feed is healthy. Match the collector's tolerance so a dashboard
  // click can still hydrate and persist a detail row during a slow response.
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    res.setHeader('X-Detail-Source', 'portal');
    const response = await fetch(`https://portal.311.nyc.gov/sr-details/?id=${encodeURIComponent(id)}`, {
      headers: { ...PORTAL_HEADERS, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Portal detail fetch failed: ${response.status}`);

    const detail = parsePortalDetail(await response.text());
    setCache(ck, detail);
    persistLivePortalDetail(id, detail);
    res.json(detail);
  } catch (err) {
    console.error('Portal detail proxy error:', err.message);
    res.status(502).json({ error: 'Case details are temporarily unavailable' });
  } finally {
    clearTimeout(timeout);
  }
});

// Complete, lightweight marker dataset. This is intentionally separate from the
// bounded dashboard feed so the map does not lose older coordinate-bearing rows.
app.get('/api/police-precincts', (req, res) => {
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  res.setHeader('Cache-Control', 'private, max-age=300');
  try {
    if (!require('fs').existsSync(databasePath)) return res.json({ boundary_version: null, precincts: [] });
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    if (!tableExists(database, 'police_precincts')
        || !tableExists(database, 'police_precinct_boundary_versions')) {
      return res.json({ boundary_version: null, precincts: [] });
    }
    const precincts = database.prepare(`
      SELECT precinct.precinct_number,precinct.label,precinct.boundary_version
      FROM police_precincts AS precinct
      JOIN police_precinct_boundary_versions AS version
        ON version.version=precinct.boundary_version AND version.active=1
      ORDER BY precinct.precinct_number
    `).all();
    return res.json({
      boundary_version: precincts[0] ? precincts[0].boundary_version : null,
      precincts
    });
  } catch (error) {
    console.error('Police precinct list error:', error.message);
    return res.status(503).json({ error: 'Police precincts are temporarily unavailable' });
  } finally {
    if (database) database.close();
  }
});

app.get('/api/business-improvement-districts', (req, res) => {
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  res.setHeader('Cache-Control', 'private, max-age=300');
  try {
    if (!require('fs').existsSync(databasePath)) {
      return res.json({ boundary_version: null, districts: [] });
    }
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    if (!tableExists(database, 'business_improvement_districts')
        || !tableExists(database, 'business_improvement_district_boundary_versions')) {
      return res.json({ boundary_version: null, districts: [] });
    }
    const districts = database.prepare(`
      SELECT district.bid_id,district.name,district.borough_code,
             district.borough_name,district.boundary_version
      FROM business_improvement_districts AS district
      JOIN business_improvement_district_boundary_versions AS version
        ON version.version=district.boundary_version AND version.active=1
      ORDER BY district.name COLLATE NOCASE,district.bid_id
    `).all();
    return res.json({
      boundary_version: districts[0] ? districts[0].boundary_version : null,
      districts
    });
  } catch (error) {
    console.error('Business improvement district list error:', error.message);
    return res.status(503).json({
      error: 'Business improvement districts are temporarily unavailable'
    });
  } finally {
    if (database) database.close();
  }
});

function categoryRows(rows) {
  const categoriesByName = new Map();
  for (const row of rows) {
    const name = String(row.request_type || '').trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase('en-US');
    let category = categoriesByName.get(key);
    if (!category) {
      category = { name, count: 0, subtypes: [] };
      categoriesByName.set(key, category);
    }
    const count = Number(row.request_count || 0);
    category.count += count;
    const subtype = String(row.request_subtype || '').trim();
    if (subtype) category.subtypes.push({ name: subtype, count });
  }
  return [...categoriesByName.values()];
}

// The Portal owns this vocabulary and can introduce new combinations. Build
// the filter catalog from observed records instead of hard-coding categories.
app.get('/api/request-categories', (req, res) => {
  const databasePath = process.env.DATABASE_PATH
    || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  res.setHeader('Cache-Control', 'private, max-age=300');
  try {
    if (!require('fs').existsSync(databasePath)) return res.json({ categories: [] });
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    if (!tableExists(database, 'live_portal_requests')) {
      return res.json({ categories: [] });
    }
    const scope = requestGeographyScope(req, database);
    const hasCategoryCache = tableExists(database, 'live_request_category_cache');
    if (hasCategoryCache) {
      const categoryAlias = 'category_cache';
      let source;
      const predicates = [`${categoryAlias}.request_type IS NOT NULL`];
      if (scope.bid) {
        source = `live_request_bid_memberships AS category_scope_bid
          JOIN live_request_category_cache AS ${categoryAlias}
            ON ${categoryAlias}.srnumber=category_scope_bid.srnumber`;
        predicates.push(
          'category_scope_bid.boundary_version=@bid_boundary_version',
          'category_scope_bid.bid_id=@bid_id'
        );
      } else if (scope.collectorBidOnly) {
        source = `(SELECT DISTINCT membership.srnumber
          FROM live_request_bid_memberships AS membership
          JOIN business_improvement_district_boundary_versions AS boundary
            ON boundary.version=membership.boundary_version AND boundary.active=1
        ) AS category_scope_bid
          JOIN live_request_category_cache AS ${categoryAlias}
            ON ${categoryAlias}.srnumber=category_scope_bid.srnumber`;
      } else {
        source = `live_request_category_cache AS ${categoryAlias}`;
      }
      if (scope.precinct) {
        predicates.push(
          `${categoryAlias}.police_precinct=@precinct`,
          `${categoryAlias}.police_precinct_boundary_version=@precinct_boundary_version`
        );
      }
      const rows = database.prepare(`
        SELECT ${categoryAlias}.request_type,
               ${categoryAlias}.request_subtype,
               COUNT(*) AS request_count
        FROM ${source}
        ${sqlWhere(predicates)}
        GROUP BY ${categoryAlias}.request_type COLLATE NOCASE,
                 ${categoryAlias}.request_subtype COLLATE NOCASE
        ORDER BY ${categoryAlias}.request_type COLLATE NOCASE,
                 request_count DESC,
                 ${categoryAlias}.request_subtype COLLATE NOCASE
      `).all(scopeParameters(scope));
      return res.json({
        categories: categoryRows(rows),
        generated_at: new Date().toISOString()
      });
    }
    const hasDetails = tableExists(database, 'portal_requests');
    const bidAlias = 'category_scope_bid';
    const source = scopedLiveRequestSource('live', scope, bidAlias);
    const detailJoin = hasDetails
      ? 'LEFT JOIN portal_requests AS details ON details.srnumber=live.srnumber'
      : '';
    const typeSql = effectiveTextSql('live', 'problem', hasDetails ? 'details' : null);
    const subtypeSql = hasDetails ? "NULLIF(TRIM(details.problem_details),'')" : 'NULL';
    const predicates = [
      ...scopePredicates('live', scope, bidAlias),
      `${typeSql} IS NOT NULL`
    ];
    const rows = database.prepare(`
      SELECT ${typeSql} AS request_type,
             ${subtypeSql} AS request_subtype,
             COUNT(*) AS request_count
      FROM ${source}
      ${detailJoin}
      ${sqlWhere(predicates)}
      GROUP BY request_type COLLATE NOCASE,request_subtype COLLATE NOCASE
      ORDER BY request_type COLLATE NOCASE,request_count DESC,
               request_subtype COLLATE NOCASE
    `).all(scopeParameters(scope));
    return res.json({
      categories: categoryRows(rows),
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Request category list error:', error.message);
    return res.status(error.statusCode || 503).json({
      error: error.statusCode && error.statusCode < 500
        ? error.message
        : 'Request categories are temporarily unavailable'
    });
  } finally {
    if (database) database.close();
  }
});

function serveBoundaryGeometry(req, res, {
  load,
  id,
  idLabel,
  maxIdDigits,
  versionTable,
  unavailableMessage,
  logLabel
}) {
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  let readTransaction = false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  try {
    const parsedId = strictPositiveId(id, { label: idLabel, maxDigits: maxIdDigits });
    if (!require('fs').existsSync(databasePath)) {
      throw new BoundaryLookupError(unavailableMessage, 503);
    }
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('BEGIN');
    readTransaction = true;
    const expectedVersion = requestedBoundaryVersion(req, 'boundary_version');
    const currentVersion = activeBoundaryVersion(database, versionTable);
    if (expectedVersion && currentVersion && expectedVersion !== currentVersion) {
      throw new BoundaryLookupError(
        `${idLabel} boundary release changed; reload the filter`,
        409
      );
    }
    const feature = load(database, parsedId);
    const actualVersion = feature && feature.properties
      && feature.properties.boundary_version;
    if (expectedVersion && expectedVersion !== actualVersion) {
      throw new BoundaryLookupError(
        `${idLabel} boundary release changed; reload the filter`,
        409
      );
    }
    database.exec('COMMIT');
    readTransaction = false;
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
    return res.json(feature);
  } catch (error) {
    const expected = error instanceof BoundaryLookupError;
    const explicitStatus = Number(error && error.statusCode);
    const statusCode = expected
      ? error.statusCode
      : Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus < 500
        ? explicitStatus
        : 503;
    if (statusCode >= 500) {
      const cause = error.cause && error.cause.message ? `: ${error.cause.message}` : '';
      console.error(`${logLabel}: ${error.message}${cause}`);
    }
    return res.status(statusCode).json({
      error: expected || statusCode < 500 ? error.message : unavailableMessage
    });
  } finally {
    if (database) {
      if (readTransaction) {
        try {
          database.exec('ROLLBACK');
        } catch (_) {}
      }
      database.close();
    }
  }
}

app.get('/api/police-precincts/:precinct/geometry', (req, res) => {
  return serveBoundaryGeometry(req, res, {
    load: loadActivePolicePrecinctFeature,
    id: req.params.precinct,
    idLabel: 'Police precinct',
    maxIdDigits: 3,
    versionTable: 'police_precinct_boundary_versions',
    unavailableMessage: 'Police precinct boundaries are temporarily unavailable',
    logLabel: 'Police precinct geometry error'
  });
});

app.get('/api/business-improvement-districts/:bidId/geometry', (req, res) => {
  return serveBoundaryGeometry(req, res, {
    load: loadActiveBusinessImprovementDistrictFeature,
    id: req.params.bidId,
    idLabel: 'Business improvement district ID',
    maxIdDigits: 6,
    versionTable: 'business_improvement_district_boundary_versions',
    unavailableMessage: 'Business improvement district boundaries are temporarily unavailable',
    logLabel: 'Business improvement district geometry error'
  });
});

app.get('/api/live-map', (req, res) => {
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  let readTransaction = false;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const includeTotals = liveMapIncludeTotals(req);
    const paginate = liveMapPaginationMode(req);
    const filters = optionalRecordFilters(req);
    const emptyPayload = () => {
      const payload = buildLiveMapPayload([]);
      if (!includeTotals) delete payload.stats;
      payload.page = {
        limit: 250,
        returned: 0,
        has_more: false,
        more_available: false,
        next_before_suffix: null,
        snapshot_at: null
      };
      return payload;
    };
    if (!require('fs').existsSync(databasePath)) {
      return res.status(503).json({
        ...emptyPayload(),
        error: 'Live archive is not available yet'
      });
    }
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    registerEffectiveRecordSqlFunctions(database);
    const tables = new Set(database.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
    `).all().map(row => row.name));
    if (!tables.has('live_portal_requests')) {
      return res.status(503).json({
        ...emptyPayload(),
        error: 'Live archive is not initialized yet'
      });
    }
    database.exec('BEGIN');
    readTransaction = true;
    const scope = requestGeographyScope(req, database);
    const rawPageLimit = req.query && req.query.limit;
    // Always bound the work, including requests from older cached clients
    // that predate map pagination. An omitted limit previously selected the
    // entire archive and could hold a long SQLite read lock, starving the
    // collector and every other HTTP request.
    let pageLimit = 250;
    if (rawPageLimit != null && String(rawPageLimit).trim() !== '') {
      if (Array.isArray(rawPageLimit) || typeof rawPageLimit === 'object'
          || !/^\d{1,5}$/.test(String(rawPageLimit).trim())) {
        const error = new Error('limit must be an integer from 1 through 1000');
        error.statusCode = 400;
        throw error;
      }
      pageLimit = Number(rawPageLimit);
      if (pageLimit < 1 || pageLimit > 1000) {
        const error = new Error('limit must be an integer from 1 through 1000');
        error.statusCode = 400;
        throw error;
      }
    }
    const beforeSuffix = positiveSuffixQuery(req, 'before_suffix');
    const submittedSince = isoTimestampQuery(req, 'submitted_since');
    let snapshotAt = isoTimestampQuery(req, 'snapshot_at');
    if (!paginate && (beforeSuffix != null || snapshotAt != null)) {
      const error = new Error('before_suffix and snapshot_at require paginate=1');
      error.statusCode = 400;
      throw error;
    }
    if (paginate && beforeSuffix != null && snapshotAt == null) {
      const error = new Error('snapshot_at is required after the first page');
      error.statusCode = 400;
      throw error;
    }
    if (paginate && snapshotAt == null) snapshotAt = archiveSnapshotAt();

    const hasDetails = tables.has('portal_requests');
    const hasFollowUps = tables.has('request_followup_queue');
    const hasClosureSnapshots = tables.has('request_closure_snapshots');
    const detailColumns = hasDetails
      ? `details.portal_id AS detail_portal_id,
         details.problem AS detail_problem,
         details.problem_details,
         details.address AS detail_address,
         details.status AS detail_status,
         details.portal_url AS detail_portal_url,
         details.date_reported AS detail_date_reported,
         details.date_closed AS detail_date_closed,
         details.archived_at AS details_fetched_at`
      : `NULL AS detail_portal_id,
         NULL AS detail_problem,
         NULL AS problem_details,
         NULL AS detail_address,
         NULL AS detail_status,
         NULL AS detail_portal_url,
         NULL AS detail_date_reported,
         NULL AS detail_date_closed,
         NULL AS details_fetched_at`;
    const detailJoin = hasDetails
      ? 'LEFT JOIN portal_requests AS details ON details.srnumber=live.srnumber'
      : '';
    const followUpColumns = hasFollowUps
      ? `followup.state AS followup_state,
         followup.next_check_at AS next_check_at,
         followup.finalized_at AS finalized_at`
      : `NULL AS followup_state,
         NULL AS next_check_at,
         NULL AS finalized_at`;
    const followUpJoin = hasFollowUps
      ? 'LEFT JOIN request_followup_queue AS followup ON followup.srnumber=live.srnumber'
      : '';
    const exactQuery = Boolean(filters.query && /^311-\d{8}$/i.test(filters.query));
    const needsEffectiveFilters = Boolean(
      filters.status || filters.requestType || filters.requestSubtype
      || (filters.query && !exactQuery)
    );
    const filterDetailJoin = hasDetails && (submittedSince != null || needsEffectiveFilters)
      ? detailJoin
      : '';
    const filterFollowUpJoin = hasFollowUps && needsEffectiveFilters ? followUpJoin : '';
    const currentClosureColumns = hasFollowUps && hasClosureSnapshots
      ? `current_final.date_closed AS current_cycle_date_closed,
         1 AS closure_cycle_tracking`
      : `NULL AS current_cycle_date_closed,
         0 AS closure_cycle_tracking`;
    const currentClosureJoin = hasFollowUps && hasClosureSnapshots
      ? `LEFT JOIN request_closure_snapshots AS current_final
           ON current_final.srnumber=followup.srnumber
          AND current_final.closure_cycle=followup.closure_cycle
          AND current_final.is_final=1`
      : '';
    const bidScopeAlias = 'map_scope_bid';
    const liveSource = scopedLiveRequestSource('live', scope, bidScopeAlias);
    const livePredicates = [
      ...scopePredicates('live', scope, bidScopeAlias),
      ...recordFilterPredicates('live', filters, {
        detailsAlias: hasDetails ? 'details' : null,
        followupAlias: hasFollowUps ? 'followup' : null
      })
    ];
    if (submittedSince != null) {
      livePredicates.push(
        `${effectiveSubmittedJulianDaySql(
          'live',
          hasDetails ? 'details' : null
        )} >= julianday(@submitted_since)`
      );
    }
    if (snapshotAt != null) livePredicates.push('live.first_seen_at <= @snapshot_at');
    const totalsWhere = sqlWhere(livePredicates);
    const mappedPredicates = [
      ...livePredicates,
      'live.latitude BETWEEN -90 AND 90',
      'live.longitude BETWEEN -180 AND 180'
    ];
    if (beforeSuffix != null) mappedPredicates.push('live.suffix < @before_suffix');
    const mappedWhere = sqlWhere(mappedPredicates);
    const liveIndexClause = liveMapRequestIndexClause(database, scope, {
      exactSrnumber: exactQuery
    });
    const liveRecordSource = scope && scope.bid
      ? liveSource
      : `${liveSource} ${liveIndexClause}`;
    const commonParameters = {
      ...scopeParameters(scope),
      ...recordFilterParameters(filters),
      ...(submittedSince != null ? { submitted_since: submittedSince } : {}),
      ...(snapshotAt != null ? { snapshot_at: snapshotAt } : {})
    };
    const totals = includeTotals
      ? database.prepare(`
          SELECT
            COUNT(*) AS total,
            COALESCE(SUM(
              live.latitude BETWEEN -90 AND 90
              AND live.longitude BETWEEN -180 AND 180
            ), 0) AS mapped_total
          FROM ${liveSource}
          ${filterDetailJoin}
          ${filterFollowUpJoin}
          ${totalsWhere}
        `).get(commonParameters)
      : null;
    const queryParameters = {
      ...commonParameters,
      ...(beforeSuffix != null ? { before_suffix: beforeSuffix } : {}),
      map_limit: pageLimit + 1
    };
    const statement = database.prepare(`
      SELECT live.srnumber,live.suffix,live.portal_id,live.problem,live.address,
             live.borough,live.incident_zip,
             live.police_precinct,live.police_precinct_boundary_version,
             ${businessImprovementDistrictIdsSql('live')}
               AS business_improvement_district_ids,
             live.business_improvement_district_boundary_version,
             live.latitude,live.longitude,live.submitted_at,live.status,
             live.portal_url,live.first_seen_at,live.last_seen_at,
             ${detailColumns},${followUpColumns},${currentClosureColumns}
      FROM ${liveRecordSource}
      ${detailJoin}
      ${followUpJoin}
      ${currentClosureJoin}
      ${mappedWhere}
      ORDER BY live.suffix DESC
      LIMIT @map_limit
    `);
    const pageRows = statement.all(queryParameters);
    const hasMore = pageRows.length > pageLimit;
    const rows = hasMore ? pageRows.slice(0, pageLimit) : pageRows;
    const total = totals ? Number(totals.total || 0) : null;
    const mappedTotal = totals ? Number(totals.mapped_total || 0) : null;
    const payload = buildLiveMapPayload(rows, totals ? {
      total,
      mapped_total: mappedTotal,
      unmapped_total: Math.max(0, total - mappedTotal)
    } : null);
    if (!includeTotals) delete payload.stats;
    const lastRecord = payload.records[payload.records.length - 1];
    payload.page = {
      limit: pageLimit,
      returned: payload.records.length,
      // Deliberate paginate=1 callers get a truthful continuation bit. Cached
      // and legacy clients remain bounded to one page.
      has_more: paginate && hasMore,
      more_available: hasMore,
      next_before_suffix: lastRecord ? lastRecord.suffix : null,
      snapshot_at: snapshotAt
    };
    database.exec('COMMIT');
    readTransaction = false;
    return res.json(payload);
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) {
      console.error('Live map data error:', error.message);
    }
    return res.status(error.statusCode || 503).json(
      error.statusCode ? { error: error.message } : buildLiveMapPayload([])
    );
  } finally {
    if (database) {
      if (readTransaction) {
        try {
          database.exec('ROLLBACK');
        } catch (_) {}
      }
      database.close();
    }
  }
});

// Deterministic summary contract for the dashboard and future API clients.
// The live windows are map-feed-only because the delayed number audit cannot
// complete the newest submissions yet. A separate older map-plus-audit window
// is returned without claiming that backlog-free continuity has been proven.
app.get('/api/live-summary', (req, res) => {
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  let readTransaction = false;
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!require('fs').existsSync(databasePath)) {
      return res.status(503).json({ error: 'Live archive is not available yet' });
    }
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('BEGIN');
    readTransaction = true;
    const scope = requestGeographyScope(req, database);
    const payload = cachedLiveSummary(database, databasePath, scope);
    database.exec('COMMIT');
    readTransaction = false;
    return res.json(payload);
  } catch (error) {
    console.error('Live summary error:', error.message);
    return res.status(error.statusCode || 503).json({
      error: error.statusCode ? error.message : 'Live summary is temporarily unavailable'
    });
  } finally {
    if (database) {
      if (readTransaction) {
        try {
          database.exec('ROLLBACK');
        } catch (_) {}
      }
      database.close();
    }
  }
});

// Read-only operational metrics for the email subscription pipeline. The
// response deliberately separates Portal closure time from email delivery
// delay so the dashboard does not present notification speed as agency speed.
app.get('/api/email-metrics', (req, res) => {
  const databasePath = process.env.DATABASE_PATH
    || path.join(__dirname, 'data', 'portal-archive.sqlite');
  res.setHeader('Cache-Control', 'no-store');
  try {
    verifyArchiveCollectorScope(databasePath);
    const result = emailMetricsBackground.get(databasePath);
    if (result.payload.retry_after_seconds) {
      res.setHeader('Retry-After', String(result.payload.retry_after_seconds));
    }
    return res.status(result.statusCode).json(result.payload);
  } catch (error) {
    console.error('Email metrics error:', error.message);
    return res.status(503).json({
      error: 'Email monitoring metrics are temporarily unavailable'
    });
  }
});

app.get('/api/operational-health', (req, res) => {
  const databasePath = process.env.DATABASE_PATH
    || path.join(__dirname, 'data', 'portal-archive.sqlite');
  const now = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  try {
    verifyArchiveCollectorScope(databasePath);
    if (
      operationalHealthCache
      && operationalHealthCache.databasePath === databasePath
      && now - operationalHealthCache.createdAt < OPERATIONAL_HEALTH_CACHE_TTL_MS
    ) {
      return res.status(operationalHealthCache.statusCode)
        .json(operationalHealthCache.payload);
    }
    const analyticsSnapshot = emailMetricsBackground.peek(databasePath);
    const payload = loadOperationalHealth(databasePath, { analyticsSnapshot });
    const statusCode = payload.components.database.available ? 200 : 503;
    operationalHealthCache = {
      databasePath,
      createdAt: now,
      statusCode,
      payload
    };
    return res.status(statusCode).json(payload);
  } catch (error) {
    console.error('Operational health error:', error.message);
    return res.status(503).json({
      version: 1,
      generated_at: new Date(now).toISOString(),
      status: 'attention',
      components: {
        database: {
          status: 'attention',
          reason: 'health_check_unavailable',
          available: false
        }
      }
    });
  }
});

app.get('/api/release-info', (req, res) => {
  const databasePath = process.env.DATABASE_PATH
    || path.join(__dirname, 'data', 'portal-archive.sqlite');
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json(readReleaseInfo(databasePath));
  } catch (error) {
    console.error('Release info read error:', error.message);
    return res.status(503).json({
      available: false,
      error: 'Release timing is temporarily unavailable'
    });
  }
});

// Read-only feed for the macOS live monitor dashboard. The SQLite module is
// loaded lazily so the existing web deployment remains compatible with older
// Node runtimes that do not include node:sqlite.
app.get('/api/live-dashboard', (req, res) => {
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let compact;
  let includeTotals;
  try {
    compact = liveDashboardCompactMode(req);
    includeTotals = liveDashboardIncludeTotals(req);
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      error: error.message,
      records: [],
      stats: {}
    });
  }
  const rawSrnumber = req.query && req.query.srnumber;
  if (Array.isArray(rawSrnumber) || (rawSrnumber != null && typeof rawSrnumber === 'object')) {
    return res.status(400).json({
      error: 'srnumber must use the format 311-12345678',
      records: [],
      stats: {}
    });
  }
  const requestedSrnumber = rawSrnumber == null || String(rawSrnumber).trim() === ''
    ? null
    : String(rawSrnumber).trim().toUpperCase();
  if (requestedSrnumber && !/^311-\d{8}$/.test(requestedSrnumber)) {
    return res.status(400).json({
      error: 'srnumber must use the format 311-12345678',
      records: [],
      stats: {}
    });
  }
  let limit = requestedSrnumber ? 1 : 300;
  const rawLimit = req.query && req.query.limit;
  if (rawLimit != null && String(rawLimit).trim() !== '') {
    if (Array.isArray(rawLimit) || typeof rawLimit === 'object'
        || !/^\d{1,4}$/.test(String(rawLimit).trim())) {
      return res.status(400).json({
        error: 'limit must be an integer from 1 through 300',
        records: [],
        stats: {}
      });
    }
    limit = Number(rawLimit);
  }
  if (requestedSrnumber) {
    limit = 1;
  } else if (!Number.isSafeInteger(limit) || limit < 1 || limit > 300) {
    return res.status(400).json({
      error: 'limit must be an integer from 1 through 300',
      records: [],
      stats: {}
    });
  }
  let beforeSuffix;
  let submittedSince;
  let requestedSnapshotAt;
  let filters;
  try {
    beforeSuffix = positiveSuffixQuery(req, 'before_suffix');
    submittedSince = isoTimestampQuery(req, 'submitted_since');
    requestedSnapshotAt = isoTimestampQuery(req, 'snapshot_at');
    filters = optionalRecordFilters(req);
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      error: error.message,
      records: [],
      stats: {}
    });
  }
  if (requestedSrnumber && beforeSuffix != null) {
    return res.status(400).json({
      error: 'before_suffix cannot be combined with an exact srnumber lookup',
      records: [],
      stats: {}
    });
  }
  if (beforeSuffix != null && requestedSnapshotAt == null) {
    return res.status(400).json({
      error: 'snapshot_at is required after the first page',
      records: [],
      stats: {}
    });
  }
  let database;
  let readTransaction = false;
  try {
    if (!require('fs').existsSync(databasePath)) {
      return res.status(503).json({
        error: 'Live archive is not available yet',
        records: [],
        stats: compact
          ? emptyCompactDashboardStats()
          : { total: 0, pending: 0, frontier: null, last_seen_at: null }
      });
    }
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    registerEffectiveRecordSqlFunctions(database);
    database.exec('BEGIN');
    readTransaction = true;
    const snapshotAt = requestedSnapshotAt || archiveSnapshotAt();
    const scope = requestGeographyScope(req, database);
    const hasDetails = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portal_requests'
    `).get();
    const hasFollowUps = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'request_followup_queue'
    `).get();
    const hasClosureSnapshots = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'request_closure_snapshots'
    `).get();
    const detailColumns = hasDetails
      ? `details.portal_id AS detail_portal_id, details.status AS detail_status,
         details.problem AS detail_problem, details.address AS detail_address,
         details.portal_url AS detail_portal_url,
         details.problem_details, details.additional_details, details.next_update,
         json_extract(details.fields_json, '$."Agency Response"') AS agency_response,
         COALESCE(
           json_extract(details.fields_json, '$."Agency Response Source"'),
           CASE
             WHEN NULLIF(TRIM(json_extract(details.fields_json, '$."Agency Response"')), '') IS NOT NULL
               THEN 'NYC311 Portal'
             ELSE NULL
           END
         ) AS agency_response_source,
         json_extract(details.fields_json, '$."Agency Response Updated At"')
           AS agency_response_updated_at,
         details.date_reported, details.updated_on, details.date_closed,
         details.archived_at AS details_fetched_at`
      : `NULL AS detail_portal_id, NULL AS detail_status,
         NULL AS detail_problem, NULL AS detail_address, NULL AS detail_portal_url,
         NULL AS problem_details, NULL AS additional_details, NULL AS next_update,
         NULL AS agency_response, NULL AS agency_response_source,
         NULL AS agency_response_updated_at,
         NULL AS date_reported, NULL AS updated_on, NULL AS date_closed,
         NULL AS details_fetched_at`;
    const detailJoin = hasDetails
      ? 'LEFT JOIN portal_requests AS details ON details.srnumber = live.srnumber'
      : '';
    const followUpColumns = hasFollowUps
      ? `followup.state AS followup_state, followup.next_check_at,
         followup.closure_cycle, followup.finalized_at`
      : `NULL AS followup_state, NULL AS next_check_at,
         0 AS closure_cycle, NULL AS finalized_at`;
    const followUpJoin = hasFollowUps
      ? 'LEFT JOIN request_followup_queue AS followup ON followup.srnumber = live.srnumber'
      : '';
    const exactQuery = Boolean(filters.query && /^311-\d{8}$/i.test(filters.query));
    const needsEffectiveFilters = Boolean(
      filters.status || filters.requestType || filters.requestSubtype
      || (filters.query && !exactQuery)
    );
    const filterDetailJoin = hasDetails && (submittedSince != null || needsEffectiveFilters)
      ? detailJoin
      : '';
    const filterFollowUpJoin = hasFollowUps && needsEffectiveFilters ? followUpJoin : '';
    const currentClosureColumns = hasFollowUps && hasClosureSnapshots
      ? `current_final.date_closed AS current_cycle_date_closed,
         current_final.final_state AS current_cycle_final_state,
         1 AS closure_cycle_tracking`
      : `NULL AS current_cycle_date_closed,
         NULL AS current_cycle_final_state,
         0 AS closure_cycle_tracking`;
    const currentClosureJoin = hasFollowUps && hasClosureSnapshots
      ? `LEFT JOIN request_closure_snapshots AS current_final
           ON current_final.id = (
             SELECT MAX(snapshot.id)
             FROM request_closure_snapshots AS snapshot
             WHERE snapshot.srnumber = followup.srnumber
               AND snapshot.closure_cycle = followup.closure_cycle
               AND snapshot.is_final = 1
           )`
      : '';
    const bidScopeAlias = 'dashboard_scope_bid';
    const liveSource = scopedLiveRequestSource('live', scope, bidScopeAlias);
    const liveIndexClause = liveMapRequestIndexClause(database, scope, {
      exactSrnumber: Boolean(requestedSrnumber || exactQuery)
    });
    const liveRecordSource = scope && scope.bid
      ? liveSource
      : `${liveSource} ${liveIndexClause}`;
    const livePredicates = [
      ...scopePredicates('live', scope, bidScopeAlias),
      ...recordFilterPredicates('live', filters, {
        detailsAlias: hasDetails ? 'details' : null,
        followupAlias: hasFollowUps ? 'followup' : null
      }),
      'live.first_seen_at <= @snapshot_at'
    ];
    if (submittedSince != null) {
      livePredicates.push(
        `${effectiveSubmittedJulianDaySql(
          'live',
          hasDetails ? 'details' : null
        )} >= julianday(@submitted_since)`
      );
    }
    const scopedParameters = scopeParameters(scope);
    const recordParameters = {
      limit: limit + 1,
      snapshot_at: snapshotAt,
      ...scopedParameters,
      ...recordFilterParameters(filters),
      ...(submittedSince != null ? { submitted_since: submittedSince } : {})
    };
    if (requestedSrnumber) {
      livePredicates.push('live.srnumber=@srnumber');
      recordParameters.srnumber = requestedSrnumber;
    }
    if (beforeSuffix != null) {
      livePredicates.push('live.suffix < @before_suffix');
      recordParameters.before_suffix = beforeSuffix;
    }
    const liveWhere = sqlWhere(livePredicates);
    const storedStatement = database.prepare(`
      SELECT live.srnumber, live.suffix, live.portal_id, live.problem, live.address,
             live.borough,live.incident_zip,
             live.police_precinct,live.police_precinct_boundary_version,
             ${businessImprovementDistrictIdsSql('live')}
               AS business_improvement_district_ids,
             live.business_improvement_district_boundary_version,
             live.latitude, live.longitude, live.submitted_at, live.status,
             live.portal_url, live.first_seen_at, live.last_seen_at,
             ${detailColumns}, ${followUpColumns}, ${currentClosureColumns}
      FROM ${liveRecordSource}
      ${detailJoin}
      ${followUpJoin}
      ${currentClosureJoin}
      ${liveWhere}
      ORDER BY live.suffix DESC
      LIMIT @limit
    `);
    const pageRows = storedStatement.all(recordParameters);
    const hasMore = !requestedSrnumber && pageRows.length > limit;
    const storedRecords = hasMore ? pageRows.slice(0, limit) : pageRows;
    const records = storedRecords.map(stored => {
      const {
        detail_portal_id: detailPortalId,
        detail_status: detailStatus,
        detail_problem: detailProblem,
        detail_address: detailAddress,
        detail_portal_url: detailPortalUrl,
        ...record
      } = stored;
      record.portal_id = hasText(record.portal_id) ? record.portal_id : detailPortalId;
      record.status = hasText(record.status) ? record.status : detailStatus;
      record.problem = hasText(record.problem) ? record.problem : detailProblem;
      record.address = hasText(record.address) ? record.address : detailAddress;
      record.business_improvement_district_ids = businessImprovementDistrictIds(
        record.business_improvement_district_ids
      );
      record.submitted_at = validTimestampValue(
        record.submitted_at,
        record.date_reported
      );
      // Detail rows intentionally retain an older closure date for history.
      // Do not present that date as the current cycle after a reopen, or while
      // a newly observed closure is still being verified.
      record.closure_cycle_tracking = Boolean(record.closure_cycle_tracking);
      Object.assign(record, currentLifecycleProjection(record));
      record.portal_url = hasText(record.portal_url)
        ? record.portal_url
        : detailPortalUrl || (record.portal_id
          ? `https://portal.311.nyc.gov/sr-details/?id=${record.portal_id}`
          : null);
      return { ...record, ...assessRecordAvailability(record) };
    });
    const matchingTotal = !compact && beforeSuffix == null && includeTotals
      ? Number(database.prepare(`
          SELECT COUNT(*) AS count
          FROM ${liveSource}
          ${filterDetailJoin}
          ${filterFollowUpJoin}
          ${sqlWhere(livePredicates)}
        `).get({
          snapshot_at: snapshotAt,
          ...scopedParameters,
          ...recordFilterParameters(filters),
          ...(submittedSince != null ? { submitted_since: submittedSince } : {}),
          ...(requestedSrnumber ? { srnumber: requestedSrnumber } : {})
        }).count || 0)
      : null;
    const lastRecord = records[records.length - 1];
    const page = {
      limit,
      returned: records.length,
      has_more: hasMore,
      next_before_suffix: lastRecord ? lastRecord.suffix : null,
      snapshot_at: snapshotAt,
      ...(matchingTotal == null ? {} : { matching_total: matchingTotal })
    };
    if (compact) {
      const stats = compactLiveDashboardStats(database);
      database.exec('COMMIT');
      readTransaction = false;
      return res.json({
        records,
        page,
        stats
      });
    }
    const capturedBidAlias = 'captured_scope_bid';
    const capturedSource = scopedLiveRequestSource(
      'captured',
      scope,
      capturedBidAlias
    );
    const capturedDetailsAlias = hasDetails ? 'captured_details' : null;
    const capturedDetailsJoin = hasDetails
      ? `LEFT JOIN portal_requests AS ${capturedDetailsAlias}
           ON ${capturedDetailsAlias}.srnumber=captured.srnumber`
      : '';
    const capturedFollowUpAlias = hasFollowUps ? 'captured_followup' : null;
    const capturedFollowUpJoin = hasFollowUps
      ? `LEFT JOIN request_followup_queue AS ${capturedFollowUpAlias}
           ON ${capturedFollowUpAlias}.srnumber=captured.srnumber`
      : '';
    const capturedFilterDetailJoin = hasDetails
        && (submittedSince != null || needsEffectiveFilters)
      ? capturedDetailsJoin
      : '';
    const capturedFilterFollowUpJoin = hasFollowUps && needsEffectiveFilters
      ? capturedFollowUpJoin
      : '';
    const capturedFilterJoins = `${capturedFilterDetailJoin}
      ${capturedFilterFollowUpJoin}`;
    const capturedClosureJoins = `${capturedFilterDetailJoin}
      ${capturedFilterFollowUpJoin || capturedFollowUpJoin}`;
    const capturedPredicates = [
      ...scopePredicates('captured', scope, capturedBidAlias),
      ...recordFilterPredicates('captured', filters, {
        detailsAlias: capturedDetailsAlias,
        followupAlias: capturedFollowUpAlias
      }),
      'captured.first_seen_at <= @snapshot_at'
    ];
    if (submittedSince != null) {
      capturedPredicates.push(
        `${effectiveSubmittedJulianDaySql(
          'captured',
          capturedDetailsAlias
        )} >= julianday(@submitted_since)`
      );
    }
    if (requestedSrnumber) capturedPredicates.push('captured.srnumber=@srnumber');
    const capturedWhere = sqlWhere(capturedPredicates);
    const totalsParameters = {
      ...scopedParameters,
      ...recordFilterParameters(filters),
      snapshot_at: snapshotAt,
      ...(submittedSince != null ? { submitted_since: submittedSince } : {}),
      ...(requestedSrnumber ? { srnumber: requestedSrnumber } : {})
    };
    const detailStats = hasDetails
      ? `(SELECT COUNT(*) FROM ${capturedSource}
          ${capturedFilterJoins}
          JOIN portal_requests AS stored ON stored.srnumber=captured.srnumber
          ${capturedWhere}) AS details_loaded,
         (SELECT COUNT(*) FROM ${capturedSource}
          ${capturedFilterJoins}
          LEFT JOIN portal_requests AS stored ON stored.srnumber = captured.srnumber
          ${sqlWhere([...capturedPredicates, 'stored.srnumber IS NULL'])}) AS details_pending`
      : `0 AS details_loaded,
         (SELECT COUNT(*) FROM ${capturedSource}
          ${capturedFilterJoins}
          ${capturedWhere}) AS details_pending`;
    const closureStats = hasFollowUps
      ? `(SELECT COUNT(*) FROM ${capturedSource}
          ${capturedClosureJoins}
          ${sqlWhere([...capturedPredicates, `${capturedFollowUpAlias}.state='closing'`])})
            AS closure_refreshes_pending,
         (SELECT COUNT(*) FROM ${capturedSource}
          ${capturedClosureJoins}
          ${sqlWhere([...capturedPredicates, `${capturedFollowUpAlias}.state='open'`])})
            AS open_followups_scheduled,
         (SELECT COUNT(*) FROM ${capturedSource}
          ${capturedClosureJoins}
          ${sqlWhere([...capturedPredicates, `${capturedFollowUpAlias}.state='closed'`])})
            AS closures_finalized`
      : `0 AS closure_refreshes_pending,
         0 AS open_followups_scheduled,
         0 AS closures_finalized`;
    const totalsStatement = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM ${capturedSource}
          ${capturedFilterJoins}
          ${capturedWhere}) AS total,
        (SELECT COUNT(*) FROM ${capturedSource}
          ${capturedFilterJoins}
          ${sqlWhere([
            ...capturedPredicates,
            '(captured.latitude IS NULL OR captured.longitude IS NULL)'
          ])}) AS unmapped_total,
        (SELECT COUNT(*) FROM live_number_queue WHERE audit_outcome = 'pending') AS pending,
        (SELECT MAX(suffix) FROM live_number_queue) AS frontier,
        (SELECT MAX(captured.last_seen_at) FROM ${capturedSource}
          ${capturedFilterJoins}
          ${capturedWhere}) AS last_seen_at,
        COALESCE(
          (SELECT CAST(value AS INTEGER) FROM live_monitor_state WHERE key = 'poll_interval_seconds'),
          15
        ) AS poll_interval_seconds,
        ${detailStats},
        ${closureStats}
    `);
    const totals = totalsStatement.get(totalsParameters);
    const collectorScopeRow = database.prepare(`
      SELECT value FROM live_monitor_state WHERE key='collector_scope'
    `).get();
    totals.collector_scope = effectiveCollectorScope(collectorScopeRow && collectorScopeRow.value);
    totals.number_audit_mode = totals.collector_scope === 'bid_only'
      ? 'not_applicable_bid_only'
      : 'citywide_suffix_gap';
    if (totals.collector_scope === 'bid_only') {
      totals.pending = null;
      totals.frontier = null;
      const bidInterval = database.prepare(`
        SELECT value FROM live_monitor_state WHERE key='bid_poll_interval_seconds'
      `).get();
      totals.poll_interval_seconds = Number(bidInterval && bidInterval.value || 60);
    }
    try {
      totals.summary = cachedLiveSummary(database, databasePath, scope);
      totals.scope = {
        police_precinct: scope.precinct ? scope.precinct.precinct : null,
        police_precinct_boundary_version: scope.precinct
          ? scope.precinct.boundaryVersion
          : null,
        bid_id: scope.bid ? scope.bid.bidId : null,
        business_improvement_district_boundary_version: scope.bid
          ? scope.bid.boundaryVersion
          : null
      };
    } catch (summaryError) {
      console.error('Embedded live summary error:', summaryError.message);
      totals.summary = null;
    }
    const catchupWindowRow = database.prepare(`
      SELECT value FROM live_monitor_state WHERE key = 'catchup_window'
    `).get();
    const auditRunRow = database.prepare(`
      SELECT value FROM live_monitor_state WHERE key = 'audit_run'
    `).get();
    const legacyReconciliationRow = database.prepare(`
      SELECT value,updated_at
      FROM live_monitor_state
      WHERE key = 'legacy_reconciliation'
    `).get();
    totals.legacy_reconciliation = totals.collector_scope === 'bid_only'
      ? null
      : sanitizeLegacyReconciliation(
        legacyReconciliationRow && legacyReconciliationRow.value,
        legacyReconciliationRow && legacyReconciliationRow.updated_at
      );
    const catchupWindow = totals.collector_scope === 'bid_only'
      ? null
      : parseState(catchupWindowRow && catchupWindowRow.value);
    if (catchupWindow && Number.isInteger(Number(catchupWindow.low_suffix)) &&
        Number.isInteger(Number(catchupWindow.high_suffix))) {
      const low = Number(catchupWindow.low_suffix);
      const high = Number(catchupWindow.high_suffix);
      const coverage = database.prepare(`
        SELECT
          SUM(CASE WHEN outcome IN ('found', 'not_found') THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN outcome = 'found' THEN 1 ELSE 0 END) AS found,
          SUM(CASE WHEN outcome = 'not_found' THEN 1 ELSE 0 END) AS not_found,
          SUM(CASE WHEN outcome = 'retry' THEN 1 ELSE 0 END) AS retry
        FROM number_ledger
        WHERE suffix BETWEEN ? AND ?
      `).get(low, high);
      const current = database.prepare(`
        SELECT MAX(queue.suffix) AS suffix
        FROM live_number_queue AS queue
        LEFT JOIN number_ledger AS ledger ON ledger.suffix = queue.suffix
        WHERE queue.suffix BETWEEN ? AND ?
          AND (ledger.suffix IS NULL OR ledger.outcome = 'retry')
      `).get(low, high);
      totals.catchup = buildCatchupStatus({
        windowState: catchupWindow,
        runState: auditRunRow && auditRunRow.value,
        coverage,
        currentSuffix: current && current.suffix
      });
    } else {
      totals.catchup = null;
    }
    database.exec('COMMIT');
    readTransaction = false;
    res.json({ records, page, stats: totals });
  } catch (error) {
    res.status(error.statusCode || 503).json({ error: error.message, records: [], stats: {} });
  } finally {
    if (database) {
      if (readTransaction) {
        try {
          database.exec('ROLLBACK');
        } catch (_) {}
      }
      database.close();
    }
  }
});

app.get('/api/status-history/:srnumber', (req, res) => {
  const srnumber = String(req.params.srnumber || '').trim();
  if (!/^311-\d{8}$/.test(srnumber)) {
    return res.status(400).json({ error: 'valid 311 request number required' });
  }
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  try {
    if (!require('fs').existsSync(databasePath)) {
      return res.status(503).json({ error: 'Live archive is not available yet' });
    }
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('BEGIN');
    requireRequestCollectorAccess(database, srnumber);
    const tableNames = new Set(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map(row => row.name));
    const history = tableNames.has('request_status_history')
      ? database.prepare(`
          SELECT id, previous_status, status, source, effective_at, observed_at
          FROM request_status_history
          WHERE srnumber = ? ORDER BY id
        `).all(srnumber)
      : [];
    const closureSnapshots = tableNames.has('request_closure_snapshots')
      ? database.prepare(`
          SELECT id, closure_cycle, status, date_closed, source, fetched_at,
                 is_final, final_state, content_hash, snapshot_json
          FROM request_closure_snapshots
          WHERE srnumber = ? ORDER BY id
        `).all(srnumber).map(row => {
          try {
            return { ...row, snapshot: JSON.parse(row.snapshot_json), snapshot_json: undefined };
          } catch (_) {
            return row;
          }
        })
      : [];
    const followup = tableNames.has('request_followup_queue')
      ? database.prepare(`
          SELECT state, next_check_at, attempts, closing_attempts, closure_cycle,
                 last_checked_at, last_error, finalized_at, updated_at
          FROM request_followup_queue WHERE srnumber = ?
        `).get(srnumber) || null
      : null;
    const payload = { srnumber, history, closure_snapshots: closureSnapshots, followup };
    database.exec('COMMIT');
    return res.json(payload);
  } catch (error) {
    if (database) {
      try {
        database.exec('ROLLBACK');
      } catch (_) {}
    }
    res.status(error.statusCode || 503).json({ error: error.message });
  } finally {
    if (database) database.close();
  }
});

app.get('/api/email-updates/:srnumber', (req, res) => {
  const srnumber = String(req.params.srnumber || '').trim();
  res.setHeader('Cache-Control', 'no-store');
  if (!/^311-\d{8}$/.test(srnumber)) {
    return res.status(400).json({ error: 'valid 311 request number required' });
  }
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  try {
    if (!require('fs').existsSync(databasePath)) {
      return res.status(503).json({ error: 'Live archive is not available yet' });
    }
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('BEGIN');
    requireRequestCollectorAccess(database, srnumber);
    const payload = readRequestEmailUpdates(databasePath, srnumber, { database });
    database.exec('COMMIT');
    return res.json(payload);
  } catch (error) {
    if (database) {
      try {
        database.exec('ROLLBACK');
      } catch (_) {}
    }
    console.error('NYC311 email updates read error:', error.message);
    return res.status(error.statusCode || 503).json({
      error: error.statusCode
        ? error.message
        : 'Email updates are temporarily unavailable'
    });
  } finally {
    if (database) database.close();
  }
});

app.post('/api/live-settings', dashboardSettingsAuth, (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'application/json is required' });
  }
  const requestProtocol = req.get('x-forwarded-proto') || req.protocol;
  if (!originMatchesHost(req.get('origin'), req.get('host'), requestProtocol)) {
    return res.status(403).json({ error: 'cross-origin settings changes are not allowed' });
  }
  const interval = Number(req.body && req.body.poll_interval_seconds);
  if (![5, 10, 15, 30, 60].includes(interval)) {
    return res.status(400).json({ error: 'poll_interval_seconds must be 5, 10, 15, 30, or 60' });
  }
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    if (requireCollectorScope(database) === 'bid_only') {
      return res.status(409).json({
        error: 'BID-only polling is fixed by BID_POLL_INTERVAL_SECONDS to protect Portal capacity'
      });
    }
    database.prepare(`
      INSERT INTO live_monitor_state (key, value, updated_at)
      VALUES ('poll_interval_seconds', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(interval), new Date().toISOString());
    res.json({ poll_interval_seconds: interval });
  } catch (error) {
    res.status(503).json({ error: error.message });
  } finally {
    if (database) database.close();
  }
});

function currentHealth() {
  const now = new Date();
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  const health = inspectSqliteHealth(databasePath, { now });
  const configuredScope = configuredCollectorScope(process.env);
  const collectorScopeReady = Boolean(
    configuredScope
    && health.collector_scope_recorded
    && health.collector_scope === configuredScope
    && health.collector_scope_integrity === 'ready'
  );
  const collectorScopeSafe = Boolean(
    configuredScope
    && health.collector_scope_recorded
    && health.collector_scope === configuredScope
    && ['ready', 'zone_catching_up', 'zone_plan_incomplete']
      .includes(health.collector_scope_integrity)
  );
  if (health.error) console.error('Health check failed:', health.error);
  const { error: _privateError, ...publicHealthFields } = health;
  const publicHealth = {
    ...publicHealthFields,
    expected_collector_scope: configuredScope || DEFAULT_COLLECTOR_SCOPE,
    collector_scope_ready: collectorScopeReady
  };
  return { now, health, publicHealth, collectorScopeReady, collectorScopeSafe };
}

// Web/database liveness stays available during a Portal outage so the archive
// remains readable. Collector readiness is a separate monitored endpoint.
app.get('/api/health', (req, res) => {
  const { now, health, publicHealth } = currentHealth();
  res.status(health.ok ? 200 : 503).json({
    ...publicHealth,
    timestamp: now.toISOString()
  });
});

app.get('/api/health/collector', (req, res) => {
  const {
    now, health, publicHealth, collectorScopeReady, collectorScopeSafe
  } = currentHealth();
  const ready = health.ok && health.collector === 'fresh' && collectorScopeReady;
  const active = health.ok && health.collector === 'fresh' && collectorScopeSafe;
  res.status(active ? 200 : 503).json({
    ...publicHealth,
    active,
    ready,
    timestamp: now.toISOString()
  });
});

const onListen = () => {
  console.log(`NYC BID 311 Explorer running at http://localhost:${PORT}`);
};

if (process.env.NYC311_SERVER_NO_LISTEN !== '1') {
  if (HOST) app.listen(PORT, HOST, onListen);
  else app.listen(PORT, onListen);
}

module.exports = {
  app,
  collectorScopePolicy,
  compactLiveDashboardStats,
  configuredCollectorScope,
  filterPortalPinsToFeature,
  liveDashboardCompactMode,
  liveMapIncludeTotals,
  liveMapRequestIndexClause,
  scopePredicates,
  scopedLiveRequestSource,
  sanitizeLegacyReconciliation
};
