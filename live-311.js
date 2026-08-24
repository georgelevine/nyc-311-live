const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { DatabaseSync } = require('node:sqlite');
const {
  PORTAL_DETAIL_UNAVAILABLE_CODE,
  createClosureTracker,
  isClosedStatus,
  statusesMatch
} = require('./closure-tracking');
const { promoteAuditDiscoveries } = require('./audit-discovery');
const { reconcileStoredDetails } = require('./detail-queue');
const {
  resolveBusyTimeoutMs,
  resolveSynchronousMode
} = require('./sqlite-runtime');
const { ensureLiveCollectorBaseSchema } = require('./live-collector-schema');
const { applyMigrations } = require('./sqlite-finalization');
const { normalizePortalTimestamp } = require('./portal-timestamp');
const { attachPortalAgencyResponse } = require('./portal-agency-response');
const {
  ensureSqliteRequestGeography,
  geographyFromPortalAddress
} = require('./address-geography');
const {
  ensureSqlitePolicePrecinctSchema,
  loadActivePolicePrecinctMatcher
} = require('./police-precincts');
const {
  ensureSqliteBusinessImprovementDistrictSchema,
  loadActiveBusinessImprovementDistrictMatcher
} = require('./business-improvement-districts');
const {
  importBusinessImprovementDistrictBoundaryBytes,
  parseArgs: parseBusinessImprovementDistrictImportArgs
} = require('./import-business-improvement-districts');
const { refreshActiveBoundaryMatchers } = require('./boundary-matcher-coherence');
const {
  claimSubscription,
  completeSubscription,
  enqueueAllSubscriptions,
  enqueueBidSubscriptions,
  enqueuePrecinctSubscriptions,
  parseBidIds,
  quarantineLegacySubscriptionRetries,
  retrySubscription,
  subscribeRequest
} = require('./nyc311-portal-subscriptions');
const {
  claimInitialAlert,
  completeInitialAlert,
  enqueueInitialAlerts,
  retryInitialAlert,
  sendInitialAlert
} = require('./nyc311-initial-alerts');
const {
  chooseDetailWork,
  monitoringMode,
  preservePendingClosureStatus,
  scheduledOpenFollowupsEnabled
} = require('./monitoring-mode');
const { reconcileStoredEmailClosures } = require('./nyc311-email-inbound');
const { seedClosureTracking } = require('./closure-tracking-seed');
const {
  buildBidQueryZones,
  canonicalizePortalPin,
  collectBidZonePins,
  collectorInteger,
  deduplicatePortalPins,
  filterPinsToBids,
  mapWithConcurrency,
  parseCollectorScope,
  queryPlanHash,
  verifyZoneCoverage
} = require('./bid-collector-scope');
const {
  PORTAL_CAP,
  bidRecoveryRange,
  createBidPortalClient
} = require('./bid-portal-recovery');

const PORTAL_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const EXPECTED_BID_FEATURE_COUNT = 78;
const COLLECTOR_SCOPE = parseCollectorScope(process.env);
const BID_ONLY = COLLECTOR_SCOPE === 'bid_only';
const POLL_INTERVAL_SECONDS = Math.max(5, Number(process.env.POLL_INTERVAL_SECONDS || 15));
const BID_POLL_INTERVAL_SECONDS = collectorInteger(process.env, 'BID_POLL_INTERVAL_SECONDS', {
  fallback: 60,
  minimum: 30,
  maximum: 3600
});
const BID_QUERY_CONCURRENCY = collectorInteger(process.env, 'BID_QUERY_CONCURRENCY', {
  fallback: 3,
  minimum: 1,
  maximum: 8
});
const BID_QUERY_ZONE_TARGET = collectorInteger(process.env, 'BID_QUERY_ZONE_TARGET', {
  fallback: 12,
  minimum: 5,
  maximum: 30
});
const BID_CATCHUP_MAX_DAYS = collectorInteger(process.env, 'BID_CATCHUP_MAX_DAYS', {
  fallback: 2,
  minimum: 1,
  maximum: 31
});
const LIVE_DURATION_SECONDS = Math.max(0, Number(process.env.LIVE_DURATION_SECONDS || 0));
const AUDIT_DELAY_MINUTES = Math.max(30, Number(process.env.AUDIT_DELAY_MINUTES || 35));
// One detail request every 2.5 seconds leaves room for the four map polls per
// minute while keeping total routine Portal traffic below about 30/minute.
const DETAIL_REQUEST_DELAY_MS = Math.max(500, Number(process.env.DETAIL_REQUEST_DELAY_MS || 2500));
const EMAIL_SUBSCRIBE_BID_IDS = parseBidIds(process.env.EMAIL_SUBSCRIBE_BID_IDS);
const EMAIL_SUBSCRIBE_PRECINCTS = parseBidIds(process.env.EMAIL_SUBSCRIBE_PRECINCTS);
const EMAIL_PRECINCT_START_AT = process.env.EMAIL_PRECINCT_START_AT || null;
const EMAIL_SUBSCRIBE_ALL_NEW = /^(?:1|true)$/i.test(
  String(process.env.EMAIL_SUBSCRIBE_ALL_NEW || '')
);
const EMAIL_ALL_START_AT = process.env.EMAIL_ALL_START_AT || null;
const EMAIL_SUBSCRIPTION_DELAY_MS = Math.max(
  1000,
  Number(process.env.EMAIL_SUBSCRIPTION_DELAY_MS || 5000)
);
const configuredEmailSubscriptionWorkers = Number(
  process.env.EMAIL_SUBSCRIPTION_WORKERS || 3
);
const EMAIL_SUBSCRIPTION_WORKERS = Number.isFinite(configuredEmailSubscriptionWorkers)
  ? Math.max(1, Math.min(4, Math.trunc(configuredEmailSubscriptionWorkers)))
  : 2;
const SCHEDULED_OPEN_FOLLOWUPS_ENABLED = scheduledOpenFollowupsEnabled(process.env);
const BID_ONLY_LIVE_SCOPE_SQL = BID_ONLY ? `AND EXISTS (
  SELECT 1
  FROM live_request_bid_memberships AS collector_membership
  JOIN business_improvement_district_boundary_versions AS collector_boundary
    ON collector_boundary.version=collector_membership.boundary_version
   AND collector_boundary.active=1
  WHERE collector_membership.srnumber=live.srnumber
)` : '';
const SQLITE_SYNCHRONOUS = resolveSynchronousMode(process.env.SQLITE_SYNCHRONOUS);
const SQLITE_BUSY_TIMEOUT_MS = resolveBusyTimeoutMs(process.env.SQLITE_BUSY_TIMEOUT_MS);
const DATABASE_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'data', 'portal-archive.sqlite');

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = ${SQLITE_SYNCHRONOUS};
  PRAGMA foreign_keys = ON;
`);
ensureLiveCollectorBaseSchema(db);

ensureSqliteRequestGeography(db);
applyMigrations(db);
ensureSqlitePolicePrecinctSchema(db);
let policePrecinctMatcher = loadActivePolicePrecinctMatcher(db);
ensureSqliteBusinessImprovementDistrictSchema(db);
let businessImprovementDistrictMatcher = loadActiveBusinessImprovementDistrictMatcher(db);

const closureTracker = createClosureTracker(db);

const getLiveRequest = db.prepare(`
  SELECT srnumber, suffix, portal_id, status, first_seen_at, last_seen_at,
         latitude,longitude,police_precinct_boundary_version,
         business_improvement_district_boundary_version
  FROM live_portal_requests WHERE srnumber = ?
`);
const upsertRequest = db.prepare(`
  INSERT INTO live_portal_requests (
    srnumber, suffix, portal_id, problem, address, borough, incident_zip,
    police_precinct, police_precinct_boundary_version, police_precinct_matched_at,
    business_improvement_district_boundary_version,
    business_improvement_district_matched_at,
    latitude, longitude,
    submitted_at, status, portal_url, first_seen_at, last_seen_at, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(srnumber) DO UPDATE SET
    portal_id = COALESCE(excluded.portal_id, live_portal_requests.portal_id),
    problem = COALESCE(excluded.problem, live_portal_requests.problem),
    address = COALESCE(excluded.address, live_portal_requests.address),
    borough = COALESCE(excluded.borough, live_portal_requests.borough),
    incident_zip = COALESCE(excluded.incident_zip, live_portal_requests.incident_zip),
    police_precinct = CASE
      WHEN excluded.police_precinct_boundary_version IS NOT NULL THEN excluded.police_precinct
      ELSE live_portal_requests.police_precinct END,
    police_precinct_boundary_version = COALESCE(
      excluded.police_precinct_boundary_version,
      live_portal_requests.police_precinct_boundary_version
    ),
    police_precinct_matched_at = COALESCE(
      excluded.police_precinct_matched_at,
      live_portal_requests.police_precinct_matched_at
    ),
    business_improvement_district_boundary_version = COALESCE(
      excluded.business_improvement_district_boundary_version,
      live_portal_requests.business_improvement_district_boundary_version
    ),
    business_improvement_district_matched_at = COALESCE(
      excluded.business_improvement_district_matched_at,
      live_portal_requests.business_improvement_district_matched_at
    ),
    latitude = COALESCE(excluded.latitude, live_portal_requests.latitude),
    longitude = COALESCE(excluded.longitude, live_portal_requests.longitude),
    submitted_at = COALESCE(excluded.submitted_at, live_portal_requests.submitted_at),
    status = COALESCE(excluded.status, live_portal_requests.status),
    portal_url = COALESCE(excluded.portal_url, live_portal_requests.portal_url),
    last_seen_at = excluded.last_seen_at,
    raw_json = excluded.raw_json
`);
const clearBusinessImprovementDistrictMemberships = db.prepare(`
  DELETE FROM live_request_bid_memberships WHERE srnumber = ?
`);
const insertBusinessImprovementDistrictMembership = db.prepare(`
  INSERT INTO live_request_bid_memberships(srnumber,boundary_version,bid_id,matched_at)
  VALUES (?, ?, ?, ?)
`);
const upsertBusinessImprovementDistrictAssignment = db.prepare(`
  INSERT INTO live_request_bid_assignment_versions (
    srnumber,boundary_version,matched_at,latitude,longitude
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(srnumber,boundary_version) DO UPDATE SET
    matched_at=excluded.matched_at,
    latitude=excluded.latitude,
    longitude=excluded.longitude
`);
const updateLiveStatus = db.prepare(`
  UPDATE live_portal_requests SET status = ? WHERE srnumber = ?
`);
const upsertQueue = db.prepare(`
  INSERT INTO live_number_queue (
    suffix, srnumber, first_detected_at, audit_after, map_seen
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(suffix) DO UPDATE SET
    map_seen = MAX(live_number_queue.map_seen, excluded.map_seen)
`);
const upsertDetailQueue = db.prepare(`
  INSERT INTO live_detail_queue (
    srnumber, portal_id, status, attempts, next_attempt_at, last_error, updated_at
  ) VALUES (?, ?, 'pending', 0, ?, NULL, ?)
  ON CONFLICT(srnumber) DO UPDATE SET
    portal_id = COALESCE(excluded.portal_id, live_detail_queue.portal_id),
    updated_at = excluded.updated_at
`);
const seedDetailQueue = db.prepare(`
  INSERT OR IGNORE INTO live_detail_queue (
    srnumber, portal_id, status, attempts, next_attempt_at, last_error, updated_at
  )
  SELECT live.srnumber, live.portal_id,
         CASE WHEN details.srnumber IS NULL THEN 'pending' ELSE 'found' END,
         0, ?, NULL, ?
  FROM live_portal_requests AS live
  LEFT JOIN portal_requests AS details ON details.srnumber = live.srnumber
  WHERE 1=1
    ${BID_ONLY_LIVE_SCOPE_SQL}
`);
const nextDetailRequest = db.prepare(`
  SELECT queue.srnumber, queue.portal_id, queue.attempts, queue.updated_at,
         live.suffix,
         COALESCE((
           SELECT MAX(history.id) FROM request_status_history AS history
           WHERE history.srnumber = queue.srnumber
         ), 0) AS status_version,
         'initial' AS work_kind
  FROM live_detail_queue AS queue
  JOIN live_portal_requests AS live ON live.srnumber = queue.srnumber
  WHERE queue.status IN ('pending', 'retry')
    AND queue.next_attempt_at <= ?
    ${BID_ONLY_LIVE_SCOPE_SQL}
    AND NOT EXISTS (
      SELECT 1 FROM request_followup_queue AS followup
      WHERE followup.srnumber = queue.srnumber
        AND (
          followup.state = 'closing'
          OR followup.last_checked_at IS NOT NULL
        )
    )
  ORDER BY live.suffix DESC
  LIMIT 1
`);
const nextClosingFollowUp = db.prepare(`
  SELECT queue.*, live.suffix,
         COALESCE((
           SELECT MAX(history.id) FROM request_status_history AS history
           WHERE history.srnumber = queue.srnumber
         ), 0) AS status_version,
         'closing' AS work_kind
  FROM request_followup_queue AS queue
  JOIN live_portal_requests AS live ON live.srnumber = queue.srnumber
  WHERE queue.state = 'closing'
    AND queue.next_check_at IS NOT NULL
    AND queue.next_check_at <= ?
    ${BID_ONLY_LIVE_SCOPE_SQL}
  ORDER BY queue.next_check_at, live.suffix DESC
  LIMIT 1
`);
const nextOpenFollowUp = db.prepare(`
  SELECT queue.*, live.suffix,
         COALESCE((
           SELECT MAX(history.id) FROM request_status_history AS history
           WHERE history.srnumber = queue.srnumber
         ), 0) AS status_version,
         'followup' AS work_kind
  FROM request_followup_queue AS queue
  JOIN live_portal_requests AS live ON live.srnumber = queue.srnumber
  WHERE queue.state = 'open'
    AND queue.next_check_at IS NOT NULL
    AND queue.next_check_at <= ?
    ${BID_ONLY_LIVE_SCOPE_SQL}
  ORDER BY queue.next_check_at, live.suffix DESC
  LIMIT 1
`);
const saveDetailedRequest = db.prepare(`
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
`);
const markDetailFound = db.prepare(`
  UPDATE live_detail_queue
  SET status = 'found', attempts = attempts + 1, last_error = NULL, updated_at = ?
  WHERE srnumber = ?
`);
const markDetailRetry = db.prepare(`
  UPDATE live_detail_queue
  SET status = 'retry', attempts = attempts + 1, next_attempt_at = ?,
      last_error = ?, updated_at = ?
  WHERE srnumber = ?
`);
const latestStatusVersion = db.prepare(`
  SELECT COALESCE(MAX(id), 0) AS version
  FROM request_status_history WHERE srnumber = ?
`);
const getClosureFallbackEvidence = db.prepare(`
  SELECT live.srnumber,live.portal_id,live.status AS live_status,
         live.problem,live.address,live.submitted_at,
         history.status AS evidence_status,history.source AS evidence_source
  FROM live_portal_requests AS live
  LEFT JOIN request_status_history AS history ON history.id=(
    SELECT MAX(candidate.id)
    FROM request_status_history AS candidate
    WHERE candidate.srnumber=live.srnumber
      AND candidate.source IN ('map','detail','number_audit')
  )
  WHERE live.srnumber=?
`);
const getState = db.prepare('SELECT value FROM live_monitor_state WHERE key = ?');
const setState = db.prepare(`
  INSERT INTO live_monitor_state (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);
const getBidBoundaryMetadata = db.prepare(`
  SELECT version,source_sha256,source_date,feature_count
  FROM business_improvement_district_boundary_versions
  WHERE active=1 LIMIT 1
`);
const getBidZoneState = db.prepare(`
  SELECT * FROM bid_collector_zone_state
  WHERE boundary_version=? AND plan_hash=? AND zone_id=?
`);
const saveBidZoneSuccess = db.prepare(`
  INSERT INTO bid_collector_zone_state (
    boundary_version,plan_hash,zone_id,bbox_json,last_successful_poll_at,
    last_result_count,saturation_count,last_error,updated_at
  ) VALUES (?,?,?,?,?,?,?,NULL,?)
  ON CONFLICT(boundary_version,plan_hash,zone_id) DO UPDATE SET
    bbox_json=excluded.bbox_json,
    last_successful_poll_at=excluded.last_successful_poll_at,
    last_result_count=excluded.last_result_count,
    saturation_count=bid_collector_zone_state.saturation_count+excluded.saturation_count,
    last_error=NULL,
    updated_at=excluded.updated_at
`);
const saveBidZoneFailure = db.prepare(`
  INSERT INTO bid_collector_zone_state (
    boundary_version,plan_hash,zone_id,bbox_json,last_successful_poll_at,
    last_result_count,saturation_count,last_error,updated_at
  ) VALUES (?,?,?,?,NULL,?,?,?,?)
  ON CONFLICT(boundary_version,plan_hash,zone_id) DO UPDATE SET
    bbox_json=excluded.bbox_json,
    last_result_count=excluded.last_result_count,
    saturation_count=bid_collector_zone_state.saturation_count+excluded.saturation_count,
    last_error=excluded.last_error,
    updated_at=excluded.updated_at
`);
const collectorStartedAt = new Date().toISOString();
setState.run('audit_delay_minutes', String(AUDIT_DELAY_MINUTES), collectorStartedAt);
const countResolvedInRange = db.prepare(`
  SELECT COUNT(*) AS count
  FROM number_ledger
  WHERE suffix BETWEEN ? AND ?
    AND outcome IN ('found', 'not_found')
`);
const saveMapLedger = db.prepare(`
  INSERT INTO number_ledger (
    suffix, srnumber, outcome, attempts, http_status, error, checked_at
  ) VALUES (?, ?, 'found', 0, 200, NULL, ?)
  ON CONFLICT(suffix) DO UPDATE SET
    outcome = 'found',
    http_status = 200,
    error = NULL,
    checked_at = excluded.checked_at
`);
const markMapQueueFound = db.prepare(`
  UPDATE live_number_queue
  SET audit_outcome = 'found_map', audited_at = ?
  WHERE map_seen = 1 AND audit_outcome = 'pending'
`);
const markNumberSeenOnMap = db.prepare(`
  UPDATE live_number_queue
  SET map_seen = 1,
      audit_outcome = CASE
        WHEN audit_outcome = 'pending' THEN 'found_map'
        ELSE audit_outcome
      END,
      audited_at = CASE
        WHEN audit_outcome = 'pending' THEN ?
        ELSE audited_at
      END
  WHERE suffix = ?
`);
const eligibleAuditRange = db.prepare(`
  SELECT MIN(suffix) AS low, MAX(suffix) AS high, COUNT(*) AS count
  FROM live_number_queue
  WHERE audit_outcome = 'pending' AND audit_after <= ?
`);
const syncCompletedAudits = db.prepare(`
  UPDATE live_number_queue
  SET audit_outcome = (
        SELECT outcome FROM number_ledger
        WHERE number_ledger.suffix = live_number_queue.suffix
      ),
      audited_at = ?
  WHERE audit_outcome = 'pending'
    AND EXISTS (
      SELECT 1 FROM number_ledger
      WHERE number_ledger.suffix = live_number_queue.suffix
        AND number_ledger.outcome IN ('found', 'not_found')
    )
`);

let stopRequested = false;
let stopReason = null;
let activeArchiveChild = null;
let detailHydrationStopping = false;
let emailSubscriptionPromise = null;
const pendingSleeps = new Set();

function sleep(milliseconds) {
  return new Promise(resolve => {
    const pending = {
      timer: null,
      resolve() {
        if (!pendingSleeps.delete(pending)) return;
        clearTimeout(pending.timer);
        resolve();
      }
    };
    pending.timer = setTimeout(pending.resolve, milliseconds);
    pendingSleeps.add(pending);
  });
}

function terminateArchiveChild() {
  const child = activeArchiveChild;
  if (child && child.exitCode == null && child.signalCode == null) {
    child.kill('SIGTERM');
  }
}

function requestStop(reason = 'requested') {
  if (stopRequested) return;
  stopRequested = true;
  stopReason = reason;
  detailHydrationStopping = true;
  for (const pending of [...pendingSleeps]) pending.resolve();
  terminateArchiveChild();
  console.log(JSON.stringify({ stopping: true, reason }));
}

function startEmailSubscriptions() {
  if ((!EMAIL_SUBSCRIBE_BID_IDS.length
      && !EMAIL_SUBSCRIBE_PRECINCTS.length
      && !EMAIL_SUBSCRIBE_ALL_NEW)
      || emailSubscriptionPromise) return;
  try {
    const legacy = quarantineLegacySubscriptionRetries(db);
    if (legacy.quarantined) {
      console.log(JSON.stringify({
        email_subscription_quarantine: 'rescheduled',
        jobs: legacy.quarantined,
        earliest_retry_at: legacy.earliestNextAttemptAt,
        latest_retry_at: legacy.latestNextAttemptAt
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      email_subscription_quarantine: 'failed',
      error: error.message
    }));
  }
  const enqueueAndSendInitialAlerts = async () => {
    while (!detailHydrationStopping) {
      try {
        const added = enqueueBidSubscriptions(db, EMAIL_SUBSCRIBE_BID_IDS);
        const precinctAdded = enqueuePrecinctSubscriptions(db, EMAIL_SUBSCRIBE_PRECINCTS, {
          startAt: EMAIL_PRECINCT_START_AT,
          requireBidMembership: BID_ONLY
        });
        const allAdded = EMAIL_SUBSCRIBE_ALL_NEW
          ? enqueueAllSubscriptions(db, {
            startAt: EMAIL_ALL_START_AT,
            requireBidMembership: BID_ONLY
          })
          : 0;
        const initialAdded = enqueueInitialAlerts(db, {
          bidIds: EMAIL_SUBSCRIBE_BID_IDS,
          precincts: EMAIL_SUBSCRIBE_PRECINCTS,
          requireBidMembership: BID_ONLY
        });
        if (added) {
          console.log(JSON.stringify({
            email_subscriptions_queued: added,
            bid_ids: EMAIL_SUBSCRIBE_BID_IDS
          }));
        }
        if (precinctAdded) {
          console.log(JSON.stringify({
            email_subscriptions_queued: precinctAdded,
            police_precincts: EMAIL_SUBSCRIBE_PRECINCTS,
            first_seen_at_or_after: EMAIL_PRECINCT_START_AT
          }));
        }
        if (allAdded) {
          console.log(JSON.stringify({
            email_subscriptions_queued: allAdded,
            scope: 'all',
            first_seen_at_or_after: EMAIL_ALL_START_AT
          }));
        }
        if (initialAdded) {
          console.log(JSON.stringify({ initial_emails_queued: initialAdded }));
        }
        const initialJob = claimInitialAlert(db, new Date(), {
          requireBidMembership: BID_ONLY
        });
        if (initialJob) {
          try {
            await sendInitialAlert(initialJob);
            completeInitialAlert(db, initialJob);
            console.log(JSON.stringify({
              initial_email: 'sent',
              srnumber: initialJob.srnumber,
              bid_id: initialJob.bid_id
            }));
          } catch (error) {
            retryInitialAlert(db, initialJob, error);
            console.error(JSON.stringify({
              initial_email: 'retry',
              srnumber: initialJob.srnumber,
              error: error.message
            }));
          }
          await sleep(EMAIL_SUBSCRIPTION_DELAY_MS);
          continue;
        }
      } catch (error) {
        console.error(JSON.stringify({ email_subscription_enqueue_error: error.message }));
      }
      await sleep(5000);
    }
  };
  const runSubscriptionWorker = async (workerIndex) => {
    // Keep one lane draining the historical backlog and dedicate every
    // additional lane to new requests so a burst cannot bury live records.
    const order = workerIndex === EMAIL_SUBSCRIPTION_WORKERS - 1
      ? 'oldest'
      : 'newest';
    while (!detailHydrationStopping) {
      try {
        const job = claimSubscription(db, new Date(), {
          order,
          requireBidMembership: BID_ONLY
        });
        if (!job) {
          await sleep(2000);
          continue;
        }
        try {
          await subscribeRequest({
            portalId: job.portal_id,
            email: job.recipient_address
          });
          db.exec('BEGIN');
          try {
            completeSubscription(db, job);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          console.log(JSON.stringify({
            email_subscription: 'subscribed',
            srnumber: job.srnumber,
            bid_id: job.bid_id,
            worker: workerIndex + 1,
            queue_order: order
          }));
        } catch (error) {
          const retry = retrySubscription(db, job, error);
          console.error(JSON.stringify({
            email_subscription: retry.quarantined ? 'quarantined' : 'retry',
            srnumber: job.srnumber,
            worker: workerIndex + 1,
            queue_order: order,
            retry_policy: retry.policy,
            next_attempt_at: retry.nextAttemptAt,
            error: error.message
          }));
        }
      } catch (error) {
        console.error(JSON.stringify({ email_subscription_loop_error: error.message }));
      }
      await sleep(EMAIL_SUBSCRIPTION_DELAY_MS);
    }
  };
  emailSubscriptionPromise = Promise.all([
    enqueueAndSendInitialAlerts(),
    ...Array.from(
      { length: EMAIL_SUBSCRIPTION_WORKERS },
      (_, workerIndex) => runSubscriptionWorker(workerIndex)
    )
  ]);
}

function suffixOf(number) {
  const match = String(number || '').match(/^311-(\d{8})$/);
  return match ? Number(match[1]) : null;
}

function finitePortalCoordinate(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requestNumber(suffix) {
  return `311-${String(suffix).padStart(8, '0')}`;
}

function currentPollIntervalSeconds() {
  if (BID_ONLY) return BID_POLL_INTERVAL_SECONDS;
  const saved = getState.get('poll_interval_seconds');
  const value = Number(saved && saved.value);
  return [5, 10, 15, 30, 60].includes(value) ? value : POLL_INTERVAL_SECONDS;
}

function stateJson(key) {
  const row = getState.get(key);
  if (!row || !row.value) return null;
  try {
    return JSON.parse(row.value);
  } catch (_) {
    return null;
  }
}

function saveJsonState(key, value, updatedAt = new Date().toISOString()) {
  setState.run(key, JSON.stringify(value), updatedAt);
}

const startupLastSuccessfulPoll = getState.get('last_successful_poll_at');
const startupFrontier = getState.get('live_frontier');
let firstSuccessfulPoll = true;

function recordSuccessfulPoll(result, observedAt) {
  if (BID_ONLY) {
    setState.run('last_successful_poll_at', observedAt, observedAt);
    return;
  }
  if (firstSuccessfulPoll) {
    firstSuccessfulPoll = false;
    const priorPollAt = startupLastSuccessfulPoll && startupLastSuccessfulPoll.value;
    const priorFrontier = Number(startupFrontier && startupFrontier.value);
    const gapMilliseconds = priorPollAt ? Date.parse(observedAt) - Date.parse(priorPollAt) : 0;
    const existingWindow = stateJson('catchup_window');
    const existingStillActive = existingWindow && existingWindow.status !== 'complete';
    const low = startupFrontier && Number.isInteger(priorFrontier) ? priorFrontier + 1 : null;
    const high = Number(result.highest);
    const gapThreshold = Math.max(90_000, currentPollIntervalSeconds() * 3_000);
    if (!existingStillActive && gapMilliseconds >= gapThreshold &&
        Number.isInteger(low) && Number.isInteger(high) && high >= low) {
      saveJsonState('catchup_window', {
        status: 'pending',
        offline_from: priorPollAt,
        offline_to: observedAt,
        low_suffix: low,
        high_suffix: high,
        total: high - low + 1,
        created_at: observedAt
      }, observedAt);
    }
  }
  setState.run('last_successful_poll_at', observedAt, observedAt);
}

let resolveFirstPoll;
let firstPollSettled = false;
const firstPoll = new Promise(resolve => { resolveFirstPoll = resolve; });

function settleFirstPoll(result) {
  if (firstPollSettled) return;
  firstPollSettled = true;
  resolveFirstPoll(result);
}

function parseLiveDetail(html, expectedNumber, portalId) {
  const $ = cheerio.load(html);
  const pagePortalId = String($('#EntityFormView_EntityID').val() || '').trim();
  const fields = {};
  $('.info label').each((_, label) => {
    const name = $(label).text().replace(/\s+/g, ' ').trim();
    const field = $(label).closest('[class*="col-"]');
    const value = field.find('.control span').first().text().replace(/\s+/g, ' ').trim();
    if (name && value && value !== '-') fields[name] = value;
  });
  const agencyResponse = attachPortalAgencyResponse($, fields);

  const scripts = $('script').map((_, script) => $(script).html() || '').get().join('\n');
  const scriptDate = id => {
    const pattern = new RegExp(`\\$\\(["']#${id}["']\\)\\.text\\(getESTDate\\(["']([^"']+)["']\\)\\)`);
    const match = scripts.match(pattern);
    return match ? normalizePortalTimestamp(match[1]) : null;
  };

  const number = fields['SR Number'] || expectedNumber;
  if (!number || !fields['SR Number']) {
    const error = new Error('Portal detail page did not contain a service request');
    error.code = PORTAL_DETAIL_UNAVAILABLE_CODE;
    throw error;
  }
  return {
    srnumber: number,
    portalId: portalId || pagePortalId || null,
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

async function fetchLiveDetail(row) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const lookup = row.portal_id
      ? `id=${encodeURIComponent(row.portal_id)}`
      : `srnum=${encodeURIComponent(row.srnumber)}`;
    const response = await fetch(
      `https://portal.311.nyc.gov/sr-details/?${lookup}`,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Live/1.0)',
          Referer: 'https://portal.311.nyc.gov/check-status/'
        },
        signal: controller.signal
      }
    );
    if (!response.ok) throw new Error(`Portal detail returned HTTP ${response.status}`);
    const detail = parseLiveDetail(await response.text(), row.srnumber, row.portal_id);
    if (detail.srnumber !== row.srnumber) {
      throw new Error(`Portal returned ${detail.srnumber} while ${row.srnumber} was requested`);
    }
    return detail;
  } finally {
    clearTimeout(timeout);
  }
}

function nextFollowUpDetailWork(now) {
  const closing = nextClosingFollowUp.get(now);
  const open = closing || !SCHEDULED_OPEN_FOLLOWUPS_ENABLED
    ? null
    : nextOpenFollowUp.get(now);
  return chooseDetailWork({
    closing,
    open,
    scheduledOpenFollowups: SCHEDULED_OPEN_FOLLOWUPS_ENABLED
  });
}

let detailHydrationPromise = null;
let detailHydrationPaused = false;

async function processDetailWork(row) {
  let workTimestamp = new Date().toISOString();
  try {
    const fetchedDetail = await fetchLiveDetail(row);
    workTimestamp = new Date().toISOString();
    const currentJob = closureTracker.getFollowUp.get(row.srnumber);
    const currentStatusVersion = latestStatusVersion.get(row.srnumber).version;
    const statusChangedInFlight = Number(currentStatusVersion) !== Number(row.status_version);
    const followUpChangedInFlight = row.work_kind !== 'initial'
      && (!currentJob || currentJob.state !== row.state
        || Number(currentJob.closure_cycle) !== Number(row.closure_cycle)
        || currentJob.updated_at !== row.updated_at);
    if (statusChangedInFlight || followUpChangedInFlight) {
      console.log(JSON.stringify({
        stale_detail_work_ignored: row.srnumber,
        selected_state: row.state || 'initial',
        selected_cycle: row.closure_cycle || 0,
        selected_status_version: row.status_version,
        current_state: currentJob && currentJob.state,
        current_cycle: currentJob && currentJob.closure_cycle,
        current_status_version: currentStatusVersion
      }));
      return;
    }
    const detail = fetchedDetail.dateClosed && !isClosedStatus(fetchedDetail.status)
      ? { ...fetchedDetail, status: 'Closed' }
      : fetchedDetail;
    db.exec('BEGIN');
    try {
      const current = getLiveRequest.get(row.srnumber);
      const followUp = closureTracker.getFollowUp.get(row.srnumber);
      const preserveMapClosure = current
        && isClosedStatus(current.status)
        && !isClosedStatus(detail.status)
        && followUp
        && followUp.state === 'closing';
      const effectiveStatus = preserveMapClosure
        ? current.status
        : (detail.status || (current && current.status) || null);

      if (current && detail.status && !preserveMapClosure
          && !statusesMatch(current.status, detail.status)) {
        closureTracker.observeStatus({
          srnumber: row.srnumber,
          previousStatus: current.status,
          status: detail.status,
          source: 'detail',
          effectiveAt: isClosedStatus(detail.status)
            ? (detail.dateClosed || detail.updatedOn)
            : detail.updatedOn,
          observedAt: workTimestamp,
          snapshot: detail
        });
        updateLiveStatus.run(detail.status, row.srnumber);
      }

      const detailPortalUrl = detail.portalId
        ? `https://portal.311.nyc.gov/sr-details/?id=${detail.portalId}`
        : `https://portal.311.nyc.gov/sr-details/?srnum=${detail.srnumber}`;
      saveDetailedRequest.run(
        detail.srnumber,
        row.suffix,
        detail.portalId,
        detail.status,
        detail.problem,
        detail.problemDetails,
        detail.additionalDetails,
        detail.address,
        detail.nextUpdate,
        detail.dateReported,
        detail.updatedOn,
        detail.dateClosed,
        JSON.stringify(detail.fields),
        detailPortalUrl,
        workTimestamp
      );
      markDetailFound.run(workTimestamp, row.srnumber);
      const followUpResult = closureTracker.scheduleAfterDetail({
        srnumber: row.srnumber,
        portalId: detail.portalId,
        effectiveStatus,
        detail,
        source: row.work_kind === 'closing' ? 'closure_followup' : 'detail',
        checkedAt: workTimestamp
      });
      db.exec('COMMIT');
      if (followUpResult.snapshotAdded || followUpResult.finalized) {
        console.log(JSON.stringify({
          closure_refresh: row.srnumber,
          source: row.work_kind,
          status: detail.status,
          date_closed: detail.dateClosed,
          finalized: followUpResult.finalized,
          snapshot_added: followUpResult.snapshotAdded
        }));
      }
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    workTimestamp = new Date().toISOString();
    const retryDelay = Math.min(
      15 * 60_000,
      30_000 * (2 ** Math.min(Number(row.attempts || 0), 5))
    );
    const retryAt = new Date(Date.now() + retryDelay).toISOString();
    if (row.work_kind === 'closing' || row.work_kind === 'followup') {
      const currentJob = closureTracker.getFollowUp.get(row.srnumber);
      const currentStatusVersion = latestStatusVersion.get(row.srnumber).version;
      if (currentJob && currentJob.state === row.state
          && Number(currentJob.closure_cycle) === Number(row.closure_cycle)
          && currentJob.updated_at === row.updated_at
          && Number(currentStatusVersion) === Number(row.status_version)) {
        const evidence = getClosureFallbackEvidence.get(row.srnumber);
        const failure = closureTracker.handleFollowUpFailure({
          row,
          error,
          checkedAt: workTimestamp,
          effectiveStatus: evidence && evidence.live_status,
          evidenceSource: evidence && evidence.evidence_source,
          evidenceStatus: evidence && evidence.evidence_status,
          detail: evidence ? {
            srnumber: evidence.srnumber,
            portalId: evidence.portal_id,
            status: evidence.live_status,
            problem: evidence.problem,
            address: evidence.address,
            dateReported: evidence.submitted_at,
            dateClosed: null,
            fields: {}
          } : null
        });
        if (failure.finalized) {
          console.log(JSON.stringify({
            closure_refresh: row.srnumber,
            source: 'portal_status_detail_unavailable',
            status: evidence && evidence.live_status,
            date_closed: null,
            finalized: true,
            snapshot_added: failure.snapshotAdded,
            consecutive_detail_unavailable: failure.attempts
          }));
        }
      }
    } else {
      markDetailRetry.run(retryAt, error.message, workTimestamp, row.srnumber);
    }
  }
}

async function runDetailHydrationLane(nextWork) {
  while (!detailHydrationStopping) {
    if (detailHydrationPaused) {
      await sleep(1000);
      continue;
    }
    const row = nextWork(new Date().toISOString());
    if (!row) {
      await sleep(3000);
      continue;
    }
    await processDetailWork(row);
    await sleep(DETAIL_REQUEST_DELAY_MS);
  }
}

function startDetailHydration() {
  if (detailHydrationPromise) return;
  detailHydrationPromise = Promise.all([
    runDetailHydrationLane(now => nextDetailRequest.get(now)),
    runDetailHydrationLane(nextFollowUpDetailWork)
  ]);
}

const bidPortalClient = createBidPortalClient({
  concurrency: BID_QUERY_CONCURRENCY,
  timeoutMs: 30_000
});
let bidCollectorPlan = null;

function bootstrapBundledBidBoundaryRelease() {
  const boundaryPath = path.resolve(
    process.env.BID_BOUNDARY_BOOTSTRAP_FILE
      || path.join(__dirname, 'exports', 'nyc-bid-boundaries-2026-04-28.geojson')
  );
  const options = parseBusinessImprovementDistrictImportArgs([
    '--db', DATABASE_PATH,
    '--file', boundaryPath
  ]);
  const result = importBusinessImprovementDistrictBoundaryBytes(
    db,
    options,
    fs.readFileSync(boundaryPath)
  );
  console.log(JSON.stringify({
    bid_boundary_bootstrap: 'complete',
    boundary_version: result.version,
    source_sha256: result.sha256,
    feature_count: result.districtCount,
    backfilled_requests: result.processed
  }));
}

function refreshBidCollectorPlan() {
  const boundaryMatchers = refreshActiveBoundaryMatchers(db, {
    policePrecinctMatcher,
    businessImprovementDistrictMatcher
  }, {
    loadPolicePrecinctMatcher: loadActivePolicePrecinctMatcher,
    loadBusinessImprovementDistrictMatcher: loadActiveBusinessImprovementDistrictMatcher
  });
  policePrecinctMatcher = boundaryMatchers.policePrecinctMatcher;
  businessImprovementDistrictMatcher = boundaryMatchers.businessImprovementDistrictMatcher;
  if (!businessImprovementDistrictMatcher) {
    bootstrapBundledBidBoundaryRelease();
    businessImprovementDistrictMatcher = loadActiveBusinessImprovementDistrictMatcher(db);
  }
  if (!businessImprovementDistrictMatcher) {
    throw new Error(
      'BID-only collection requires a complete active business improvement district boundary release'
    );
  }
  const metadata = getBidBoundaryMetadata.get();
  if (!metadata
      || metadata.version !== businessImprovementDistrictMatcher.version
      || Number(metadata.feature_count) !== EXPECTED_BID_FEATURE_COUNT
      || businessImprovementDistrictMatcher.districts.length !== EXPECTED_BID_FEATURE_COUNT) {
    throw new Error('The active business improvement district boundary release is incomplete');
  }
  if (bidCollectorPlan && bidCollectorPlan.boundaryVersion === metadata.version
      && bidCollectorPlan.boundaryHash === metadata.source_sha256) return bidCollectorPlan;

  const zones = buildBidQueryZones(businessImprovementDistrictMatcher.districts, {
    targetCount: BID_QUERY_ZONE_TARGET
  });
  const coverage = verifyZoneCoverage(businessImprovementDistrictMatcher.districts, zones);
  if (!coverage.ok) {
    throw new Error(
      `BID query plan does not cover BID IDs ${coverage.uncoveredBidIds.join(', ')}`
    );
  }
  const planHash = queryPlanHash(metadata.version, zones);
  bidCollectorPlan = {
    boundaryVersion: metadata.version,
    boundaryHash: metadata.source_sha256,
    featureCount: Number(metadata.feature_count),
    planHash,
    zones
  };
  return bidCollectorPlan;
}

async function fetchBidOnlyPoll() {
  const plan = refreshBidCollectorPlan();
  const attemptedAt = new Date();
  const attemptedAtIso = attemptedAt.toISOString();
  // Persist liveness before any potentially long bounded recovery. This lets
  // operators and deployment checks distinguish active catch-up from a dead
  // process without pretending that a complete network scan has finished.
  setState.run('bid_collector_last_attempt_at', attemptedAtIso, attemptedAtIso);
  const globalPollState = getState.get('last_successful_poll_at');
  const fallbackPriorState = globalPollState && globalPollState.value
    ? { last_successful_poll_at: globalPollState.value }
    : null;
  const outcomes = await mapWithConcurrency(
    plan.zones,
    BID_QUERY_CONCURRENCY,
    async zone => {
      const queryStartedAt = new Date().toISOString();
      const storedPriorState = getBidZoneState.get(
        plan.boundaryVersion,
        plan.planHash,
        zone.zoneId
      );
      // A new query plan inherits the last complete BID-network watermark so
      // changing the zone layout cannot silently skip an offline interval.
      const priorState = storedPriorState || fallbackPriorState;
      try {
        const collected = await collectBidZonePins({
          portalClient: bidPortalClient,
          bbox: zone.bbox,
          priorState,
          attemptedAt,
          pollIntervalSeconds: BID_POLL_INTERVAL_SECONDS,
          cap: PORTAL_CAP,
          // A zone that has already saturated should use the bounded endpoint
          // directly. Retrying the known-bad undated request added minutes to
          // every cycle before eventually using the same bounded fallback.
          preferBounded: Boolean(
            storedPriorState && (
              Number(storedPriorState.saturation_count) > 0
              || /aborted|timed out|timeout/i.test(storedPriorState.last_error || '')
            )
          ),
          resolveRecoveryRange: (state, now) => bidRecoveryRange(state, now, {
            maxDays: BID_CATCHUP_MAX_DAYS
          })
        });
        const progressAt = new Date().toISOString();
        setState.run('bid_collector_last_attempt_at', progressAt, progressAt);
        return {
          ok: true,
          zone,
          ...collected,
          resultCount: collected.pins.length,
          watermarkAt: collected.watermarkAt || queryStartedAt,
          caughtUp: collected.caughtUp !== false
        };
      } catch (error) {
        const progressAt = new Date().toISOString();
        setState.run('bid_collector_last_attempt_at', progressAt, progressAt);
        const recovery = error && error.bidZoneRecovery || {};
        return {
          ok: false,
          zone,
          pins: [],
          resultCount: recovery.initialCount ?? null,
          initialCount: recovery.initialCount ?? null,
          saturated: Boolean(recovery.saturated),
          offlineGap: Boolean(recovery.offlineGap),
          recoveryReason: recovery.recoveryReason || null,
          watermarkAt: queryStartedAt,
          caughtUp: false,
          error: error.message
        };
      }
    }
  );
  const successful = outcomes.filter(outcome => outcome.ok);
  const uniquePins = deduplicatePortalPins(successful.flatMap(outcome => outcome.pins));
  const accepted = filterPinsToBids(uniquePins, businessImprovementDistrictMatcher);
  return {
    records: accepted.map(item => item.pin),
    rawUniqueCount: uniquePins.length,
    rejectedCount: uniquePins.length - accepted.length,
    expectedBoundaryVersion: plan.boundaryVersion,
    boundaryHash: plan.boundaryHash,
    planHash: plan.planHash,
    zoneCount: plan.zones.length,
    successfulZones: successful.length,
    failedZones: outcomes.length - successful.length,
    catchingUpZones: successful.filter(outcome => !outcome.caughtUp).length,
    zoneOutcomes: outcomes,
    attemptedAt: attemptedAt.toISOString()
  };
}

async function fetchLatest() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(PORTAL_URL, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Live/1.0)',
        Referer: 'https://portal.311.nyc.gov/check-status/',
        Origin: 'https://portal.311.nyc.gov'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Portal returned HTTP ${response.status}`);
    const text = await response.text();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Portal response did not contain a record list');
    const records = JSON.parse(match[0]);
    if (!Array.isArray(records)) throw new Error('Portal response was not a record list');
    return records;
  } finally {
    clearTimeout(timeout);
  }
}

function savePoll(records) {
  const {
    zoneOutcomes = [],
    expectedBoundaryVersion = null,
    planHash = null
  } = arguments[1] || {};
  const now = new Date();
  const nowIso = now.toISOString();
  const auditAfter = new Date(now.getTime() + AUDIT_DELAY_MINUTES * 60 * 1000).toISOString();
  const numbered = records
    .map(pin => {
      const canonicalPin = canonicalizePortalPin(pin);
      const srnumber = canonicalPin && canonicalPin.data.srnumber;
      return {
        pin: canonicalPin || pin,
        suffix: suffixOf(srnumber)
      };
    })
    .filter(item => item.suffix != null);
  const highest = !BID_ONLY && numbered.length
    ? Math.max(...numbered.map(item => item.suffix))
    : null;
  const priorState = BID_ONLY ? null : getState.get('live_frontier');
  const previousFrontier = priorState ? Number(priorState.value) : null;
  let newMapRecords = 0;
  let statusChanges = 0;
  let closureRefreshesQueued = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    const boundaryMatchers = refreshActiveBoundaryMatchers(db, {
      policePrecinctMatcher,
      businessImprovementDistrictMatcher
    }, {
      loadPolicePrecinctMatcher: loadActivePolicePrecinctMatcher,
      loadBusinessImprovementDistrictMatcher:
        loadActiveBusinessImprovementDistrictMatcher
    });
    policePrecinctMatcher = boundaryMatchers.policePrecinctMatcher;
    businessImprovementDistrictMatcher =
      boundaryMatchers.businessImprovementDistrictMatcher;
    if (BID_ONLY && (!businessImprovementDistrictMatcher
        || (expectedBoundaryVersion
          && businessImprovementDistrictMatcher.version !== expectedBoundaryVersion))) {
      throw new Error('The active BID boundary changed during the Portal poll; retrying safely');
    }
    for (const { pin, suffix } of numbered) {
      const data = pin.data || {};
      const number = data.srnumber;
      const address = data.address || pin.sublabel || null;
      const geography = geographyFromPortalAddress(address);
      const latitude = finitePortalCoordinate(pin.latitude);
      const longitude = finitePortalCoordinate(pin.longitude);
      const existing = getLiveRequest.get(number);
      const coordinatesChanged = !existing
        || Number(existing.latitude) !== latitude
        || Number(existing.longitude) !== longitude;
      const precinctAttempted = Boolean(
        policePrecinctMatcher && latitude != null && longitude != null
        && (!existing
          || existing.police_precinct_boundary_version !== policePrecinctMatcher.version
          || coordinatesChanged)
      );
      const precinctMatch = precinctAttempted
        ? policePrecinctMatcher.match(latitude, longitude)
        : null;
      const bidAttempted = Boolean(
        businessImprovementDistrictMatcher && latitude != null && longitude != null
        && (BID_ONLY || !existing
          || existing.business_improvement_district_boundary_version
            !== businessImprovementDistrictMatcher.version
          || coordinatesChanged)
      );
      const bidMatch = bidAttempted
        ? businessImprovementDistrictMatcher.match(latitude, longitude)
        : null;
      if (BID_ONLY && (!bidMatch || !Array.isArray(bidMatch.districts)
          || bidMatch.districts.length === 0)) continue;
      if (!existing) newMapRecords += 1;
      const existingFollowUp = existing
        ? closureTracker.getFollowUp.get(number)
        : null;
      const preservePendingClosure = existing && preservePendingClosureStatus({
        currentStatus: existing.status,
        incomingStatus: data.status,
        followUpState: existingFollowUp && existingFollowUp.state
      });
      const effectiveMapStatus = preservePendingClosure
        ? existing.status
        : data.status;
      const statusChanged = effectiveMapStatus
        && (!existing || !statusesMatch(existing.status, effectiveMapStatus));
      if (statusChanged) {
        const added = closureTracker.observeStatus({
          srnumber: number,
          previousStatus: existing ? existing.status : null,
          status: effectiveMapStatus,
          source: 'map',
          observedAt: nowIso,
          snapshot: pin
        });
        if (added && existing) statusChanges += 1;
        const queued = closureTracker.queueMapStatusChange({
          srnumber: number,
          portalId: pin.id || (existing && existing.portal_id),
          previousStatus: existing ? existing.status : null,
          status: effectiveMapStatus,
          observedAt: nowIso
        });
        if (queued && isClosedStatus(effectiveMapStatus)) closureRefreshesQueued += 1;
      }
      upsertRequest.run(
        number,
        suffix,
        pin.id || null,
        data.problem || pin.label || null,
        address,
        geography.borough,
        geography.incident_zip,
        precinctMatch ? precinctMatch.precinctNumber : null,
        precinctAttempted ? policePrecinctMatcher.version : null,
        precinctAttempted ? nowIso : null,
        bidAttempted ? businessImprovementDistrictMatcher.version : null,
        bidAttempted ? nowIso : null,
        latitude,
        longitude,
        normalizePortalTimestamp(data.submitteddate),
        effectiveMapStatus || null,
        pin.id ? `https://portal.311.nyc.gov/sr-details/?id=${pin.id}` : null,
        nowIso,
        nowIso,
        JSON.stringify(pin)
      );
      if (bidAttempted) {
        upsertBusinessImprovementDistrictAssignment.run(
          number,
          businessImprovementDistrictMatcher.version,
          nowIso,
          latitude,
          longitude
        );
        clearBusinessImprovementDistrictMemberships.run(number);
        for (const district of bidMatch && bidMatch.districts || []) {
          insertBusinessImprovementDistrictMembership.run(
            number,
            businessImprovementDistrictMatcher.version,
            district.bidId,
            nowIso
          );
        }
      }
      upsertDetailQueue.run(number, pin.id || null, nowIso, nowIso);
      if (!BID_ONLY) {
        saveMapLedger.run(suffix, number, nowIso);
        markNumberSeenOnMap.run(nowIso, suffix);
      }
    }

    let queued = 0;
    if (!BID_ONLY && highest != null && previousFrontier != null && highest > previousFrontier) {
      const mapSuffixes = new Set(numbered.map(item => item.suffix));
      for (let suffix = previousFrontier + 1; suffix <= highest; suffix += 1) {
        upsertQueue.run(
          suffix,
          requestNumber(suffix),
          nowIso,
          auditAfter,
          mapSuffixes.has(suffix) ? 1 : 0
        );
        queued += 1;
      }
    }

    if (!BID_ONLY && highest != null && (previousFrontier == null || highest > previousFrontier)) {
      setState.run('live_frontier', String(highest), nowIso);
    }
    if (!BID_ONLY) markMapQueueFound.run(nowIso);
    if (BID_ONLY) {
      for (const outcome of zoneOutcomes) {
        const bboxJson = JSON.stringify(outcome.zone.bbox);
        const saturated = outcome.saturated ? 1 : 0;
        if (outcome.ok) {
          saveBidZoneSuccess.run(
            expectedBoundaryVersion,
            planHash,
            outcome.zone.zoneId,
            bboxJson,
            outcome.watermarkAt || nowIso,
            outcome.resultCount,
            saturated,
            nowIso
          );
        } else {
          saveBidZoneFailure.run(
            expectedBoundaryVersion,
            planHash,
            outcome.zone.zoneId,
            bboxJson,
            outcome.resultCount,
            saturated,
            String(outcome.error || 'Portal zone poll failed').slice(0, 1000),
            nowIso
          );
        }
      }
      setState.run('bid_collector_last_attempt_at', nowIso, nowIso);
      setState.run(
        'bid_collector_failed_zones',
        String(zoneOutcomes.filter(outcome => !outcome.ok).length),
        nowIso
      );
      setState.run(
        'bid_collector_catching_up_zones',
        String(zoneOutcomes.filter(outcome => outcome.ok && !outcome.caughtUp).length),
        nowIso
      );
      if (zoneOutcomes.some(outcome => outcome.ok)) {
        setState.run('bid_collector_last_progress_at', nowIso, nowIso);
      }
    }
    db.exec('COMMIT');
    return {
      highest,
      previousFrontier,
      newMapRecords,
      queued,
      statusChanges,
      closureRefreshesQueued,
      successfulZones: BID_ONLY ? zoneOutcomes.filter(outcome => outcome.ok).length : null,
      failedZones: BID_ONLY ? zoneOutcomes.filter(outcome => !outcome.ok).length : null,
      catchingUpZones: BID_ONLY
        ? zoneOutcomes.filter(outcome => outcome.ok && !outcome.caughtUp).length
        : null
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function runArchiveRange(low, high) {
  return new Promise((resolve, reject) => {
    if (stopRequested) {
      reject(new Error(`Delayed audit was not started because shutdown was requested (${stopReason})`));
      return;
    }
    const child = spawn(process.execPath, [path.join(__dirname, 'archive-311.js')], {
      cwd: path.dirname(DATABASE_PATH),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        LOW_SUFFIX: String(low),
        HIGH_SUFFIX: String(high),
        DATABASE_PATH,
        MAX_PARALLEL: process.env.AUDIT_MAX_PARALLEL || '2',
        REQUEST_DELAY_MS: process.env.AUDIT_REQUEST_DELAY_MS || '500'
      },
      stdio: 'inherit'
    });
    activeArchiveChild = child;
    const clearActiveChild = () => {
      if (activeArchiveChild === child) activeArchiveChild = null;
    };
    child.once('error', error => {
      clearActiveChild();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearActiveChild();
      if (code === 0) resolve();
      else reject(new Error(
        signal
          ? `Delayed audit was terminated by ${signal}`
          : `Delayed audit exited with code ${code}`
      ));
    });
  });
}

let auditPromise = null;

function startEligibleAudit() {
  if (stopRequested) return { started: false, reason: 'stopping' };
  if (auditPromise) return { started: false, reason: 'already_running' };
  const nowIso = new Date().toISOString();
  const range = eligibleAuditRange.get(nowIso);
  if (!range || !range.count) return { started: false, reason: 'nothing_due' };

  console.log(JSON.stringify({
    delayed_audit: 'starting',
    low_suffix: range.low,
    high_suffix: range.high,
    pending_suffixes: range.count
  }));
  const catchupWindow = stateJson('catchup_window');
  const catchupLow = Number(catchupWindow && catchupWindow.low_suffix);
  const catchupHigh = Number(catchupWindow && catchupWindow.high_suffix);
  const progressLow = Number.isInteger(catchupLow) ? catchupLow : range.low;
  const progressHigh = Number.isInteger(catchupHigh) ? catchupHigh : range.high;
  const completedAtStart = Number(countResolvedInRange.get(progressLow, progressHigh).count || 0);
  saveJsonState('audit_run', {
    status: 'running',
    low_suffix: range.low,
    high_suffix: range.high,
    pending_suffixes: range.count,
    completed_at_start: completedAtStart,
    started_at: nowIso
  }, nowIso);
  detailHydrationPaused = true;
  auditPromise = (async () => {
    try {
      await runArchiveRange(range.low, range.high);
      const completedAt = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = syncCompletedAudits.run(completedAt);
        const promotion = promoteAuditDiscoveries({
          db,
          closureTracker,
          observedAt: completedAt,
          manageTransaction: false
        });
        db.exec('COMMIT');
        const summary = {
          status: 'complete',
          low_suffix: range.low,
          high_suffix: range.high,
          attempted: range.count,
          completed: Number(result.changes || 0),
          promoted: promotion.promoted,
          promotion_conflicts: promotion.conflicts,
          promotion_invalid: promotion.invalid,
          started_at: nowIso,
          finished_at: completedAt
        };
        saveJsonState('audit_run', summary, completedAt);
        const completedCatchupWindow = stateJson('catchup_window');
        if (completedCatchupWindow) {
          const completedCatchupLow = Number(completedCatchupWindow.low_suffix);
          const completedCatchupHigh = Number(completedCatchupWindow.high_suffix);
          if (Number.isInteger(completedCatchupLow) && Number.isInteger(completedCatchupHigh)) {
            const resolved = Number(countResolvedInRange.get(completedCatchupLow, completedCatchupHigh).count || 0);
            if (resolved >= completedCatchupHigh - completedCatchupLow + 1) {
              saveJsonState('catchup_window', {
                ...completedCatchupWindow,
                status: 'complete',
                completed_at: completedAt
              }, completedAt);
            }
          }
        }
        console.log(JSON.stringify({ delayed_audit: 'finished', ...summary }));
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      const failedAt = new Date().toISOString();
      saveJsonState('audit_run', {
        status: 'retry',
        low_suffix: range.low,
        high_suffix: range.high,
        started_at: nowIso,
        failed_at: failedAt,
        error: error.message
      }, failedAt);
      console.error(JSON.stringify({ delayed_audit: 'failed', error: error.message }));
    } finally {
      detailHydrationPaused = false;
      auditPromise = null;
    }
  })();
  return { started: true, low: range.low, high: range.high, pending: range.count };
}

async function main() {
  const started = Date.now();
  let polls = 0;
  const startupStateAt = new Date().toISOString();
  setState.run('collector_scope', COLLECTOR_SCOPE, startupStateAt);
  setState.run(
    'number_audit_mode',
    BID_ONLY ? 'not_applicable_bid_only' : 'citywide_suffix_gap',
    startupStateAt
  );
  let startupBidPlan = null;
  if (BID_ONLY) {
    try {
      startupBidPlan = refreshBidCollectorPlan();
      db.prepare(`
        DELETE FROM live_monitor_state WHERE key='bid_collector_startup_error'
      `).run();
    } catch (error) {
      setState.run(
        'bid_collector_startup_error',
        String(error.message || error).slice(0, 1000),
        startupStateAt
      );
      throw error;
    }
  }
  if (startupBidPlan) {
    setState.run('bid_boundary_version', startupBidPlan.boundaryVersion, startupStateAt);
    setState.run('bid_boundary_sha256', startupBidPlan.boundaryHash, startupStateAt);
    setState.run('bid_query_plan_hash', startupBidPlan.planHash, startupStateAt);
    setState.run('bid_query_zone_count', String(startupBidPlan.zones.length), startupStateAt);
    setState.run('bid_poll_interval_seconds', String(BID_POLL_INTERVAL_SECONDS), startupStateAt);
  }
  const startupPromotion = BID_ONLY ? { promoted: 0, conflicts: 0, invalid: 0 }
    : promoteAuditDiscoveries({
      db,
      closureTracker,
      observedAt: startupStateAt
    });
  let detailQueueReconciled = { reconciled: 0 };
  let seeded = {
    statusRows: 0,
    followUpsSeeded: 0,
    provisionalFollowUpsSeeded: 0
  };
  let emailClosuresReconciled = {
    reconciled: 0,
    verification_queued: 0,
    skipped_later_open_status: 0
  };
  // Citywide mode still performs the legacy, archive-wide startup repair. In
  // BID-only mode it is both redundant and harmful: an existing mixed archive
  // can contain hundreds of thousands of intentionally dormant citywide rows,
  // while current BID rows are already queued when each exact polygon match is
  // saved. Skipping the historical sweep lets the first BID poll establish a
  // fresh watermark immediately; all ongoing detail, closure, and subscription
  // workers remain restricted to active BID memberships below.
  if (!BID_ONLY) {
    const detailQueueSeededAt = new Date().toISOString();
    seedDetailQueue.run(detailQueueSeededAt, detailQueueSeededAt);
    detailQueueReconciled = reconcileStoredDetails(db, {
      updatedAt: detailQueueSeededAt
    });
    seeded = seedClosureTracking({
      db,
      closureTracker,
      updateLiveStatus,
      now: new Date()
    });
    emailClosuresReconciled = reconcileStoredEmailClosures(db, {
      now: new Date()
    });
  }
  const openFollowUpsRescheduled = SCHEDULED_OPEN_FOLLOWUPS_ENABLED
    ? closureTracker.normalizeOpenFollowUps(new Date())
    : 0;
  if (!getState.get('poll_interval_seconds')) {
    setState.run('poll_interval_seconds', String(POLL_INTERVAL_SECONDS), new Date().toISOString());
  }
  const monitoringStateAt = new Date().toISOString();
  setState.run(
    'scheduled_open_followups_enabled',
    SCHEDULED_OPEN_FOLLOWUPS_ENABLED ? '1' : '0',
    monitoringStateAt
  );
  setState.run('status_monitoring_mode', monitoringMode(process.env), monitoringStateAt);
  setState.run(
    'email_subscription_workers',
    String(EMAIL_SUBSCRIPTION_WORKERS),
    monitoringStateAt
  );
  setState.run('detail_hydration_lanes', '2', monitoringStateAt);
  console.log(JSON.stringify({
    database: DATABASE_PATH,
    collector_scope: COLLECTOR_SCOPE,
    poll_interval_seconds: currentPollIntervalSeconds(),
    duration_seconds: LIVE_DURATION_SECONDS || null,
    delayed_audit_minutes: AUDIT_DELAY_MINUTES,
    detail_request_delay_ms: DETAIL_REQUEST_DELAY_MS,
    detail_hydration_lanes: 2,
    email_subscription_workers: EMAIL_SUBSCRIPTION_WORKERS,
    sqlite_synchronous: SQLITE_SYNCHRONOUS,
    sqlite_busy_timeout_ms: SQLITE_BUSY_TIMEOUT_MS,
    audit_discoveries_reconciled: startupPromotion.promoted,
    audit_promotion_conflicts: startupPromotion.conflicts,
    audit_promotion_invalid: startupPromotion.invalid,
    detail_queue_reconciled: detailQueueReconciled,
    status_history_seeded: seeded.statusRows,
    followups_seeded: seeded.followUpsSeeded,
    provisional_followups_seeded: seeded.provisionalFollowUpsSeeded,
    stored_email_closures_reconciled: emailClosuresReconciled.reconciled,
    stored_email_closure_verifications_queued:
      emailClosuresReconciled.verification_queued,
    stored_email_closures_preserved_as_reopened:
      emailClosuresReconciled.skipped_later_open_status,
    open_followups_rescheduled: openFollowUpsRescheduled,
    scheduled_open_followups_enabled: SCHEDULED_OPEN_FOLLOWUPS_ENABLED,
    status_monitoring_mode: monitoringMode(process.env),
    bid_boundary_version: startupBidPlan && startupBidPlan.boundaryVersion,
    bid_boundary_sha256: startupBidPlan && startupBidPlan.boundaryHash,
    bid_query_zone_count: startupBidPlan && startupBidPlan.zones.length,
    bid_query_plan_hash: startupBidPlan && startupBidPlan.planHash,
    number_audit_mode: BID_ONLY ? 'not_applicable_bid_only' : 'citywide_suffix_gap'
  }));
  startDetailHydration();
  startEmailSubscriptions();

  while (!stopRequested
      && (LIVE_DURATION_SECONDS === 0 || Date.now() - started < LIVE_DURATION_SECONDS * 1000)) {
    const cycleStartedAt = Date.now();
    try {
      const bidPoll = BID_ONLY ? await fetchBidOnlyPoll() : null;
      const records = bidPoll ? bidPoll.records : await fetchLatest();
      const result = savePoll(records, bidPoll ? {
        zoneOutcomes: bidPoll.zoneOutcomes,
        expectedBoundaryVersion: bidPoll.expectedBoundaryVersion,
        planHash: bidPoll.planHash
      } : undefined);
      const observedAt = new Date().toISOString();
      const completePoll = !bidPoll
        || (bidPoll.failedZones === 0 && bidPoll.catchingUpZones === 0);
      if (completePoll) recordSuccessfulPoll(result, observedAt);
      polls += 1;
      settleFirstPoll({
        ok: completePoll,
        observed_at: observedAt,
        records: records.length,
        failed_zones: bidPoll ? bidPoll.failedZones : 0
      });
      console.log(JSON.stringify({
        poll: polls,
        observed_at: observedAt,
        collector_scope: COLLECTOR_SCOPE,
        feed_records: records.length,
        raw_unique_zone_records: bidPoll && bidPoll.rawUniqueCount,
        rejected_non_bid_records: bidPoll && bidPoll.rejectedCount,
        successful_zones: bidPoll && bidPoll.successfulZones,
        failed_zones: bidPoll && bidPoll.failedZones,
        catching_up_zones: bidPoll && bidPoll.catchingUpZones,
        new_map_records: result.newMapRecords,
        previous_frontier: result.previousFrontier,
        latest_frontier: result.highest,
        suffixes_queued_for_delayed_audit: result.queued,
        status_changes: result.statusChanges,
        closure_refreshes_queued: result.closureRefreshesQueued
      }));
      if (!BID_ONLY) {
        const audit = startEligibleAudit();
        if (audit.started) console.log(JSON.stringify({ delayed_audit: 'background', ...audit }));
      }
    } catch (error) {
      settleFirstPoll({ ok: false, error: error.message });
      console.error(JSON.stringify({ poll: polls + 1, error: error.message }));
    }

    if (stopRequested
        || (LIVE_DURATION_SECONDS > 0 && Date.now() - started >= LIVE_DURATION_SECONDS * 1000)) break;
    const remainingDelay = currentPollIntervalSeconds() * 1000
      - (Date.now() - cycleStartedAt);
    await sleep(Math.max(1_000, remainingDelay));
  }

  detailHydrationStopping = true;
  if (detailHydrationPromise) await detailHydrationPromise;
  if (emailSubscriptionPromise) await emailSubscriptionPromise;
  if (auditPromise) await auditPromise;

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM live_portal_requests) AS map_requests,
      (SELECT COUNT(*) FROM live_number_queue) AS queued_suffixes,
      (SELECT COUNT(*) FROM live_number_queue WHERE map_seen = 0) AS queued_without_map_pin
  `).get();
  console.log(JSON.stringify({ finished: true, polls, ...totals }));
}

process.once('SIGINT', () => requestStop('SIGINT'));
process.once('SIGTERM', () => requestStop('SIGTERM'));
process.once('exit', terminateArchiveChild);

const monitor = main()
  .catch(error => {
    settleFirstPoll({ ok: false, fatal: true, error: error.message });
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());

module.exports = { firstPoll, monitor, stop: requestStop };
