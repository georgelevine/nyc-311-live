const crypto = require('crypto');
const {
  isClosedStatus,
  nextOpenFollowUpAt,
  statusesMatch
} = require('../closure-tracking');

const CLOSURE_RETRY_DELAYS_MS = [
  15 * 60 * 1000,
  2 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000
];

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
    agencyResponse: detail.agencyResponse || null,
    address: detail.address || null,
    nextUpdate: detail.nextUpdate || null,
    dateReported: detail.dateReported || null,
    updatedOn: detail.updatedOn || null,
    dateClosed: detail.dateClosed || null,
    fields: detail.fields || {}
  });
}

async function getFollowUp(client, srnumber, forUpdate = false) {
  const result = await client.query(
    `SELECT * FROM request_followup_queue WHERE srnumber=$1${forUpdate ? ' FOR UPDATE' : ''}`,
    [srnumber]
  );
  return result.rows[0] || null;
}

async function saveFollowUp(client, row) {
  await client.query(`
    INSERT INTO request_followup_queue (
      srnumber,portal_id,state,next_check_at,attempts,closing_attempts,closure_cycle,
      last_checked_at,last_success_at,last_error,finalized_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (srnumber) DO UPDATE SET
      portal_id=COALESCE(EXCLUDED.portal_id,request_followup_queue.portal_id),
      state=EXCLUDED.state,next_check_at=EXCLUDED.next_check_at,attempts=EXCLUDED.attempts,
      closing_attempts=EXCLUDED.closing_attempts,closure_cycle=EXCLUDED.closure_cycle,
      last_checked_at=EXCLUDED.last_checked_at,
      last_success_at=COALESCE(EXCLUDED.last_success_at,request_followup_queue.last_success_at),
      last_error=EXCLUDED.last_error,finalized_at=EXCLUDED.finalized_at,
      updated_at=EXCLUDED.updated_at
  `, [
    row.srnumber, row.portal_id || null, row.state, row.next_check_at || null,
    Number(row.attempts || 0), Number(row.closing_attempts || 0),
    Number(row.closure_cycle || 0), row.last_checked_at || null,
    row.last_success_at || null, row.last_error || null, row.finalized_at || null,
    row.updated_at
  ]);
}

async function observeStatus(client, {
  srnumber,
  previousStatus,
  status,
  source,
  observedAt,
  effectiveAt = null,
  snapshot = null
}) {
  if (!srnumber || !String(status || '').trim()) return false;
  const latest = await client.query(`
    SELECT status FROM request_status_history
    WHERE srnumber=$1 ORDER BY id DESC LIMIT 1
  `, [srnumber]);
  const comparisonStatus = latest.rowCount ? latest.rows[0].status : previousStatus;
  if (comparisonStatus != null && statusesMatch(comparisonStatus, status)) return false;
  await client.query(`
    INSERT INTO request_status_history (
      srnumber,previous_status,status,source,effective_at,observed_at,snapshot_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
  `, [
    srnumber, comparisonStatus || null, status, source, effectiveAt, observedAt,
    snapshot ? JSON.stringify(stableValue(snapshot)) : null
  ]);
  return true;
}

async function queueMapStatusChange(client, {
  srnumber,
  portalId,
  previousStatus,
  status,
  observedAt
}) {
  const changed = previousStatus == null || !statusesMatch(previousStatus, status);
  if (!changed || !status) return false;
  const existing = await getFollowUp(client, srnumber, true);
  const closing = isClosedStatus(status);
  const wasClosing = isClosedStatus(previousStatus);
  if (closing && wasClosing && existing) return false;
  const currentCycle = Math.max(0, Number(existing && existing.closure_cycle) || 0);
  const closureCycle = closing
    ? (wasClosing ? Math.max(1, currentCycle) : currentCycle + 1)
    : currentCycle;
  const provisionalOpen = !closing && previousStatus == null;
  await saveFollowUp(client, {
    srnumber,
    portal_id: portalId || (existing && existing.portal_id),
    state: closing ? 'closing' : 'open',
    next_check_at: provisionalOpen ? nextOpenFollowUpAt(new Date(observedAt)) : observedAt,
    attempts: 0,
    closing_attempts: 0,
    closure_cycle: closureCycle,
    last_checked_at: existing && iso(existing.last_checked_at),
    last_success_at: existing && iso(existing.last_success_at),
    last_error: null,
    finalized_at: null,
    updated_at: observedAt
  });
  return true;
}

async function recordClosure(client, detail, source, fetchedAt, closureCycle, isFinal, finalState = null) {
  const snapshot = closureSnapshot(detail);
  const json = JSON.stringify(snapshot);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  const result = await client.query(`
    INSERT INTO request_closure_snapshots (
      srnumber,closure_cycle,status,date_closed,source,fetched_at,is_final,
      final_state,content_hash,snapshot_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [
    detail.srnumber, closureCycle, detail.status, detail.dateClosed, source,
    fetchedAt, isFinal, finalState, hash, json
  ]);
  return result.rowCount > 0;
}

async function scheduleAfterDetail(client, {
  srnumber,
  portalId,
  effectiveStatus,
  detail,
  source,
  checkedAt
}) {
  const now = new Date(checkedAt);
  const existing = await getFollowUp(client, srnumber, true);
  const effectiveClosed = isClosedStatus(effectiveStatus) || Boolean(detail.dateClosed);
  const detailClosed = isClosedStatus(detail.status);

  if (!effectiveClosed) {
    await saveFollowUp(client, {
      srnumber,
      portal_id: portalId || (existing && existing.portal_id),
      state: 'open',
      next_check_at: nextOpenFollowUpAt(now),
      attempts: 0,
      closing_attempts: 0,
      closure_cycle: Math.max(0, Number(existing && existing.closure_cycle) || 0),
      last_checked_at: checkedAt,
      last_success_at: checkedAt,
      last_error: null,
      finalized_at: null,
      updated_at: checkedAt
    });
    return { state: 'open', finalized: false, snapshotAdded: false };
  }

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
    ? await recordClosure(client, detail, source, checkedAt, closureCycle, finalized, finalState)
    : false;
  await saveFollowUp(client, {
    srnumber,
    portal_id: portalId || (existing && existing.portal_id),
    state: finalized ? 'closed' : 'closing',
    next_check_at: finalized ? null : closureRetryAt(closingAttempts, now),
    attempts: 0,
    closing_attempts: closingAttempts,
    closure_cycle: closureCycle,
    last_checked_at: checkedAt,
    last_success_at: checkedAt,
    last_error: finalized || detailClosed
      ? null
      : 'Portal detail has not confirmed the map closure yet',
    finalized_at: finalized ? checkedAt : null,
    updated_at: checkedAt
  });
  return { state: finalized ? 'closed' : 'closing', finalized, snapshotAdded };
}

async function markFollowUpError(client, row, error, checkedAt) {
  const existing = await getFollowUp(client, row.srnumber, true) || row;
  const attempts = Math.max(0, Number(existing.attempts) || 0) + 1;
  const delay = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts - 1, 7)));
  await saveFollowUp(client, {
    srnumber: row.srnumber,
    portal_id: row.portal_id || existing.portal_id,
    state: existing.state || 'open',
    next_check_at: new Date(new Date(checkedAt).getTime() + delay).toISOString(),
    attempts,
    closing_attempts: Number(existing.closing_attempts) || 0,
    closure_cycle: Number(existing.closure_cycle) || 0,
    last_checked_at: checkedAt,
    last_success_at: iso(existing.last_success_at),
    last_error: error.message,
    finalized_at: iso(existing.finalized_at),
    updated_at: checkedAt
  });
  return delay;
}

async function normalizeOpenFollowUps(client, now = new Date()) {
  const result = await client.query(`
    SELECT * FROM request_followup_queue
    WHERE state='open' AND last_error IS NULL
    FOR UPDATE
  `);
  let changes = 0;
  for (const row of result.rows) {
    const provisional = !row.last_checked_at && !row.last_success_at;
    const anchorMs = Date.parse(iso(row.last_success_at) || iso(row.last_checked_at) || iso(row.updated_at) || '');
    const lastSuccessAt = provisional
      ? null
      : Number.isFinite(anchorMs) ? new Date(anchorMs).toISOString() : now.toISOString();
    const queuedMs = Date.parse(iso(row.next_check_at) || '');
    const desiredMs = Number.isFinite(queuedMs) && queuedMs <= now.getTime()
      ? queuedMs
      : Number.isFinite(anchorMs)
        ? Math.max(now.getTime(), anchorMs + 24 * 60 * 60 * 1000)
        : now.getTime();
    const nextCheckAt = new Date(desiredMs).toISOString();
    if (iso(row.next_check_at) === nextCheckAt && iso(row.last_success_at) === lastSuccessAt) continue;
    await client.query(`
      UPDATE request_followup_queue
      SET next_check_at=$2,last_success_at=$3,updated_at=$4 WHERE srnumber=$1
    `, [row.srnumber, nextCheckAt, lastSuccessAt, now]);
    changes += 1;
  }
  return changes;
}

module.exports = {
  closureRetryAt,
  closureSnapshot,
  getFollowUp,
  markFollowUpError,
  normalizeOpenFollowUps,
  observeStatus,
  queueMapStatusChange,
  recordClosure,
  scheduleAfterDetail,
  stableValue
};
