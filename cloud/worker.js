const { pool, query, transaction, close } = require('./db');
const {
  normalizePortalTimestamp,
  fetchLatestPins,
  fetchDetailById,
  fetchDetailByNumber
} = require('./portal');
const { isClosedStatus, statusesMatch } = require('../closure-tracking');
const {
  getFollowUp,
  markFollowUpError,
  normalizeOpenFollowUps,
  observeStatus,
  queueMapStatusChange,
  scheduleAfterDetail
} = require('./closure-tracking');

const DEFAULT_POLL_SECONDS = Math.max(5, Number(process.env.POLL_INTERVAL_SECONDS || 15));
const AUDIT_DELAY_MINUTES = Math.max(5, Number(process.env.AUDIT_DELAY_MINUTES || 35));
const DETAIL_DELAY_MS = Math.max(500, Number(process.env.DETAIL_REQUEST_DELAY_MS || 750));
const AUDIT_DELAY_MS = Math.max(500, Number(process.env.AUDIT_REQUEST_DELAY_MS || 750));
const WORKER_LOCK_ID = 31120260720;
let stopping = false;

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

function finiteCoordinate(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function currentPollIntervalSeconds() {
  const result = await query("SELECT value FROM live_monitor_state WHERE key = 'poll_interval_seconds'");
  const interval = Number(result.rows[0] && result.rows[0].value);
  return [5, 10, 15, 30, 60].includes(interval) ? interval : DEFAULT_POLL_SECONDS;
}

async function savePoll(pins) {
  const observedAt = new Date();
  const auditAfter = new Date(observedAt.getTime() + AUDIT_DELAY_MINUTES * 60_000);
  const numbered = pins.map(pin => ({ pin, suffix: suffixOf(pin.data && pin.data.srnumber) }))
    .filter(item => item.suffix !== null);
  const highest = numbered.length ? Math.max(...numbered.map(item => item.suffix)) : null;

  return transaction(async client => {
    const stateResult = await client.query(
      "SELECT value FROM live_monitor_state WHERE key = 'live_frontier' FOR UPDATE"
    );
    const previousFrontier = stateResult.rowCount ? Number(stateResult.rows[0].value) : null;
    let newMapRecords = 0;
    let statusChanges = 0;
    let closureRefreshesQueued = 0;

    for (const { pin, suffix } of numbered) {
      const data = pin.data || {};
      const srnumber = data.srnumber;
      const previous = await client.query(
        'SELECT status,portal_id FROM live_portal_requests WHERE srnumber = $1',
        [srnumber]
      );
      const previousStatus = previous.rows[0] ? previous.rows[0].status : null;
      if (!previous.rowCount) newMapRecords += 1;
      const latitude = finiteCoordinate(pin.latitude);
      const longitude = finiteCoordinate(pin.longitude);
      const statusChanged = Boolean(
        data.status && (!previous.rowCount || !statusesMatch(previousStatus, data.status))
      );

      await client.query(`
        INSERT INTO live_portal_requests (
          srnumber, suffix, portal_id, problem, address, latitude, longitude, location,
          submitted_at, status, portal_url, source, first_seen_at, last_seen_at, raw_json
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          CASE WHEN $6::double precision IS NOT NULL AND $7::double precision IS NOT NULL
            THEN ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography ELSE NULL END,
          $8, $9, $10, 'map', $11, $11, $12::jsonb
        )
        ON CONFLICT (srnumber) DO UPDATE SET
          suffix = EXCLUDED.suffix,
          portal_id = COALESCE(EXCLUDED.portal_id, live_portal_requests.portal_id),
          problem = COALESCE(EXCLUDED.problem, live_portal_requests.problem),
          address = COALESCE(EXCLUDED.address, live_portal_requests.address),
          latitude = COALESCE(EXCLUDED.latitude,live_portal_requests.latitude),
          longitude = COALESCE(EXCLUDED.longitude,live_portal_requests.longitude),
          location = COALESCE(EXCLUDED.location,live_portal_requests.location),
          submitted_at = COALESCE(EXCLUDED.submitted_at, live_portal_requests.submitted_at),
          status = COALESCE(EXCLUDED.status, live_portal_requests.status),
          portal_url = COALESCE(EXCLUDED.portal_url, live_portal_requests.portal_url),
          source = 'map',
          last_seen_at = EXCLUDED.last_seen_at,
          raw_json = EXCLUDED.raw_json
      `, [
        srnumber, suffix, pin.id || null, data.problem || pin.label || null,
        data.address || pin.sublabel || null, latitude, longitude,
        normalizePortalTimestamp(data.submitteddate), data.status || null,
        pin.id ? `https://portal.311.nyc.gov/sr-details/?id=${pin.id}` : null,
        observedAt, JSON.stringify(pin)
      ]);

      if (statusChanged) {
        const added = await observeStatus(client, {
          srnumber,
          previousStatus,
          status: data.status,
          source: 'map',
          observedAt,
          snapshot: pin
        });
        if (added && previous.rowCount) statusChanges += 1;
        const queuedClosure = await queueMapStatusChange(client, {
          srnumber,
          portalId: pin.id || (previous.rows[0] && previous.rows[0].portal_id),
          previousStatus,
          status: data.status,
          observedAt
        });
        if (queuedClosure && isClosedStatus(data.status)) closureRefreshesQueued += 1;
      }

      await client.query(`
        INSERT INTO live_detail_queue (
          srnumber, portal_id, status, attempts, next_attempt_at, last_error, updated_at
        ) VALUES ($1, $2, 'pending', 0, $3, NULL, $3)
        ON CONFLICT (srnumber) DO UPDATE SET
          portal_id = COALESCE(EXCLUDED.portal_id, live_detail_queue.portal_id),
          updated_at = EXCLUDED.updated_at
      `, [srnumber, pin.id || null, observedAt]);

      await client.query(`
        INSERT INTO number_ledger (suffix, srnumber, outcome, attempts, http_status, error, checked_at)
        VALUES ($1, $2, 'found', 0, 200, NULL, $3)
        ON CONFLICT (suffix) DO UPDATE SET
          srnumber = EXCLUDED.srnumber, outcome = 'found', http_status = 200,
          error = NULL, checked_at = EXCLUDED.checked_at
      `, [suffix, srnumber, observedAt]);
      await client.query(`
        UPDATE live_number_queue
        SET map_seen=TRUE,
            audit_outcome=CASE WHEN audit_outcome='pending' THEN 'found_map' ELSE audit_outcome END,
            audited_at=CASE WHEN audit_outcome='pending' THEN $2 ELSE audited_at END
        WHERE suffix=$1
      `, [suffix, observedAt]);
    }

    let queued = 0;
    if (highest !== null && previousFrontier !== null && highest > previousFrontier) {
      const mapSuffixes = numbered.map(item => item.suffix);
      const inserted = await client.query(`
        INSERT INTO live_number_queue (
          suffix, srnumber, first_detected_at, audit_after, map_seen
        )
        SELECT series, '311-' || LPAD(series::text, 8, '0'), $3, $4,
               series = ANY($5::bigint[])
        FROM generate_series($1::bigint, $2::bigint) AS series
        ON CONFLICT (suffix) DO UPDATE SET
          map_seen = live_number_queue.map_seen OR EXCLUDED.map_seen
        RETURNING suffix
      `, [previousFrontier + 1, highest, observedAt, auditAfter, mapSuffixes]);
      queued = inserted.rowCount;
    }

    if (highest !== null && (previousFrontier === null || highest > previousFrontier)) {
      await client.query(`
        INSERT INTO live_monitor_state (key, value, updated_at)
        VALUES ('live_frontier', $1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
      `, [String(highest), observedAt]);
    }
    await client.query(`
      INSERT INTO live_monitor_state (key, value, updated_at)
      VALUES ('last_successful_poll_at', $1, $1)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at
    `, [observedAt]);
    await client.query(`
      UPDATE live_number_queue
      SET audit_outcome = 'found_map', audited_at = $1
      WHERE map_seen = TRUE AND audit_outcome = 'pending'
    `, [observedAt]);

    return {
      highest,
      previousFrontier,
      newMapRecords,
      queued,
      statusChanges,
      closureRefreshesQueued
    };
  });
}

async function claimDetailWork() {
  return transaction(async client => {
    let selected = await client.query(`
      SELECT queue.*,live.suffix,
             COALESCE((SELECT MAX(id) FROM request_status_history history
                       WHERE history.srnumber=queue.srnumber),0) AS status_version,
             'closing'::text AS work_kind
      FROM request_followup_queue AS queue
      JOIN live_portal_requests AS live USING (srnumber)
      WHERE queue.state='closing' AND queue.next_check_at<=NOW()
      ORDER BY queue.next_check_at,live.suffix DESC
      FOR UPDATE OF queue SKIP LOCKED LIMIT 1
    `);
    if (!selected.rowCount) selected = await client.query(`
      SELECT queue.srnumber,queue.portal_id,queue.attempts,queue.updated_at,live.suffix,
             COALESCE((SELECT MAX(id) FROM request_status_history history
                       WHERE history.srnumber=queue.srnumber),0) AS status_version,
             'initial'::text AS work_kind
      FROM live_detail_queue AS queue
      JOIN live_portal_requests AS live ON live.srnumber = queue.srnumber
      WHERE queue.status IN ('pending', 'retry')
        AND queue.next_attempt_at <= NOW()
        AND NOT EXISTS (
          SELECT 1 FROM request_followup_queue followup
          WHERE followup.srnumber=queue.srnumber
            AND followup.last_checked_at IS NOT NULL
        )
      ORDER BY live.suffix DESC
      FOR UPDATE OF queue SKIP LOCKED
      LIMIT 1
    `);
    if (!selected.rowCount) selected = await client.query(`
      SELECT queue.*,live.suffix,
             COALESCE((SELECT MAX(id) FROM request_status_history history
                       WHERE history.srnumber=queue.srnumber),0) AS status_version,
             'followup'::text AS work_kind
      FROM request_followup_queue AS queue
      JOIN live_portal_requests AS live USING (srnumber)
      WHERE queue.state='open' AND queue.next_check_at<=NOW()
      ORDER BY queue.next_check_at,live.suffix DESC
      FOR UPDATE OF queue SKIP LOCKED LIMIT 1
    `);
    if (!selected.rowCount) return null;
    const row = selected.rows[0];
    if (row.work_kind === 'initial') {
      await client.query(
        "UPDATE live_detail_queue SET status='working',updated_at=NOW() WHERE srnumber=$1",
        [row.srnumber]
      );
    }
    return row;
  });
}

async function fetchDetailWork(row) {
  const result = row.portal_id
    ? await fetchDetailById(row.srnumber, row.portal_id)
    : await fetchDetailByNumber(row.srnumber);
  if (result.outcome !== 'found') throw new Error(result.error || 'Portal detail was not found');
  if (result.record.srnumber !== row.srnumber) {
    throw new Error(`Portal returned ${result.record.srnumber} while ${row.srnumber} was requested`);
  }
  return result.record.dateClosed && !isClosedStatus(result.record.status)
    ? { ...result.record, status: 'Closed' }
    : result.record;
}

async function persistDetail(row, detail) {
  const now = new Date();
  return transaction(async client => {
    const currentResult = await client.query(
      'SELECT status,portal_id FROM live_portal_requests WHERE srnumber=$1 FOR UPDATE',
      [row.srnumber]
    );
    if (!currentResult.rowCount) throw new Error(`Missing live request ${row.srnumber}`);
    const current = currentResult.rows[0];
    const currentStatusVersion = await client.query(
      'SELECT COALESCE(MAX(id),0)::bigint AS version FROM request_status_history WHERE srnumber=$1',
      [row.srnumber]
    );
    const currentFollowUp = await getFollowUp(client, row.srnumber, true);
    const statusChangedInFlight = Number(currentStatusVersion.rows[0].version) !== Number(row.status_version);
    const followUpChangedInFlight = row.work_kind !== 'initial' && (
      !currentFollowUp || currentFollowUp.state !== row.state
      || Number(currentFollowUp.closure_cycle) !== Number(row.closure_cycle)
      || new Date(currentFollowUp.updated_at).getTime() !== new Date(row.updated_at).getTime()
    );
    if (statusChangedInFlight || followUpChangedInFlight) {
      return { stale: true, finalized: false, snapshotAdded: false };
    }

    const preserveMapClosure = isClosedStatus(current.status)
      && !isClosedStatus(detail.status)
      && currentFollowUp
      && currentFollowUp.state === 'closing';
    const effectiveStatus = preserveMapClosure
      ? current.status
      : (detail.status || current.status || null);

    if (detail.status && !preserveMapClosure && !statusesMatch(current.status, detail.status)) {
      await observeStatus(client, {
        srnumber: row.srnumber,
        previousStatus: current.status,
        status: detail.status,
        source: 'detail',
        effectiveAt: isClosedStatus(detail.status)
          ? (detail.dateClosed || detail.updatedOn)
          : detail.updatedOn,
        observedAt: now,
        snapshot: detail
      });
      await client.query(
        'UPDATE live_portal_requests SET status=$2 WHERE srnumber=$1',
        [row.srnumber, detail.status]
      );
    }

    const portalUrl = detail.portalId
      ? `https://portal.311.nyc.gov/sr-details/?id=${detail.portalId}`
      : `https://portal.311.nyc.gov/sr-details/?srnum=${detail.srnumber}`;
    await client.query(`
      INSERT INTO portal_requests (
        srnumber, suffix, portal_id, status, problem, problem_details,
        additional_details, address, next_update, date_reported, updated_on,
        date_closed, fields_json, portal_url, archived_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
      ON CONFLICT (srnumber) DO UPDATE SET
        portal_id=COALESCE(EXCLUDED.portal_id,portal_requests.portal_id),
        status=CASE WHEN portal_requests.date_closed IS NOT NULL AND EXCLUDED.date_closed IS NULL
          THEN portal_requests.status ELSE COALESCE(EXCLUDED.status,portal_requests.status) END,
        problem=COALESCE(EXCLUDED.problem,portal_requests.problem),
        problem_details=COALESCE(EXCLUDED.problem_details,portal_requests.problem_details),
        additional_details=COALESCE(EXCLUDED.additional_details,portal_requests.additional_details),
        address=COALESCE(EXCLUDED.address,portal_requests.address),
        next_update=COALESCE(EXCLUDED.next_update,portal_requests.next_update),
        date_reported=COALESCE(EXCLUDED.date_reported,portal_requests.date_reported),
        updated_on=COALESCE(EXCLUDED.updated_on,portal_requests.updated_on),
        date_closed=COALESCE(EXCLUDED.date_closed,portal_requests.date_closed),
        fields_json=portal_requests.fields_json || EXCLUDED.fields_json,
        portal_url=COALESCE(EXCLUDED.portal_url,portal_requests.portal_url),
        archived_at=EXCLUDED.archived_at
    `, [
      detail.srnumber, row.suffix, detail.portalId, detail.status, detail.problem,
      detail.problemDetails, detail.additionalDetails, detail.address, detail.nextUpdate,
      detail.dateReported, detail.updatedOn, detail.dateClosed, JSON.stringify(detail.fields),
      portalUrl, now
    ]);
    if (row.work_kind === 'initial') {
      await client.query(`
        UPDATE live_detail_queue
        SET status='found',attempts=attempts+1,last_error=NULL,updated_at=$2
        WHERE srnumber=$1
      `, [row.srnumber, now]);
    }
    const result = await scheduleAfterDetail(client, {
      srnumber: row.srnumber,
      portalId: detail.portalId,
      effectiveStatus,
      detail,
      source: row.work_kind === 'closing' ? 'closure_followup' : 'detail',
      checkedAt: now
    });
    return { stale: false, ...result };
  });
}

async function failDetail(row, error) {
  if (row.work_kind === 'closing' || row.work_kind === 'followup') {
    return transaction(async client => {
      const current = await getFollowUp(client, row.srnumber, true);
      const currentVersion = await client.query(
        'SELECT COALESCE(MAX(id),0)::bigint AS version FROM request_status_history WHERE srnumber=$1',
        [row.srnumber]
      );
      if (!current || current.state !== row.state
          || Number(current.closure_cycle) !== Number(row.closure_cycle)
          || new Date(current.updated_at).getTime() !== new Date(row.updated_at).getTime()
          || Number(currentVersion.rows[0].version) !== Number(row.status_version)) return false;
      await markFollowUpError(client, row, error, new Date());
      return true;
    });
  }
  const attempts = Number(row.attempts || 0);
  const retryDelay = Math.min(15 * 60_000, 30_000 * (2 ** Math.min(attempts, 5)));
  await query(`
    UPDATE live_detail_queue
    SET status = 'retry', attempts = attempts + 1,
        next_attempt_at = $2, last_error = $3, updated_at = NOW()
    WHERE srnumber = $1
  `, [row.srnumber, new Date(Date.now() + retryDelay), error.message]);
  return true;
}

async function claimAuditRequest() {
  return transaction(async client => {
    const selected = await client.query(`
      SELECT suffix, srnumber
      FROM live_number_queue
      WHERE map_seen = FALSE AND audit_outcome = 'pending' AND audit_after <= NOW()
      ORDER BY suffix
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    if (!selected.rowCount) return null;
    const row = selected.rows[0];
    await client.query(
      "UPDATE live_number_queue SET audit_outcome = 'working' WHERE suffix = $1",
      [row.suffix]
    );
    return row;
  });
}

async function persistAudit(row, result) {
  const now = new Date();
  await transaction(async client => {
    if (result.outcome === 'found') {
      const detail = result.record.dateClosed && !isClosedStatus(result.record.status)
        ? { ...result.record, status: 'Closed' }
        : result.record;
      const previousResult = await client.query(
        'SELECT status FROM live_portal_requests WHERE srnumber=$1 FOR UPDATE',
        [detail.srnumber]
      );
      const previousStatus = previousResult.rowCount ? previousResult.rows[0].status : null;
      const portalUrl = detail.portalId
        ? `https://portal.311.nyc.gov/sr-details/?id=${detail.portalId}`
        : `https://portal.311.nyc.gov/sr-details/?srnum=${detail.srnumber}`;
      await client.query(`
        INSERT INTO live_portal_requests (
          srnumber, suffix, portal_id, problem, address, submitted_at, status,
          portal_url, source, first_seen_at, last_seen_at, raw_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'number_audit',$9,$9,$10::jsonb)
        ON CONFLICT (srnumber) DO UPDATE SET
          portal_id = COALESCE(EXCLUDED.portal_id, live_portal_requests.portal_id),
          problem = COALESCE(EXCLUDED.problem, live_portal_requests.problem),
          address = COALESCE(EXCLUDED.address, live_portal_requests.address),
          submitted_at = COALESCE(EXCLUDED.submitted_at, live_portal_requests.submitted_at),
          status = CASE
            WHEN live_portal_requests.status IS NOT NULL AND EXCLUDED.status IS NULL
              THEN live_portal_requests.status
            ELSE COALESCE(EXCLUDED.status,live_portal_requests.status) END,
          portal_url = COALESCE(EXCLUDED.portal_url, live_portal_requests.portal_url),
          last_seen_at = EXCLUDED.last_seen_at
      `, [
        detail.srnumber, row.suffix, detail.portalId, detail.problem, detail.address,
        detail.dateReported, detail.status, portalUrl,
        now, JSON.stringify({ source: 'number_audit' })
      ]);
      await client.query(`
        INSERT INTO portal_requests (
          srnumber, suffix, portal_id, status, problem, problem_details,
          additional_details, address, next_update, date_reported, updated_on,
          date_closed, fields_json, portal_url, archived_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
        ON CONFLICT (srnumber) DO UPDATE SET
          portal_id=COALESCE(EXCLUDED.portal_id,portal_requests.portal_id),
          status=CASE WHEN portal_requests.date_closed IS NOT NULL AND EXCLUDED.date_closed IS NULL
            THEN portal_requests.status ELSE COALESCE(EXCLUDED.status,portal_requests.status) END,
          problem=COALESCE(EXCLUDED.problem,portal_requests.problem),
          problem_details=COALESCE(EXCLUDED.problem_details,portal_requests.problem_details),
          additional_details=COALESCE(EXCLUDED.additional_details,portal_requests.additional_details),
          address=COALESCE(EXCLUDED.address,portal_requests.address),
          next_update=COALESCE(EXCLUDED.next_update,portal_requests.next_update),
          date_reported=COALESCE(EXCLUDED.date_reported,portal_requests.date_reported),
          updated_on=COALESCE(EXCLUDED.updated_on,portal_requests.updated_on),
          date_closed=COALESCE(EXCLUDED.date_closed,portal_requests.date_closed),
          fields_json=portal_requests.fields_json || EXCLUDED.fields_json,
          portal_url=COALESCE(EXCLUDED.portal_url,portal_requests.portal_url),
          archived_at=EXCLUDED.archived_at
      `, [
        detail.srnumber, row.suffix, detail.portalId, detail.status, detail.problem,
        detail.problemDetails, detail.additionalDetails, detail.address, detail.nextUpdate,
        detail.dateReported, detail.updatedOn, detail.dateClosed, JSON.stringify(detail.fields),
        portalUrl, now
      ]);
      if (detail.status) {
        await observeStatus(client, {
          srnumber: detail.srnumber,
          previousStatus,
          status: detail.status,
          source: 'number_audit',
          effectiveAt: isClosedStatus(detail.status)
            ? (detail.dateClosed || detail.updatedOn)
            : detail.updatedOn,
          observedAt: now,
          snapshot: detail
        });
      }
      await client.query(`
        INSERT INTO live_detail_queue (
          srnumber,portal_id,status,attempts,next_attempt_at,last_error,updated_at
        ) VALUES ($1,$2,'found',1,$3,NULL,$3)
        ON CONFLICT (srnumber) DO UPDATE SET
          portal_id=COALESCE(EXCLUDED.portal_id,live_detail_queue.portal_id),
          status='found',attempts=GREATEST(live_detail_queue.attempts,1),
          last_error=NULL,updated_at=EXCLUDED.updated_at
      `, [detail.srnumber, detail.portalId, now]);
      await scheduleAfterDetail(client, {
        srnumber: detail.srnumber,
        portalId: detail.portalId,
        effectiveStatus: detail.status,
        detail,
        source: 'number_audit',
        checkedAt: now
      });
    }
    await client.query(`
      INSERT INTO number_ledger (suffix, srnumber, outcome, attempts, http_status, error, checked_at)
      VALUES ($1,$2,$3,1,$4,$5,$6)
      ON CONFLICT (suffix) DO UPDATE SET
        outcome=EXCLUDED.outcome, attempts=number_ledger.attempts+1,
        http_status=EXCLUDED.http_status, error=EXCLUDED.error, checked_at=EXCLUDED.checked_at
    `, [row.suffix, row.srnumber, result.outcome, result.httpStatus || 200, result.error || null, now]);
    await client.query(`
      UPDATE live_number_queue SET audit_outcome=$2, audited_at=$3 WHERE suffix=$1
    `, [row.suffix, result.outcome, now]);
  });
}

async function pollLoop() {
  let poll = 0;
  while (!stopping) {
    try {
      const pins = await fetchLatestPins();
      const result = await savePoll(pins);
      poll += 1;
      console.log(JSON.stringify({ poll, observed_at: new Date().toISOString(), feed_records: pins.length, ...result }));
    } catch (error) {
      console.error(JSON.stringify({ poll: poll + 1, portal_poll_error: error.message }));
    }
    await sleep((await currentPollIntervalSeconds()) * 1000);
  }
}

async function detailLoop() {
  while (!stopping) {
    const row = await claimDetailWork();
    if (!row) {
      await sleep(2000);
      continue;
    }
    try {
      const detail = await fetchDetailWork(row);
      const result = await persistDetail(row, detail);
      if (result && !result.stale && (result.snapshotAdded || result.finalized)) {
        console.log(JSON.stringify({
          closure_refresh: row.srnumber,
          source: row.work_kind,
          status: detail.status,
          date_closed: detail.dateClosed,
          finalized: result.finalized,
          snapshot_added: result.snapshotAdded
        }));
      }
    } catch (error) {
      await failDetail(row, error);
    }
    await sleep(DETAIL_DELAY_MS);
  }
}

async function auditLoop() {
  while (!stopping) {
    const row = await claimAuditRequest();
    if (!row) {
      await sleep(5000);
      continue;
    }
    try {
      const result = await fetchDetailByNumber(row.srnumber);
      if (result.outcome === 'retry') throw new Error(result.error || 'Portal audit response was inconclusive');
      await persistAudit(row, result);
    } catch (error) {
      await query(`
        UPDATE live_number_queue
        SET audit_outcome='pending', audit_after=NOW()+INTERVAL '1 minute'
        WHERE suffix=$1
      `, [row.suffix]);
      await query(`
        INSERT INTO number_ledger (suffix,srnumber,outcome,attempts,http_status,error,checked_at)
        VALUES ($1,$2,'retry',1,NULL,$3,NOW())
        ON CONFLICT (suffix) DO UPDATE SET outcome='retry', attempts=number_ledger.attempts+1,
          error=EXCLUDED.error, checked_at=EXCLUDED.checked_at
      `, [row.suffix, row.srnumber, error.message]);
    }
    await sleep(AUDIT_DELAY_MS);
  }
}

async function seedClosureTracking() {
  return transaction(async client => {
    const now = new Date();
    const missingHistory = await client.query(`
      SELECT live.srnumber,live.status,live.first_seen_at
      FROM live_portal_requests live
      WHERE live.status IS NOT NULL AND BTRIM(live.status)<>''
        AND NOT EXISTS (
          SELECT 1 FROM request_status_history history WHERE history.srnumber=live.srnumber
        )
      ORDER BY live.suffix
    `);
    for (const row of missingHistory.rows) {
      await observeStatus(client, {
        srnumber: row.srnumber,
        previousStatus: null,
        status: row.status,
        source: 'migration',
        observedAt: row.first_seen_at || now
      });
    }

    const missingFollowUps = await client.query(`
      SELECT live.srnumber,live.portal_id,live.status AS live_status,
             detail.status AS detail_status,detail.problem,detail.problem_details,
             detail.additional_details,detail.address,detail.next_update,
             detail.date_reported,detail.updated_on,detail.date_closed,
             detail.fields_json,detail.archived_at
      FROM live_portal_requests live
      JOIN portal_requests detail USING (srnumber)
      LEFT JOIN request_followup_queue followup USING (srnumber)
      WHERE followup.srnumber IS NULL
      ORDER BY live.suffix
    `);
    for (const row of missingFollowUps.rows) {
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
        fields: row.fields_json || {}
      };
      let effectiveStatus = row.live_status || detail.status;
      if (isClosedStatus(detail.status) && !isClosedStatus(row.live_status)) {
        await observeStatus(client, {
          srnumber: row.srnumber,
          previousStatus: row.live_status,
          status: detail.status,
          source: 'stored_detail',
          effectiveAt: row.date_closed || row.updated_on,
          observedAt: row.archived_at || now,
          snapshot: detail
        });
        await client.query(
          'UPDATE live_portal_requests SET status=$2 WHERE srnumber=$1',
          [row.srnumber, detail.status]
        );
        effectiveStatus = detail.status;
      }
      if (isClosedStatus(effectiveStatus) && !isClosedStatus(detail.status)) {
        await queueMapStatusChange(client, {
          srnumber: row.srnumber,
          portalId: row.portal_id,
          previousStatus: 'Open',
          status: effectiveStatus,
          observedAt: now
        });
      } else {
        await scheduleAfterDetail(client, {
          srnumber: row.srnumber,
          portalId: row.portal_id,
          effectiveStatus,
          detail,
          source: 'migration',
          checkedAt: row.archived_at || now
        });
      }
    }
    const missingProvisionalFollowUps = await client.query(`
      SELECT live.srnumber,live.portal_id,live.status,
             COALESCE(live.last_seen_at,live.first_seen_at,$1) AS observed_at
      FROM live_portal_requests live
      LEFT JOIN request_followup_queue followup USING (srnumber)
      WHERE followup.srnumber IS NULL
        AND live.status IS NOT NULL AND BTRIM(live.status)<>''
      ORDER BY live.suffix
    `, [now]);
    let provisionalFollowUpsSeeded = 0;
    for (const row of missingProvisionalFollowUps.rows) {
      if (await queueMapStatusChange(client, {
        srnumber: row.srnumber,
        portalId: row.portal_id,
        previousStatus: null,
        status: row.status,
        observedAt: row.observed_at
      })) provisionalFollowUpsSeeded += 1;
    }
    const openFollowUpsRescheduled = await normalizeOpenFollowUps(client, now);
    return {
      historySeeded: missingHistory.rowCount,
      followUpsSeeded: missingFollowUps.rowCount,
      provisionalFollowUpsSeeded,
      openFollowUpsRescheduled
    };
  });
}

async function main() {
  const schema = await query(`
    SELECT to_regclass('public.request_followup_queue') IS NOT NULL AS ready
  `);
  if (!schema.rows[0].ready) {
    throw new Error('Database schema is not ready; run npm run cloud:migrate before starting the worker');
  }
  const lockClient = await pool.connect();
  const lock = await lockClient.query('SELECT pg_try_advisory_lock($1) AS acquired', [WORKER_LOCK_ID]);
  if (!lock.rows[0].acquired) {
    lockClient.release();
    throw new Error('Another cloud collector already owns the database worker lock');
  }
  await query("UPDATE live_detail_queue SET status='retry', next_attempt_at=NOW() WHERE status='working'");
  const detailQueueReconciled = await query(`
    UPDATE live_detail_queue AS queue
    SET status='found', last_error=NULL, updated_at=NOW()
    FROM portal_requests AS details
    WHERE details.srnumber=queue.srnumber AND queue.status<>'found'
  `);
  await query("UPDATE live_number_queue SET audit_outcome='pending', audit_after=NOW() WHERE audit_outcome='working'");
  await query(`
    INSERT INTO live_monitor_state (key,value,updated_at)
    VALUES ('poll_interval_seconds',$1,NOW()) ON CONFLICT (key) DO NOTHING
  `, [String(DEFAULT_POLL_SECONDS)]);
  const seeded = await seedClosureTracking();
  let lockLost = false;
  lockClient.on('error', error => {
    lockLost = true;
    stopping = true;
    process.exitCode = 1;
    console.error(JSON.stringify({ worker_leadership_connection_lost: error.message }));
  });
  console.log(JSON.stringify({
    cloud_worker: 'started',
    poll_interval_seconds: await currentPollIntervalSeconds(),
    detail_queue_reconciled: detailQueueReconciled.rowCount,
    status_history_seeded: seeded.historySeeded,
    followups_seeded: seeded.followUpsSeeded,
    open_followups_rescheduled: seeded.openFollowUpsRescheduled
  }));
  try {
    await Promise.all([pollLoop(), detailLoop(), auditLoop()]);
  } finally {
    if (!lockLost) {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK_ID]).catch(() => {});
    }
    lockClient.release();
  }
}

function stop() {
  stopping = true;
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(close);
