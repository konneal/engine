// Cross-encoder rerank (additive — vector order is the fallback, by
// design) + the post-rerank family pin. The pre-rerank family boost does
// not survive re-sorting — short structural summaries always lose to
// content-heavy clauses under a cross-encoder. For doc-scoped queries
// pin family chunks AFTER rerank: 'what is R 60' must lead with the
// family summary, not an annex definition that happens to match the
// words.
//
// lexical-rrf: RRF with the FULL-CORPUS lexical ranking (not a re-score
// of the dense shortlist). ETSI §II-B7: dense+sparse fusion lifts
// precision and MRR on standards jargon without changing recall. Runs
// after rerank even when rerank failed (the monolith's try/catch left
// the fuse outside it — preserved by the runner's additive semantics).
import { rerank } from "../ai.ts";
import { LIMITS, MODELS } from "../config.ts";
import { rrfFuse } from "../hybrid.ts";
import type { Stage } from "./types.ts";

export const rerankStage: Stage = {
  name: "rerank",
  failure: "additive",
  when: (c) => c.hits.length > 1,
  run: async (c) => {
    const tRerank = Date.now();
    const scores = await rerank(c.env.AI, MODELS.rerank, c.query, c.hits.map((h) => h.text));
    console.log("stage: rerank", Date.now() - tRerank, "ms over", c.hits.length, "candidates");
    if (scores) {
      c.hits.forEach((h, i) => (h.rerank_score = scores[i]));
      c.hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
      if (c.filter?.doc_number) {
        const families = c.hits.filter((h) => h.metadata.clause_anchor === "family");
        if (families.length) {
          c.hits = [...families, ...c.hits.filter((h) => h.metadata.clause_anchor !== "family")];
        }
      }
    }
  },
};

export const lexicalRrf: Stage = {
  name: "lexical-rrf",
  when: (c) => c.hits.length > 1 && c.lexicalHits.length > 0,
  run: (c) => {
    c.hits = rrfFuse(c.hits, c.lexicalHits, LIMITS.retrieveK);
  },
};
