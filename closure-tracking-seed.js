'use strict';

const { isClosedStatus } = require('./closure-tracking');

const SEED_MISSING_STATUS_HISTORY_SQL = `
  INSERT INTO request_status_history (
    srnumber,previous_status,status,source,effective_at,observed_at,snapshot_json
  )
  SELECT live.srnumber,NULL,live.status,'migration',NULL,
         COALESCE(live.first_seen_at,?),NULL
  FROM live_portal_requests AS live
  WHERE live.status IS NOT NULL AND TRIM(live.status)<>''
    AND NOT EXISTS (
      SELECT 1
      FROM request_status_history AS history
      WHERE history.srnumber=live.srnumber
    )
`;

const DETAIL_ROWS_WITHOUT_FOLLOWUP_SQL = `
  SELECT live.srnumber, live.portal_id, live.status AS live_status,
         details.status AS detail_status, details.problem, details.problem_details,
         details.additional_details, details.address, details.next_update,
         details.date_reported, details.updated_on, details.date_closed,
         details.fields_json, details.archived_at
  FROM live_portal_requests AS live
  JOIN portal_requests AS details ON details.srnumber=live.srnumber
  WHERE NOT EXISTS (
    SELECT 1
    FROM request_followup_queue AS followup
    WHERE followup.srnumber=live.srnumber
  )
`;

const LIVE_ROWS_WITHOUT_FOLLOWUP_SQL = `
  SELECT live.srnumber, live.portal_id, live.status,
         COALESCE(live.last_seen_at,live.first_seen_at,?) AS observed_at
  FROM live_portal_requests AS live
  WHERE live.status IS NOT NULL AND TRIM(live.status)<>''
    AND NOT EXISTS (
      SELECT 1
      FROM request_followup_queue AS followup
      WHERE followup.srnumber=live.srnumber
    )
  ORDER BY live.suffix
`;

function safelyParseFields(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function seedClosureTracking({
  db,
  closureTracker,
  updateLiveStatus,
  now = new Date()
}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('db must be an open SQLite database');
  }
  if (!closureTracker || typeof closureTracker.observeStatus !== 'function') {
    throw new TypeError('closureTracker is required');
  }
  if (!updateLiveStatus || typeof updateLiveStatus.run !== 'function') {
    throw new TypeError('updateLiveStatus must be a prepared statement');
  }

  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const seedMissingStatusHistory = db.prepare(SEED_MISSING_STATUS_HISTORY_SQL);
  const detailRowsWithoutFollowUp = db.prepare(DETAIL_ROWS_WITHOUT_FOLLOWUP_SQL);
  const liveRowsWithoutFollowUp = db.prepare(LIVE_ROWS_WITHOUT_FOLLOWUP_SQL);
  let statusRows = 0;
  let followUpsSeeded = 0;
  let provisionalFollowUpsSeeded = 0;

  // Take the writer reservation before reading either seed snapshot. Otherwise,
  // a concurrent email write can advance the WAL between SELECT and INSERT and
  // turn this startup repair into SQLITE_BUSY_SNAPSHOT.
  db.exec('BEGIN IMMEDIATE');
  try {
    statusRows = Number(seedMissingStatusHistory.run(nowIso).changes || 0);
    const detailRows = detailRowsWithoutFollowUp.all();
    followUpsSeeded = detailRows.length;
    for (const row of detailRows) {
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
        fields: safelyParseFields(row.fields_json)
      };
      let effectiveStatus = row.live_status || detail.status;
      if (isClosedStatus(detail.status) && !isClosedStatus(row.live_status)) {
        closureTracker.observeStatus({
          srnumber: row.srnumber,
          previousStatus: row.live_status,
          status: detail.status,
          source: 'stored_detail',
          effectiveAt: row.date_closed || row.updated_on,
          observedAt: row.archived_at || nowIso,
          snapshot: detail
        });
        updateLiveStatus.run(detail.status, row.srnumber);
        effectiveStatus = detail.status;
      }
      if (isClosedStatus(effectiveStatus) && !isClosedStatus(detail.status)) {
        closureTracker.queueMapStatusChange({
          srnumber: row.srnumber,
          portalId: row.portal_id,
          previousStatus: 'Open',
          status: effectiveStatus,
          observedAt: nowIso
        });
      } else {
        closureTracker.scheduleAfterDetail({
          srnumber: row.srnumber,
          portalId: row.portal_id,
          effectiveStatus,
          detail,
          source: 'migration',
          checkedAt: row.archived_at || nowIso
        });
      }
    }

    // Run this after stored details are restored so detail-backed rows retain
    // their stronger schedule and only the remainder receive provisional state.
    for (const row of liveRowsWithoutFollowUp.all(nowIso)) {
      if (closureTracker.queueMapStatusChange({
        srnumber: row.srnumber,
        portalId: row.portal_id,
        previousStatus: null,
        status: row.status,
        observedAt: row.observed_at
      })) provisionalFollowUpsSeeded += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    statusRows,
    followUpsSeeded,
    provisionalFollowUpsSeeded
  };
}

module.exports = {
  DETAIL_ROWS_WITHOUT_FOLLOWUP_SQL,
  LIVE_ROWS_WITHOUT_FOLLOWUP_SQL,
  SEED_MISSING_STATUS_HISTORY_SQL,
  seedClosureTracking
};
