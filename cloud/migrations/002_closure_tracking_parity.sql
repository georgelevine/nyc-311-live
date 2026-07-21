ALTER TABLE request_status_history
  ADD COLUMN IF NOT EXISTS previous_status TEXT;
ALTER TABLE request_status_history
  ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE request_status_history
  ADD COLUMN IF NOT EXISTS effective_at TIMESTAMPTZ;
ALTER TABLE request_status_history
  ADD COLUMN IF NOT EXISTS snapshot_json JSONB;

-- The reduced cloud schema deduplicated exact timestamps in the database.
-- Local history uses its primary key and application-level normalized status
-- checks instead, so retain every imported transition even if two source rows
-- share the same status and observed time.
ALTER TABLE request_status_history
  DROP CONSTRAINT IF EXISTS request_status_history_srnumber_status_observed_at_key;

UPDATE request_status_history
SET source = 'legacy_cloud'
WHERE source IS NULL OR BTRIM(source) = '';

ALTER TABLE request_status_history
  ALTER COLUMN source SET DEFAULT 'cloud';
ALTER TABLE request_status_history
  ALTER COLUMN source SET NOT NULL;

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
