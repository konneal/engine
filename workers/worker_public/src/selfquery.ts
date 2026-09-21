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

// ── the license entitlement scope (TODO.external-refs/08) ────────────────
// A chunk's `standard_key` metadata carries the licensed package's
// entitlement key; public content carries none. The scope is a HARD
// FILTER (a hit never reaches ranking when its key is outside the
// caller's set) — but it deliberately does NOT translate into a
// Vectorize metadata predicate: the wire has no "field missing OR in-set"
// operator, so a `standard_key $in […]` push-down would exclude every
// public chunk (they predate the field). The scope binds pool-level
// (stages/licenseScope.ts, before rerank) and at the lexical lane's
// source (pipeline.ts, the sealScope posture) instead; the single-doc
// post-seal fetches (section-descent, typed-pin parent, edition-cover)
// are doc-scoped and a document's key is a per-document constant, so
// they cannot re-admit a dropped key.

/** The one entitlement predicate: no key = public = always allowed; a key
 *  outside the caller's set = never allowed. `null`/undefined keys (the
 *  deployment declares no licensed content) disable the scope entirely. */
export function standardKeyAllowed(
  meta: { standard_key?: string },
  keys: ReadonlySet<string> | null | undefined,
): boolean {
  if (!keys) return true;
  const k = meta.standard_key;
  return !k || keys.has(k);
}
