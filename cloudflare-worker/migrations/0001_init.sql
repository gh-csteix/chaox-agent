CREATE TABLE IF NOT EXISTS app_state (
  app TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'disabled',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  catalog_json TEXT,
  summary_json TEXT,
  last_sync_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
  request_id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  op TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_json TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_app_created ON inbox (app, created_at ASC);

CREATE TABLE IF NOT EXISTS receipts (
  request_id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  op TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  record_id TEXT,
  stable_id TEXT,
  summary TEXT,
  details_json TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_receipts_app_processed ON receipts (app, processed_at DESC);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
