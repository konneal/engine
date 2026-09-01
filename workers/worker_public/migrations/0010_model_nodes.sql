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
