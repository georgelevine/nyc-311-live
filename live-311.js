const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { DatabaseSync } = require('node:sqlite');
const {
  createClosureTracker,
  isClosedStatus,
  statusesMatch
} = require('./closure-tracking');
const { promoteAuditDiscoveries } = require('./audit-discovery');
const { reconcileStoredDetails } = require('./detail-queue');

const PORTAL_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const POLL_INTERVAL_SECONDS = Math.max(5, Number(process.env.POLL_INTERVAL_SECONDS || 15));
const LIVE_DURATION_SECONDS = Math.max(0, Number(process.env.LIVE_DURATION_SECONDS || 0));
const AUDIT_DELAY_MINUTES = Math.max(30, Number(process.env.AUDIT_DELAY_MINUTES || 35));
// One detail request every 2.5 seconds leaves room for the four map polls per
// minute while keeping total routine Portal traffic below about 30/minute.
const DETAIL_REQUEST_DELAY_MS = Math.max(500, Number(process.env.DETAIL_REQUEST_DELAY_MS || 2500));
const DATABASE_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'data', 'portal-archive.sqlite');

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 3000;

  CREATE TABLE IF NOT EXISTS live_portal_requests (
    srnumber TEXT PRIMARY KEY,
    suffix INTEGER UNIQUE,
    portal_id TEXT UNIQUE,
    problem TEXT,
    address TEXT,
    latitude REAL,
    longitude REAL,
    submitted_at TEXT,
    status TEXT,
    portal_url TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS live_number_queue (
    suffix INTEGER PRIMARY KEY,
    srnumber TEXT NOT NULL UNIQUE,
    first_detected_at TEXT NOT NULL,
    audit_after TEXT NOT NULL,
    map_seen INTEGER NOT NULL DEFAULT 0,
    audit_outcome TEXT NOT NULL DEFAULT 'pending',
    audited_at TEXT
  );

  CREATE TABLE IF NOT EXISTS live_monitor_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

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

  CREATE TABLE IF NOT EXISTS live_detail_queue (
    srnumber TEXT PRIMARY KEY,
    portal_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS live_detail_queue_status_idx
    ON live_detail_queue(status, next_attempt_at);

  CREATE TABLE IF NOT EXISTS number_ledger (
    suffix INTEGER PRIMARY KEY,
    srnumber TEXT NOT NULL UNIQUE,
    outcome TEXT NOT NULL CHECK (outcome IN ('found', 'not_found', 'retry')),
    attempts INTEGER NOT NULL,
    http_status INTEGER,
    error TEXT,
    checked_at TEXT NOT NULL
  );
`);

const closureTracker = createClosureTracker(db);

const getLiveRequest = db.prepare(`
  SELECT srnumber, suffix, portal_id, status, first_seen_at, last_seen_at
  FROM live_portal_requests WHERE srnumber = ?
`);
const upsertRequest = db.prepare(`
  INSERT INTO live_portal_requests (
    srnumber, suffix, portal_id, problem, address, latitude, longitude,
    submitted_at, status, portal_url, first_seen_at, last_seen_at, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(srnumber) DO UPDATE SET
    portal_id = COALESCE(excluded.portal_id, live_portal_requests.portal_id),
    problem = COALESCE(excluded.problem, live_portal_requests.problem),
    address = COALESCE(excluded.address, live_portal_requests.address),
    latitude = COALESCE(excluded.latitude, live_portal_requests.latitude),
    longitude = COALESCE(excluded.longitude, live_portal_requests.longitude),
    submitted_at = COALESCE(excluded.submitted_at, live_portal_requests.submitted_at),
    status = COALESCE(excluded.status, live_portal_requests.status),
    portal_url = COALESCE(excluded.portal_url, live_portal_requests.portal_url),
    last_seen_at = excluded.last_seen_at,
    raw_json = excluded.raw_json
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
    AND NOT EXISTS (
      SELECT 1 FROM request_followup_queue AS followup
      WHERE followup.srnumber = queue.srnumber
        AND followup.last_checked_at IS NOT NULL
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
const getState = db.prepare('SELECT value FROM live_monitor_state WHERE key = ?');
const setState = db.prepare(`
  INSERT INTO live_monitor_state (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);
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

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function suffixOf(number) {
  const match = String(number || '').match(/^311-(\d{8})$/);
  return match ? Number(match[1]) : null;
}

function requestNumber(suffix) {
  return `311-${String(suffix).padStart(8, '0')}`;
}

function currentPollIntervalSeconds() {
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

  const scripts = $('script').map((_, script) => $(script).html() || '').get().join('\n');
  const scriptDate = id => {
    const pattern = new RegExp(`\\$\\(["']#${id}["']\\)\\.text\\(getESTDate\\(["']([^"']+)["']\\)\\)`);
    const match = scripts.match(pattern);
    return match ? match[1] : null;
  };

  const number = fields['SR Number'] || expectedNumber;
  if (!number || !fields['SR Number']) throw new Error('Portal detail page did not contain a service request');
  return {
    srnumber: number,
    portalId: portalId || pagePortalId || null,
    status: fields['SR Status'] || null,
    problem: fields.Problem || null,
    problemDetails: fields['Problem Details'] || null,
    additionalDetails: fields['Additional Details'] || null,
    address: fields['SR Address'] || null,
    nextUpdate: fields['Time To Next Update'] || null,
    dateReported: scriptDate('srdatereported'),
    updatedOn: scriptDate('srupdatedon'),
    dateClosed: scriptDate('srdateclosed'),
    fields
  };
}

function safelyParseFields(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function seedClosureTracking() {
  const now = new Date().toISOString();
  const liveRows = db.prepare(`
    SELECT srnumber, portal_id, status, first_seen_at
    FROM live_portal_requests
    WHERE status IS NOT NULL AND TRIM(status) <> ''
  `).all();
  const detailRowsWithoutFollowUp = db.prepare(`
    SELECT live.srnumber, live.portal_id, live.status AS live_status,
           details.status AS detail_status, details.problem, details.problem_details,
           details.additional_details, details.address, details.next_update,
           details.date_reported, details.updated_on, details.date_closed,
           details.fields_json, details.archived_at
    FROM live_portal_requests AS live
    JOIN portal_requests AS details ON details.srnumber = live.srnumber
    LEFT JOIN request_followup_queue AS followup ON followup.srnumber = live.srnumber
    WHERE followup.srnumber IS NULL
  `).all();

  db.exec('BEGIN');
  try {
    for (const row of liveRows) {
      closureTracker.observeStatus({
        srnumber: row.srnumber,
        previousStatus: null,
        status: row.status,
        source: 'migration',
        observedAt: row.first_seen_at || now
      });
    }
    for (const row of detailRowsWithoutFollowUp) {
      const detail = {
        srnumber: row.srnumber,
        portalId: row.portal_id,
        status: row.date_closed && !isClosedStatus(row.detail_status)
          ? 'Closed'
          : row.detail_status,
        problem: row.problem,
        problemDetails: row.problem_details,
        additionalDetails: row.additional_details,
        address: row.address,
        nextUpdate: row.next_update,
        dateReported: row.date_reported,
        updatedOn: row.updated_on,
        dateClosed: row.date_closed,
        fields: safelyParseFields(row.fields_json)
      };
      let effectiveStatus = row.live_status || detail.status;
      if (isClosedStatus(detail.status) && !isClosedStatus(row.live_status)) {
        closureTracker.observeStatus({
          srnumber: row.srnumber,
          previousStatus: row.live_status,
          status: detail.status,
          source: 'stored_detail',
          effectiveAt: row.date_closed || row.updated_on,
          observedAt: row.archived_at || now,
          snapshot: detail
        });
        updateLiveStatus.run(detail.status, row.srnumber);
        effectiveStatus = detail.status;
      }
      if (isClosedStatus(effectiveStatus) && !isClosedStatus(detail.status)) {
        closureTracker.queueMapStatusChange({
          srnumber: row.srnumber,
          portalId: row.portal_id,
          previousStatus: 'Open',
          status: effectiveStatus,
          observedAt: now
        });
      } else {
        closureTracker.scheduleAfterDetail({
          srnumber: row.srnumber,
          portalId: row.portal_id,
          effectiveStatus,
          detail,
          source: 'migration',
          checkedAt: row.archived_at || now
        });
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  let provisionalFollowUpsSeeded = 0;
  const liveRowsWithoutFollowUp = db.prepare(`
    SELECT live.srnumber, live.portal_id, live.status,
           COALESCE(live.last_seen_at, live.first_seen_at, ?) AS observed_at
    FROM live_portal_requests AS live
    LEFT JOIN request_followup_queue AS followup ON followup.srnumber = live.srnumber
    WHERE followup.srnumber IS NULL
      AND live.status IS NOT NULL AND TRIM(live.status) <> ''
    ORDER BY live.suffix
  `).all(now);
  db.exec('BEGIN');
  try {
    for (const row of liveRowsWithoutFollowUp) {
      if (closureTracker.queueMapStatusChange({
        srnumber: row.srnumber,
        portalId: row.portal_id,
        previousStatus: null,
        status: row.status,
        observedAt: row.observed_at
      })) provisionalFollowUpsSeeded += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    statusRows: liveRows.length,
    followUpsSeeded: detailRowsWithoutFollowUp.length,
    provisionalFollowUpsSeeded
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

function nextDetailWork(now) {
  return nextClosingFollowUp.get(now)
    || nextDetailRequest.get(now)
    || nextOpenFollowUp.get(now)
    || null;
}

let detailHydrationPromise = null;
let detailHydrationStopping = false;
let detailHydrationPaused = false;

function startDetailHydration() {
  if (detailHydrationPromise) return;
  detailHydrationPromise = (async () => {
    while (!detailHydrationStopping) {
      if (detailHydrationPaused) {
        await sleep(1000);
        continue;
      }
      const row = nextDetailWork(new Date().toISOString());
      if (!row) {
        await sleep(3000);
        continue;
      }
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
          await sleep(DETAIL_REQUEST_DELAY_MS);
          continue;
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
        const retryDelay = Math.min(15 * 60_000, 30_000 * (2 ** Math.min(Number(row.attempts || 0), 5)));
        const retryAt = new Date(Date.now() + retryDelay).toISOString();
        if (row.work_kind === 'closing' || row.work_kind === 'followup') {
          const currentJob = closureTracker.getFollowUp.get(row.srnumber);
          const currentStatusVersion = latestStatusVersion.get(row.srnumber).version;
          if (currentJob && currentJob.state === row.state
              && Number(currentJob.closure_cycle) === Number(row.closure_cycle)
              && currentJob.updated_at === row.updated_at
              && Number(currentStatusVersion) === Number(row.status_version)) {
            closureTracker.markFollowUpError(row, error, workTimestamp);
          }
        } else {
          markDetailRetry.run(retryAt, error.message, workTimestamp, row.srnumber);
        }
      }
      await sleep(DETAIL_REQUEST_DELAY_MS);
    }
  })();
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
  const now = new Date();
  const nowIso = now.toISOString();
  const auditAfter = new Date(now.getTime() + AUDIT_DELAY_MINUTES * 60 * 1000).toISOString();
  const numbered = records
    .map(pin => ({ pin, suffix: suffixOf(pin.data && pin.data.srnumber) }))
    .filter(item => item.suffix != null);
  const highest = numbered.length ? Math.max(...numbered.map(item => item.suffix)) : null;
  const priorState = getState.get('live_frontier');
  const previousFrontier = priorState ? Number(priorState.value) : null;
  let newMapRecords = 0;
  let statusChanges = 0;
  let closureRefreshesQueued = 0;

  db.exec('BEGIN');
  try {
    for (const { pin, suffix } of numbered) {
      const data = pin.data || {};
      const number = data.srnumber;
      const existing = getLiveRequest.get(number);
      if (!existing) newMapRecords += 1;
      const statusChanged = data.status
        && (!existing || !statusesMatch(existing.status, data.status));
      if (statusChanged) {
        const added = closureTracker.observeStatus({
          srnumber: number,
          previousStatus: existing ? existing.status : null,
          status: data.status,
          source: 'map',
          observedAt: nowIso,
          snapshot: pin
        });
        if (added && existing) statusChanges += 1;
        const queued = closureTracker.queueMapStatusChange({
          srnumber: number,
          portalId: pin.id || (existing && existing.portal_id),
          previousStatus: existing ? existing.status : null,
          status: data.status,
          observedAt: nowIso
        });
        if (queued && isClosedStatus(data.status)) closureRefreshesQueued += 1;
      }
      upsertRequest.run(
        number,
        suffix,
        pin.id || null,
        data.problem || pin.label || null,
        data.address || pin.sublabel || null,
        Number.isFinite(Number(pin.latitude)) ? Number(pin.latitude) : null,
        Number.isFinite(Number(pin.longitude)) ? Number(pin.longitude) : null,
        data.submitteddate || null,
        data.status || null,
        pin.id ? `https://portal.311.nyc.gov/sr-details/?id=${pin.id}` : null,
        nowIso,
        nowIso,
        JSON.stringify(pin)
      );
      upsertDetailQueue.run(number, pin.id || null, nowIso, nowIso);
      saveMapLedger.run(suffix, number, nowIso);
      markNumberSeenOnMap.run(nowIso, suffix);
    }

    let queued = 0;
    if (highest != null && previousFrontier != null && highest > previousFrontier) {
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

    if (highest != null && (previousFrontier == null || highest > previousFrontier)) {
      setState.run('live_frontier', String(highest), nowIso);
    }
    markMapQueueFound.run(nowIso);
    db.exec('COMMIT');
    return {
      highest,
      previousFrontier,
      newMapRecords,
      queued,
      statusChanges,
      closureRefreshesQueued
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function runArchiveRange(low, high) {
  return new Promise((resolve, reject) => {
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
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Delayed audit exited with code ${code}`));
    });
  });
}

let auditPromise = null;

function startEligibleAudit() {
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
  const startupPromotion = promoteAuditDiscoveries({
    db,
    closureTracker,
    observedAt: new Date().toISOString()
  });
  const detailQueueSeededAt = new Date().toISOString();
  seedDetailQueue.run(detailQueueSeededAt, detailQueueSeededAt);
  const detailQueueReconciled = reconcileStoredDetails(db, {
    updatedAt: detailQueueSeededAt
  });
  const seeded = seedClosureTracking();
  const openFollowUpsRescheduled = closureTracker.normalizeOpenFollowUps(new Date());
  if (!getState.get('poll_interval_seconds')) {
    setState.run('poll_interval_seconds', String(POLL_INTERVAL_SECONDS), new Date().toISOString());
  }
  console.log(JSON.stringify({
    database: DATABASE_PATH,
    poll_interval_seconds: currentPollIntervalSeconds(),
    duration_seconds: LIVE_DURATION_SECONDS || null,
    delayed_audit_minutes: AUDIT_DELAY_MINUTES,
    detail_request_delay_ms: DETAIL_REQUEST_DELAY_MS,
    audit_discoveries_reconciled: startupPromotion.promoted,
    audit_promotion_conflicts: startupPromotion.conflicts,
    audit_promotion_invalid: startupPromotion.invalid,
    detail_queue_reconciled: detailQueueReconciled,
    status_history_seeded: seeded.statusRows,
    followups_seeded: seeded.followUpsSeeded,
    provisional_followups_seeded: seeded.provisionalFollowUpsSeeded,
    open_followups_rescheduled: openFollowUpsRescheduled
  }));
  startDetailHydration();

  while (LIVE_DURATION_SECONDS === 0 || Date.now() - started < LIVE_DURATION_SECONDS * 1000) {
    try {
      const records = await fetchLatest();
      const result = savePoll(records);
      const observedAt = new Date().toISOString();
      recordSuccessfulPoll(result, observedAt);
      polls += 1;
      settleFirstPoll({ ok: true, observed_at: observedAt, records: records.length });
      console.log(JSON.stringify({
        poll: polls,
        observed_at: observedAt,
        feed_records: records.length,
        new_map_records: result.newMapRecords,
        previous_frontier: result.previousFrontier,
        latest_frontier: result.highest,
        suffixes_queued_for_delayed_audit: result.queued,
        status_changes: result.statusChanges,
        closure_refreshes_queued: result.closureRefreshesQueued
      }));
      const audit = startEligibleAudit();
      if (audit.started) console.log(JSON.stringify({ delayed_audit: 'background', ...audit }));
    } catch (error) {
      settleFirstPoll({ ok: false, error: error.message });
      console.error(JSON.stringify({ poll: polls + 1, error: error.message }));
    }

    if (LIVE_DURATION_SECONDS > 0 && Date.now() - started >= LIVE_DURATION_SECONDS * 1000) break;
    await sleep(currentPollIntervalSeconds() * 1000);
  }

  detailHydrationStopping = true;
  if (detailHydrationPromise) await detailHydrationPromise;
  if (auditPromise) await auditPromise;

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM live_portal_requests) AS map_requests,
      (SELECT COUNT(*) FROM live_number_queue) AS queued_suffixes,
      (SELECT COUNT(*) FROM live_number_queue WHERE map_seen = 0) AS queued_without_map_pin
  `).get();
  console.log(JSON.stringify({ finished: true, polls, ...totals }));
}

const monitor = main()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());

module.exports = { firstPoll, monitor };
