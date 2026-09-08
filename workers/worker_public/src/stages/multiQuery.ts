// Multi-Query RAG-Fusion: generate 2-3 alternative phrasings, retrieve
// for each, fuse via RRF. Different phrasings surface documents the
// original query misses.
// Ref: RAG-Fusion paper (Semantic Scholar b4d1da74); dev.to 2026 blueprint
import { embed } from "../ai.ts";
import { LIMITS, MODELS } from "../config.ts";
import { toHits, type Stage } from "./types.ts";
import type { Hit } from "../../../shared/chunk.ts";

const RRF_K = 60;

export const multiQuery: Stage = {
  name: "multi-query",
  when: (c) => !!c.u?.query_variants?.length,
  prefetch: (c) => {
    const { env, filter, u } = c;
    // the variants are independent queries — embed + search them in
    // PARALLEL (and ahead of the dense lane, via prefetch); a serial
    // loop paid 2 x (embed + query) round trips on the hot path for
    // zero quality difference (same candidate set)
    c.lane["multi-query"] = Promise.all(
      u!.query_variants!.slice(0, 3).map(async (variant) => {
        try {
          const vv = await embed(env.AI, MODELS.embed, variant);
          const vres = await env.VECTORIZE.query(vv, { topK: 20, returnMetadata: "all", ...(filter ? { filter } : {}) });
          return toHits(vres.matches ?? []);
        } catch {
          return [] as never[]; // variant retrieval failure — primary results stand
        }
      }),
    );
  },
  run: async (c) => {
    const variantResults = ((await c.lane["multi-query"]!) as Hit[][]).filter((r) => r.length > 0);
    // RRF fuse: primary ranking + each variant ranking
    if (variantResults.length > 0) {
      const allRankings = [toHits(c.matches), ...variantResults];
      // simple RRF across all rankings
      const scores = new Map<string, number>();
      const byId = new Map<string, (typeof allRankings)[number][number]>();
      allRankings.forEach((ranking) => {
        ranking.forEach((h, i) => {
          scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (RRF_K + i + 1));
          byId.set(h.id, h);
        });
      });
      const fused = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, LIMITS.retrieveK)
        .map(([id]) => byId.get(id)!)
        .filter(Boolean);
      if (fused.length > 0) {
        c.matches = fused.map((h) => ({ id: h.id, score: h.score, metadata: h.metadata }));
      }
    }
  },
};
