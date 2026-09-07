// Concept-anchored steering (rag#137): the vocabulary link names the
// corpus's own concepts for the question's subject; their DEFINING
// publications get a small rerank boost — the same spread-scaled
// steering idiom as edition steering. Measured motivation: for
// everyday-goods phrasing the right family's chunks sit at dense rank 3
// and are then BURIED by the cross-encoder under instrument-markings
// vocabulary (R 111/R 76 "label" clauses outrank R 79's overview for
// "rules for the label on a bag of flour"). The concept link knows the
// subject's family ("actual quantity" → R 87, "Prepackage" → R 79); the
// boost is what lets that knowledge survive the cross-encoder. The
// answer model still adjudicates among the boosted families' passages.
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const conceptSteer: Stage = {
  name: "concept-steer",
  when: (c) => c.glossary.length > 0 && c.hits.length > 1,
  run: (c) => {
    const fams = new Set(c.glossary.map((g) => g.doc_number.split("-")[0]).filter(Boolean));
    if (fams.size) {
      const scored = c.hits.map((h) => h.rerank_score ?? h.score);
      const spread = Math.max(...scored) - Math.min(...scored);
      if (spread > 0) {
        let boosted = 0;
        for (const h of c.hits) {
          const base = String(h.metadata.doc_number ?? "").split("-")[0];
          if (fams.has(base)) {
            h.rerank_score = (h.rerank_score ?? h.score) + spread * THRESHOLDS.conceptSteerSpread;
            boosted++;
          }
        }
        if (boosted) {
          console.log("concept steering: +", boosted, "hits in", [...fams].join(","));
          c.hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
        }
      }
    }
  },
};
