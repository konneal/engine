// G-ETSI-1: full-corpus BM25 prefilter via D1 FTS5 (arXiv:2604.09868 §II-B5).
// Returns Hits ranked by bm25; caller unions with dense and RRF-fuses.
// Fail-open: any D1/FTS error → empty list (dense path stands alone).

import type { Hit, ChunkMeta } from "./pipeline";

const LEXICAL_K = 40;

/** Build a safe FTS5 MATCH query from user text: alphanumeric tokens,
 *  joined with OR so jargon hits don't require full-phrase match. */
export function ftsMatchQuery(query: string): string | null {
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 40)
    // drop pure stop-ish tokens that blow up OR-queries on standards text
    .filter((t) => !STOP.has(t));
  const uniq = [...new Set(terms)].slice(0, 12);
  if (!uniq.length) return null;
  // quote each term; FTS5 bare tokens are fine for alnum, quotes for safety
  return uniq.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

const STOP = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "for", "on", "is", "are",
  "was", "were", "be", "by", "with", "as", "at", "from", "that", "this",
  "what", "how", "when", "where", "which", "who", "does", "do", "did",
  "can", "could", "should", "would", "may", "might", "shall", "must",
  "about", "into", "than", "then", "its", "it", "their", "there",
]);

function rowMeta(r: any): ChunkMeta {
  return {
    doc_id: String(r.doc_id ?? ""),
    docidentifier: String(r.docidentifier ?? ""),
    doctype: String(r.doctype ?? ""),
    doc_number: String(r.doc_number ?? ""),
    edition: String(r.edition ?? ""),
    language: String(r.language ?? "en"),
    clause_anchor: String(r.clause_anchor ?? ""),
    clause_title: String(r.clause_title ?? ""),
    tier: String(r.tier ?? ""),
    corpus: String(r.corpus ?? ""),
    text_ref: "",
    status: String(r.status ?? "unknown"),
    superseded_by: String(r.superseded_by ?? ""),
    // contract v2 over the lexical lane: typed chunks arriving via BM25
    // keep their unit identity ([[u:…]] refs, typed pin, retyping check)
    unit_id: String(r.unit_id ?? "") || undefined,
    block: String(r.block ?? "") || undefined,
  };
}

export function rowsToHits(rows: any[]): Hit[] {
  return rows.map((r: any) => {
    // rank is bm25 (lower better) → convert to positive score that RRF can ignore
    // (RRF uses rank position, not score). score kept for logging only.
    const bm25 = typeof r.rank === "number" ? r.rank : 0;
    return {
      id: String(r.id),
      score: 1 / (1 + Math.max(0, bm25)),
      metadata: rowMeta(r),
      text: String(r.text ?? ""),
    } satisfies Hit;
  });
}

/** Lexical matches for the lane merges: match-shaped, with the text
 *  riding the metadata (toHits reads chunk_text out of it). */
function rowsToMatches(rows: any[]): { id: string; score: number; metadata: Record<string, unknown> }[] {
  return rows.map((r: any) => {
    const bm25 = typeof r.rank === "number" ? Math.max(0, r.rank) : 0;
    return {
      id: String(r.id),
      score: 1 / (1 + bm25),
      metadata: { ...rowMeta(r), chunk_text: String(r.text ?? "") },
    };
  });
}

/** Lexical ranking WITHIN a document set (the graph lanes' identity
 *  resolution): BM25 over the corpus's own FTS, restricted to the
 *  documents' doc_number values. This is the working substitute for
 *  Vectorize metadata filtering, which is dead on this index (measured
 *  2026-10-05: filters return empty for values proven present). */
export async function lexicalWithin(
  env: { DB: D1Database },
  query: string,
  docNumbers: string[],
  k = 12,
): Promise<{ id: string; score: number; metadata: Record<string, unknown> }[]> {
  const match = ftsMatchQuery(query);
  if (!match || !docNumbers.length) return [];
  try {
    const placeholders = docNumbers.map((_, i) => `?${i + 2}`).join(",");
    const res = await env.DB.prepare(
      `SELECT c.id, c.doc_id, c.docidentifier, c.doctype, c.doc_number, c.edition,
              c.language, c.clause_anchor, c.clause_title, c.status, c.superseded_by,
              c.corpus, c.tier, c.text, c.unit_id, c.block, bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?1 AND c.doc_number IN (${placeholders})
        ORDER BY rank
        LIMIT ?${docNumbers.length + 2}`,
    )
      .bind(match, ...docNumbers, k)
      .all();
    return rowsToMatches(res.results ?? []);
  } catch (e) {
    console.log("lexical-within failed:", String(e).slice(0, 200));
    return [];
  }
}

export async function lexicalPrefilter(env: { DB: D1Database }, query: string, k = LEXICAL_K): Promise<Hit[]> {
  const match = ftsMatchQuery(query);
  if (!match) return [];
  try {
    // bm25() lower = better; multiply by -1 for descending score convention
    const res = await env.DB.prepare(
      `SELECT c.id, c.doc_id, c.docidentifier, c.doctype, c.doc_number, c.edition,
              c.language, c.clause_anchor, c.clause_title, c.status, c.superseded_by,
              c.corpus, c.tier, c.text, c.unit_id, c.block, bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?1
        ORDER BY rank
        LIMIT ?2`,
    )
      .bind(match, k)
      .all();
    const rows = res.results ?? [];
    return rowsToHits(rows);
  } catch (e) {
    console.log("lexical prefilter failed:", String(e).slice(0, 200));
    return [];
  }
}
