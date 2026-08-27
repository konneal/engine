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
