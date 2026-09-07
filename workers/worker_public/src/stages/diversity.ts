// Per-publication diversity, keyed by normalized identity: overview
// chunks are near-duplicates across editions — at most ONE per
// publication; clause chunks get a higher cap so content can fill slots.
import { LIMITS } from "../config.ts";
import type { Stage } from "./types.ts";

export const diversity: Stage = {
  name: "diversity",
  run: (c) => {
    const filters = c.filters;
    const perDoc = new Map<string, number>();
    let overviews = 0;
    const diversified = [];
    for (const h of c.hits) {
      const isOverview = h.metadata.clause_anchor === "overview";
      // a doc-number query matches every part (R 60-1/-2/Annexe A) —
      // without a global overview cap their near-identical overviews
      // crowd out the definition and clause chunks the answer needs
      const ovCap = filters?.doc_number ? 6 : 2; // part overviews of the queried family are signal, not noise
      if (isOverview && overviews >= ovCap) continue;
      const key = `${h.metadata.docidentifier}|${h.metadata.language}`;
      const n = perDoc.get(key) ?? 0;
      const cap = isOverview ? 1 : filters?.doc_number ? 3 : 2;
      if (n < cap) {
        diversified.push(h);
        perDoc.set(key, n + 1);
        if (isOverview) overviews += 1;
      }
      if (diversified.length >= LIMITS.rerankKeep + 2) break;
    }
    c.finalHits = diversified.slice(0, LIMITS.rerankKeep);
  },
};
