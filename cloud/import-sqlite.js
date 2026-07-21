const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { query, transaction, migrate, close } = require('./db');
const { normalizePortalTimestamp } = require('./portal');

const SQLITE_PATH = path.resolve(process.env.SQLITE_PATH || process.argv[2] || 'data/portal-archive.sqlite');
const WORKER_LOCK_ID = Number(process.env.WORKER_LOCK_ID || 31120260720);
const ALLOW_LIVE_SQLITE_IMPORT = process.env.ALLOW_LIVE_SQLITE_IMPORT === '1';

const TABLES = [
  { name: 'live_portal_requests', key: 'srnumber', keyType: 'text' },
  { name: 'portal_requests', key: 'srnumber', keyType: 'text' },
  { name: 'live_detail_queue', key: 'srnumber', keyType: 'text' },
  { name: 'live_number_queue', key: 'suffix', keyType: 'bigint' },
  { name: 'number_ledger', key: 'suffix', keyType: 'bigint' },
  { name: 'live_monitor_state', key: 'key', keyType: 'text' },
  { name: 'request_status_history', key: 'id', keyType: 'bigint' },
  { name: 'request_closure_snapshots', key: 'id', keyType: 'bigint' },
  { name: 'request_followup_queue', key: 'srnumber', keyType: 'text' }
];

function timestamp(value, context, required = false) {
  if (value == null || String(value).trim() === '') {
    if (required) throw new Error(`${context} is required`);
    return null;
  }
  const normalized = normalizePortalTimestamp(value);
  if (!normalized) throw new Error(`${context} is not a valid timestamp: ${String(value)}`);
  return normalized;
}

function jsonObject(value, context, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${context} is not valid JSON: ${error.message}`);
  }
}

function booleanValue(value) {
  return value === true || value === 1 || value === '1';
}

function liveSource(row, raw) {
  if (raw && typeof raw.source === 'string') return raw.source;
  if (raw && raw.coordinate_free) return 'number_audit';
  if (row.latitude != null && row.longitude != null) return 'map';
  return 'sqlite_import';
}

function hasTable(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function requireSourceSchema(database) {
  const missing = TABLES.map(table => table.name).filter(name => !hasTable(database, name));
  if (missing.length) {
    throw new Error(`SQLite snapshot is not finalized; missing tables: ${missing.join(', ')}`);
  }
}

function sourceManifest(database) {
  const manifest = {};
  for (const table of TABLES) {
    const row = database.prepare(`
      SELECT COUNT(*) AS count, MIN(${table.key}) AS minimum, MAX(${table.key}) AS maximum
      FROM ${table.name}
    `).get();
    manifest[table.name] = {
      count: Number(row.count),
      minimum: row.minimum == null ? null : String(row.minimum),
      maximum: row.maximum == null ? null : String(row.maximum)
    };
  }
  const auditOnly = database.prepare(`
    SELECT COUNT(*) AS count
    FROM portal_requests AS detail
    LEFT JOIN live_portal_requests AS live USING (srnumber)
    WHERE live.srnumber IS NULL
  `).get();
  manifest.archive_only_promotions = Number(auditOnly.count);
  return manifest;
}

async function targetManifest(client) {
  const manifest = {};
  for (const table of TABLES) {
    const result = await client.query(`
      SELECT COUNT(*)::bigint AS count, MIN(${table.key})::text AS minimum,
             MAX(${table.key})::text AS maximum
      FROM ${table.name}
    `);
    const row = result.rows[0];
    manifest[table.name] = {
      count: Number(row.count),
      minimum: row.minimum,
      maximum: row.maximum
    };
  }
  return manifest;
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const input = fs.createReadStream(filename);
    input.on('error', reject);
    input.on('data', chunk => digest.update(chunk));
    input.on('end', () => resolve(digest.digest('hex')));
  });
}

async function importRows(database, client, table, importer) {
  let imported = 0;
  for (const row of database.prepare(`SELECT * FROM ${table}`).iterate()) {
    await importer(client, row);
    imported += 1;
    if (imported % 1000 === 0) console.log(JSON.stringify({ table, imported }));
  }
  console.log(JSON.stringify({ table, imported, complete: true }));
}

async function verifySourceKeys(database, client, table) {
  const batch = [];
  let verified = 0;
  const flush = async () => {
    if (!batch.length) return;
    const cast = table.keyType === 'bigint' ? 'bigint[]' : 'text[]';
    const result = await client.query(
      `SELECT COUNT(*)::int AS count FROM ${table.name} WHERE ${table.key} = ANY($1::${cast})`,
      [batch.splice(0)]
    );
    verified += Number(result.rows[0].count);
  };
  for (const row of database.prepare(`SELECT ${table.key} AS source_key FROM ${table.name}`).iterate()) {
    batch.push(row.source_key);
    if (batch.length >= 500) await flush();
  }
  await flush();
  const expected = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table.name}`).get().count);
  if (verified !== expected) {
    throw new Error(`PostgreSQL verification failed for ${table.name}: expected ${expected} source keys, found ${verified}`);
  }
}

async function importLiveRequests(database, client) {
  await importRows(database, client, 'live_portal_requests', async (db, row) => {
    const raw = jsonObject(row.raw_json, `${row.srnumber}.raw_json`);
    const firstSeen = timestamp(row.first_seen_at, `${row.srnumber}.first_seen_at`, true);
    const lastSeen = timestamp(row.last_seen_at, `${row.srnumber}.last_seen_at`, true);
    await db.query(`
      INSERT INTO live_portal_requests (
        srnumber,suffix,portal_id,problem,address,latitude,longitude,location,
        submitted_at,status,portal_url,source,first_seen_at,last_seen_at,raw_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,
        CASE WHEN $6::double precision IS NOT NULL AND $7::double precision IS NOT NULL
          THEN ST_SetSRID(ST_MakePoint($7,$6),4326)::geography ELSE NULL END,
        $8,$9,$10,$11,$12,$13,$14::jsonb)
      ON CONFLICT (srnumber) DO UPDATE SET
        suffix = EXCLUDED.suffix,
        portal_id = COALESCE(live_portal_requests.portal_id, EXCLUDED.portal_id),
        problem = CASE WHEN EXCLUDED.last_seen_at >= live_portal_requests.last_seen_at
          THEN COALESCE(EXCLUDED.problem,live_portal_requests.problem)
          ELSE COALESCE(live_portal_requests.problem,EXCLUDED.problem) END,
        address = CASE WHEN EXCLUDED.last_seen_at >= live_portal_requests.last_seen_at
          THEN COALESCE(EXCLUDED.address,live_portal_requests.address)
          ELSE COALESCE(live_portal_requests.address,EXCLUDED.address) END,
        latitude = CASE WHEN EXCLUDED.last_seen_at >= live_portal_requests.last_seen_at
          THEN COALESCE(EXCLUDED.latitude,live_portal_requests.latitude)
          ELSE COALESCE(live_portal_requests.latitude,EXCLUDED.latitude) END,
        longitude = CASE WHEN EXCLUDED.last_seen_at >= live_portal_requests.last_seen_at
          THEN COALESCE(EXCLUDED.longitude,live_portal_requests.longitude)
          ELSE COALESCE(live_portal_requests.longitude,EXCLUDED.longitude) END,
        location = CASE WHEN EXCLUDED.last_seen_at >= live_portal_requests.last_seen_at
          THEN COALESCE(EXCLUDED.location,live_portal_requests.location)
          ELSE COALESCE(live_portal_requests.location,EXCLUDED.location) END,
        submitted_at = COALESCE(live_portal_requests.submitted_at,EXCLUDED.submitted_at),
        status = CASE WHEN EXCLUDED.last_seen_at >= live_portal_requests.last_seen_at
          THEN COALESCE(EXCLUDED.status,live_portal_requests.status) ELSE live_portal_requests.status END,
        portal_url = COALESCE(live_portal_requests.portal_url,EXCLUDED.portal_url),
        source = CASE WHEN EXCLUDED.last_seen_at >= live_portal_requests.last_seen_at
          THEN EXCLUDED.source ELSE live_portal_requests.source END,
        first_seen_at = LEAST(EXCLUDED.first_seen_at,live_portal_requests.first_seen_at),
        last_seen_at = GREATEST(EXCLUDED.last_seen_at,live_portal_requests.last_seen_at),
        raw_json = CASE WHEN EXCLUDED.last_seen_at >= live_portal_requests.last_seen_at
          THEN EXCLUDED.raw_json ELSE live_portal_requests.raw_json END
    `, [
      row.srnumber, row.suffix, row.portal_id, row.problem, row.address,
      row.latitude, row.longitude, timestamp(row.submitted_at, `${row.srnumber}.submitted_at`),
      row.status, row.portal_url, liveSource(row, raw), firstSeen, lastSeen, JSON.stringify(raw)
    ]);
  });
}

async function importPortalRequests(database, client) {
  await importRows(database, client, 'portal_requests', async (db, row) => {
    const archivedAt = timestamp(row.archived_at, `${row.srnumber}.archived_at`, true);
    await db.query(`
      INSERT INTO portal_requests (
        srnumber,suffix,portal_id,status,problem,problem_details,additional_details,address,
        next_update,date_reported,updated_on,date_closed,fields_json,portal_url,archived_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
      ON CONFLICT (srnumber) DO UPDATE SET
        portal_id=COALESCE(portal_requests.portal_id,EXCLUDED.portal_id),
        status=CASE
          WHEN portal_requests.date_closed IS NOT NULL AND EXCLUDED.date_closed IS NULL THEN portal_requests.status
          WHEN EXCLUDED.archived_at >= portal_requests.archived_at THEN COALESCE(EXCLUDED.status,portal_requests.status)
          ELSE portal_requests.status END,
        problem=CASE WHEN EXCLUDED.archived_at >= portal_requests.archived_at
          THEN COALESCE(EXCLUDED.problem,portal_requests.problem) ELSE COALESCE(portal_requests.problem,EXCLUDED.problem) END,
        problem_details=CASE WHEN EXCLUDED.archived_at >= portal_requests.archived_at
          THEN COALESCE(EXCLUDED.problem_details,portal_requests.problem_details)
          ELSE COALESCE(portal_requests.problem_details,EXCLUDED.problem_details) END,
        additional_details=CASE WHEN EXCLUDED.archived_at >= portal_requests.archived_at
          THEN COALESCE(EXCLUDED.additional_details,portal_requests.additional_details)
          ELSE COALESCE(portal_requests.additional_details,EXCLUDED.additional_details) END,
        address=CASE WHEN EXCLUDED.archived_at >= portal_requests.archived_at
          THEN COALESCE(EXCLUDED.address,portal_requests.address) ELSE COALESCE(portal_requests.address,EXCLUDED.address) END,
        next_update=CASE WHEN EXCLUDED.archived_at >= portal_requests.archived_at
          THEN COALESCE(EXCLUDED.next_update,portal_requests.next_update) ELSE portal_requests.next_update END,
        date_reported=COALESCE(portal_requests.date_reported,EXCLUDED.date_reported),
        updated_on=CASE WHEN EXCLUDED.archived_at >= portal_requests.archived_at
          THEN COALESCE(EXCLUDED.updated_on,portal_requests.updated_on) ELSE portal_requests.updated_on END,
        date_closed=COALESCE(portal_requests.date_closed,EXCLUDED.date_closed),
        fields_json=CASE WHEN EXCLUDED.archived_at >= portal_requests.archived_at
          THEN portal_requests.fields_json || EXCLUDED.fields_json ELSE portal_requests.fields_json END,
        portal_url=COALESCE(portal_requests.portal_url,EXCLUDED.portal_url),
        archived_at=GREATEST(portal_requests.archived_at,EXCLUDED.archived_at)
    `, [
      row.srnumber, row.suffix, row.portal_id, row.status, row.problem,
      row.problem_details, row.additional_details, row.address, row.next_update,
      timestamp(row.date_reported, `${row.srnumber}.date_reported`),
      timestamp(row.updated_on, `${row.srnumber}.updated_on`),
      timestamp(row.date_closed, `${row.srnumber}.date_closed`),
      JSON.stringify(jsonObject(row.fields_json, `${row.srnumber}.fields_json`)),
      row.portal_url, archivedAt
    ]);
  });

  await client.query(`
    INSERT INTO live_portal_requests (
      srnumber,suffix,portal_id,problem,address,submitted_at,status,portal_url,
      source,first_seen_at,last_seen_at,raw_json
    )
    SELECT detail.srnumber,detail.suffix,detail.portal_id,detail.problem,detail.address,
           detail.date_reported,
           CASE WHEN detail.date_closed IS NOT NULL THEN 'Closed' ELSE detail.status END,
           detail.portal_url,'sqlite_archive_import',detail.archived_at,detail.archived_at,
           jsonb_build_object('source','sqlite_archive_import','coordinate_free',true)
    FROM portal_requests AS detail
    LEFT JOIN live_portal_requests AS live USING (srnumber)
    WHERE live.srnumber IS NULL
    ON CONFLICT (srnumber) DO NOTHING
  `);
}

async function importDetailQueue(database, client) {
  await importRows(database, client, 'live_detail_queue', (db, row) => db.query(`
    INSERT INTO live_detail_queue (
      srnumber,portal_id,status,attempts,next_attempt_at,last_error,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (srnumber) DO UPDATE SET
      portal_id=COALESCE(live_detail_queue.portal_id,EXCLUDED.portal_id),
      status=CASE WHEN EXCLUDED.updated_at >= live_detail_queue.updated_at
        THEN EXCLUDED.status ELSE live_detail_queue.status END,
      attempts=CASE WHEN EXCLUDED.updated_at >= live_detail_queue.updated_at
        THEN EXCLUDED.attempts ELSE live_detail_queue.attempts END,
      next_attempt_at=CASE WHEN EXCLUDED.updated_at >= live_detail_queue.updated_at
        THEN EXCLUDED.next_attempt_at ELSE live_detail_queue.next_attempt_at END,
      last_error=CASE WHEN EXCLUDED.updated_at >= live_detail_queue.updated_at
        THEN EXCLUDED.last_error ELSE live_detail_queue.last_error END,
      updated_at=GREATEST(live_detail_queue.updated_at,EXCLUDED.updated_at)
  `, [
    row.srnumber, row.portal_id, row.status, row.attempts,
    timestamp(row.next_attempt_at, `${row.srnumber}.next_attempt_at`, true),
    row.last_error, timestamp(row.updated_at, `${row.srnumber}.updated_at`, true)
  ]));
}

async function importNumberQueue(database, client) {
  await importRows(database, client, 'live_number_queue', (db, row) => db.query(`
    INSERT INTO live_number_queue (
      suffix,srnumber,first_detected_at,audit_after,map_seen,audit_outcome,audited_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (suffix) DO UPDATE SET
      map_seen=live_number_queue.map_seen OR EXCLUDED.map_seen,
      first_detected_at=LEAST(live_number_queue.first_detected_at,EXCLUDED.first_detected_at),
      audit_after=CASE
        WHEN COALESCE(EXCLUDED.audited_at,EXCLUDED.first_detected_at) >=
             COALESCE(live_number_queue.audited_at,live_number_queue.first_detected_at)
          THEN EXCLUDED.audit_after ELSE live_number_queue.audit_after END,
      audit_outcome=CASE
        WHEN COALESCE(EXCLUDED.audited_at,EXCLUDED.first_detected_at) >=
             COALESCE(live_number_queue.audited_at,live_number_queue.first_detected_at)
          THEN EXCLUDED.audit_outcome ELSE live_number_queue.audit_outcome END,
      audited_at=CASE WHEN EXCLUDED.audited_at IS NULL THEN live_number_queue.audited_at
        ELSE GREATEST(live_number_queue.audited_at,EXCLUDED.audited_at) END
  `, [
    row.suffix, row.srnumber,
    timestamp(row.first_detected_at, `${row.srnumber}.first_detected_at`, true),
    timestamp(row.audit_after, `${row.srnumber}.audit_after`, true),
    booleanValue(row.map_seen), row.audit_outcome,
    timestamp(row.audited_at, `${row.srnumber}.audited_at`)
  ]));
}

async function importLedger(database, client) {
  await importRows(database, client, 'number_ledger', (db, row) => db.query(`
    INSERT INTO number_ledger (suffix,srnumber,outcome,attempts,http_status,error,checked_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (suffix) DO UPDATE SET
      srnumber=EXCLUDED.srnumber,
      outcome=CASE WHEN EXCLUDED.checked_at >= number_ledger.checked_at
        THEN EXCLUDED.outcome ELSE number_ledger.outcome END,
      attempts=GREATEST(number_ledger.attempts,EXCLUDED.attempts),
      http_status=CASE WHEN EXCLUDED.checked_at >= number_ledger.checked_at
        THEN EXCLUDED.http_status ELSE number_ledger.http_status END,
      error=CASE WHEN EXCLUDED.checked_at >= number_ledger.checked_at
        THEN EXCLUDED.error ELSE number_ledger.error END,
      checked_at=GREATEST(number_ledger.checked_at,EXCLUDED.checked_at)
  `, [
    row.suffix, row.srnumber, row.outcome, row.attempts, row.http_status, row.error,
    timestamp(row.checked_at, `${row.srnumber}.checked_at`, true)
  ]));
}

async function importMonitorState(database, client) {
  await importRows(database, client, 'live_monitor_state', (db, row) => db.query(`
    INSERT INTO live_monitor_state (key,value,updated_at) VALUES ($1,$2,$3)
    ON CONFLICT (key) DO UPDATE SET
      value=CASE
        WHEN EXCLUDED.key='live_frontier' THEN GREATEST(
          NULLIF(live_monitor_state.value,'')::bigint,
          NULLIF(EXCLUDED.value,'')::bigint
        )::text
        WHEN EXCLUDED.updated_at >= live_monitor_state.updated_at THEN EXCLUDED.value
        ELSE live_monitor_state.value END,
      updated_at=GREATEST(live_monitor_state.updated_at,EXCLUDED.updated_at)
  `, [row.key, row.value, timestamp(row.updated_at, `${row.key}.updated_at`, true)]));
}

async function importStatusHistory(database, client) {
  await importRows(database, client, 'request_status_history', (db, row) => db.query(`
    INSERT INTO request_status_history (
      id,srnumber,previous_status,status,source,effective_at,observed_at,snapshot_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT DO NOTHING
  `, [
    row.id, row.srnumber, row.previous_status, row.status, row.source,
    timestamp(row.effective_at, `history.${row.id}.effective_at`),
    timestamp(row.observed_at, `history.${row.id}.observed_at`, true),
    row.snapshot_json == null ? null : JSON.stringify(jsonObject(row.snapshot_json, `history.${row.id}.snapshot_json`))
  ]));
}

async function importClosureSnapshots(database, client) {
  await importRows(database, client, 'request_closure_snapshots', (db, row) => db.query(`
    INSERT INTO request_closure_snapshots (
      id,srnumber,closure_cycle,status,date_closed,source,fetched_at,is_final,
      final_state,content_hash,snapshot_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT DO NOTHING
  `, [
    row.id, row.srnumber, row.closure_cycle, row.status,
    timestamp(row.date_closed, `snapshot.${row.id}.date_closed`), row.source,
    timestamp(row.fetched_at, `snapshot.${row.id}.fetched_at`, true),
    booleanValue(row.is_final), row.final_state, row.content_hash,
    JSON.stringify(jsonObject(row.snapshot_json, `snapshot.${row.id}.snapshot_json`))
  ]));
}

async function importFollowUps(database, client) {
  await importRows(database, client, 'request_followup_queue', (db, row) => db.query(`
    INSERT INTO request_followup_queue (
      srnumber,portal_id,state,next_check_at,attempts,closing_attempts,closure_cycle,
      last_checked_at,last_success_at,last_error,finalized_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (srnumber) DO UPDATE SET
      portal_id=COALESCE(request_followup_queue.portal_id,EXCLUDED.portal_id),
      state=CASE WHEN EXCLUDED.updated_at >= request_followup_queue.updated_at
        THEN EXCLUDED.state ELSE request_followup_queue.state END,
      next_check_at=CASE WHEN EXCLUDED.updated_at >= request_followup_queue.updated_at
        THEN EXCLUDED.next_check_at ELSE request_followup_queue.next_check_at END,
      attempts=CASE WHEN EXCLUDED.updated_at >= request_followup_queue.updated_at
        THEN EXCLUDED.attempts ELSE request_followup_queue.attempts END,
      closing_attempts=CASE WHEN EXCLUDED.updated_at >= request_followup_queue.updated_at
        THEN EXCLUDED.closing_attempts ELSE request_followup_queue.closing_attempts END,
      closure_cycle=GREATEST(request_followup_queue.closure_cycle,EXCLUDED.closure_cycle),
      last_checked_at=CASE WHEN EXCLUDED.last_checked_at IS NULL THEN request_followup_queue.last_checked_at
        ELSE GREATEST(request_followup_queue.last_checked_at,EXCLUDED.last_checked_at) END,
      last_success_at=CASE WHEN EXCLUDED.last_success_at IS NULL THEN request_followup_queue.last_success_at
        ELSE GREATEST(request_followup_queue.last_success_at,EXCLUDED.last_success_at) END,
      last_error=CASE WHEN EXCLUDED.updated_at >= request_followup_queue.updated_at
        THEN EXCLUDED.last_error ELSE request_followup_queue.last_error END,
      finalized_at=COALESCE(request_followup_queue.finalized_at,EXCLUDED.finalized_at),
      updated_at=GREATEST(request_followup_queue.updated_at,EXCLUDED.updated_at)
  `, [
    row.srnumber, row.portal_id, row.state,
    timestamp(row.next_check_at, `${row.srnumber}.next_check_at`), row.attempts,
    row.closing_attempts, row.closure_cycle,
    timestamp(row.last_checked_at, `${row.srnumber}.last_checked_at`),
    timestamp(row.last_success_at, `${row.srnumber}.last_success_at`), row.last_error,
    timestamp(row.finalized_at, `${row.srnumber}.finalized_at`),
    timestamp(row.updated_at, `${row.srnumber}.updated_at`, true)
  ]));
}

async function resetSequences(client) {
  for (const table of ['request_status_history', 'request_closure_snapshots']) {
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('${table}','id'),
        GREATEST(COALESCE((SELECT MAX(id) FROM ${table}),0),1),
        EXISTS (SELECT 1 FROM ${table})
      )
    `);
  }
}

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) throw new Error(`SQLite snapshot does not exist: ${SQLITE_PATH}`);
  const walPath = `${SQLITE_PATH}-wal`;
  if (!ALLOW_LIVE_SQLITE_IMPORT && fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error(
      `Refusing to import an active/incomplete WAL database (${walPath}). ` +
      'Run the SQLite finalizer and import its standalone backup instead.'
    );
  }

  await migrate();
  const sourceHash = await sha256File(SQLITE_PATH);
  const runId = crypto.randomUUID();
  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  sqlite.exec('PRAGMA query_only=ON; BEGIN');
  requireSourceSchema(sqlite);
  const source = sourceManifest(sqlite);
  await query(`
    INSERT INTO sqlite_import_runs (
      run_id,source_sha256,source_name,source_manifest,started_at,status
    ) VALUES ($1,$2,$3,$4::jsonb,NOW(),'running')
  `, [runId, sourceHash, path.basename(SQLITE_PATH), JSON.stringify(source)]);

  try {
    const target = await transaction(async client => {
      const lock = await client.query(
        'SELECT pg_try_advisory_xact_lock($1) AS acquired',
        [WORKER_LOCK_ID]
      );
      if (!lock.rows[0].acquired) {
        throw new Error('The cloud collector is running. Scale it to zero before importing.');
      }

      await importLiveRequests(sqlite, client);
      await importPortalRequests(sqlite, client);
      await importDetailQueue(sqlite, client);
      await importNumberQueue(sqlite, client);
      await importLedger(sqlite, client);
      await importMonitorState(sqlite, client);
      await importStatusHistory(sqlite, client);
      await importClosureSnapshots(sqlite, client);
      await importFollowUps(sqlite, client);
      await resetSequences(client);

      for (const table of TABLES) await verifySourceKeys(sqlite, client, table);
      return targetManifest(client);
    });
    sqlite.exec('COMMIT');
    await query(`
      UPDATE sqlite_import_runs
      SET target_manifest=$2::jsonb,completed_at=NOW(),status='completed'
      WHERE run_id=$1
    `, [runId, JSON.stringify(target)]);
    console.log(JSON.stringify({
      import_complete: true,
      run_id: runId,
      sqlite: SQLITE_PATH,
      source_sha256: sourceHash,
      source_manifest: source,
      target_manifest: target
    }));
  } catch (error) {
    try { sqlite.exec('ROLLBACK'); } catch (_) {}
    await query(`
      UPDATE sqlite_import_runs
      SET completed_at=NOW(),status='failed',error=$2 WHERE run_id=$1
    `, [runId, error.message]).catch(() => {});
    throw error;
  } finally {
    sqlite.close();
  }
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    })
    .finally(close);
}

module.exports = {
  TABLES,
  booleanValue,
  jsonObject,
  liveSource,
  requireSourceSchema,
  sourceManifest,
  timestamp
};
