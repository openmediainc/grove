-- Key/value + pub/sub tables used when REDIS_URL=pg (Vercel + Supabase).
-- Mini keeps using Redis; these tables are unused there.

CREATE TABLE IF NOT EXISTS grove_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS grove_set (
  key TEXT NOT NULL,
  member TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (key, member)
);

CREATE INDEX IF NOT EXISTS grove_kv_expires_idx ON grove_kv (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS grove_set_expires_idx ON grove_set (expires_at)
  WHERE expires_at IS NOT NULL;
