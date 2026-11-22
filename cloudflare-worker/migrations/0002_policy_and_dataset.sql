ALTER TABLE app_state ADD COLUMN policy_json TEXT;

CREATE TABLE IF NOT EXISTS app_dataset (
  app TEXT NOT NULL,
  domain TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app, domain)
);

CREATE INDEX IF NOT EXISTS idx_app_dataset_app ON app_dataset (app);
