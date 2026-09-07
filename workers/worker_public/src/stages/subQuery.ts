// Multi-hop decomposition for complex questions (additive per sub-query):
// retrieve for each sub-question and merge the top results.
// Ref: Agent-Orchestrated Adaptive RAG (arXiv 2606.05658)
import { embed } from "../ai.ts";
import { MODELS, THRESHOLDS } from "../config.ts";
import { toHits, type Stage } from "./types.ts";

export const subQuery: Stage = {
  name: "sub-query",
  when: (c) => c.u?.complexity === "complex" && !!c.u?.sub_queries?.length,
  run: async (c) => {
    const { env, u } = c;
    // sub-questions are independent — parallel rounds, same as variants
    const subResults = (
      await Promise.all(
        u!.sub_queries!.slice(0, 4).map(async (sub) => {
          try {
            const sv = await embed(env.AI, MODELS.embed, sub);
            const sres = await env.VECTORIZE.query(sv, { topK: 15, returnMetadata: "all" });
            return toHits(sres.matches ?? []);
          } catch {
            return [] as never[]; // sub-query failure — primary results stand
          }
        }),
      )
    ).filter((r) => r.length > 0);
    // merge sub-results into the candidate pool (union, no RRF — these
    // are complementary perspectives, not alternatives)
    const seenIds = new Set(c.matches.map((m: any) => m.id));
    for (const sr of subResults) {
      for (const h of sr.slice(0, 8)) {
        if (!seenIds.has(h.id)) {
          c.matches.push({ id: h.id, score: h.score * THRESHOLDS.subQueryDiscount, metadata: h.metadata });
          seenIds.add(h.id);
        }
      }
    }
  },
};
