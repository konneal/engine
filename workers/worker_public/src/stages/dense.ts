// Dense lane (blocking): the primary Vectorize query over the folded
// retrieval query. Three shapes: Option C optimistic reuse (identical
// query, no filter — bit-for-bit same candidates, one serial round-trip
// saved), the doc/edition-filtered query with its guessed-pin drop and
// sparse-filter widen, and the plain unfiltered query.
import { LIMITS } from "../config.ts";
import type { Stage } from "./types.ts";

export const dense: Stage = {
  name: "dense",
  run: async (c) => {
    const { env, filters, vector, opts, rq, folded } = c;
    // the index's metadata filtering is DEAD on this platform (measured
    // 2026-10-05: filters return empty for values proven present), so
    // the scope never rides the query — the matches filter IN CODE and
    // the sparse widen still covers thin scopes
    const q: any = { topK: LIMITS.retrieveK, returnMetadata: "all" };
    const optimistic = opts.optimisticHits ?? [];
    const sameLane = rq === folded; // optimistic vector === this lane's vector
    if (!filters?.doc_number && sameLane && optimistic.length) {
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
    if (filters?.doc_number) {
      const allMatches: any[] = (await env.VECTORIZE.query(vector, q)).matches ?? [];
      let matches: any[] = allMatches;
      const before = matches.length;
      matches = matches.filter((m) => String(m.metadata?.doc_number ?? "") === filters.doc_number);
      if (filters.edition) matches = matches.filter((m) => !m.metadata?.edition || String(m.metadata.edition) === filters.edition);
      console.log("dense scope (in code):", before, "→", matches.length, "in doc", filters.doc_number, filters.edition ? `@${filters.edition}` : "");
      // an edition pin corroborated by (almost) nothing means the pin
      // was a guess — understanding emits editions for families it
      // mixes up (observed: R 76 pinned @2021, an R 60 year; the corpus
      // holds 1988/1992/2006). The index is the ground truth for which
      // editions EXIST: a wrong pin starves the doc filter and the
      // widen then floods the pool with superseded editions. Drop to
      // the doc-only filter and let family-relative steering rank
      // editions downstream. A pin the user actually asked for
      // survives — its edition exists in the corpus.
      // the same guess-drop, in code: a pinned edition that starved the
      // scoped set drops to the doc-only scope
      if (filters && filters.edition && matches.length < 3) {
        const docOnly = allMatches.filter((m) => String(m.metadata?.doc_number ?? "") === filters.doc_number);
        if (docOnly.length > matches.length) {
          console.log("edition pin dropped:", filters.doc_number, "@", filters.edition, "→", docOnly.length, "doc-scoped hits (edition not in corpus)");
          matches = docOnly;
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
