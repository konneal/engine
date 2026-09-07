// Exact-term lookup: the understanding names the term; clause chunks
// whose head IS the term get a decisive nudge (publication headers
// contain the title words, so the reranker alone is unreliable here).
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const termNudge: Stage = {
  name: "term-nudge",
  when: (c) => !!c.u?.term,
  run: (c) => {
    const scored = c.hits.map((h) => h.rerank_score ?? h.score);
    const spread = Math.max(...scored) - Math.min(...scored);
    if (spread > 0) {
      const esc = c.u!.term!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const termRe = new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, "i");
      for (const h of c.hits) {
        const body = h.text.split("\n").slice(1).join(" ").slice(0, 200);
        const hay = `${h.metadata.clause_title || ""} ${body}`.toLowerCase();
        if (termRe.test(hay)) h.rerank_score = (h.rerank_score ?? h.score) + spread * THRESHOLDS.termNudgeSpread;
      }
      c.hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
    }
  },
};
