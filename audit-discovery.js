'use strict';

const { createClosureTracker } = require('./closure-tracking');

function parseFields(value) {
  try {
    const fields = JSON.parse(value || '{}');
    return fields && typeof fields === 'object' ? fields : {};
  } catch (_) {
    return {};
  }
}

function promoteAuditDiscoveries({
  db,
  closureTracker = null,
  observedAt = new Date().toISOString(),
  manageTransaction = true,
  lowSuffix = null,
  highSuffix = null
} = {}) {
  if (!db) throw new TypeError('db is required');
  const tracker = closureTracker || createClosureTracker(db);
  const low = Number.isInteger(lowSuffix) ? lowSuffix : null;
  const high = Number.isInteger(highSuffix) ? highSuffix : null;
  const findCandidates = db.prepare(`
    SELECT queue.suffix, queue.srnumber, queue.first_detected_at,
           queue.audited_at, details.portal_id, details.status,
           details.problem, details.problem_details, details.additional_details,
           details.address, details.next_update, details.date_reported,
           details.updated_on, details.date_closed, details.fields_json,
           details.portal_url, details.archived_at
    FROM live_number_queue AS queue
    JOIN number_ledger AS ledger
      ON ledger.suffix = queue.suffix
     AND ledger.srnumber = queue.srnumber
     AND ledger.outcome = 'found'
    JOIN portal_requests AS details
      ON details.srnumber = queue.srnumber
     AND details.suffix = queue.suffix
    LEFT JOIN live_portal_requests AS live ON live.srnumber = queue.srnumber
    WHERE queue.map_seen = 0
      AND queue.audit_outcome = 'found'
      AND live.srnumber IS NULL
      AND (? IS NULL OR queue.suffix >= ?)
      AND (? IS NULL OR queue.suffix <= ?)
    ORDER BY queue.suffix
  `);
  const insertLive = db.prepare(`
    INSERT INTO live_portal_requests (
      srnumber, suffix, portal_id, problem, address, latitude, longitude,
      submitted_at, status, portal_url, first_seen_at, last_seen_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  const markDetailFound = db.prepare(`
    INSERT INTO live_detail_queue (
      srnumber, portal_id, status, attempts, next_attempt_at,
      last_error, updated_at
    ) VALUES (?, ?, 'found', 0, ?, NULL, ?)
    ON CONFLICT(srnumber) DO UPDATE SET
      portal_id = COALESCE(excluded.portal_id, live_detail_queue.portal_id),
      status = 'found',
      attempts = 0,
      next_attempt_at = excluded.next_attempt_at,
      last_error = NULL,
      updated_at = excluded.updated_at
  `);
  const counts = {
    candidates: 0,
    promoted: 0,
    open: 0,
    closing: 0,
    closed: 0,
    conflicts: 0,
    invalid: 0
  };

  if (manageTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const candidates = findCandidates.all(low, low, high, high);
    counts.candidates = candidates.length;
    for (const row of candidates) {
      const numberMatch = String(row.srnumber || '').match(/^311-(\d{8})$/);
      if (!Number.isInteger(row.suffix) || !numberMatch || Number(numberMatch[1]) !== row.suffix) {
        counts.invalid += 1;
        continue;
      }
      const status = row.date_closed ? 'Closed' : row.status;
      const discoveredAt = row.archived_at || observedAt;
      const detail = {
        srnumber: row.srnumber,
        portalId: row.portal_id,
        status,
        problem: row.problem,
        problemDetails: row.problem_details,
        additionalDetails: row.additional_details,
        address: row.address,
        nextUpdate: row.next_update,
        dateReported: row.date_reported,
        updatedOn: row.updated_on,
        dateClosed: row.date_closed,
        fields: parseFields(row.fields_json)
      };
      const raw = JSON.stringify({
        source: 'number_audit',
        coordinate_free: true,
        data: {
          srnumber: row.srnumber,
          problem: row.problem,
          address: row.address,
          submitteddate: row.date_reported,
          status
        }
      });
      const inserted = insertLive.run(
        row.srnumber,
        row.suffix,
        row.portal_id,
        row.problem,
        row.address,
        row.date_reported,
        status,
        row.portal_url,
        discoveredAt,
        discoveredAt,
        raw
      );
      if (Number(inserted.changes || 0) === 0) {
        counts.conflicts += 1;
        continue;
      }

      markDetailFound.run(row.srnumber, row.portal_id, discoveredAt, discoveredAt);
      if (String(status || '').trim()) {
        tracker.observeStatus({
          srnumber: row.srnumber,
          previousStatus: null,
          status,
          source: 'number_audit',
          effectiveAt: row.date_closed || row.updated_on || row.date_reported,
          observedAt: discoveredAt,
          snapshot: detail
        });
      }
      const scheduled = tracker.scheduleAfterDetail({
        srnumber: row.srnumber,
        portalId: row.portal_id,
        effectiveStatus: status,
        detail,
        source: 'number_audit',
        checkedAt: discoveredAt
      });
      counts.promoted += 1;
      counts[scheduled.state] += 1;
    }
    if (manageTransaction) db.exec('COMMIT');
    return counts;
  } catch (error) {
    if (manageTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { promoteAuditDiscoveries };
