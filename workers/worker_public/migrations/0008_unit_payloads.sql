-- Answer contract v2: typed unit payloads for block rendering.
-- Served blocks NEVER pass through the LLM — the model emits [[u:<id>]]
-- references; the worker resolves them here and validates against the
-- passages actually used (producer payloads, ingest-validated).

CREATE TABLE IF NOT EXISTS unit_payloads (
  unit_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  docidentifier TEXT,
  edition TEXT,
  clause_anchor TEXT,
  type TEXT NOT NULL,          -- table | formula | figure | term | requirement
  payload TEXT NOT NULL        -- the MN 116 typed payload, JSON-encoded
);
CREATE INDEX IF NOT EXISTS idx_unit_payloads_doc ON unit_payloads(doc_id);
