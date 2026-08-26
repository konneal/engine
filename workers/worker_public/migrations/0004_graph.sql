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
