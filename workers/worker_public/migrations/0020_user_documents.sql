-- The member's own documents (TODO.sota/20 v1): imported certificates
-- and scanned reports, privately indexed in the user lane, answered
-- beside the public corpus. 10 documents per member, 20 MB each, held
-- until the member deletes; deletion is immediate and total.
CREATE TABLE IF NOT EXISTS user_documents (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT,
    status TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    r2_key TEXT,
    fields TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_documents_owner ON user_documents (owner_sub);
