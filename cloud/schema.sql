CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version BIGINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_portal_requests (
  srnumber TEXT PRIMARY KEY,
  suffix BIGINT UNIQUE,
  portal_id TEXT UNIQUE,
  problem TEXT,
  address TEXT,
  borough TEXT,
  incident_zip TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  location GEOGRAPHY(POINT, 4326),
  submitted_at TIMESTAMPTZ,
  status TEXT,
  portal_url TEXT,
  source TEXT NOT NULL DEFAULT 'map',
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS live_portal_requests_suffix_idx
  ON live_portal_requests (suffix DESC);
CREATE INDEX IF NOT EXISTS live_portal_requests_submitted_idx
  ON live_portal_requests (submitted_at DESC);
CREATE INDEX IF NOT EXISTS live_portal_requests_status_idx
  ON live_portal_requests (status);
CREATE INDEX IF NOT EXISTS live_portal_requests_borough_idx
  ON live_portal_requests (borough);
CREATE INDEX IF NOT EXISTS live_portal_requests_incident_zip_idx
  ON live_portal_requests (incident_zip);
CREATE INDEX IF NOT EXISTS live_portal_requests_location_idx
  ON live_portal_requests USING GIST (location);

CREATE TABLE IF NOT EXISTS portal_requests (
  srnumber TEXT PRIMARY KEY,
  suffix BIGINT NOT NULL UNIQUE,
  portal_id TEXT UNIQUE,
  status TEXT,
  problem TEXT,
  problem_details TEXT,
  additional_details TEXT,
  address TEXT,
  next_update TEXT,
  date_reported TIMESTAMPTZ,
  updated_on TIMESTAMPTZ,
  date_closed TIMESTAMPTZ,
  fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  portal_url TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS request_status_history (
  id BIGSERIAL PRIMARY KEY,
  srnumber TEXT NOT NULL REFERENCES live_portal_requests(srnumber) ON DELETE CASCADE,
  previous_status TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'cloud',
  effective_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  snapshot_json JSONB
);

CREATE INDEX IF NOT EXISTS request_status_history_request_idx
  ON request_status_history (srnumber, observed_at DESC);

CREATE TABLE IF NOT EXISTS request_closure_snapshots (
  id BIGSERIAL PRIMARY KEY,
  srnumber TEXT NOT NULL REFERENCES live_portal_requests(srnumber) ON DELETE CASCADE,
  closure_cycle INTEGER NOT NULL,
  status TEXT,
  date_closed TIMESTAMPTZ,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  is_final BOOLEAN NOT NULL DEFAULT FALSE,
  final_state TEXT,
  content_hash TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  UNIQUE (srnumber, closure_cycle, content_hash, is_final)
);

CREATE INDEX IF NOT EXISTS request_closure_snapshots_request_idx
  ON request_closure_snapshots (srnumber, closure_cycle DESC, fetched_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS request_closure_snapshots_final_idx
  ON request_closure_snapshots (srnumber, closure_cycle)
  WHERE is_final = TRUE;

CREATE TABLE IF NOT EXISTS request_followup_queue (
  srnumber TEXT PRIMARY KEY REFERENCES live_portal_requests(srnumber) ON DELETE CASCADE,
  portal_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'closing', 'closed')),
  next_check_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  closing_attempts INTEGER NOT NULL DEFAULT 0,
  closure_cycle INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  finalized_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS request_followup_queue_due_idx
  ON request_followup_queue (state, next_check_at);

CREATE TABLE IF NOT EXISTS live_detail_queue (
  srnumber TEXT PRIMARY KEY REFERENCES live_portal_requests(srnumber) ON DELETE CASCADE,
  portal_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'working', 'found', 'retry')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS live_detail_queue_status_idx
  ON live_detail_queue (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS live_number_queue (
  suffix BIGINT PRIMARY KEY,
  srnumber TEXT NOT NULL UNIQUE,
  first_detected_at TIMESTAMPTZ NOT NULL,
  audit_after TIMESTAMPTZ NOT NULL,
  map_seen BOOLEAN NOT NULL DEFAULT FALSE,
  audit_outcome TEXT NOT NULL DEFAULT 'pending',
  audited_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS live_number_queue_pending_idx
  ON live_number_queue (audit_outcome, audit_after);

CREATE TABLE IF NOT EXISTS number_ledger (
  suffix BIGINT PRIMARY KEY,
  srnumber TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK (outcome IN ('found', 'not_found', 'retry')),
  attempts INTEGER NOT NULL,
  http_status INTEGER,
  error TEXT,
  checked_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS number_ledger_outcome_idx
  ON number_ledger (outcome);

CREATE TABLE IF NOT EXISTS live_monitor_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_summaries (
  id BIGSERIAL PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ended_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_summaries_created_idx
  ON ai_summaries (created_at DESC);

CREATE TABLE IF NOT EXISTS sqlite_import_runs (
  run_id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  source_name TEXT,
  source_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_manifest JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  error TEXT
);

COMMENT ON COLUMN sqlite_import_runs.source_name IS
  'Redacted source basename only; never store a local absolute path.';

CREATE INDEX IF NOT EXISTS sqlite_import_runs_completed_at_idx
  ON sqlite_import_runs (completed_at DESC);
