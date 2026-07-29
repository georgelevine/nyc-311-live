const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { DatabaseSync } = require('node:sqlite');
const {
  resolveBusyTimeoutMs,
  resolveSynchronousMode
} = require('./sqlite-runtime');
const { normalizePortalTimestamp } = require('./portal-timestamp');
const { attachPortalAgencyResponse } = require('./portal-agency-response');

const LOW_SUFFIX = Number(process.env.LOW_SUFFIX);
const HIGH_SUFFIX = Number(process.env.HIGH_SUFFIX);
const MAX_PARALLEL = Math.max(1, Math.min(8, Number(process.env.MAX_PARALLEL || 2)));
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.REQUEST_DELAY_MS || 500));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.REQUEST_TIMEOUT_MS || 30000));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.MAX_ATTEMPTS || 3));
const DATABASE_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'data', 'portal-archive.sqlite');
const SQLITE_SYNCHRONOUS = resolveSynchronousMode(process.env.SQLITE_SYNCHRONOUS);
const SQLITE_BUSY_TIMEOUT_MS = resolveBusyTimeoutMs(process.env.SQLITE_BUSY_TIMEOUT_MS);

if (!Number.isInteger(LOW_SUFFIX) || !Number.isInteger(HIGH_SUFFIX) ||
    LOW_SUFFIX < 0 || HIGH_SUFFIX < LOW_SUFFIX || HIGH_SUFFIX > 99999999) {
  console.error('Set valid LOW_SUFFIX and HIGH_SUFFIX values (without the 311- prefix).');
  process.exit(1);
}

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = ${SQLITE_SYNCHRONOUS};

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

  CREATE TABLE IF NOT EXISTS number_ledger (
    suffix INTEGER PRIMARY KEY,
    srnumber TEXT NOT NULL UNIQUE,
    outcome TEXT NOT NULL CHECK (outcome IN ('found', 'not_found', 'retry')),
    attempts INTEGER NOT NULL,
    http_status INTEGER,
    error TEXT,
    checked_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS number_ledger_outcome_idx
    ON number_ledger(outcome);
`);

const ledgerStatus = db.prepare('SELECT outcome FROM number_ledger WHERE suffix = ?');
const saveLedger = db.prepare(`
  INSERT INTO number_ledger (
    suffix, srnumber, outcome, attempts, http_status, error, checked_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(suffix) DO UPDATE SET
    outcome = excluded.outcome,
    attempts = number_ledger.attempts + excluded.attempts,
    http_status = excluded.http_status,
    error = excluded.error,
    checked_at = excluded.checked_at
`);
const saveRequest = db.prepare(`
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

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function srnumber(suffix) {
  return `311-${String(suffix).padStart(8, '0')}`;
}

function parseDetail(html, expectedNumber) {
  const $ = cheerio.load(html);
  const portalId = String($('#EntityFormView_EntityID').val() || '').trim();
  const notFoundText = $('.alert, .validation-summary-errors, #MessagePanel')
    .text().replace(/\s+/g, ' ').trim();

  if (!portalId) {
    if (/didn['’]t find a Service Request with this number/i.test(notFoundText)) {
      return { outcome: 'not_found' };
    }
    return { outcome: 'retry', error: 'Portal page had neither a record nor its not-found marker' };
  }

  const fields = {};
  $('.info label').each((_, label) => {
    const name = $(label).text().replace(/\s+/g, ' ').trim();
    const field = $(label).closest('[class*="col-"]');
    const value = field.find('.control span').first().text().replace(/\s+/g, ' ').trim();
    if (name && value && value !== '-') fields[name] = value;
  });
  const agencyResponse = attachPortalAgencyResponse($, fields);

  const scripts = $('script').map((_, script) => $(script).html() || '').get().join('\n');
  const scriptDate = (id) => {
    const pattern = new RegExp(`\\$\\(["']#${id}["']\\)\\.text\\(getESTDate\\(["']([^"']+)["']\\)\\)`);
    const match = scripts.match(pattern);
    return match ? normalizePortalTimestamp(match[1]) : null;
  };
  const actualNumber = fields['SR Number'] || expectedNumber;

  return {
    outcome: 'found',
    record: {
      srnumber: actualNumber,
      portalId,
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
    }
  };
}

async function requestDetail(number) {
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://portal.311.nyc.gov/sr-details/?srnum=${number}`,
        {
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Archive/1.0)',
            Referer: 'https://portal.311.nyc.gov/check-status/'
          },
          signal: controller.signal
        }
      );
      lastStatus = response.status;
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Portal returned HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error(`Portal returned HTTP ${response.status}`);

      const parsed = parseDetail(await response.text(), number);
      if (parsed.outcome === 'retry') throw new Error(parsed.error);
      if (parsed.outcome === 'found' && parsed.record.srnumber !== number) {
        throw new Error(`Portal returned ${parsed.record.srnumber} while ${number} was requested`);
      }
      return { ...parsed, attempts: attempt, httpStatus: response.status };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(1000 * (2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    outcome: 'retry',
    attempts: MAX_ATTEMPTS,
    httpStatus: lastStatus,
    error: lastError ? lastError.message : 'unknown request failure'
  };
}

function persist(suffix, result) {
  const number = srnumber(suffix);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (result.outcome === 'found') {
      const record = result.record;
      saveRequest.run(
        record.srnumber,
        suffix,
        record.portalId,
        record.status,
        record.problem,
        record.problemDetails,
        record.additionalDetails,
        record.address,
        record.nextUpdate,
        record.dateReported,
        record.updatedOn,
        record.dateClosed,
        JSON.stringify(record.fields),
        `https://portal.311.nyc.gov/sr-details/?id=${record.portalId}`,
        now
      );
    }
    saveLedger.run(
      suffix,
      number,
      result.outcome,
      result.attempts,
      result.httpStatus,
      result.error || null,
      now
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

let nextSuffix = HIGH_SUFFIX;
let processed = 0;
let found = 0;
let notFound = 0;
let retry = 0;
let skipped = 0;
const startedAt = Date.now();

function takeNextSuffix() {
  while (nextSuffix >= LOW_SUFFIX) {
    const suffix = nextSuffix;
    nextSuffix -= 1;
    const existing = ledgerStatus.get(suffix);
    if (existing && existing.outcome !== 'retry') {
      skipped += 1;
      continue;
    }
    return suffix;
  }
  return null;
}

function logProgress(force = false) {
  if (!force && processed % 100 !== 0) return;
  const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
  const rate = processed / elapsedSeconds;
  const remaining = Math.max(0, nextSuffix - LOW_SUFFIX + 1);
  const etaHours = rate > 0 ? remaining / rate / 3600 : null;
  console.log(JSON.stringify({
    processed,
    skipped,
    found,
    not_found: notFound,
    retry,
    requests_per_second: Number(rate.toFixed(2)),
    remaining,
    eta_hours: etaHours == null ? null : Number(etaHours.toFixed(2))
  }));
}

async function worker() {
  while (true) {
    const suffix = takeNextSuffix();
    if (suffix == null) return;
    const result = await requestDetail(srnumber(suffix));
    persist(suffix, result);
    processed += 1;
    if (result.outcome === 'found') found += 1;
    else if (result.outcome === 'not_found') notFound += 1;
    else retry += 1;
    logProgress();
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }
}

async function main() {
  console.log(JSON.stringify({
    database: DATABASE_PATH,
    low_suffix: LOW_SUFFIX,
    high_suffix: HIGH_SUFFIX,
    total_suffixes: HIGH_SUFFIX - LOW_SUFFIX + 1,
    parallel: MAX_PARALLEL,
    delay_ms_per_worker: REQUEST_DELAY_MS
  }));
  await Promise.all(Array.from({ length: MAX_PARALLEL }, () => worker()));
  logProgress(true);
  const unresolved = db.prepare("SELECT COUNT(*) AS count FROM number_ledger WHERE outcome = 'retry'").get().count;
  console.log(JSON.stringify({ complete: unresolved === 0, unresolved }));
}

main()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
