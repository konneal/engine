CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  day_limit  INTEGER NOT NULL DEFAULT 2000,
  created_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS queries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  day          TEXT NOT NULL,
  tier         TEXT NOT NULL,
  route        TEXT,
  model        TEXT,
  ok           INTEGER,
  answer_chars INTEGER,
  query_hash   TEXT,
  lang         TEXT,
  duration_ms  INTEGER,
  key_id       TEXT
);

CREATE TABLE IF NOT EXISTS spend (
  day      TEXT NOT NULL,
  tier     TEXT NOT NULL,
  model    TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tier, model)
);

CREATE TABLE IF NOT EXISTS feedback (
  query_hash TEXT NOT NULL,
  rating     INTEGER NOT NULL,
  ts         TEXT NOT NULL
);

-- ── the migration-tracked tables (single union with migrations/*.sql; a
-- drift test pins the two table sets equal) ──

-- Conversations for signed-in members (TODO.impl/15). Anonymous history
-- is device-local by design; the server stores member conversations only.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,             -- m:<hex16>
  sub TEXT NOT NULL,               -- owner (session sub)
  name TEXT NOT NULL,              -- "Lab context"
  content TEXT NOT NULL,           -- the CONTEXT.md body (<= 8k chars)
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_sub ON memories(sub, updated_at);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,             -- p:<hex16>
  sub TEXT NOT NULL,               -- owner (session sub)
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,             -- pf:<hex16>
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id, updated_at);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_id TEXT             -- the project this conversation belongs to (NULL = none)
);
CREATE INDEX IF NOT EXISTS idx_conversations_sub ON conversations(sub, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  citations TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
-- Public read-only shared conversations (TODO.rag/09)
CREATE TABLE IF NOT EXISTS shared_conversations (
  slug TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  messages TEXT NOT NULL,  -- JSON array of {role, content, citations}
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_owner ON shared_conversations(owner_sub);
-- Graph projection (Stage 6 of the SOTA specs): structural edges from
-- relaton-data-oiml + concept nodes from the Glossarist vocab datasets.
-- Populated by ingest/graph.py; read by the retrieval graph lane.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,          -- doc:OIML-R-60-1-2017 | family:R-60 | concept:<id>
  kind TEXT NOT NULL,           -- doc | family | concept
  label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,           -- part_of | variant_of | successor | amends | defines
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges(src);
CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(dst);
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
-- Cross-turn entity memory (G5): resolved entities per conversation so
-- pronouns/ellipsis in follow-ups resolve O(1) instead of re-deriving
-- from raw history text every turn.
CREATE TABLE IF NOT EXISTS conversation_entities (
  conversation_id TEXT NOT NULL,
  entity TEXT NOT NULL,          -- display form, e.g. "OIML R 60-1:2021"
  kind TEXT NOT NULL,            -- document | term
  ts INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_conv_entities ON conversation_entities(conversation_id);
-- G-ETSI-1: full-corpus lexical index for BM25 prefilter (arXiv:2604.09868 §II-B5).
-- Dense-only Vectorize cannot recover exact-jargon misses; FTS5 is the
-- corpus-wide sparse stage that feeds RRF alongside dense top-K.

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  docidentifier TEXT,
  doctype TEXT,
  doc_number TEXT,
  edition TEXT,
  language TEXT,
  clause_anchor TEXT,
  clause_title TEXT,
  status TEXT,
  superseded_by TEXT,
  corpus TEXT,
  tier TEXT,
  -- original body for Hit assembly when dense didn't return this id
  text TEXT NOT NULL,
  -- context preamble + body (Anthropic contextual BM25); what FTS indexes
  fts_text TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  fts_text,
  content='chunks',
  content_rowid='rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, fts_text) VALUES (new.rowid, new.fts_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, fts_text) VALUES ('delete', old.rowid, old.fts_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, fts_text) VALUES ('delete', old.rowid, old.fts_text);
  INSERT INTO chunks_fts(rowid, fts_text) VALUES (new.rowid, new.fts_text);
END;

CREATE INDEX IF NOT EXISTS idx_chunks_doc_number ON chunks(doc_number);
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
-- Contract v2 over the lexical lane: typed chunks (tables, figures,
-- formulas, terms) must carry their unit identity through BM25 too —
-- without these columns, a typed chunk arriving via FTS cannot be
-- referenced [[u:…]], pinned for doc-scoped queries, or protected by
-- the retyping check (Vectorize metadata already carries them; D1 did not).

ALTER TABLE chunks ADD COLUMN unit_id TEXT;
ALTER TABLE chunks ADD COLUMN block TEXT;
-- The per-answer context mark (TODO.ai-platform/02): the transcript marks
-- the context each answer was grounded in (the panel's declared chip as
-- the service APPLIED it — the context_applied echo), so a resumed
-- conversation keeps its honest context lines. NULL means the answer
-- carries no recorded context (pre-chips history included) — the panel
-- renders no context line for those rather than guessing one.
ALTER TABLE messages ADD COLUMN context_applied TEXT;
-- The model plane (TODO.ai-platform/05): the SMART Recommendation MODELS
-- join the retrieval — the packages' machine content (the requirements'
-- constraints, the applicability rules, the acceptance criteria, the
-- conformance tests, the term definitions, the subject constraints, the
-- characteristics, the state machines) indexed alongside the prose corpus.
-- The content DERIVES from the primmel packages (the SSOT) via the smart
-- repo's model-plane bundles (browser/public/data/model-plane/*.json,
-- byte-clean-guarded there); the per-standard source_hash pins WHAT the
-- index derived from — a package change moves the hash and the freshness
-- gate (ingest model-plane --check) refuses to call the index current
-- until a re-index lands.

CREATE TABLE IF NOT EXISTS model_nodes (
  standard     TEXT NOT NULL,        -- oiml-r60
  node_id      TEXT NOT NULL,        -- /req/metrological/mpe
  kind         TEXT NOT NULL,        -- requirement | conformance_test | term | constraint | characteristic | state_machine | dimension
  name         TEXT,
  clause_doc   TEXT,                 -- urn:oiml:pub:r:60-1:2021 (the provenance's document)
  clause_ref   TEXT,                 -- 5.3.2 (the clause inside it)
  content      TEXT NOT NULL,        -- the node's JSON (the bundle projection, verbatim)
  content_hash TEXT NOT NULL,        -- sha256 of content (drift forensics)
  PRIMARY KEY (standard, node_id)
);
CREATE INDEX IF NOT EXISTS idx_model_nodes_kind ON model_nodes(kind);

CREATE TABLE IF NOT EXISTS model_plane_meta (
  standard    TEXT PRIMARY KEY,
  package     TEXT NOT NULL,         -- oiml-r60 (the primmel package)
  plane       TEXT NOT NULL,         -- the bundle shape version (model-plane/1)
  source_hash TEXT NOT NULL,         -- the package content hash the index derived from
  node_count  INTEGER NOT NULL,
  indexed_at  TEXT NOT NULL          -- when the index landed (operational truth)
);
