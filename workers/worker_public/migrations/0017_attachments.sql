-- conversation attachments (TODO.new-era/8 Tier 1): a member's uploaded
-- images persist until they delete them; the R2 object key embeds the
-- owner's subject so the storage partition is the isolation
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    sub TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_sub ON attachments (sub);
