-- Document identity registry (Stage 1 of the SOTA specs): the SSOT for
-- edition status. Status is DERIVED, not copied: relaton's status field
-- is inconsistent (records claim in-force while carrying successors) —
-- an edition with a successor is superseded regardless; the ACTIVE
-- edition of a family+part is the terminal node of its successor chain
-- (no successor, max edition).
CREATE TABLE IF NOT EXISTS documents (
  canonical_id TEXT PRIMARY KEY,   -- doc:OIML-R-60-2021
  docidentifier TEXT NOT NULL,     -- OIML R 60:2021
  family TEXT NOT NULL,            -- R-60
  part TEXT,                       -- 1 | 2 | 3 | A | annexes | sup | NULL
  edition TEXT NOT NULL,           -- 2021
  status TEXT NOT NULL,            -- in-force | superseded | withdrawn
  derived_status TEXT NOT NULL,    -- successor-edge derivation result
  active INTEGER NOT NULL,         -- 1 = the active edition of family+part
  superseded_by TEXT,              -- canonical_id of the successor
  title TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_family ON documents(family, part, active);
