CREATE INDEX IF NOT EXISTS idx_receipts_processed ON receipts (processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox (created_at ASC);
CREATE INDEX IF NOT EXISTS idx_csteix_wuxu_active_written ON csteix_wuxu (deleted_at, written_at DESC, slug ASC);
