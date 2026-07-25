'use strict';

const cheerio = require('cheerio');
const fetch = require('node-fetch');
const {
  createRequestAlias,
  markAliasSubscribed
} = require('./nyc311-email-aliases');

const FORM_ID = '648e71af-564d-e811-a835-000d3a33b1e4';
const FORM_PATH = '/_portal/modal-form-template-path/d78574f9-20c3-4dcc-8d8d-85cf5b7ac141';
const SUBMIT_TARGET =
  'ctl00$ContentContainer$MainContent$EntityFormControl$InsertButton';
const CONTACT_NAME =
  'ctl00$ContentContainer$MainContent$EntityFormControl$EntityFormControl_EntityFormView$n311_preferredmethodofcontact';
const EMAIL_NAME =
  'ctl00$ContentContainer$MainContent$EntityFormControl$EntityFormControl_EntityFormView$n311_email';
const DEFAULT_SUBSCRIPTION_TIMEOUT_MS = 15_000;
const STALE_SUBSCRIPTION_PROCESSING_MS = 10 * 60 * 1000;

function parseBidIds(value) {
  return [...new Set(String(value || '').split(',')
    .map(item => Number(item.trim()))
    .filter(Number.isInteger))];
}

function precinctLabel(number) {
  const value = Number(number);
  const remainder100 = value % 100;
  const suffix = remainder100 >= 11 && remainder100 <= 13
    ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] || 'th');
  return `NYPD ${value}${suffix} Precinct`;
}

function modalUrl(portalId) {
  const id = String(portalId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError('portalId must be a UUID');
  const query = new URLSearchParams({
    id,
    entityformid: FORM_ID,
    languagecode: '1033',
    refentity: 'n311_nycservicerequest',
    refid: id,
    refrel: 'n311_nycservicerequest_srdistributionlist_servicerequest'
  });
  return `https://portal.311.nyc.gov${FORM_PATH}?${query}`;
}

function cookieHeader(response) {
  const values = response.headers.raw()['set-cookie'] || [];
  return values.map(value => value.split(';', 1)[0]).join('; ');
}

function formPayload(html, email) {
  const $ = cheerio.load(html);
  const fields = new URLSearchParams();
  $('input[type="hidden"][name]').each((_, input) => {
    fields.set($(input).attr('name'), $(input).attr('value') || '');
  });
  if (!fields.has('__VIEWSTATE') || !fields.has('__EVENTVALIDATION')) {
    throw new Error('NYC311 subscription form tokens were missing');
  }
  fields.set('__EVENTTARGET', SUBMIT_TARGET);
  fields.set('__EVENTARGUMENT', '');
  fields.set(CONTACT_NAME, '614110001');
  fields.set(EMAIL_NAME, email);
  return fields;
}

function subscriptionSubmitAccepted(html) {
  const $ = cheerio.load(String(html || ''));
  return $('#MessageLabel').toArray().some(element =>
    $(element).text().replace(/\s+/g, ' ').trim().toLowerCase() === 'saved'
  );
}

async function fetchTextWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    return { response, text: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

async function subscribeRequest({
  portalId,
  email,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_SUBSCRIPTION_TIMEOUT_MS
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number');
  }
  const url = modalUrl(portalId);
  const headers = {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Live/1.0)',
    Referer: `https://portal.311.nyc.gov/sr-details/?id=${portalId}`
  };
  const initialResult = await fetchTextWithTimeout(fetchImpl, url, { headers }, timeoutMs);
  const initial = initialResult.response;
  if (!initial.ok) throw new Error(`NYC311 subscription form returned HTTP ${initial.status}`);
  const body = formPayload(initialResult.text, email);
  const submittedResult = await fetchTextWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(initial)
    },
    body: body.toString()
  }, timeoutMs);
  const submitted = submittedResult.response;
  const responseText = submittedResult.text;
  if (!submitted.ok) throw new Error(`NYC311 subscription submit returned HTTP ${submitted.status}`);
  if (/already exists for this service request|already subscribed/i.test(responseText)) {
    return true;
  }
  if (/validation-summary-errors|field-validation-error/i.test(responseText)) {
    throw new Error('NYC311 rejected the subscription form');
  }
  if (!subscriptionSubmitAccepted(responseText)) {
    throw new Error('NYC311 did not confirm the subscription');
  }
  return true;
}

function enqueueBidSubscriptions(database, bidIds, {
  domain = process.env.INBOUND_EMAIL_DOMAIN,
  now = new Date()
} = {}) {
  if (!bidIds.length) return 0;
  const nowIso = now.toISOString();
  const placeholders = bidIds.map(() => '?').join(',');
  const rows = database.prepare(`
    SELECT DISTINCT request.srnumber
    FROM live_portal_requests AS request
    JOIN live_request_bid_memberships AS membership USING(srnumber)
    JOIN business_improvement_district_boundary_versions AS version
      ON version.version=membership.boundary_version AND version.active=1
    WHERE membership.bid_id IN (${placeholders})
      AND request.portal_id IS NOT NULL
  `).all(...bidIds);
  let added = 0;
  const insert = database.prepare(`
    INSERT OR IGNORE INTO nyc311_email_subscription_jobs (
      srnumber,alias_id,bid_id,state,attempts,next_attempt_at,last_error,
      created_at,updated_at,subscribed_at,scope_type,scope_id,scope_label
    )
    SELECT ?,?,?,CASE WHEN alias.state IN ('subscribed','active') THEN 'subscribed' ELSE 'pending' END,
           0,?,NULL,?,?,alias.subscribed_at,'bid',?,?
    FROM nyc311_email_aliases AS alias WHERE alias.id=?
  `);
  const findBid = database.prepare(`
    SELECT membership.bid_id
    FROM live_request_bid_memberships membership
    JOIN business_improvement_district_boundary_versions version
      ON version.version=membership.boundary_version AND version.active=1
    WHERE membership.srnumber=? AND membership.bid_id IN (${placeholders})
    ORDER BY membership.bid_id LIMIT 1
  `);
  for (const row of rows) {
    const alias = createRequestAlias(database, { srnumber: row.srnumber, domain, now });
    const bid = findBid.get(row.srnumber, ...bidIds);
    added += insert.run(
      row.srnumber, alias.id, bid.bid_id, nowIso, nowIso, nowIso,
      bid.bid_id, bid.bid_id === 68 ? 'Hudson Square BID' : `BID ${bid.bid_id}`,
      alias.id
    ).changes;
  }
  return added;
}

function enqueuePrecinctSubscriptions(database, precincts, {
  domain = process.env.INBOUND_EMAIL_DOMAIN,
  startAt,
  now = new Date()
} = {}) {
  if (!precincts.length) return 0;
  const cutoff = new Date(startAt);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error('EMAIL_PRECINCT_START_AT must be a valid timestamp');
  }
  const nowIso = now.toISOString();
  const placeholders = precincts.map(() => '?').join(',');
  const rows = database.prepare(`
    SELECT srnumber,police_precinct
    FROM live_portal_requests
    WHERE police_precinct IN (${placeholders})
      AND portal_id IS NOT NULL
      AND first_seen_at>=?
    ORDER BY suffix
  `).all(...precincts, cutoff.toISOString());
  const insert = database.prepare(`
    INSERT OR IGNORE INTO nyc311_email_subscription_jobs (
      srnumber,alias_id,bid_id,state,attempts,next_attempt_at,last_error,
      created_at,updated_at,subscribed_at,scope_type,scope_id,scope_label
    )
    SELECT ?,?,0,CASE WHEN alias.state IN ('subscribed','active') THEN 'subscribed' ELSE 'pending' END,
           0,?,NULL,?,?,alias.subscribed_at,'police_precinct',?,?
    FROM nyc311_email_aliases AS alias WHERE alias.id=?
  `);
  let added = 0;
  for (const row of rows) {
    const alias = createRequestAlias(database, { srnumber: row.srnumber, domain, now });
    added += insert.run(
      row.srnumber,
      alias.id,
      nowIso,
      nowIso,
      nowIso,
      row.police_precinct,
      precinctLabel(row.police_precinct),
      alias.id
    ).changes;
  }
  return added;
}

function enqueueAllSubscriptions(database, {
  domain = process.env.INBOUND_EMAIL_DOMAIN,
  startAt,
  now = new Date()
} = {}) {
  const cutoff = new Date(startAt);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error('EMAIL_ALL_START_AT must be a valid timestamp');
  }
  const nowIso = now.toISOString();
  const rows = database.prepare(`
    SELECT srnumber
    FROM live_portal_requests
    WHERE portal_id IS NOT NULL
      AND first_seen_at>=?
    ORDER BY suffix
  `).all(cutoff.toISOString());
  const insert = database.prepare(`
    INSERT OR IGNORE INTO nyc311_email_subscription_jobs (
      srnumber,alias_id,bid_id,state,attempts,next_attempt_at,last_error,
      created_at,updated_at,subscribed_at,scope_type,scope_id,scope_label
    )
    SELECT ?,?,0,CASE WHEN alias.state IN ('subscribed','active') THEN 'subscribed' ELSE 'pending' END,
           0,?,NULL,?,?,alias.subscribed_at,'all',0,'All NYC311'
    FROM nyc311_email_aliases AS alias WHERE alias.id=?
  `);
  let added = 0;
  for (const row of rows) {
    const alias = createRequestAlias(database, { srnumber: row.srnumber, domain, now });
    added += insert.run(
      row.srnumber,
      alias.id,
      nowIso,
      nowIso,
      nowIso,
      alias.id
    ).changes;
  }
  return added;
}

function recoverStaleProcessingSubscriptions(database, {
  now = new Date(),
  staleAfterMs = STALE_SUBSCRIPTION_PROCESSING_MS
} = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new TypeError('now must be a valid date');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new TypeError('staleAfterMs must be a nonnegative number');
  }
  const nowIso = current.toISOString();
  const staleBefore = new Date(current.getTime() - staleAfterMs).toISOString();
  return Number(database.prepare(`
    UPDATE nyc311_email_subscription_jobs
    SET state='retry',
        next_attempt_at=?,
        last_error='Recovered a stale subscription attempt',
        updated_at=?
    WHERE state='processing' AND updated_at<=?
  `).run(nowIso, nowIso, staleBefore).changes || 0);
}

function claimSubscription(database, now = new Date()) {
  const nowIso = now.toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    recoverStaleProcessingSubscriptions(database, { now });
    const row = database.prepare(`
      SELECT job.*,alias.recipient_address,request.portal_id
      FROM nyc311_email_subscription_jobs job
      JOIN nyc311_email_aliases alias ON alias.id=job.alias_id
      JOIN live_portal_requests request USING(srnumber)
      WHERE job.state IN ('pending','retry') AND job.next_attempt_at<=?
      ORDER BY job.next_attempt_at,job.created_at LIMIT 1
    `).get(nowIso);
    if (!row) {
      database.exec('COMMIT');
      return null;
    }
    const claimed = database.prepare(`
      UPDATE nyc311_email_subscription_jobs
      SET state='processing',attempts=attempts+1,updated_at=?
      WHERE srnumber=? AND state IN ('pending','retry')
    `).run(nowIso, row.srnumber);
    database.exec('COMMIT');
    return Number(claimed.changes || 0) > 0 ? row : null;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function completeSubscription(database, job, now = new Date()) {
  const nowIso = now.toISOString();
  markAliasSubscribed(database, job.recipient_address, { now });
  database.prepare(`
    UPDATE nyc311_email_subscription_jobs
    SET state='subscribed',next_attempt_at=?,last_error=NULL,
        updated_at=?,subscribed_at=? WHERE srnumber=?
  `).run(nowIso, nowIso, nowIso, job.srnumber);
}

function retrySubscription(database, job, error, now = new Date()) {
  const delayMinutes = Math.min(360, 2 ** Math.min(8, Number(job.attempts || 0)));
  const next = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
  database.prepare(`
    UPDATE nyc311_email_subscription_jobs
    SET state='retry',next_attempt_at=?,last_error=?,updated_at=? WHERE srnumber=?
  `).run(next, String(error && error.message || error).slice(0, 1000), now.toISOString(), job.srnumber);
}

module.exports = {
  claimSubscription,
  completeSubscription,
  enqueueAllSubscriptions,
  enqueueBidSubscriptions,
  enqueuePrecinctSubscriptions,
  formPayload,
  modalUrl,
  parseBidIds,
  precinctLabel,
  recoverStaleProcessingSubscriptions,
  retrySubscription,
  subscribeRequest
};
