'use strict';

function ensureLiveCollectorBaseSchema(database) {
  if (!database || typeof database.exec !== 'function') {
    throw new TypeError('A SQLite database is required');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS live_portal_requests (
      srnumber TEXT PRIMARY KEY,
      suffix INTEGER UNIQUE,
      portal_id TEXT UNIQUE,
      problem TEXT,
      address TEXT,
      borough TEXT,
      incident_zip TEXT,
      police_precinct INTEGER,
      police_precinct_boundary_version TEXT,
      police_precinct_matched_at TEXT,
      business_improvement_district_boundary_version TEXT,
      business_improvement_district_matched_at TEXT,
      latitude REAL,
      longitude REAL,
      submitted_at TEXT,
      status TEXT,
      portal_url TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS live_portal_requests_submitted_at_idx
      ON live_portal_requests(submitted_at) WHERE submitted_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS live_number_queue (
      suffix INTEGER PRIMARY KEY,
      srnumber TEXT NOT NULL UNIQUE,
      first_detected_at TEXT NOT NULL,
      audit_after TEXT NOT NULL,
      map_seen INTEGER NOT NULL DEFAULT 0,
      audit_outcome TEXT NOT NULL DEFAULT 'pending',
      audited_at TEXT
    );

    CREATE INDEX IF NOT EXISTS live_number_queue_pending_audit_idx
      ON live_number_queue(audit_after, suffix) WHERE audit_outcome = 'pending';

    CREATE TABLE IF NOT EXISTS live_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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

    CREATE INDEX IF NOT EXISTS portal_requests_date_reported_idx
      ON portal_requests(date_reported) WHERE date_reported IS NOT NULL;

    CREATE TABLE IF NOT EXISTS live_detail_queue (
      srnumber TEXT PRIMARY KEY,
      portal_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS live_detail_queue_status_idx
      ON live_detail_queue(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS number_ledger (
      suffix INTEGER PRIMARY KEY,
      srnumber TEXT NOT NULL UNIQUE,
      outcome TEXT NOT NULL CHECK (outcome IN ('found', 'not_found', 'retry')),
      attempts INTEGER NOT NULL,
      http_status INTEGER,
      error TEXT,
      checked_at TEXT NOT NULL
    );
  `);
}

module.exports = { ensureLiveCollectorBaseSchema };
