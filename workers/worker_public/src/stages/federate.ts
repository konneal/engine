// Federated ISO/IEC tier (additive by contract — the federate callback
// catches its own transport failures). Members get passages from the
// internal index (service binding) merged into the same candidate pool;
// the shared reranker + fusion below sort it out. Slight discount: the
// public corpus answers by default.
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const federate: Stage = {
  name: "federate",
  when: (c) => !!c.opts.federate,
  run: async (c) => {
    const fed = await c.opts.federate!(c.rq).catch(() => []);
    const seen = new Set(c.hits.map((h) => h.id));
    for (const h of fed) {
      if (!seen.has(h.id)) {
        c.hits.push({ ...h, score: h.score * THRESHOLDS.federateDiscount });
        seen.add(h.id);
      }
    }
  },
};
