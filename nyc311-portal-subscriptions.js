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

function parseBidIds(value) {
  return [...new Set(String(value || '').split(',')
    .map(item => Number(item.trim()))
    .filter(Number.isInteger))];
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

async function subscribeRequest({ portalId, email, fetchImpl = fetch }) {
  const url = modalUrl(portalId);
  const headers = {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Live/1.0)',
    Referer: `https://portal.311.nyc.gov/sr-details/?id=${portalId}`
  };
  const initial = await fetchImpl(url, { headers });
  if (!initial.ok) throw new Error(`NYC311 subscription form returned HTTP ${initial.status}`);
  const body = formPayload(await initial.text(), email);
  const submitted = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(initial)
    },
    body: body.toString()
  });
  const responseText = await submitted.text();
  if (!submitted.ok) throw new Error(`NYC311 subscription submit returned HTTP ${submitted.status}`);
  if (/validation-summary-errors|field-validation-error/i.test(responseText)
      || /already exists for this service request/i.test(responseText)) {
    throw new Error('NYC311 rejected the subscription form');
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
      created_at,updated_at,subscribed_at
    )
    SELECT ?,?,?,CASE WHEN alias.state IN ('subscribed','active') THEN 'subscribed' ELSE 'pending' END,
           0,?,NULL,?,?,alias.subscribed_at
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
      row.srnumber, alias.id, bid.bid_id, nowIso, nowIso, nowIso, alias.id
    ).changes;
  }
  return added;
}

function claimSubscription(database, now = new Date()) {
  const row = database.prepare(`
    SELECT job.*,alias.recipient_address,request.portal_id
    FROM nyc311_email_subscription_jobs job
    JOIN nyc311_email_aliases alias ON alias.id=job.alias_id
    JOIN live_portal_requests request USING(srnumber)
    WHERE job.state IN ('pending','retry') AND job.next_attempt_at<=?
    ORDER BY job.next_attempt_at,job.created_at LIMIT 1
  `).get(now.toISOString());
  if (!row) return null;
  database.prepare(`
    UPDATE nyc311_email_subscription_jobs
    SET state='processing',attempts=attempts+1,updated_at=? WHERE srnumber=?
  `).run(now.toISOString(), row.srnumber);
  return row;
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
  enqueueBidSubscriptions,
  formPayload,
  modalUrl,
  parseBidIds,
  retrySubscription,
  subscribeRequest
};
