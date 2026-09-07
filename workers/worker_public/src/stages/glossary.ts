// Vocabulary link — the L2 nomenclature bridge (additive). Everyday
// words don't match defined terms — the one gap every comparison lane
// fails. Dense candidates + cross-encoder rerank, and the ANSWER model
// adjudicates among the top-3 (the entity-linking pattern: retrieval
// proposes, generation disambiguates — naive top-1 dense binding picks
// the wrong term). Computed BEFORE the pool closes, because the
// candidates' defining publications also ROUTE the pool: a question
// whose concept link lands in a family the primary lanes missed
// (colloquial "bag of flour sold by weight" → the prepackage domain)
// gets that family's passages merged like the graph lane does — the
// concept link is a family router, not just a note.
import { rerank } from "../ai.ts";
import { MODELS, THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const glossary: Stage = {
  name: "glossary",
  failure: "additive",
  when: (c) => !!c.env.GLOSSARY && c.vector.length > 0,
  run: async (c) => {
    const g = await c.env.GLOSSARY.query(c.vector, { topK: 5, returnMetadata: "all" });
    const cands = (g.matches ?? []).filter((m: any) => m.score >= THRESHOLDS.glossaryCosineFloor);
    if (cands.length) {
      const texts = cands.map((m: any) => String(m.metadata?.chunk_text ?? ""));
      const rs = await rerank(c.env.AI, MODELS.rerank, c.query, texts);
      const ranked = cands
        .map((m: any, i: number) => ({
          term: String(m.metadata?.clause_title ?? "").trim(),
          definition: String(m.metadata?.chunk_text ?? "").split(" — ").slice(1).join(" — ").slice(0, 300),
          docidentifier: String(m.metadata?.docidentifier ?? ""),
          doc_number: String(m.metadata?.doc_number ?? ""),
          score: rs ? rs[i] : m.score,
        }))
        .filter((x: any) => x.term && x.definition);
      // one entry per DISTINCT CONCEPT, and only candidates the
      // cross-encoder actually deems relevant (score > 0). Distinctness
      // is spelling-normalized: "Weigh labeler"/"Weigh labeller" are
      // one concept in two spellings — without normalization the note's
      // slots burn on variants while the domain-bridging concept one
      // rank down ("actual quantity" — the PREPACKAGE domain) never
      // reaches the adjudicator.
      const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/labeler\b/g, "labeller").replace(/\s+/g, " ").trim();
      const byTerm = new Map<string, (typeof ranked)[number]>();
      for (const r of ranked) if (r.score > 0) {
        const k = norm(r.term);
        if (!byTerm.has(k)) byTerm.set(k, r);
      }
      c.glossary = [...byTerm.values()].sort((a, b) => b.score - a.score).slice(0, 3);
      if (c.glossary.length) console.log("glossary link:", c.glossary.map((g2) => g2.term).join(", "));
    }
  },
};
