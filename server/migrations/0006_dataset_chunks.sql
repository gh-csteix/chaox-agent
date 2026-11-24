CREATE TABLE IF NOT EXISTS app_dataset_chunks (
  app TEXT NOT NULL,
  domain TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app, domain, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_app_dataset_chunks_app ON app_dataset_chunks (app);
