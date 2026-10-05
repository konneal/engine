// Licensed lane (additive): an entitled caller whose question is
// topically about a licensed standard gets that standard's typed units
// merged into the pool at the graph lane's discount — the public
// restatements (the Recommendations' own annexes citing the standard)
// stop out-ranking the licensed package's own units, the rank-order
// gap the quality ledger has documented on every damp-heat run since
// the eleven-standard wave. Unentitled callers never see this lane
// (license-scope would strip the units anyway — the lane simply does
// not fire).
import { THRESHOLDS } from "../config.ts";
import { portIndex } from "../env.ts";
import type { Stage } from "./types.ts";

export const licensedLane: Stage = {
  name: "licensed-lane",
  failure: "additive",
  when: (c) => !!c.opts.licensedDocNumbers?.length && c.vector.length > 0,
  prefetch: (c) => {
    c.lane["licensed-lane"] = portIndex(c.env, "public").query({
      vector: c.vector,
      topK: 12,
      filter: { standard: { $in: c.opts.licensedDocNumbers } },
    });
  },
  run: async (c) => {
    const g = (await c.lane["licensed-lane"]!) as any;
    const seenIds = new Set(c.matches.map((m: any) => m.id));
    let merged = 0;
    for (const m of (g ?? []).slice(0, 10)) {
      if (!seenIds.has(m.id)) {
        c.matches.push({ id: m.id, score: m.score * THRESHOLDS.graphLaneDiscount, metadata: m.metadata });
        seenIds.add(m.id);
        merged++;
      }
    }
    console.log("licensed lane:", g?.length ?? 0, "hits,", merged, "merged");
  },
};
