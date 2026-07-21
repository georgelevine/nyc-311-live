CREATE TABLE IF NOT EXISTS live_portal_requests (
  srnumber TEXT PRIMARY KEY,
  suffix BIGINT UNIQUE,
  portal_id TEXT UNIQUE,
  problem TEXT,
  address TEXT,
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
  status TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (srnumber, status, observed_at)
);

CREATE INDEX IF NOT EXISTS request_status_history_request_idx
  ON request_status_history (srnumber, observed_at DESC);

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
