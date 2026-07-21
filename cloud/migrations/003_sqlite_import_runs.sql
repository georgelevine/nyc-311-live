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
