'use strict';

const crypto = require('crypto');
const fetch = require('node-fetch');

function enqueueInitialAlerts(database, bidIds, now = new Date()) {
  if (!bidIds.length) return 0;
  const placeholders = bidIds.map(() => '?').join(',');
  const nowIso = now.toISOString();
  return database.prepare(`
    INSERT OR IGNORE INTO nyc311_initial_email_jobs (
      srnumber,bid_id,state,attempts,next_attempt_at,last_error,created_at,updated_at,sent_at
    )
    SELECT subscription.srnumber,subscription.bid_id,'pending',0,?,NULL,?,?,NULL
    FROM nyc311_email_subscription_jobs subscription
    JOIN portal_requests detail USING(srnumber)
    WHERE subscription.bid_id IN (${placeholders})
      AND subscription.state='subscribed'
    ORDER BY subscription.created_at
  `).run(nowIso, nowIso, nowIso, ...bidIds).changes;
}

function claimInitialAlert(database, now = new Date()) {
  const row = database.prepare(`
    SELECT job.*,live.problem AS map_problem,live.address AS map_address,
           live.status AS live_status,live.portal_url,
           detail.problem,detail.problem_details,detail.additional_details,
           detail.address,detail.status,detail.next_update,detail.date_reported,
           detail.updated_on,detail.date_closed
    FROM nyc311_initial_email_jobs job
    JOIN live_portal_requests live USING(srnumber)
    JOIN portal_requests detail USING(srnumber)
    WHERE job.state IN ('pending','retry') AND job.next_attempt_at<=?
    ORDER BY job.next_attempt_at,job.created_at LIMIT 1
  `).get(now.toISOString());
  if (!row) return null;
  database.prepare(`
    UPDATE nyc311_initial_email_jobs
    SET state='processing',attempts=attempts+1,updated_at=? WHERE srnumber=?
  `).run(now.toISOString(), row.srnumber);
  return row;
}

function initialPayload(row) {
  return {
    kind: 'initial_request',
    srnumber: row.srnumber,
    bid_id: row.bid_id,
    problem: row.problem || row.map_problem || null,
    problem_details: row.problem_details || null,
    additional_details: row.additional_details || null,
    address: row.address || row.map_address || null,
    status: row.status || row.live_status || null,
    submitted_at: row.date_reported || null,
    updated_at: row.updated_on || null,
    closed_at: row.date_closed || null,
    next_update: row.next_update || null,
    portal_url: row.portal_url || null
  };
}

async function sendInitialAlert(row, {
  endpoint = process.env.INITIAL_EMAIL_ENDPOINT,
  secret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET,
  fetchImpl = fetch,
  now = new Date()
} = {}) {
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    throw new Error('INITIAL_EMAIL_ENDPOINT must be an HTTPS URL');
  }
  if (!secret) throw new Error('INBOUND_EMAIL_WEBHOOK_SECRET is required');
  const body = JSON.stringify(initialPayload(row));
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const signature = crypto.createHmac('sha256', secret)
    .update(`v1\n${timestamp}\n${body}`, 'utf8')
    .digest('hex');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      'content-type': 'application/json',
      'x-nyc311-alert-timestamp': timestamp,
      'x-nyc311-alert-signature': `v1=${signature}`
    },
    body
  });
  if (!response.ok) {
    throw new Error(`Initial email endpoint returned HTTP ${response.status}`);
  }
}

function completeInitialAlert(database, row, now = new Date()) {
  const nowIso = now.toISOString();
  database.prepare(`
    UPDATE nyc311_initial_email_jobs
    SET state='sent',last_error=NULL,updated_at=?,sent_at=? WHERE srnumber=?
  `).run(nowIso, nowIso, row.srnumber);
}

function retryInitialAlert(database, row, error, now = new Date()) {
  const delayMinutes = Math.min(360, 2 ** Math.min(8, Number(row.attempts || 0)));
  const next = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
  database.prepare(`
    UPDATE nyc311_initial_email_jobs
    SET state='retry',next_attempt_at=?,last_error=?,updated_at=? WHERE srnumber=?
  `).run(next, String(error && error.message || error).slice(0, 1000), now.toISOString(), row.srnumber);
}

module.exports = {
  claimInitialAlert,
  completeInitialAlert,
  enqueueInitialAlerts,
  initialPayload,
  retryInitialAlert,
  sendInitialAlert
};
