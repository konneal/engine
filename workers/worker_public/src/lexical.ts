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

export async function lexicalPrefilter(env: { DB: D1Database }, query: string, k = LEXICAL_K): Promise<Hit[]> {
  const match = ftsMatchQuery(query);
  if (!match) return [];
  try {
    // bm25() lower = better; multiply by -1 for descending score convention
    const res = await env.DB.prepare(
      `SELECT c.id, c.doc_id, c.docidentifier, c.doctype, c.doc_number, c.edition,
              c.language, c.clause_anchor, c.clause_title, c.status, c.superseded_by,
              c.corpus, c.tier, c.text, bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?1
        ORDER BY rank
        LIMIT ?2`,
    )
      .bind(match, k)
      .all();
    const rows = res.results ?? [];
    return rows.map((r: any, i: number) => {
      const meta: ChunkMeta = {
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
      };
      // rank is bm25 (lower better) → convert to positive score that RRF can ignore
      // (RRF uses rank position, not score). score kept for logging only.
      const bm25 = typeof r.rank === "number" ? r.rank : i;
      return {
        id: String(r.id),
        score: 1 / (1 + Math.max(0, bm25)),
        metadata: meta,
        text: String(r.text ?? ""),
      } satisfies Hit;
    });
  } catch (e) {
    console.log("lexical prefilter failed:", String(e).slice(0, 200));
    return [];
  }
}
