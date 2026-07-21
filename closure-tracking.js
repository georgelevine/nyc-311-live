const crypto = require('crypto');

const CLOSED_STATUS_PATTERN = /\b(?:closed|resolved|cancel(?:led|ed)?)\b/i;
const OPEN_FOLLOW_UP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLOSURE_RETRY_DELAYS_MS = [
  15 * 60 * 1000,
  2 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000
];

function isClosedStatus(value) {
  return CLOSED_STATUS_PATTERN.test(String(value || ''));
}

function normalizedStatus(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function statusesMatch(first, second) {
  return normalizedStatus(first) === normalizedStatus(second);
}

function nextOpenFollowUpAt(now = new Date()) {
  return new Date(now.getTime() + OPEN_FOLLOW_UP_INTERVAL_MS).toISOString();
}

function closureRetryAt(attempts, now = new Date()) {
  const index = Math.max(0, Math.min(CLOSURE_RETRY_DELAYS_MS.length - 1, attempts - 1));
  return new Date(now.getTime() + CLOSURE_RETRY_DELAYS_MS[index]).toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value == null ? null : value;
}

function closureSnapshot(detail) {
  return stableValue({
    srnumber: detail.srnumber || null,
    portalId: detail.portalId || null,
    status: detail.status || null,
    problem: detail.problem || null,
    problemDetails: detail.problemDetails || null,
    additionalDetails: detail.additionalDetails || null,
    address: detail.address || null,
    nextUpdate: detail.nextUpdate || null,
    dateReported: detail.dateReported || null,
    updatedOn: detail.updatedOn || null,
    dateClosed: detail.dateClosed || null,
    fields: detail.fields || {}
  });
}

function ensureClosureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      srnumber TEXT NOT NULL,
      previous_status TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      effective_at TEXT,
      observed_at TEXT NOT NULL,
      snapshot_json TEXT
    );

    CREATE INDEX IF NOT EXISTS request_status_history_request_idx
      ON request_status_history(srnumber, observed_at);

    CREATE TABLE IF NOT EXISTS request_closure_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      srnumber TEXT NOT NULL,
      closure_cycle INTEGER NOT NULL,
      status TEXT,
      date_closed TEXT,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      is_final INTEGER NOT NULL DEFAULT 0,
      final_state TEXT,
      content_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      UNIQUE(srnumber, closure_cycle, content_hash, is_final)
    );

    CREATE INDEX IF NOT EXISTS request_closure_snapshots_request_idx
      ON request_closure_snapshots(srnumber, closure_cycle DESC, fetched_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS request_closure_snapshots_final_idx
      ON request_closure_snapshots(srnumber, closure_cycle)
      WHERE is_final = 1;

    CREATE TABLE IF NOT EXISTS request_followup_queue (
      srnumber TEXT PRIMARY KEY,
      portal_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('open', 'closing', 'closed')),
      next_check_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      closing_attempts INTEGER NOT NULL DEFAULT 0,
      closure_cycle INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      finalized_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS request_followup_queue_due_idx
      ON request_followup_queue(state, next_check_at);
  `);
  const followUpColumns = db.prepare('PRAGMA table_info(request_followup_queue)').all();
  if (!followUpColumns.some(column => column.name === 'last_success_at')) {
    db.exec('ALTER TABLE request_followup_queue ADD COLUMN last_success_at TEXT');
  }
}

function createClosureTracker(db) {
  ensureClosureSchema(db);

  const latestHistory = db.prepare(`
    SELECT status FROM request_status_history
    WHERE srnumber = ? ORDER BY id DESC LIMIT 1
  `);
  const insertHistory = db.prepare(`
    INSERT INTO request_status_history (
      srnumber, previous_status, status, source, effective_at, observed_at, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getFollowUp = db.prepare(`
    SELECT * FROM request_followup_queue WHERE srnumber = ?
  `);
  const saveFollowUp = db.prepare(`
    INSERT INTO request_followup_queue (
      srnumber, portal_id, state, next_check_at, attempts, closing_attempts,
      closure_cycle, last_checked_at, last_success_at, last_error, finalized_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(srnumber) DO UPDATE SET
      portal_id = COALESCE(excluded.portal_id, request_followup_queue.portal_id),
      state = excluded.state,
      next_check_at = excluded.next_check_at,
      attempts = excluded.attempts,
      closing_attempts = excluded.closing_attempts,
      closure_cycle = excluded.closure_cycle,
      last_checked_at = excluded.last_checked_at,
      last_success_at = COALESCE(excluded.last_success_at, request_followup_queue.last_success_at),
      last_error = excluded.last_error,
      finalized_at = excluded.finalized_at,
      updated_at = excluded.updated_at
  `);
  const openFollowUps = db.prepare(`
    SELECT srnumber, next_check_at, last_checked_at, last_success_at, updated_at
    FROM request_followup_queue
    WHERE state = 'open' AND last_error IS NULL
  `);
  const setOpenFollowUpSchedule = db.prepare(`
    UPDATE request_followup_queue
    SET next_check_at = ?, last_success_at = ?, updated_at = ?
    WHERE srnumber = ?
  `);
  const insertClosureSnapshot = db.prepare(`
    INSERT INTO request_closure_snapshots (
      srnumber, closure_cycle, status, date_closed, source, fetched_at,
      is_final, final_state, content_hash, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);

  function observeStatus({
    srnumber,
    previousStatus,
    status,
    source,
    observedAt,
    effectiveAt = null,
    snapshot = null
  }) {
    if (!srnumber || !String(status || '').trim()) return false;
    const latest = latestHistory.get(srnumber);
    const comparisonStatus = latest ? latest.status : previousStatus;
    if (comparisonStatus != null && statusesMatch(comparisonStatus, status)) return false;
    insertHistory.run(
      srnumber,
      comparisonStatus || null,
      status,
      source,
      effectiveAt,
      observedAt,
      snapshot ? JSON.stringify(stableValue(snapshot)) : null
    );
    return true;
  }

  function queueMapStatusChange({ srnumber, portalId, previousStatus, status, observedAt }) {
    const changed = previousStatus == null || !statusesMatch(previousStatus, status);
    if (!changed || !status) return false;
    const existing = getFollowUp.get(srnumber);
    const closing = isClosedStatus(status);
    const wasClosing = isClosedStatus(previousStatus);

    // "Closed" -> "Resolved" is useful status history, but it is still the
    // same closure event. Do not reset its retry clock or create a new cycle.
    if (closing && wasClosing && existing) return false;
    const currentCycle = Math.max(0, Number(existing && existing.closure_cycle) || 0);
    const closureCycle = closing
      ? (wasClosing ? Math.max(1, currentCycle) : currentCycle + 1)
      : currentCycle;

    const provisionalOpen = !closing && previousStatus == null;
    saveFollowUp.run(
      srnumber,
      portalId || (existing && existing.portal_id) || null,
      closing ? 'closing' : 'open',
      provisionalOpen ? nextOpenFollowUpAt(new Date(observedAt)) : observedAt,
      0,
      0,
      closureCycle,
      existing ? existing.last_checked_at : null,
      existing ? existing.last_success_at : null,
      null,
      null,
      observedAt
    );
    return true;
  }

  function recordClosure(detail, source, fetchedAt, closureCycle, isFinal, finalState = null) {
    const snapshot = closureSnapshot(detail);
    const json = JSON.stringify(snapshot);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    const result = insertClosureSnapshot.run(
      detail.srnumber,
      closureCycle,
      detail.status,
      detail.dateClosed,
      source,
      fetchedAt,
      isFinal ? 1 : 0,
      finalState,
      hash,
      json
    );
    return Number(result.changes || 0) > 0;
  }

  function scheduleAfterDetail({
    srnumber,
    portalId,
    effectiveStatus,
    detail,
    source,
    checkedAt
  }) {
    const now = new Date(checkedAt);
    const existing = getFollowUp.get(srnumber);
    const effectiveClosed = isClosedStatus(effectiveStatus) || Boolean(detail.dateClosed);
    const detailClosed = isClosedStatus(detail.status);

    if (!effectiveClosed) {
      saveFollowUp.run(
        srnumber,
        portalId || (existing && existing.portal_id) || null,
        'open',
        nextOpenFollowUpAt(now),
        0,
        0,
        Math.max(0, Number(existing && existing.closure_cycle) || 0),
        checkedAt,
        checkedAt,
        null,
        null,
        checkedAt
      );
      return { state: 'open', finalized: false, snapshotAdded: false };
    }

    // Late work from the legacy detail queue must not create another closure
    // cycle after this one was already finalized. A genuine reopen first moves
    // the row back to `open`, so it will not take this branch.
    if (existing && existing.state === 'closed') {
      return { state: 'closed', finalized: true, snapshotAdded: false };
    }

    const closureCycle = existing && existing.state === 'closing'
      ? Math.max(1, Number(existing.closure_cycle) || 1)
      : Math.max(0, Number(existing && existing.closure_cycle) || 0) + 1;
    const closingAttempts = Math.max(0, Number(existing && existing.closing_attempts) || 0) + 1;
    const finalized = Boolean(detail.dateClosed) || closingAttempts >= 4;
    const finalState = finalized
      ? (detail.dateClosed ? 'complete' : detailClosed ? 'date_missing' : 'detail_unconfirmed')
      : null;
    const snapshotAdded = detailClosed || finalized
      ? recordClosure(detail, source, checkedAt, closureCycle, finalized, finalState)
      : false;
    saveFollowUp.run(
      srnumber,
      portalId || (existing && existing.portal_id) || null,
      finalized ? 'closed' : 'closing',
      finalized ? null : closureRetryAt(closingAttempts, now),
      0,
      closingAttempts,
      closureCycle,
      checkedAt,
      checkedAt,
      finalized || detailClosed ? null : 'Portal detail has not confirmed the map closure yet',
      finalized ? checkedAt : null,
      checkedAt
    );
    return { state: finalized ? 'closed' : 'closing', finalized, snapshotAdded };
  }

  function markFollowUpError(row, error, checkedAt) {
    const existing = getFollowUp.get(row.srnumber) || row;
    const attempts = Math.max(0, Number(existing.attempts) || 0) + 1;
    const delay = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts - 1, 7)));
    saveFollowUp.run(
      row.srnumber,
      row.portal_id || existing.portal_id || null,
      existing.state || 'open',
      new Date(new Date(checkedAt).getTime() + delay).toISOString(),
      attempts,
      Number(existing.closing_attempts) || 0,
      Number(existing.closure_cycle) || 0,
      checkedAt,
      existing.last_success_at || null,
      error.message,
      existing.finalized_at || null,
      checkedAt
    );
    return delay;
  }

  function normalizeOpenFollowUps(now = new Date()) {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    let changes = 0;
    for (const row of openFollowUps.all()) {
      const provisional = !row.last_checked_at && !row.last_success_at;
      const anchorMs = Date.parse(row.last_success_at || row.last_checked_at || row.updated_at || '');
      const lastSuccessAt = provisional
        ? null
        : Number.isFinite(anchorMs) ? new Date(anchorMs).toISOString() : nowIso;
      const queuedMs = Date.parse(row.next_check_at || '');
      const desiredMs = Number.isFinite(queuedMs) && queuedMs <= nowMs
        ? queuedMs
        : Number.isFinite(anchorMs)
          ? Math.max(nowMs, anchorMs + OPEN_FOLLOW_UP_INTERVAL_MS)
          : nowMs;
      const nextCheckAt = new Date(desiredMs).toISOString();
      if (row.next_check_at === nextCheckAt && row.last_success_at === lastSuccessAt) continue;
      const result = setOpenFollowUpSchedule.run(nextCheckAt, lastSuccessAt, nowIso, row.srnumber);
      changes += Number(result.changes || 0);
    }
    return changes;
  }

  return {
    getFollowUp,
    observeStatus,
    queueMapStatusChange,
    scheduleAfterDetail,
    markFollowUpError,
    normalizeOpenFollowUps,
    recordClosure
  };
}

module.exports = {
  createClosureTracker,
  ensureClosureSchema,
  isClosedStatus,
  nextOpenFollowUpAt,
  statusesMatch
};
