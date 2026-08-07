#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const fetch = require('node-fetch');
const { DatabaseSync } = require('node:sqlite');
const { parseDetail } = require('../cloud/portal');
const { geographyFromPortalAddress, ensureSqliteRequestGeography } = require('../address-geography');
const { ensureSqliteBusinessImprovementDistrictSchema } = require('../business-improvement-districts');
const { resolveBusyTimeoutMs, resolveSynchronousMode } = require('../sqlite-runtime');

const DEFAULT_INPUT = path.resolve(
  'exports',
  'sr-bid-records-with-coordinates-2026-01-01-to-2026-08-04.csv'
);
const EXPECTED_HEADERS = Object.freeze([
  'SR Number',
  'BID ID',
  'BID Name',
  'Borough',
  'Submitted At',
  'Latitude',
  'Longitude',
  'Problem',
  'Status',
  'Address',
  'Portal URL',
  'Boundary Version'
]);
const TERMINAL_STATES = Object.freeze(['succeeded', 'failed']);

function usage() {
  return `Usage: node scripts/backfill-sr-list.js [options]

Imports the authoritative BID/SR export into the SQLite archive, then fetches
the NYC311 Portal detail page for each missing request. The work queue and
retry state live in SQLite, so the same command can safely be restarted.

Options:
  --input PATH          Source CSV (default: exports/sr-bid-records-with-coordinates-2026-01-01-to-2026-08-04.csv)
  --db PATH             SQLite archive (default: DATABASE_PATH or data/portal-archive.sqlite)
  --concurrency N       Simultaneous Portal requests, 1-8 (default: 2)
  --delay-ms N          Delay after each Portal request per worker (default: 500)
  --request-timeout N   Per-request timeout in milliseconds (default: 30000)
  --max-attempts N      Attempts before an item becomes failed (default: 4)
  --retry-base-ms N     Exponential retry base delay (default: 5000)
  --limit N             Stop after N Portal requests; useful for benchmarking
  --progress-every N    Emit JSON progress every N Portal requests (default: 100)
  --import-batch-size N Commit imported records in batches (default: 500)
  --refresh-existing    Fetch details even when portal_requests already has the SR
  --prepare-only        Validate/import/checkpoint without calling the Portal
  --validate-only       Validate the CSV and manifest without changing SQLite
  --help                Show this message
`;
}

function integerOption(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

function parseArguments(argv, env = process.env) {
  const options = {
    input: DEFAULT_INPUT,
    databasePath: path.resolve(env.DATABASE_PATH || 'data/portal-archive.sqlite'),
    concurrency: 2,
    delayMs: 500,
    requestTimeoutMs: 30_000,
    maxAttempts: 4,
    retryBaseMs: 5_000,
    limit: null,
    progressEvery: 100,
    importBatchSize: 500,
    refreshExisting: false,
    prepareOnly: false,
    validateOnly: false,
    help: false
  };
  const valueOptions = new Map([
    ['--input', 'input'],
    ['--db', 'databasePath'],
    ['--concurrency', 'concurrency'],
    ['--delay-ms', 'delayMs'],
    ['--request-timeout', 'requestTimeoutMs'],
    ['--max-attempts', 'maxAttempts'],
    ['--retry-base-ms', 'retryBaseMs'],
    ['--limit', 'limit'],
    ['--progress-every', 'progressEvery'],
    ['--import-batch-size', 'importBatchSize']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--refresh-existing') options.refreshExisting = true;
    else if (argument === '--prepare-only') options.prepareOnly = true;
    else if (argument === '--validate-only') options.validateOnly = true;
    else {
      const key = valueOptions.get(argument);
      if (!key || index + 1 >= argv.length) {
        throw new Error(`Unknown or incomplete option: ${argument}`);
      }
      options[key] = argv[++index];
    }
  }
  options.input = path.resolve(options.input);
  options.databasePath = path.resolve(options.databasePath);
  options.concurrency = integerOption(options.concurrency, '--concurrency', {
    minimum: 1,
    maximum: 8
  });
  options.delayMs = integerOption(options.delayMs, '--delay-ms', { maximum: 60_000 });
  options.requestTimeoutMs = integerOption(options.requestTimeoutMs, '--request-timeout', {
    minimum: 5_000,
    maximum: 120_000
  });
  options.maxAttempts = integerOption(options.maxAttempts, '--max-attempts', {
    minimum: 1,
    maximum: 20
  });
  options.retryBaseMs = integerOption(options.retryBaseMs, '--retry-base-ms', {
    minimum: 100,
    maximum: 3_600_000
  });
  if (options.limit != null) {
    options.limit = integerOption(options.limit, '--limit', { minimum: 1 });
  }
  options.progressEvery = integerOption(options.progressEvery, '--progress-every', {
    minimum: 1,
    maximum: 1_000_000
  });
  options.importBatchSize = integerOption(options.importBatchSize, '--import-batch-size', {
    minimum: 1,
    maximum: 10_000
  });
  if (options.prepareOnly && options.validateOnly) {
    throw new Error('--prepare-only and --validate-only are mutually exclusive');
  }
  return options;
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('CSV row contains an unterminated quoted value');
  values.push(value);
  return values;
}

function textOrNull(value) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function parsePortalId(portalUrl) {
  if (!portalUrl) return null;
  try {
    return textOrNull(new URL(portalUrl).searchParams.get('id'));
  } catch (_) {
    return null;
  }
}

function normalizedTimestamp(value, label, lineNumber) {
  const text = textOrNull(value);
  if (!text) return null;
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`Line ${lineNumber}: ${label} is not a valid timestamp`);
  }
  return timestamp.toISOString();
}

function normalizeSourceRow(values, lineNumber) {
  if (values.length !== EXPECTED_HEADERS.length) {
    throw new Error(
      `Line ${lineNumber}: expected ${EXPECTED_HEADERS.length} columns, found ${values.length}`
    );
  }
  const [
    srnumber, bidIdValue, bidName, borough, submittedAt, latitudeValue,
    longitudeValue, problem, status, address, portalUrl, boundaryVersion
  ] = values.map(value => String(value == null ? '' : value).trim());
  const match = srnumber.match(/^311-(\d{8})$/);
  if (!match) throw new Error(`Line ${lineNumber}: invalid SR Number ${srnumber || '(empty)'}`);
  const bidId = Number(bidIdValue);
  if (!Number.isInteger(bidId) || bidId < 1) {
    throw new Error(`Line ${lineNumber}: invalid BID ID ${bidIdValue || '(empty)'}`);
  }
  if (!bidName) throw new Error(`Line ${lineNumber}: BID Name is empty`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(boundaryVersion)) {
    throw new Error(`Line ${lineNumber}: invalid Boundary Version ${boundaryVersion || '(empty)'}`);
  }
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < 39.5 || latitude > 41.5 || longitude < -75 || longitude > -73) {
    throw new Error(`Line ${lineNumber}: coordinates are outside the expected NYC area`);
  }
  const canonicalPortalUrl = textOrNull(portalUrl);
  if (canonicalPortalUrl) {
    let parsed;
    try {
      parsed = new URL(canonicalPortalUrl);
    } catch (_) {
      throw new Error(`Line ${lineNumber}: Portal URL is invalid`);
    }
    if (parsed.hostname !== 'portal.311.nyc.gov' || parsed.pathname !== '/sr-details/') {
      throw new Error(`Line ${lineNumber}: Portal URL is not an NYC311 detail URL`);
    }
  }
  const parsedGeography = geographyFromPortalAddress(address);
  return {
    srnumber,
    suffix: Number(match[1]),
    portalId: parsePortalId(canonicalPortalUrl),
    bidId,
    bidName,
    borough: textOrNull(borough) || parsedGeography.borough,
    incidentZip: parsedGeography.incident_zip,
    submittedAt: normalizedTimestamp(submittedAt, 'Submitted At', lineNumber),
    latitude,
    longitude,
    problem: textOrNull(problem),
    status: textOrNull(status),
    address: textOrNull(address),
    portalUrl: canonicalPortalUrl,
    boundaryVersion
  };
}

function recordFingerprint(row) {
  return JSON.stringify([
    row.suffix,
    row.portalId,
    row.borough,
    row.incidentZip,
    row.submittedAt,
    row.latitude,
    row.longitude,
    row.problem,
    row.status,
    row.address,
    row.portalUrl,
    row.boundaryVersion
  ]);
}

async function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filename);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function manifestPathFor(inputPath) {
  return inputPath.replace(/\.csv$/i, '') + '.manifest.json';
}

function loadManifest(inputPath) {
  const filename = manifestPathFor(inputPath);
  if (!fs.existsSync(filename)) return { filename: null, manifest: null };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse manifest ${filename}: ${error.message}`);
  }
  return { filename, manifest };
}

async function visitCsvRows(inputPath, visitor) {
  const input = fs.createReadStream(inputPath);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      const headers = parseCsvLine(line);
      if (headers.length !== EXPECTED_HEADERS.length
          || headers.some((header, index) => header !== EXPECTED_HEADERS[index])) {
        throw new Error(
          `CSV header does not match the expected export schema: ${EXPECTED_HEADERS.join(', ')}`
        );
      }
      continue;
    }
    if (!line.trim()) continue;
    await visitor(normalizeSourceRow(parseCsvLine(line), lineNumber), lineNumber);
  }
  if (lineNumber === 0) throw new Error('CSV is empty');
}

async function validateSource(inputPath, { digest = null } = {}) {
  const sourceSha256 = digest || await sha256File(inputPath);
  const { filename: manifestFilename, manifest } = loadManifest(inputPath);
  const bidReferences = new Map();
  let membershipRows = 0;
  let uniqueSrNumbers = 0;
  let duplicateMemberships = 0;
  let multiBidSrNumbers = 0;
  let previous = null;
  let previousFingerprint = null;
  let currentBidIds = new Set();
  const finishPrevious = () => {
    if (currentBidIds.size > 1) multiBidSrNumbers += 1;
  };
  await visitCsvRows(inputPath, row => {
    membershipRows += 1;
    if (previous && row.srnumber < previous.srnumber) {
      throw new Error(
        `CSV must be sorted by SR Number; ${row.srnumber} appears after ${previous.srnumber}`
      );
    }
    if (!previous || row.srnumber !== previous.srnumber) {
      finishPrevious();
      uniqueSrNumbers += 1;
      previous = row;
      previousFingerprint = recordFingerprint(row);
      currentBidIds = new Set();
    } else if (recordFingerprint(row) !== previousFingerprint) {
      throw new Error(`Conflicting map fields for duplicate request ${row.srnumber}`);
    }
    const membershipKey = `${row.boundaryVersion}:${row.bidId}`;
    if (currentBidIds.has(membershipKey)) duplicateMemberships += 1;
    currentBidIds.add(membershipKey);
    if (!bidReferences.has(row.boundaryVersion)) {
      bidReferences.set(row.boundaryVersion, new Set());
    }
    bidReferences.get(row.boundaryVersion).add(row.bidId);
  });
  finishPrevious();
  if (!membershipRows) throw new Error('CSV contains no data rows');

  if (manifest) {
    if (manifest.csv_sha256 && manifest.csv_sha256 !== sourceSha256) {
      throw new Error(
        `CSV SHA-256 does not match its manifest: expected ${manifest.csv_sha256}, received ${sourceSha256}`
      );
    }
    if (manifest.membership_rows != null
        && Number(manifest.membership_rows) !== membershipRows) {
      throw new Error(
        `Manifest expected ${manifest.membership_rows} membership rows; found ${membershipRows}`
      );
    }
    if (manifest.unique_sr_numbers != null
        && Number(manifest.unique_sr_numbers) !== uniqueSrNumbers) {
      throw new Error(
        `Manifest expected ${manifest.unique_sr_numbers} unique SRs; found ${uniqueSrNumbers}`
      );
    }
    if (manifest.boundary_version
        && !bidReferences.has(String(manifest.boundary_version))) {
      throw new Error(`Manifest boundary version ${manifest.boundary_version} is absent from the CSV`);
    }
  }
  return {
    sourceSha256,
    sourceName: path.basename(inputPath),
    manifestFilename,
    manifest,
    membershipRows,
    uniqueSrNumbers,
    duplicateMemberships,
    deduplicatedRows: membershipRows - uniqueSrNumbers,
    multiBidSrNumbers,
    bidReferences
  };
}

function ensureBackfillSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sr_list_backfill_runs (
      run_id TEXT PRIMARY KEY,
      source_sha256 TEXT NOT NULL,
      source_name TEXT NOT NULL,
      refresh_existing INTEGER NOT NULL DEFAULT 0 CHECK(refresh_existing IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('preparing','ready','running','paused','completed','failed')),
      membership_rows INTEGER NOT NULL,
      total_requests INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS sr_list_backfill_items (
      run_id TEXT NOT NULL,
      srnumber TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','working','retry','succeeded','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      http_status INTEGER,
      last_error TEXT,
      duration_ms INTEGER,
      result_source TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id,srnumber),
      FOREIGN KEY(run_id) REFERENCES sr_list_backfill_runs(run_id) ON DELETE CASCADE,
      FOREIGN KEY(srnumber) REFERENCES live_portal_requests(srnumber) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS sr_list_backfill_items_due_idx
      ON sr_list_backfill_items(run_id,state,next_attempt_at,ordinal);
  `);
}

function assertDatabaseContract(database) {
  const required = [
    'live_portal_requests',
    'portal_requests',
    'live_detail_queue',
    'number_ledger',
    'live_monitor_state'
  ];
  const missing = required.filter(table => !database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table));
  if (missing.length) {
    throw new Error(`SQLite archive is missing required tables: ${missing.join(', ')}`);
  }
}

function runIdFor(sourceSha256, refreshExisting) {
  return crypto.createHash('sha256')
    .update(`${sourceSha256}\nrefresh_existing=${refreshExisting ? 1 : 0}`)
    .digest('hex')
    .slice(0, 24);
}

function validateBoundaryReferences(database, bidReferences) {
  const findBid = database.prepare(`
    SELECT name FROM business_improvement_districts
    WHERE boundary_version=? AND bid_id=?
  `);
  const missing = [];
  for (const [version, bidIds] of bidReferences) {
    for (const bidId of bidIds) {
      if (!findBid.get(version, bidId)) missing.push(`${version}:${bidId}`);
    }
  }
  if (missing.length) {
    throw new Error(
      `SQLite is missing ${missing.length} referenced BID boundaries (first: ${missing.slice(0, 10).join(', ')})`
    );
  }
}

function sourceRawJson(row, sourceObservedAt) {
  return JSON.stringify({
    id: row.portalId,
    label: row.problem,
    sublabel: row.address,
    latitude: String(row.latitude),
    longitude: String(row.longitude),
    data: {
      srnumber: row.srnumber,
      problem: row.problem,
      address: row.address,
      submitteddate: row.submittedAt,
      status: row.status
    },
    backfill: {
      source: 'historical_bid_portal_export',
      observed_at: sourceObservedAt,
      boundary_version: row.boundaryVersion
    }
  });
}

function createImportStatements(database) {
  return {
    upsertLive: database.prepare(`
      INSERT INTO live_portal_requests (
        srnumber,suffix,portal_id,problem,address,borough,incident_zip,
        business_improvement_district_boundary_version,
        business_improvement_district_matched_at,
        latitude,longitude,submitted_at,status,portal_url,
        first_seen_at,last_seen_at,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(srnumber) DO UPDATE SET
        suffix=COALESCE(live_portal_requests.suffix,excluded.suffix),
        portal_id=COALESCE(live_portal_requests.portal_id,excluded.portal_id),
        problem=CASE WHEN excluded.last_seen_at>=live_portal_requests.last_seen_at
          THEN COALESCE(excluded.problem,live_portal_requests.problem)
          ELSE COALESCE(live_portal_requests.problem,excluded.problem) END,
        address=CASE WHEN excluded.last_seen_at>=live_portal_requests.last_seen_at
          THEN COALESCE(excluded.address,live_portal_requests.address)
          ELSE COALESCE(live_portal_requests.address,excluded.address) END,
        borough=COALESCE(live_portal_requests.borough,excluded.borough),
        incident_zip=COALESCE(live_portal_requests.incident_zip,excluded.incident_zip),
        business_improvement_district_boundary_version=COALESCE(
          live_portal_requests.business_improvement_district_boundary_version,
          excluded.business_improvement_district_boundary_version
        ),
        business_improvement_district_matched_at=CASE
          WHEN live_portal_requests.business_improvement_district_boundary_version IS NULL
            OR live_portal_requests.business_improvement_district_boundary_version=
               excluded.business_improvement_district_boundary_version
          THEN excluded.business_improvement_district_matched_at
          ELSE live_portal_requests.business_improvement_district_matched_at END,
        latitude=CASE WHEN excluded.last_seen_at>=live_portal_requests.last_seen_at
          THEN COALESCE(excluded.latitude,live_portal_requests.latitude)
          ELSE COALESCE(live_portal_requests.latitude,excluded.latitude) END,
        longitude=CASE WHEN excluded.last_seen_at>=live_portal_requests.last_seen_at
          THEN COALESCE(excluded.longitude,live_portal_requests.longitude)
          ELSE COALESCE(live_portal_requests.longitude,excluded.longitude) END,
        submitted_at=COALESCE(live_portal_requests.submitted_at,excluded.submitted_at),
        status=CASE WHEN excluded.last_seen_at>=live_portal_requests.last_seen_at
          THEN COALESCE(excluded.status,live_portal_requests.status)
          ELSE COALESCE(live_portal_requests.status,excluded.status) END,
        portal_url=COALESCE(live_portal_requests.portal_url,excluded.portal_url),
        first_seen_at=MIN(live_portal_requests.first_seen_at,excluded.first_seen_at),
        last_seen_at=MAX(live_portal_requests.last_seen_at,excluded.last_seen_at),
        raw_json=CASE WHEN excluded.last_seen_at>=live_portal_requests.last_seen_at
          THEN excluded.raw_json ELSE live_portal_requests.raw_json END
    `),
    clearMemberships: database.prepare(`
      DELETE FROM live_request_bid_memberships WHERE srnumber=? AND boundary_version=?
    `),
    insertMembership: database.prepare(`
      INSERT OR IGNORE INTO live_request_bid_memberships(
        srnumber,boundary_version,bid_id,matched_at
      ) VALUES (?,?,?,?)
    `),
    stageAssignment: database.prepare(`
      INSERT INTO live_request_bid_assignment_versions(
        srnumber,boundary_version,matched_at,latitude,longitude
      ) VALUES (?,?,?,?,?)
      ON CONFLICT(srnumber,boundary_version) DO UPDATE SET
        matched_at=excluded.matched_at,
        latitude=excluded.latitude,
        longitude=excluded.longitude
    `),
    saveLedger: database.prepare(`
      INSERT INTO number_ledger(
        suffix,srnumber,outcome,attempts,http_status,error,checked_at
      ) VALUES (?,?,'found',0,200,NULL,?)
      ON CONFLICT(suffix) DO UPDATE SET
        srnumber=excluded.srnumber,
        outcome='found',
        http_status=200,
        error=NULL,
        checked_at=MAX(number_ledger.checked_at,excluded.checked_at)
    `),
    insertItem: database.prepare(`
      INSERT INTO sr_list_backfill_items(
        run_id,srnumber,ordinal,state,attempts,next_attempt_at,
        completed_at,result_source,updated_at
      ) SELECT ?,?,?,
          CASE WHEN ?=0 AND EXISTS(
            SELECT 1 FROM portal_requests WHERE srnumber=?
          ) THEN 'succeeded' ELSE 'pending' END,
          0,?,
          CASE WHEN ?=0 AND EXISTS(
            SELECT 1 FROM portal_requests WHERE srnumber=?
          ) THEN ? ELSE NULL END,
          CASE WHEN ?=0 AND EXISTS(
            SELECT 1 FROM portal_requests WHERE srnumber=?
          ) THEN 'existing_database' ELSE NULL END,
          ?
      ON CONFLICT(run_id,srnumber) DO NOTHING
    `)
  };
}

async function importSource(database, options, validation, {
  now = () => new Date()
} = {}) {
  ensureSqliteRequestGeography(database);
  ensureSqliteBusinessImprovementDistrictSchema(database);
  ensureBackfillSchema(database);
  validateBoundaryReferences(database, validation.bidReferences);
  const runId = runIdFor(validation.sourceSha256, options.refreshExisting);
  const preparedAt = now().toISOString();
  const sourceObservedAt = validation.manifest && validation.manifest.created_at
    ? new Date(validation.manifest.created_at).toISOString()
    : preparedAt;
  database.prepare(`
    INSERT INTO sr_list_backfill_runs(
      run_id,source_sha256,source_name,refresh_existing,status,
      membership_rows,total_requests,created_at,updated_at
    ) VALUES (?,?,?,?, 'preparing',?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET
      status=CASE WHEN sr_list_backfill_runs.status='completed'
        THEN 'completed' ELSE 'preparing' END,
      updated_at=excluded.updated_at,
      last_error=NULL
  `).run(
    runId,
    validation.sourceSha256,
    validation.sourceName,
    options.refreshExisting ? 1 : 0,
    validation.membershipRows,
    validation.uniqueSrNumbers,
    preparedAt,
    preparedAt
  );
  const statements = createImportStatements(database);
  let previousSrnumber = null;
  let ordinal = 0;
  let transactionOpen = false;
  const begin = () => {
    if (!transactionOpen) {
      database.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
    }
  };
  const commit = () => {
    if (transactionOpen) {
      database.exec('COMMIT');
      transactionOpen = false;
    }
  };
  begin();
  try {
    await visitCsvRows(options.input, row => {
      if (row.srnumber !== previousSrnumber) {
        if (ordinal > 0 && ordinal % options.importBatchSize === 0) {
          commit();
          begin();
        }
        ordinal += 1;
        previousSrnumber = row.srnumber;
        statements.upsertLive.run(
          row.srnumber,
          row.suffix,
          row.portalId,
          row.problem,
          row.address,
          row.borough,
          row.incidentZip,
          row.boundaryVersion,
          sourceObservedAt,
          row.latitude,
          row.longitude,
          row.submittedAt,
          row.status,
          row.portalUrl,
          sourceObservedAt,
          sourceObservedAt,
          sourceRawJson(row, sourceObservedAt)
        );
        statements.clearMemberships.run(row.srnumber, row.boundaryVersion);
        statements.stageAssignment.run(
          row.srnumber,
          row.boundaryVersion,
          sourceObservedAt,
          row.latitude,
          row.longitude
        );
        statements.saveLedger.run(row.suffix, row.srnumber, sourceObservedAt);
        statements.insertItem.run(
          runId,
          row.srnumber,
          ordinal,
          options.refreshExisting ? 1 : 0,
          row.srnumber,
          preparedAt,
          options.refreshExisting ? 1 : 0,
          row.srnumber,
          preparedAt,
          options.refreshExisting ? 1 : 0,
          row.srnumber,
          preparedAt
        );
      }
      statements.insertMembership.run(
        row.srnumber,
        row.boundaryVersion,
        row.bidId,
        sourceObservedAt
      );
    });
    commit();
  } catch (error) {
    if (transactionOpen) database.exec('ROLLBACK');
    database.prepare(`
      UPDATE sr_list_backfill_runs
      SET status='failed',last_error=?,updated_at=? WHERE run_id=?
    `).run(error.message, now().toISOString(), runId);
    throw error;
  }
  if (ordinal !== validation.uniqueSrNumbers) {
    throw new Error(
      `Imported ${ordinal} unique SRs after validation counted ${validation.uniqueSrNumbers}`
    );
  }
  database.prepare(`
    UPDATE sr_list_backfill_runs SET status='ready',updated_at=?
    WHERE run_id=? AND status<>'completed'
  `).run(now().toISOString(), runId);
  return { runId, sourceObservedAt, importedRequests: ordinal };
}

function prepareQueueStatements(database) {
  return {
    stale: database.prepare(`
      UPDATE sr_list_backfill_items
      SET state='retry',next_attempt_at=?,claimed_at=NULL,
          last_error=COALESCE(last_error,'Recovered after interrupted process'),updated_at=?
      WHERE run_id=? AND state='working'
    `),
    next: database.prepare(`
      SELECT item.srnumber,item.attempts,live.portal_id,live.portal_url
      FROM sr_list_backfill_items AS item
      JOIN live_portal_requests AS live ON live.srnumber=item.srnumber
      WHERE item.run_id=? AND item.state IN ('pending','retry')
        AND item.next_attempt_at<=?
      ORDER BY item.ordinal
      LIMIT 1
    `),
    claim: database.prepare(`
      UPDATE sr_list_backfill_items
      SET state='working',attempts=attempts+1,claimed_at=?,updated_at=?
      WHERE run_id=? AND srnumber=? AND state IN ('pending','retry')
    `),
    queueWorking: database.prepare(`
      INSERT INTO live_detail_queue(
        srnumber,portal_id,status,attempts,next_attempt_at,last_error,updated_at
      ) VALUES (?,?,'working',0,?,NULL,?)
      ON CONFLICT(srnumber) DO UPDATE SET
        portal_id=COALESCE(live_detail_queue.portal_id,excluded.portal_id),
        status=CASE WHEN live_detail_queue.status='found'
          THEN 'found' ELSE 'working' END,
        updated_at=excluded.updated_at
    `),
    earliestRetry: database.prepare(`
      SELECT MIN(next_attempt_at) AS next_attempt_at
      FROM sr_list_backfill_items
      WHERE run_id=? AND state='retry'
    `)
  };
}

function resetStaleWork(database, runId, timestamp) {
  const recoveredWorking = Number(
    prepareQueueStatements(database).stale.run(timestamp, timestamp, runId).changes || 0
  );
  // A terminal failure is terminal for one invocation, not forever. Restarting
  // the same run deliberately gives failed rows a fresh retry budget.
  const recoveredFailed = Number(database.prepare(`
    UPDATE sr_list_backfill_items
    SET state='retry',attempts=0,next_attempt_at=?,claimed_at=NULL,
        completed_at=NULL,updated_at=?
    WHERE run_id=? AND state='failed'
  `).run(timestamp, timestamp, runId).changes || 0);
  return { recoveredWorking, recoveredFailed };
}

function reconcileStoredDetails(database, runId, timestamp) {
  const run = database.prepare(`
    SELECT refresh_existing FROM sr_list_backfill_runs WHERE run_id=?
  `).get(runId);
  if (!run) throw new Error(`Unknown SR-list backfill run ${runId}`);
  if (Number(run.refresh_existing)) return 0;
  return Number(database.prepare(`
    UPDATE sr_list_backfill_items
    SET state='succeeded',completed_at=COALESCE(completed_at,?),
        result_source='existing_database',last_error=NULL,updated_at=?
    WHERE run_id=? AND state<>'succeeded'
      AND EXISTS (
        SELECT 1 FROM portal_requests
        WHERE portal_requests.srnumber=sr_list_backfill_items.srnumber
      )
  `).run(timestamp, timestamp, runId).changes || 0);
}

function claimNext(database, statements, runId, timestamp) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const item = statements.next.get(runId, timestamp);
    if (!item) {
      database.exec('COMMIT');
      return null;
    }
    const claimed = statements.claim.run(timestamp, timestamp, runId, item.srnumber);
    if (!Number(claimed.changes || 0)) {
      database.exec('ROLLBACK');
      return null;
    }
    statements.queueWorking.run(item.srnumber, item.portal_id, timestamp, timestamp);
    database.exec('COMMIT');
    return { ...item, attempts: Number(item.attempts) + 1 };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function effectiveStatus(record) {
  if (record.dateClosed && !/^closed$/i.test(String(record.status || '').trim())) return 'Closed';
  return record.status || null;
}

function saveDetail(database, runId, item, result, completedAt, durationMs) {
  const record = result.record;
  const status = effectiveStatus(record);
  const portalUrl = record.portalId
    ? `https://portal.311.nyc.gov/sr-details/?id=${record.portalId}`
    : `https://portal.311.nyc.gov/sr-details/?srnum=${encodeURIComponent(record.srnumber)}`;
  const geography = geographyFromPortalAddress(record.address);
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      INSERT INTO portal_requests(
        srnumber,suffix,portal_id,status,problem,problem_details,
        additional_details,address,next_update,date_reported,updated_on,
        date_closed,fields_json,portal_url,archived_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(srnumber) DO UPDATE SET
        portal_id=COALESCE(excluded.portal_id,portal_requests.portal_id),
        status=CASE
          WHEN portal_requests.date_closed IS NOT NULL AND excluded.date_closed IS NULL
            THEN portal_requests.status
          ELSE COALESCE(excluded.status,portal_requests.status) END,
        problem=COALESCE(excluded.problem,portal_requests.problem),
        problem_details=COALESCE(excluded.problem_details,portal_requests.problem_details),
        additional_details=COALESCE(excluded.additional_details,portal_requests.additional_details),
        address=COALESCE(excluded.address,portal_requests.address),
        next_update=COALESCE(excluded.next_update,portal_requests.next_update),
        date_reported=COALESCE(excluded.date_reported,portal_requests.date_reported),
        updated_on=COALESCE(excluded.updated_on,portal_requests.updated_on),
        date_closed=COALESCE(excluded.date_closed,portal_requests.date_closed),
        fields_json=json_patch(
          COALESCE(portal_requests.fields_json,'{}'),
          COALESCE(excluded.fields_json,'{}')
        ),
        portal_url=COALESCE(excluded.portal_url,portal_requests.portal_url),
        archived_at=excluded.archived_at
    `).run(
      record.srnumber,
      Number(record.srnumber.slice(4)),
      record.portalId,
      status,
      record.problem,
      record.problemDetails,
      record.additionalDetails,
      record.address,
      record.nextUpdate,
      record.dateReported,
      record.updatedOn,
      record.dateClosed,
      JSON.stringify(record.fields || {}),
      portalUrl,
      completedAt
    );
    database.prepare(`
      UPDATE live_portal_requests SET
        portal_id=COALESCE(portal_id,?),
        problem=COALESCE(problem,?),
        address=COALESCE(address,?),
        borough=COALESCE(borough,?),
        incident_zip=COALESCE(incident_zip,?),
        submitted_at=COALESCE(submitted_at,?),
        status=CASE
          WHEN LOWER(TRIM(COALESCE(status,''))) IN ('closed','completed','resolved')
            AND ? IS NULL
          THEN status
          ELSE COALESCE(?,status) END,
        portal_url=COALESCE(portal_url,?)
      WHERE srnumber=?
    `).run(
      record.portalId,
      record.problem,
      record.address,
      geography.borough,
      geography.incident_zip,
      record.dateReported,
      record.dateClosed,
      status,
      portalUrl,
      record.srnumber
    );
    database.prepare(`
      UPDATE sr_list_backfill_items
      SET state='succeeded',completed_at=?,http_status=?,last_error=NULL,
          duration_ms=?,result_source='nyc311_portal',updated_at=?
      WHERE run_id=? AND srnumber=?
    `).run(
      completedAt,
      result.httpStatus || 200,
      durationMs,
      completedAt,
      runId,
      item.srnumber
    );
    database.prepare(`
      UPDATE live_detail_queue
      SET portal_id=COALESCE(portal_id,?),status='found',attempts=MAX(attempts,?),
          next_attempt_at=?,last_error=NULL,updated_at=?
      WHERE srnumber=?
    `).run(record.portalId, item.attempts, completedAt, completedAt, item.srnumber);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function saveFailure(database, runId, item, failure, options, timestamp, durationMs) {
  const terminal = item.attempts >= options.maxAttempts;
  const retryDelay = Math.min(
    3_600_000,
    options.retryBaseMs * (2 ** Math.max(0, item.attempts - 1))
  );
  const nextAttemptAt = new Date(new Date(timestamp).getTime() + retryDelay).toISOString();
  const state = terminal ? 'failed' : 'retry';
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      UPDATE sr_list_backfill_items
      SET state=?,next_attempt_at=?,claimed_at=NULL,completed_at=?,http_status=?,
          last_error=?,duration_ms=?,updated_at=?
      WHERE run_id=? AND srnumber=?
    `).run(
      state,
      nextAttemptAt,
      terminal ? timestamp : null,
      failure.httpStatus || null,
      failure.error,
      durationMs,
      timestamp,
      runId,
      item.srnumber
    );
    database.prepare(`
      UPDATE live_detail_queue
      SET status=CASE WHEN status='found' THEN 'found' ELSE 'retry' END,
          attempts=MAX(attempts,?),next_attempt_at=?,last_error=?,updated_at=?
      WHERE srnumber=?
    `).run(item.attempts, nextAttemptAt, failure.error, timestamp, item.srnumber);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { state, nextAttemptAt };
}

async function requestPortalDetail(item, options, fetchImpl = fetch) {
  // Resolve by SR number even when the export also contains a Portal GUID.
  // The number lookup proves that the returned page belongs to the requested
  // SR; passing a known GUID into the parser could otherwise make a generic
  // Portal error page look like a valid, empty detail response.
  const url = `https://portal.311.nyc.gov/sr-details/?srnum=${encodeURIComponent(item.srnumber)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-List-Backfill/1.0)',
        Referer: 'https://portal.311.nyc.gov/check-status/'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        outcome: 'retry',
        httpStatus: response.status,
        error: `Portal detail returned HTTP ${response.status}`
      };
    }
    const parsed = parseDetail(await response.text(), item.srnumber);
    if (parsed.outcome !== 'found') {
      return {
        outcome: 'retry',
        httpStatus: response.status,
        error: parsed.error || 'Portal reported that the request was not found'
      };
    }
    if (parsed.record.srnumber !== item.srnumber) {
      return {
        outcome: 'retry',
        httpStatus: response.status,
        error: `Portal returned ${parsed.record.srnumber} for ${item.srnumber}`
      };
    }
    if (!parsed.record.portalId
        || (!parsed.record.status && !parsed.record.problem && !parsed.record.dateReported)) {
      return {
        outcome: 'retry',
        httpStatus: response.status,
        error: 'Portal returned an incomplete detail page'
      };
    }
    return { ...parsed, httpStatus: response.status };
  } catch (error) {
    return {
      outcome: 'retry',
      httpStatus: null,
      error: error.name === 'AbortError'
        ? `Portal detail timed out after ${options.requestTimeoutMs}ms`
        : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function stateCounts(database, runId) {
  const counts = Object.fromEntries(database.prepare(`
    SELECT state,COUNT(*) AS count
    FROM sr_list_backfill_items WHERE run_id=? GROUP BY state
  `).all(runId).map(row => [row.state, Number(row.count)]));
  for (const state of ['pending', 'working', 'retry', 'succeeded', 'failed']) {
    if (!Object.hasOwn(counts, state)) counts[state] = 0;
  }
  return counts;
}

function progressSnapshot(database, runId, metrics, startedAt) {
  const counts = stateCounts(database, runId);
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const portalRate = metrics.portalRequests / elapsedSeconds;
  const remaining = counts.pending + counts.working + counts.retry;
  return {
    run_id: runId,
    portal_requests_this_run: metrics.portalRequests,
    succeeded_this_run: metrics.succeeded,
    retries_this_run: metrics.retries,
    failed_this_run: metrics.failed,
    counts,
    remaining,
    unresolved: remaining + counts.failed,
    portal_requests_per_second: Number(portalRate.toFixed(3)),
    average_request_ms: metrics.portalRequests > 0
      ? Math.round(metrics.totalRequestDurationMs / metrics.portalRequests)
      : null,
    eta_seconds: portalRate > 0 && remaining > 0 ? Math.ceil(remaining / portalRate) : null,
    eta_hours: portalRate > 0 && remaining > 0
      ? Number((remaining / portalRate / 3600).toFixed(2))
      : null,
    elapsed_seconds: Number(elapsedSeconds.toFixed(1)),
    last_srnumber: metrics.lastSrnumber
  };
}

function updateMonitorState(database, runId, event, snapshot, timestamp) {
  const value = JSON.stringify({ event, ...snapshot, updated_at: timestamp });
  database.prepare(`
    INSERT INTO live_monitor_state(key,value,updated_at)
    VALUES ('sr_list_backfill',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
  `).run(value, timestamp);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function runBackfill(database, runId, options, {
  requestDetail = requestPortalDetail,
  emit = value => console.log(JSON.stringify(value)),
  now = () => new Date(),
  wait = sleep
} = {}) {
  const statements = prepareQueueStatements(database);
  const startedAt = Date.now();
  const startTimestamp = now().toISOString();
  const reconciledExisting = reconcileStoredDetails(database, runId, startTimestamp);
  const recovered = resetStaleWork(database, runId, startTimestamp);
  database.prepare(`
    UPDATE sr_list_backfill_runs
    SET status='running',updated_at=?,completed_at=NULL,last_error=NULL WHERE run_id=?
  `).run(startTimestamp, runId);
  const metrics = {
    portalRequests: 0,
    succeeded: 0,
    retries: 0,
    failed: 0,
    totalRequestDurationMs: 0,
    lastSrnumber: null
  };
  let stopping = false;
  let budgetExhausted = false;
  let workerError = null;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const emitProgress = event => {
    const snapshot = progressSnapshot(database, runId, metrics, startedAt);
    const timestamp = now().toISOString();
    updateMonitorState(database, runId, event, snapshot, timestamp);
    emit({ event, ...snapshot });
    return snapshot;
  };

  emit({
    event: 'sr_list_backfill_started',
    run_id: runId,
    reconciled_existing_items: reconciledExisting,
    recovered_working_items: recovered.recoveredWorking,
    recovered_failed_items: recovered.recoveredFailed,
    concurrency: options.concurrency,
    delay_ms_per_worker: options.delayMs,
    limit: options.limit,
    counts: stateCounts(database, runId)
  });

  async function worker() {
    while (!stopping) {
      if (options.limit != null && metrics.portalRequests >= options.limit) {
        budgetExhausted = true;
        return;
      }
      const timestamp = now().toISOString();
      const item = claimNext(database, statements, runId, timestamp);
      if (!item) {
        const counts = stateCounts(database, runId);
        if (!counts.pending && !counts.working && !counts.retry) return;
        if (counts.working) {
          await wait(50);
          continue;
        }
        const retry = statements.earliestRetry.get(runId);
        if (!retry || !retry.next_attempt_at) return;
        const waitMs = Math.max(25, Math.min(
          1000,
          new Date(retry.next_attempt_at).getTime() - now().getTime()
        ));
        await wait(waitMs);
        continue;
      }
      // JavaScript reaches this increment synchronously, so concurrent workers
      // cannot exceed a benchmark limit between the check and increment.
      if (options.limit != null && metrics.portalRequests >= options.limit) {
        saveFailure(database, runId, item, {
          error: 'Benchmark limit reached before request started',
          httpStatus: null
        }, { ...options, maxAttempts: Number.MAX_SAFE_INTEGER }, timestamp, 0);
        budgetExhausted = true;
        return;
      }
      metrics.portalRequests += 1;
      metrics.lastSrnumber = item.srnumber;
      const requestStartedAt = Date.now();
      let result;
      try {
        result = await requestDetail(item, options);
      } catch (error) {
        result = { outcome: 'retry', error: error.message, httpStatus: null };
      }
      const completedAt = now().toISOString();
      const durationMs = Math.max(0, Date.now() - requestStartedAt);
      metrics.totalRequestDurationMs += durationMs;
      if (result.outcome === 'found') {
        saveDetail(database, runId, item, result, completedAt, durationMs);
        metrics.succeeded += 1;
      } else {
        const saved = saveFailure(database, runId, item, {
          error: result.error || 'Unknown Portal detail failure',
          httpStatus: result.httpStatus || null
        }, options, completedAt, durationMs);
        if (saved.state === 'failed') metrics.failed += 1;
        else metrics.retries += 1;
      }
      if (metrics.portalRequests % options.progressEvery === 0) {
        emitProgress('sr_list_backfill_progress');
      }
      if (options.delayMs) await wait(options.delayMs);
    }
  }

  try {
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      try {
        await worker();
      } catch (error) {
        stopping = true;
        if (!workerError) workerError = error;
      }
    }));
    if (workerError) throw workerError;
    const snapshot = progressSnapshot(database, runId, metrics, startedAt);
    const complete = snapshot.unresolved === 0;
    const status = complete ? 'completed' : 'paused';
    const timestamp = now().toISOString();
    database.prepare(`
      UPDATE sr_list_backfill_runs
      SET status=?,updated_at=?,completed_at=?,last_error=NULL WHERE run_id=?
    `).run(status, timestamp, complete ? timestamp : null, runId);
    const event = complete
      ? 'sr_list_backfill_completed'
      : budgetExhausted ? 'sr_list_backfill_benchmark_complete' : 'sr_list_backfill_paused';
    updateMonitorState(database, runId, event, snapshot, timestamp);
    emit({ event, ...snapshot });
    return { event, ...snapshot };
  } catch (error) {
    const timestamp = now().toISOString();
    database.prepare(`
      UPDATE sr_list_backfill_runs
      SET status='failed',last_error=?,updated_at=? WHERE run_id=?
    `).run(error.message, timestamp, runId);
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const validation = await validateSource(options.input);
  const validationOutput = {
    event: 'sr_list_backfill_source_validated',
    input: options.input,
    sha256: validation.sourceSha256,
    manifest: validation.manifestFilename,
    membership_rows: validation.membershipRows,
    unique_sr_numbers: validation.uniqueSrNumbers,
    deduplicated_rows: validation.deduplicatedRows,
    sr_numbers_in_multiple_bids: validation.multiBidSrNumbers,
    boundary_versions: [...validation.bidReferences.keys()]
  };
  console.log(JSON.stringify(validationOutput));
  if (options.validateOnly) return validationOutput;

  fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
  const database = new DatabaseSync(options.databasePath);
  try {
    database.exec(`PRAGMA busy_timeout=${resolveBusyTimeoutMs(process.env.SQLITE_BUSY_TIMEOUT_MS)}`);
    database.exec(`PRAGMA journal_mode=WAL`);
    database.exec(`PRAGMA synchronous=${resolveSynchronousMode(process.env.SQLITE_SYNCHRONOUS)}`);
    database.exec('PRAGMA foreign_keys=ON');
    assertDatabaseContract(database);
    const prepared = await importSource(database, options, validation);
    const preparedOutput = {
      event: 'sr_list_backfill_prepared',
      run_id: prepared.runId,
      database: options.databasePath,
      imported_requests: prepared.importedRequests,
      counts: stateCounts(database, prepared.runId)
    };
    console.log(JSON.stringify(preparedOutput));
    if (options.prepareOnly) return preparedOutput;
    return await runBackfill(database, prepared.runId, options);
  } finally {
    database.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({
      event: 'sr_list_backfill_failed',
      error: error.message
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_HEADERS,
  TERMINAL_STATES,
  assertDatabaseContract,
  effectiveStatus,
  ensureBackfillSchema,
  importSource,
  loadManifest,
  main,
  manifestPathFor,
  normalizeSourceRow,
  parseArguments,
  parseCsvLine,
  parsePortalId,
  progressSnapshot,
  reconcileStoredDetails,
  requestPortalDetail,
  runBackfill,
  runIdFor,
  saveDetail,
  sha256File,
  stateCounts,
  usage,
  validateSource,
  visitCsvRows
};
