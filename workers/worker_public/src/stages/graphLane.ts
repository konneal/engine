// Graph lane (additive): the caller-resolved document numbers (relaton
// family/successor resolution done in index.ts) merge their
// query-relevant candidates at a discount.
//
// Identity resolution, not index filtering: the candidates rank by the
// corpus's own BM25 WITHIN the document set (lexicalWithin) — Vectorize
// metadata filtering is dead on this index (measured 2026-10-05:
// filters return empty for values proven present), so the filter this
// lane used for its whole life merged nothing. The lexical rows carry
// their own text and metadata; no index round trip is needed at all.
import { THRESHOLDS } from "../config.ts";
import { lexicalWithin } from "../lexical.ts";
import type { Stage } from "./types.ts";

export const graphLane: Stage = {
  name: "graph-lane",
  failure: "additive",
  when: (c) => !!c.opts.graphDocNumbers?.length && c.vector.length > 0,
  prefetch: (c) => {
    c.lane["graph-lane"] = lexicalWithin(c.env, c.rq || c.query, c.opts.graphDocNumbers!, 15);
  },
  run: async (c) => {
    const g = (await c.lane["graph-lane"]!) as any;
    const seenIds = new Set(c.matches.map((m: any) => m.id));
    let merged = 0;
    for (const m of (g ?? []).slice(0, 10)) {
      if (!seenIds.has(m.id)) {
        c.matches.push({ id: m.id, score: m.score * THRESHOLDS.graphLaneDiscount, metadata: m.metadata });
        seenIds.add(m.id);
        merged++;
      }
    }
    console.log("graph lane:", g?.length ?? 0, "hits,", merged, "merged");
  },
};
