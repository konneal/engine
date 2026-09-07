// Dense lane (blocking): the primary Vectorize query over the folded
// retrieval query. Three shapes: Option C optimistic reuse (identical
// query, no filter — bit-for-bit same candidates, one serial round-trip
// saved), the doc/edition-filtered query with its guessed-pin drop and
// sparse-filter widen, and the plain unfiltered query.
import { LIMITS } from "../config.ts";
import { toVectorizeFilter } from "../selfquery.ts";
import type { Stage } from "./types.ts";

export const dense: Stage = {
  name: "dense",
  run: async (c) => {
    const { env, filter, filters, vector, opts, rq, folded } = c;
    const q: any = { topK: LIMITS.retrieveK, returnMetadata: "all" };
    if (filter) q.filter = filter;
    const optimistic = opts.optimisticHits ?? [];
    const sameLane = rq === folded; // optimistic vector === this lane's vector
    if (!filter && sameLane && optimistic.length) {
      // Option C fast path: the unfiltered dense query already ran
      // concurrently with understanding — same vector, same topK, no
      // filter. Reusing it skips one serial Vectorize round-trip with a
      // bit-for-bit identical candidate set.
      c.matches = optimistic.map((h) => ({ id: h.id, score: h.score, metadata: h.metadata }));
      console.log("optimistic lane: reused", c.matches.length, "dense hits (no re-query)");
      // NOTE: when rq diverged (standalone_query / override) the
      // optimistic hits are deliberately NOT unioned. Measured
      // 2026-08-30: injecting the raw question's top-50 into a
      // rewritten query's pool let topically close but wrong documents
      // outscore the correct ones under the cross-encoder — recall@5
      // fell 94.3% → 89.7% (golden ×3). The optimistic lane may only
      // REPLACE an identical query, never dilute a better one.
      return;
    }
    if (filter) {
      let matches: any[] = (await env.VECTORIZE.query(vector, q)).matches ?? [];
      // an edition pin corroborated by (almost) nothing means the pin
      // was a guess — understanding emits editions for families it
      // mixes up (observed: R 76 pinned @2021, an R 60 year; the corpus
      // holds 1988/1992/2006). The index is the ground truth for which
      // editions EXIST: a wrong pin starves the doc filter and the
      // widen then floods the pool with superseded editions. Drop to
      // the doc-only filter and let family-relative steering rank
      // editions downstream. A pin the user actually asked for
      // survives — its edition exists in the corpus.
      if (filters && filters.edition && matches.length < 3) {
        const docOnly = await env.VECTORIZE.query(vector, {
          topK: LIMITS.retrieveK,
          returnMetadata: "all",
          filter: toVectorizeFilter({ doc_number: filters.doc_number }),
        });
        if ((docOnly.matches ?? []).length > matches.length) {
          console.log("edition pin dropped:", filters.doc_number, "@", filters.edition, "→", docOnly.matches?.length ?? 0, "doc-scoped hits (edition not in corpus)");
          matches = docOnly.matches ?? [];
          filters.edition = undefined;
        }
      }
      if (matches.length < LIMITS.rerankKeep) {
        // sparse doc filter → widen with the unfiltered ranking. Same
        // lane: the optimistic results ARE that ranking (identical
        // vector, no filter) — reuse them; otherwise re-query with this
        // lane's vector.
        const unfiltered = sameLane && optimistic.length
          ? optimistic.map((h) => ({ id: h.id, score: h.score, metadata: h.metadata }))
          : (await env.VECTORIZE.query(vector, { topK: LIMITS.retrieveK, returnMetadata: "all" })).matches ?? [];
        const seen = new Set(matches.map((m: any) => m.id));
        matches = [...matches, ...unfiltered.filter((m: any) => !seen.has(m.id))];
      }
      c.matches = matches;
      return;
    }
    c.matches = (await env.VECTORIZE.query(vector, q)).matches ?? [];
  },
};
