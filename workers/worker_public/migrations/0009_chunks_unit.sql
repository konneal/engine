-- Contract v2 over the lexical lane: typed chunks (tables, figures,
-- formulas, terms) must carry their unit identity through BM25 too —
-- without these columns, a typed chunk arriving via FTS cannot be
-- referenced [[u:…]], pinned for doc-scoped queries, or protected by
-- the retyping check (Vectorize metadata already carries them; D1 did not).

ALTER TABLE chunks ADD COLUMN unit_id TEXT;
ALTER TABLE chunks ADD COLUMN block TEXT;
