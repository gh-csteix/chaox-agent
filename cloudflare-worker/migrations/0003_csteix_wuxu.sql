CREATE TABLE IF NOT EXISTS csteix_wuxu (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  title_en TEXT,
  dimensions_json TEXT NOT NULL DEFAULT '[]',
  written_at TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  body_zh TEXT NOT NULL,
  body_en TEXT,
  raw_notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_csteix_wuxu_updated_at ON csteix_wuxu (updated_at ASC);
CREATE INDEX IF NOT EXISTS idx_csteix_wuxu_written_at ON csteix_wuxu (written_at DESC);
CREATE INDEX IF NOT EXISTS idx_csteix_wuxu_deleted_at ON csteix_wuxu (deleted_at);
