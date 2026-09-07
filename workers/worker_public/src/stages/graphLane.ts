// Graph lane (additive): the caller-resolved document numbers (relaton
// family/successor resolution done in index.ts) merge their top
// candidates at a discount.
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const graphLane: Stage = {
  name: "graph-lane",
  failure: "additive",
  when: (c) => !!c.opts.graphDocNumbers?.length && c.vector.length > 0,
  run: async (c) => {
    const g = await c.env.VECTORIZE.query(c.vector, {
      topK: 15,
      returnMetadata: "all",
      filter: { doc_number: { $in: c.opts.graphDocNumbers } },
    });
    const seenIds = new Set(c.matches.map((m: any) => m.id));
    let merged = 0;
    for (const m of (g.matches ?? []).slice(0, 10)) {
      if (!seenIds.has(m.id)) {
        c.matches.push({ id: m.id, score: m.score * THRESHOLDS.graphLaneDiscount, metadata: m.metadata });
        seenIds.add(m.id);
        merged++;
      }
    }
    console.log("graph lane:", g.matches?.length ?? 0, "hits,", merged, "merged");
  },
};
