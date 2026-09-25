-- the latency program's aggregate: how many generation retries each ask
-- needed (Server-Timing carried the count per answer; this column makes
-- it rollup-able). Existing rows read 0 — they predate the column.
ALTER TABLE queries ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
