-- Personalized memory files (#171): per-member context documents the
-- ask path injects when the user selects them (their own stated facts —
-- lab setup, preferred units, instrument inventory). Member-scoped;
-- content is user-authored, never corpus. Selection rides each ask
-- (body.memories) and salts the answer cache (answercache contract).
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_sub ON memories(sub, updated_at);
