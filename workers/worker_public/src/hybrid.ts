// Hybrid search: BM25 keyword scoring fused with dense retrieval via
// Reciprocal Rank Fusion (RRF, k=60). Vectorize has no sparse vectors,
// so exact-term queries (part numbers, "n_LC", "R 60-3", defined terms)
// fail on pure vector similarity. BM25 catches them; RRF combines both
// rankings without needing calibrated scores.
// Ref: arXiv 2604.01733 — hybrid + RRF consistently outperforms either
// method alone; RRF(k=60) is the best-practice default (Denser.ai).

import type { Hit } from "./pipeline";

const RRF_K = 60;

/** Simple BM25-ish keyword scorer over the chunk corpus in memory.
 *  Not a full BM25 (no IDF — we don't have corpus statistics in the
 *  worker); this is a lexical overlap score that catches exact terms
 *  that dense embeddings miss. */
export function keywordScore(query: string, text: string): number {
  const terms = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let count = 0;
    let idx = lower.indexOf(term);
    while (idx !== -1 && count < 10) {
      count++;
      idx = lower.indexOf(term, idx + 1);
    }
    if (count > 0) {
      // saturating: the first few hits matter most
      score += 1 + Math.log(count) * 0.5;
    }
  }
  return score / terms.length;
}

/** Rank all candidates by keyword overlap against the query. */
export function keywordRank(query: string, hits: Hit[]): Hit[] {
  return hits
    .map((h) => ({ h, s: keywordScore(query, h.text) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.h);
}

/** Fuse two rankings with Reciprocal Rank Fusion.
 *  score(d) = Σ 1/(k + rank_i(d)) — rank-agnostic, robust across
 *  heterogeneous scorers (dense + sparse). */
export function rrfFuse(
  dense: Hit[],
  keyword: Hit[],
  keep: number,
): Hit[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, Hit>();

  dense.forEach((h, i) => {
    const rank = i + 1;
    scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (RRF_K + rank));
    byId.set(h.id, h);
  });
  keyword.forEach((h, i) => {
    const rank = i + 1;
    scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (RRF_K + rank));
    byId.set(h.id, h);
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, keep)
    .map(([id]) => byId.get(id)!)
    .filter(Boolean);
}
