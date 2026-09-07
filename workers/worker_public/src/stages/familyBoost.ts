// Family boost + pool sort. Family chunks carry the multi-part structure
// (which parts/annexes exist) — they must reach the model for 'what is
// R 60' / 'how many parts' queries. Vector similarity alone won't rank
// them because they're short structural summaries competing with
// content-heavy clause text. Boost them decisively for doc-scoped
// queries, then sort the pool by score (the cross-encoder re-sorts
// after; this order is the rerank-failure fallback).
import type { Stage } from "./types.ts";

export const familyBoost: Stage = {
  name: "family-boost",
  run: (c) => {
    if (c.filter?.doc_number) {
      for (const h of c.hits) {
        if (h.metadata.clause_anchor === "family") {
          h.score = Math.max(h.score, ...c.hits.map((x) => x.score)) + 1;
        }
      }
    }
    c.hits.sort((a, b) => b.score - a.score);
  },
};
