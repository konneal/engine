// HyDE — Hypothetical Document Embeddings (additive): embed the
// hypothetical answer and search with it — its vocabulary matches the
// corpus better than the question's. Only for non-filtered queries (a
// filter would nullify the benefit).
// Ref: arXiv 2212.10496; arXiv 2507.16754 (adaptive HyDE)
import { embed } from "../ai.ts";
import { MODELS, THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const hyde: Stage = {
  name: "hyde",
  failure: "additive",
  when: (c) => !!c.u?.hypothetical_answer && !c.filter,
  prefetch: (c) => {
    c.lane.hyde = embed(c.env.AI, MODELS.embed, c.u!.hypothetical_answer!)
      .then((hv) => c.env.VECTORIZE.query(hv, { topK: 20, returnMetadata: "all" }));
  },
  run: async (c) => {
    const hres = (await c.lane.hyde!) as any;
    const seenIds = new Set(c.matches.map((m: any) => m.id));
    for (const m of (hres.matches ?? []).slice(0, 10)) {
      if (!seenIds.has(m.id)) {
        c.matches.push({ id: m.id, score: m.score * THRESHOLDS.hydeDiscount, metadata: m.metadata });
        seenIds.add(m.id);
      }
    }
  },
};
