// The chunk wire contract — the shape of every Vectorize vector's
// metadata, shared by both workers. The CANONICAL producer definition is
// ingest/vector_adapter.py (ChunkMetaModel, pydantic); this module is its
// serving-side mirror, and tests/chunkmeta.test.ts fails when either side
// drifts. Change a field → change vector_adapter.py and this file in the
// same commit.

export interface ChunkMeta {
  doc_id: string;
  docidentifier: string;
  doctype: string;
  doc_number: string;
  edition: string;
  language: string;
  clause_anchor: string;
  clause_title: string;
  tier: string;
  corpus: string;
  text_ref: string;
  status?: string;
  superseded_by?: string;
  /** answer contract v2: typed MKO units carry their unit id + block type */
  unit_id?: string;
  block?: string;
  unit_hash?: string;
  producer?: string;
  source_lane?: string;
  linked_clause?: string;
  linked_document?: string;
  /** document order (metanorma-document#56): reading order is a sort */
  ordinal?: number;
  /** the model plane (retrieval-export derivation): unit versioning and
   *  identity, canonical per primmel/primmel-ts#65 */
  model_version?: string;
  model_node?: string;
  model_kind?: string;
  standard?: string;
  /** section-summary unit (FABLE multi-granularity, arXiv:2601.18116): a
   *  depth-1 clause summary vector — a navigation node whose children
   *  (child_anchors CSV) are quotable leaf clauses. The corpus's real
   *  chunks start at depth 2, so these nodes cannot collide with them. */
  section_summary?: string;
  child_anchors?: string;
  /** contextual enrichment (one-time corpus spend, KV-cached) */
  ctx?: string;
  /** the capped chunk text riding inside vector metadata */
  chunk_text?: string;
}

export interface Hit {
  id: string;
  score: number;
  rerank_score?: number;
  metadata: ChunkMeta;
  text: string;
}

// Runtime manifest of ChunkMeta's keys — the bridge the contract test
// reads (interfaces erase at runtime; this array does not).
export const CHUNK_META_FIELDS = [
  "doc_id",
  "docidentifier",
  "doctype",
  "doc_number",
  "edition",
  "language",
  "clause_anchor",
  "clause_title",
  "tier",
  "corpus",
  "text_ref",
  "status",
  "superseded_by",
  "unit_id",
  "block",
  "unit_hash",
  "producer",
  "source_lane",
  "linked_clause",
  "linked_document",
  "ordinal",
  "model_version",
  "model_node",
  "model_kind",
  "standard",
  "section_summary",
  "child_anchors",
  "ctx",
  "chunk_text",
] as const;

// Compile-time: the manifest and the interface are the same set — both
// directions. A mismatch fails typecheck here, not at the wire.
type AssertNever<T extends never> = T;
type ManifestField = (typeof CHUNK_META_FIELDS)[number];
type _manifestMissingFromInterface = AssertNever<Exclude<ManifestField, keyof ChunkMeta>>;
type _interfaceMissingFromManifest = AssertNever<Exclude<keyof ChunkMeta, ManifestField>>;
