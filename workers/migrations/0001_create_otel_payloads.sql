-- Migration: Create otel_payloads table and expires_at index
CREATE TABLE IF NOT EXISTS otel_payloads (
  object_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otel_payloads_expires_at ON otel_payloads(expires_at);
