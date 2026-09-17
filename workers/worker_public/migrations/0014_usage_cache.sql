-- Usage telemetry (2026-09-17): the cache mix on the queries ledger.
-- 'exact' | 'semantic' for served-from-cache answers, NULL for a live
-- generation — the answer-cache story (hit rates per tier) becomes
-- measurable instead of inferred.
ALTER TABLE queries ADD COLUMN cache TEXT;
