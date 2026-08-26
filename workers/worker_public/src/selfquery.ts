// Filter types + Vectorize filter conversion for the LLM understanding
// output. The regex filter floor that used to live here was removed:
// doc-number/edition/process-intent are SEMANTIC judgments about the
// user's query, and semantics are decided by query understanding
// (understanding.ts) — never by string matching. When understanding is
// unavailable, retrieval runs unfiltered rather than regex-filtered.

export interface QueryFilters {
  doctype?: string;
  doc_number?: string;
  edition?: string;
  language?: string;
}

export function toVectorizeFilter(f: QueryFilters): Record<string, string> | undefined {
  // a pinned doc number is near-selective on its own; including doctype
  // hides the dirty-corpus docs whose identifiers lost the series letter
  // ("OIML 106"), and the reranker resolves R/D number collisions
  if (f.doc_number) {
    const out: Record<string, string> = { doc_number: f.doc_number };
    if (f.edition) out.edition = f.edition;
    return out; // language filter omitted: the index is English-only
  }
  return undefined;
}
