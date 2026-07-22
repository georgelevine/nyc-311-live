'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const {
  APPLICATION_ID,
  healthCheck,
  inspectMigrationState,
  openDatabase,
  sha256File,
  tableManifest
} = require('./sqlite-finalization');

const REQUIRED_ARCHIVE_COLUMNS = Object.freeze({
  live_portal_requests: Object.freeze([
    'srnumber', 'suffix', 'portal_id', 'problem', 'address', 'latitude',
    'longitude', 'submitted_at', 'status', 'portal_url', 'first_seen_at',
    'last_seen_at', 'raw_json', 'police_precinct',
    'police_precinct_boundary_version', 'police_precinct_matched_at',
    'business_improvement_district_boundary_version',
    'business_improvement_district_matched_at'
  ]),
  live_number_queue: Object.freeze([
    'suffix', 'srnumber', 'first_detected_at', 'audit_after', 'map_seen',
    'audit_outcome', 'audited_at'
  ]),
  live_monitor_state: Object.freeze(['key', 'value', 'updated_at']),
  portal_requests: Object.freeze([
    'srnumber', 'suffix', 'portal_id', 'status', 'problem', 'problem_details',
    'additional_details', 'address', 'next_update', 'date_reported',
    'updated_on', 'date_closed', 'fields_json', 'portal_url', 'archived_at'
  ]),
  live_detail_queue: Object.freeze([
    'srnumber', 'portal_id', 'status', 'attempts', 'next_attempt_at',
    'last_error', 'updated_at'
  ]),
  number_ledger: Object.freeze([
    'suffix', 'srnumber', 'outcome', 'attempts', 'http_status', 'error', 'checked_at'
  ]),
  request_status_history: Object.freeze([
    'id', 'srnumber', 'previous_status', 'status', 'source', 'effective_at',
    'observed_at', 'snapshot_json'
  ]),
  request_closure_snapshots: Object.freeze([
    'id', 'srnumber', 'closure_cycle', 'status', 'date_closed', 'source',
    'fetched_at', 'is_final', 'final_state', 'content_hash', 'snapshot_json'
  ]),
  request_followup_queue: Object.freeze([
    'srnumber', 'portal_id', 'state', 'next_check_at', 'attempts',
    'closing_attempts', 'closure_cycle', 'last_checked_at', 'last_success_at',
    'last_error', 'finalized_at', 'updated_at'
  ]),
  police_precinct_boundary_versions: Object.freeze([
    'version', 'source_url', 'source_sha256', 'source_date', 'imported_at',
    'feature_count', 'active'
  ]),
  police_precincts: Object.freeze([
    'boundary_version', 'precinct_number', 'label', 'geometry_json',
    'min_longitude', 'min_latitude', 'max_longitude', 'max_latitude'
  ]),
  business_improvement_district_boundary_versions: Object.freeze([
    'version', 'source_url', 'source_sha256', 'source_date', 'imported_at',
    'feature_count', 'active'
  ]),
  business_improvement_districts: Object.freeze([
    'boundary_version', 'bid_id', 'name', 'borough_code', 'borough_name',
    'geometry_json', 'min_longitude', 'min_latitude', 'max_longitude',
    'max_latitude'
  ]),
  live_request_bid_memberships: Object.freeze([
    'srnumber', 'boundary_version', 'bid_id', 'matched_at'
  ]),
  schema_migrations: Object.freeze(['version', 'name', 'checksum', 'applied_at'])
});

const REQUIRED_ARCHIVE_PRIMARY_KEYS = Object.freeze({
  live_portal_requests: Object.freeze(['srnumber']),
  live_number_queue: Object.freeze(['suffix']),
  live_monitor_state: Object.freeze(['key']),
  portal_requests: Object.freeze(['srnumber']),
  live_detail_queue: Object.freeze(['srnumber']),
  number_ledger: Object.freeze(['suffix']),
  request_status_history: Object.freeze(['id']),
  request_closure_snapshots: Object.freeze(['id']),
  request_followup_queue: Object.freeze(['srnumber']),
  police_precinct_boundary_versions: Object.freeze(['version']),
  police_precincts: Object.freeze(['boundary_version', 'precinct_number']),
  business_improvement_district_boundary_versions: Object.freeze(['version']),
  business_improvement_districts: Object.freeze(['boundary_version', 'bid_id']),
  live_request_bid_memberships: Object.freeze(['srnumber', 'boundary_version', 'bid_id']),
  schema_migrations: Object.freeze(['version'])
});

const REQUIRED_ARCHIVE_UNIQUE_CONSTRAINTS = Object.freeze({
  live_portal_requests: Object.freeze([
    Object.freeze(['suffix']),
    Object.freeze(['portal_id'])
  ]),
  live_number_queue: Object.freeze([Object.freeze(['srnumber'])]),
  portal_requests: Object.freeze([
    Object.freeze(['suffix']),
    Object.freeze(['portal_id'])
  ]),
  number_ledger: Object.freeze([Object.freeze(['srnumber'])]),
  request_closure_snapshots: Object.freeze([
    Object.freeze(['srnumber', 'closure_cycle', 'content_hash', 'is_final'])
  ]),
  police_precinct_boundary_versions: Object.freeze([
    Object.freeze(['source_sha256'])
  ]),
  business_improvement_district_boundary_versions: Object.freeze([
    Object.freeze(['source_sha256'])
  ]),
  schema_migrations: Object.freeze([Object.freeze(['name'])])
});

const REQUIRED_ARCHIVE_FOREIGN_KEYS = Object.freeze({
  police_precincts: Object.freeze([
    Object.freeze({
      columns: Object.freeze(['boundary_version']),
      referenced_table: 'police_precinct_boundary_versions',
      referenced_columns: Object.freeze(['version']),
      on_delete: 'CASCADE'
    })
  ]),
  business_improvement_districts: Object.freeze([
    Object.freeze({
      columns: Object.freeze(['boundary_version']),
      referenced_table: 'business_improvement_district_boundary_versions',
      referenced_columns: Object.freeze(['version']),
      on_delete: 'CASCADE'
    })
  ]),
  live_request_bid_memberships: Object.freeze([
    Object.freeze({
      columns: Object.freeze(['boundary_version', 'bid_id']),
      referenced_table: 'business_improvement_districts',
      referenced_columns: Object.freeze(['boundary_version', 'bid_id']),
      on_delete: 'CASCADE'
    }),
    Object.freeze({
      columns: Object.freeze(['srnumber']),
      referenced_table: 'live_portal_requests',
      referenced_columns: Object.freeze(['srnumber']),
      on_delete: 'CASCADE'
    })
  ])
});

function indexKey(name, descending = false) {
  return Object.freeze({ name, descending });
}

const REQUIRED_ARCHIVE_INDEX_CONTRACTS = Object.freeze({
  live_detail_queue_status_idx: Object.freeze({
    table: 'live_detail_queue',
    unique: false,
    keys: Object.freeze([indexKey('status'), indexKey('next_attempt_at')]),
    where: null
  }),
  live_number_queue_audit_due_idx: Object.freeze({
    table: 'live_number_queue',
    unique: false,
    keys: Object.freeze([indexKey('audit_outcome'), indexKey('audit_after'), indexKey('suffix')]),
    where: null
  }),
  live_portal_requests_police_precinct_idx: Object.freeze({
    table: 'live_portal_requests',
    unique: false,
    keys: Object.freeze([indexKey('police_precinct'), indexKey('suffix', true)]),
    where: null
  }),
  live_request_bid_memberships_district_idx: Object.freeze({
    table: 'live_request_bid_memberships',
    unique: false,
    keys: Object.freeze([
      indexKey('boundary_version'),
      indexKey('bid_id'),
      indexKey('srnumber')
    ]),
    where: null
  }),
  number_ledger_outcome_idx: Object.freeze({
    table: 'number_ledger',
    unique: false,
    keys: Object.freeze([indexKey('outcome')]),
    where: null
  }),
  police_precinct_bbox_idx: Object.freeze({
    table: 'police_precincts',
    unique: false,
    keys: Object.freeze([
      indexKey('boundary_version'),
      indexKey('min_longitude'),
      indexKey('max_longitude'),
      indexKey('min_latitude'),
      indexKey('max_latitude')
    ]),
    where: null
  }),
  police_precinct_one_active_version_idx: Object.freeze({
    table: 'police_precinct_boundary_versions',
    unique: true,
    keys: Object.freeze([indexKey('active')]),
    where: 'active = 1'
  }),
  business_improvement_district_bbox_idx: Object.freeze({
    table: 'business_improvement_districts',
    unique: false,
    keys: Object.freeze([
      indexKey('boundary_version'),
      indexKey('min_longitude'),
      indexKey('max_longitude'),
      indexKey('min_latitude'),
      indexKey('max_latitude')
    ]),
    where: null
  }),
  business_improvement_district_one_active_version_idx: Object.freeze({
    table: 'business_improvement_district_boundary_versions',
    unique: true,
    keys: Object.freeze([indexKey('active')]),
    where: 'active = 1'
  }),
  request_closure_snapshots_final_idx: Object.freeze({
    table: 'request_closure_snapshots',
    unique: true,
    keys: Object.freeze([indexKey('srnumber'), indexKey('closure_cycle')]),
    where: 'is_final = 1'
  }),
  request_closure_snapshots_request_idx: Object.freeze({
    table: 'request_closure_snapshots',
    unique: false,
    keys: Object.freeze([
      indexKey('srnumber'),
      indexKey('closure_cycle', true),
      indexKey('fetched_at', true)
    ]),
    where: null
  }),
  request_followup_queue_due_idx: Object.freeze({
    table: 'request_followup_queue',
    unique: false,
    keys: Object.freeze([indexKey('state'), indexKey('next_check_at')]),
    where: null
  }),
  request_status_history_request_idx: Object.freeze({
    table: 'request_status_history',
    unique: false,
    keys: Object.freeze([indexKey('srnumber'), indexKey('observed_at')]),
    where: null
  })
});

const REQUIRED_ARCHIVE_INDEXES = Object.freeze(Object.keys(REQUIRED_ARCHIVE_INDEX_CONTRACTS));

const REQUIRED_ARCHIVE_TABLES = Object.freeze(Object.keys(REQUIRED_ARCHIVE_COLUMNS));

function quotePragmaIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableInfo(database, table) {
  return database.prepare(`PRAGMA table_info(${quotePragmaIdentifier(table)})`).all();
}

function indexList(database, table) {
  return database.prepare(`PRAGMA index_list(${quotePragmaIdentifier(table)})`).all();
}

function indexKeys(database, index) {
  return database.prepare(`PRAGMA index_xinfo(${quotePragmaIdentifier(index)})`).all()
    .filter(column => Number(column.key) === 1)
    .sort((first, second) => Number(first.seqno) - Number(second.seqno))
    .map(column => ({ name: column.name, descending: Boolean(column.desc) }));
}

function primaryKeyColumns(database, table) {
  return tableInfo(database, table)
    .filter(column => Number(column.pk) > 0)
    .sort((first, second) => Number(first.pk) - Number(second.pk))
    .map(column => column.name);
}

function uniqueConstraintColumns(database, table) {
  return indexList(database, table)
    .filter(index => Number(index.unique) === 1
      && String(index.origin) === 'u'
      && Number(index.partial) === 0)
    .map(index => indexKeys(database, index.name).map(key => key.name));
}

function foreignKeyConstraints(database, table) {
  const groups = new Map();
  for (const row of database.prepare(
    `PRAGMA foreign_key_list(${quotePragmaIdentifier(table)})`
  ).all()) {
    const id = Number(row.id);
    if (!groups.has(id)) {
      groups.set(id, {
        referenced_table: row.table,
        columns: [],
        referenced_columns: [],
        on_delete: String(row.on_delete || '').toUpperCase()
      });
    }
    const group = groups.get(id);
    group.columns[Number(row.seq)] = row.from;
    group.referenced_columns[Number(row.seq)] = row.to;
  }
  return [...groups.values()];
}

function normalizePartialPredicate(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value)
    .replace(/;+\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*=\s*/g, ' = ');
}

function partialPredicate(indexSql) {
  const match = String(indexSql || '').match(/\bWHERE\b([\s\S]*)$/i);
  return match ? normalizePartialPredicate(match[1]) : null;
}

function formatColumns(columns) {
  return columns.length ? `(${columns.join(', ')})` : '(none)';
}

function formatIndexKeys(keys) {
  return formatColumns(keys.map(key => `${key.name}${key.descending ? ' DESC' : ' ASC'}`));
}

function validateKeysAndConstraints(database) {
  const errors = [];
  for (const [table, expected] of Object.entries(REQUIRED_ARCHIVE_PRIMARY_KEYS)) {
    const actual = primaryKeyColumns(database, table);
    if (!isDeepStrictEqual(actual, expected)) {
      errors.push(`${table} primary key expected ${formatColumns(expected)}, found ${formatColumns(actual)}`);
    }
  }

  for (const [table, requiredConstraints] of Object.entries(REQUIRED_ARCHIVE_UNIQUE_CONSTRAINTS)) {
    const actualConstraints = uniqueConstraintColumns(database, table);
    for (const expected of requiredConstraints) {
      if (!actualConstraints.some(actual => isDeepStrictEqual(actual, expected))) {
        errors.push(`${table} missing UNIQUE constraint ${formatColumns(expected)}`);
      }
    }
  }
  for (const [table, requiredConstraints] of Object.entries(REQUIRED_ARCHIVE_FOREIGN_KEYS)) {
    const actualConstraints = foreignKeyConstraints(database, table);
    for (const expected of requiredConstraints) {
      if (!actualConstraints.some(actual => isDeepStrictEqual(actual, expected))) {
        errors.push(
          `${table} missing FOREIGN KEY ${formatColumns(expected.columns)} `
          + `REFERENCES ${expected.referenced_table}${formatColumns(expected.referenced_columns)} `
          + `ON DELETE ${expected.on_delete}`
        );
      }
    }
  }
  return errors;
}

function validateRequiredIndexes(database) {
  const errors = [];
  const catalogRows = database.prepare(`
    SELECT name, tbl_name, sql FROM sqlite_master
    WHERE type = 'index' AND name IS NOT NULL
  `).all();
  const catalog = new Map(catalogRows.map(row => [row.name, row]));

  for (const [name, expected] of Object.entries(REQUIRED_ARCHIVE_INDEX_CONTRACTS)) {
    const row = catalog.get(name);
    if (!row) {
      errors.push(`${name} is missing`);
      continue;
    }
    if (row.tbl_name !== expected.table) {
      errors.push(`${name} table expected ${expected.table}, found ${row.tbl_name}`);
    }
    const listEntry = indexList(database, row.tbl_name).find(index => index.name === name);
    if (!listEntry) {
      errors.push(`${name} is not attached to its catalog table`);
      continue;
    }
    const actualUnique = Number(listEntry.unique) === 1;
    if (actualUnique !== expected.unique) {
      errors.push(`${name} uniqueness expected ${expected.unique ? 'unique' : 'non-unique'}, found ${actualUnique ? 'unique' : 'non-unique'}`);
    }
    const actualKeys = indexKeys(database, name);
    if (!isDeepStrictEqual(actualKeys, expected.keys)) {
      errors.push(`${name} keys expected ${formatIndexKeys(expected.keys)}, found ${formatIndexKeys(actualKeys)}`);
    }
    const expectedPredicate = normalizePartialPredicate(expected.where);
    const actualPredicate = partialPredicate(row.sql);
    const actualPartial = Number(listEntry.partial) === 1;
    if (actualPartial !== Boolean(expectedPredicate) || actualPredicate !== expectedPredicate) {
      errors.push(`${name} predicate expected ${expectedPredicate || '(none)'}, found ${actualPredicate || '(none)'}`);
    }
  }
  return errors;
}

function validateArchiveContract(database, tables) {
  const schemaErrors = [];
  for (const [table, requiredColumns] of Object.entries(REQUIRED_ARCHIVE_COLUMNS)) {
    if (!Object.hasOwn(tables, table)) continue;
    const actualColumns = new Set(tableInfo(database, table)
      .map(column => column.name));
    const missing = requiredColumns.filter(column => !actualColumns.has(column));
    if (missing.length) schemaErrors.push(`${table}: ${missing.join(', ')}`);
  }
  if (schemaErrors.length) {
    throw new Error(`Snapshot is missing required archive column(s): ${schemaErrors.join('; ')}`);
  }

  const contractErrors = [
    ...validateKeysAndConstraints(database),
    ...validateRequiredIndexes(database)
  ];
  if (contractErrors.length) {
    throw new Error(`Snapshot archive schema contract failed: ${contractErrors.join('; ')}`);
  }

  const state = database.prepare(`
    SELECT key, value FROM live_monitor_state
    WHERE key IN ('live_frontier', 'last_successful_poll_at')
  `).all();
  const stateByKey = new Map(state.map(row => [row.key, row.value]));
  const frontier = Number(stateByKey.get('live_frontier'));
  const lastPoll = stateByKey.get('last_successful_poll_at');
  if (!Number.isInteger(frontier) || frontier < 0) {
    throw new Error('Snapshot does not contain a valid live frontier');
  }
  if (!lastPoll || !Number.isFinite(Date.parse(lastPoll))) {
    throw new Error('Snapshot does not contain a valid last successful poll timestamp');
  }

  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM live_portal_requests) AS live_requests,
      (SELECT MAX(suffix) FROM live_portal_requests) AS max_live_suffix,
      (SELECT COUNT(*) FROM live_portal_requests AS live
        LEFT JOIN live_detail_queue AS detail ON detail.srnumber = live.srnumber
        WHERE detail.srnumber IS NULL) AS missing_detail_queue,
      (SELECT COUNT(*) FROM live_portal_requests AS live
        LEFT JOIN request_followup_queue AS followup ON followup.srnumber = live.srnumber
        WHERE followup.srnumber IS NULL) AS missing_followup_queue,
      (SELECT COUNT(*) FROM live_portal_requests AS live
        LEFT JOIN number_ledger AS ledger ON ledger.srnumber = live.srnumber
        WHERE ledger.srnumber IS NULL OR ledger.outcome <> 'found') AS missing_found_ledger,
      (SELECT COUNT(*) FROM live_portal_requests
        WHERE (latitude IS NULL) <> (longitude IS NULL)) AS partial_coordinates,
      (SELECT COUNT(*) FROM live_portal_requests WHERE json_valid(raw_json) = 0) AS invalid_live_json,
      (SELECT COUNT(*) FROM portal_requests WHERE json_valid(fields_json) = 0) AS invalid_detail_json
  `).get();
  if (!Number(counts.live_requests)) throw new Error('Snapshot contains no captured requests');
  if (Number(counts.max_live_suffix) !== frontier) {
    throw new Error(`Snapshot frontier ${frontier} does not match latest captured suffix ${counts.max_live_suffix}`);
  }
  const parityFailures = [
    'missing_detail_queue',
    'missing_followup_queue',
    'missing_found_ledger',
    'partial_coordinates',
    'invalid_live_json',
    'invalid_detail_json'
  ].filter(name => Number(counts[name]) !== 0);
  if (parityFailures.length) {
    throw new Error(`Snapshot archive parity failed: ${parityFailures.map(name => `${name}=${counts[name]}`).join(', ')}`);
  }
  return {
    frontier,
    last_successful_poll_at: lastPoll,
    live_requests: Number(counts.live_requests)
  };
}

async function verifySnapshot({ databasePath, manifestPath }) {
  const resolvedDatabase = path.resolve(databasePath);
  const resolvedManifest = path.resolve(manifestPath || `${resolvedDatabase}.manifest.json`);
  if (!fs.existsSync(resolvedDatabase)) throw new Error(`Snapshot does not exist: ${resolvedDatabase}`);
  if (!fs.existsSync(resolvedManifest)) throw new Error(`Snapshot manifest does not exist: ${resolvedManifest}`);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
  } catch (error) {
    throw new Error(`Snapshot manifest is not valid JSON: ${error.message}`);
  }
  if (manifest.format !== 'nyc-311-sqlite-backup-manifest-v1') {
    throw new Error(`Unsupported snapshot manifest format: ${manifest.format || 'missing'}`);
  }

  const stat = fs.statSync(resolvedDatabase);
  if (!stat.isFile()) throw new Error('Snapshot path is not a regular file');
  if (Number(manifest.bytes) !== stat.size) {
    throw new Error(`Snapshot byte count mismatch: expected ${manifest.bytes}, received ${stat.size}`);
  }
  const digest = await sha256File(resolvedDatabase);
  if (digest !== manifest.sha256) throw new Error('Snapshot SHA-256 mismatch');

  const database = openDatabase(resolvedDatabase, { readOnly: true });
  let health;
  let migrations;
  let tables;
  let archive;
  try {
    health = healthCheck(database);
    migrations = inspectMigrationState(database);
    tables = tableManifest(database);
    if (!health.ok) throw new Error('Snapshot failed SQLite integrity verification');
    if (migrations.application_id !== APPLICATION_ID) {
      throw new Error(`Snapshot application_id ${migrations.application_id} is not NYC 311 Live`);
    }
    if (migrations.pending.length) {
      throw new Error(`Snapshot still has ${migrations.pending.length} pending migration(s)`);
    }
    const journalRow = database.prepare('PRAGMA journal_mode').get();
    const journalMode = String(journalRow && Object.values(journalRow)[0] || '').toLowerCase();
    if (journalMode !== 'delete' || manifest.journal_mode !== 'delete') {
      throw new Error(`Snapshot is not a self-contained DELETE-journal transport (found ${journalMode || 'unknown'})`);
    }
    const missingTables = REQUIRED_ARCHIVE_TABLES.filter(name => !Object.hasOwn(tables, name));
    if (missingTables.length) {
      throw new Error(`Snapshot is missing required archive table(s): ${missingTables.join(', ')}`);
    }
    archive = validateArchiveContract(database, tables);
    if (Number(manifest.application_id) !== migrations.application_id
        || Number(manifest.user_version) !== migrations.user_version) {
      throw new Error('Snapshot schema metadata does not match its manifest');
    }
    if (!isDeepStrictEqual(manifest.tables, tables)) {
      throw new Error('Snapshot table manifest does not match the transferred database');
    }
  } finally {
    database.close();
  }

  return {
    ok: true,
    database: resolvedDatabase,
    manifest: resolvedManifest,
    bytes: stat.size,
    sha256: digest,
    application_id: migrations.application_id,
    user_version: migrations.user_version,
    archive,
    tables
  };
}

module.exports = {
  REQUIRED_ARCHIVE_COLUMNS,
  REQUIRED_ARCHIVE_FOREIGN_KEYS,
  REQUIRED_ARCHIVE_INDEX_CONTRACTS,
  REQUIRED_ARCHIVE_INDEXES,
  REQUIRED_ARCHIVE_PRIMARY_KEYS,
  REQUIRED_ARCHIVE_TABLES,
  REQUIRED_ARCHIVE_UNIQUE_CONSTRAINTS,
  indexKeys,
  normalizePartialPredicate,
  primaryKeyColumns,
  uniqueConstraintColumns,
  validateArchiveContract,
  validateKeysAndConstraints,
  validateRequiredIndexes,
  verifySnapshot
};
