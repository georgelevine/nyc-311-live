'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function createArchiveFixture(directory, filename = 'source.sqlite') {
  const databasePath = path.join(directory, filename);
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE live_portal_requests (
      srnumber TEXT PRIMARY KEY,
      suffix INTEGER UNIQUE,
      portal_id TEXT UNIQUE,
      problem TEXT,
      address TEXT,
      latitude REAL,
      longitude REAL,
      submitted_at TEXT,
      status TEXT,
      portal_url TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE live_number_queue (
      suffix INTEGER PRIMARY KEY,
      srnumber TEXT NOT NULL UNIQUE,
      first_detected_at TEXT NOT NULL,
      audit_after TEXT NOT NULL,
      map_seen INTEGER NOT NULL DEFAULT 0,
      audit_outcome TEXT NOT NULL DEFAULT 'pending',
      audited_at TEXT
    );
    CREATE TABLE live_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE portal_requests (
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
    CREATE TABLE live_detail_queue (
      srnumber TEXT PRIMARY KEY,
      portal_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX live_detail_queue_status_idx
      ON live_detail_queue(status, next_attempt_at);
    CREATE TABLE number_ledger (
      suffix INTEGER PRIMARY KEY,
      srnumber TEXT NOT NULL UNIQUE,
      outcome TEXT NOT NULL CHECK (outcome IN ('found', 'not_found', 'retry')),
      attempts INTEGER NOT NULL,
      http_status INTEGER,
      error TEXT,
      checked_at TEXT NOT NULL
    );
    CREATE INDEX number_ledger_outcome_idx ON number_ledger(outcome);
    CREATE TABLE request_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      srnumber TEXT NOT NULL,
      previous_status TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      effective_at TEXT,
      observed_at TEXT NOT NULL,
      snapshot_json TEXT
    );
    CREATE INDEX request_status_history_request_idx
      ON request_status_history(srnumber, observed_at);
    CREATE TABLE request_closure_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      srnumber TEXT NOT NULL,
      closure_cycle INTEGER NOT NULL,
      status TEXT,
      date_closed TEXT,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      is_final INTEGER NOT NULL DEFAULT 0,
      final_state TEXT,
      content_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      UNIQUE(srnumber, closure_cycle, content_hash, is_final)
    );
    CREATE INDEX request_closure_snapshots_request_idx
      ON request_closure_snapshots(srnumber, closure_cycle DESC, fetched_at DESC);
    CREATE UNIQUE INDEX request_closure_snapshots_final_idx
      ON request_closure_snapshots(srnumber, closure_cycle)
      WHERE is_final = 1;
    CREATE TABLE request_followup_queue (
      srnumber TEXT PRIMARY KEY,
      portal_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('open', 'closing', 'closed')),
      next_check_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      closing_attempts INTEGER NOT NULL DEFAULT 0,
      closure_cycle INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      finalized_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX request_followup_queue_due_idx
      ON request_followup_queue(state, next_check_at);

    INSERT INTO live_portal_requests VALUES (
      '311-00000001', 1, NULL, 'Test request', '1 Test Plaza', NULL, NULL,
      '2026-07-21T00:00:00.000Z', 'Open',
      'https://portal.311.nyc.gov/sr-details/?srnum=311-00000001',
      '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z',
      '{"source":"audit","coordinate_free":true}'
    );
    INSERT INTO live_number_queue VALUES (
      1, '311-00000001', '2026-07-21T00:00:00.000Z',
      '2026-07-21T00:35:00.000Z', 0, 'found', '2026-07-21T00:36:00.000Z'
    );
    INSERT INTO live_monitor_state VALUES
      ('live_frontier', '1', '2026-07-21T00:00:00.000Z'),
      ('last_successful_poll_at', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z');
    INSERT INTO portal_requests VALUES (
      '311-00000001', 1, NULL, 'Open', 'Test request', NULL, NULL,
      '1 Test Plaza', '24 Hours', '2026-07-21T00:00:00.000Z',
      '2026-07-21T00:00:00.000Z', NULL, '{}',
      'https://portal.311.nyc.gov/sr-details/?srnum=311-00000001',
      '2026-07-21T00:00:00.000Z'
    );
    INSERT INTO live_detail_queue VALUES (
      '311-00000001', NULL, 'found', 1, '2026-07-21T00:00:00.000Z', NULL,
      '2026-07-21T00:00:00.000Z'
    );
    INSERT INTO number_ledger VALUES (
      1, '311-00000001', 'found', 1, 200, NULL, '2026-07-21T00:00:00.000Z'
    );
    INSERT INTO request_status_history (
      srnumber, previous_status, status, source, observed_at
    ) VALUES ('311-00000001', NULL, 'Open', 'map', '2026-07-21T00:00:00.000Z');
    INSERT INTO request_followup_queue VALUES (
      '311-00000001', NULL, 'open', '2026-07-22T00:00:00.000Z', 0, 0, 0,
      '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', NULL, NULL,
      '2026-07-21T00:00:00.000Z'
    );
  `);
  database.close();
  return databasePath;
}

module.exports = { createArchiveFixture };
