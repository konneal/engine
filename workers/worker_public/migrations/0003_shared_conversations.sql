-- Public read-only shared conversations (TODO.rag/09)
CREATE TABLE IF NOT EXISTS shared_conversations (
  slug TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  messages TEXT NOT NULL,  -- JSON array of {role, content, citations}
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_owner ON shared_conversations(owner_sub);
