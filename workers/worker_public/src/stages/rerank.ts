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
import { portModelRunner } from "../env.ts";
import { LIMITS, MODELS } from "../config.ts";
import { rrfFuse } from "../hybrid.ts";
import type { Stage } from "./types.ts";

export const rerankStage: Stage = {
  name: "rerank",
  failure: "additive",
  when: (c) => c.hits.length > 1,
  run: async (c) => {
    const tRerank = Date.now();
    const scores = await rerank(portModelRunner(c.env), MODELS.rerank, c.query, c.hits.map((h) => h.text));
    console.log("stage: rerank", Date.now() - tRerank, "ms over", c.hits.length, "candidates");
    if (scores) {
      c.hits.forEach((h, i) => (h.rerank_score = scores[i]));
      c.hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
      if (c.filter?.doc_number) {
        // pin the scoped doc's OWN front matter: the synthetic family
        // chunk first; documents without one (D 29 — its chunks carry
        // overview/empty anchors, no family synthetic exists) still get
        // their overview pinned — the tail showed rerank preferring
        // R 106-1's prose for "What is OIML D 29?" with the scoped
        // doc's own content present in the pool (2026-10-10)
        const families = c.hits.filter((h) => h.metadata.clause_anchor === "family" && String(h.metadata.doc_number ?? "").split("-")[0] === String(c.filter!.doc_number).split("-")[0]);
        const own = families.length
          ? families
          : c.hits.filter((h) => String(h.metadata.doc_number ?? "") === String(c.filter!.doc_number).split("-")[0] && /^(overview|)$/i.test(String(h.metadata.clause_anchor ?? "")));
        if (own.length) {
          const ownIds = new Set(own.map((h) => h.id));
          c.hits = [...own, ...c.hits.filter((h) => !ownIds.has(h.id))];
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
