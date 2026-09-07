// Concept-graph lane (additive). The D1 projection (relaton structure +
// Glossarist defines edges) resolves what the query's WORDS map to in
// the corpus's own structure: a defined term → the documents that
// define it; a named publication → its family/successors. Same query
// vector, graph-filtered candidates — vocabulary mismatch stops
// mattering when the graph carries the link. Path A (rag#137): the
// concept link drives the SAME resolver — linked TERM → defining
// documents. Unlike the reverted candidate-family routing (every chunk
// of every candidate's family, which flooded the pool with the wrong
// domain), this is narrow: the definitional clauses of the linked
// concepts. "actual quantity" (defined by R 87) brings the prepackage
// domain in without the weigh-labeler families.
//
// NOTE: candidate-family pool routing was measured and REVERTED (rag#137
// experiment, 2026-09-05): the wrong-domain candidates' families (the
// labeler concepts, R 51/R 45) merged at the same discount and DILUTED
// the pool — canary fell 3/6 → 1/6. Candidate-level families cannot
// adjudicate domains; only the answer model can (it does, when the
// family's content reaches it).
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const conceptGraph: Stage = {
  name: "concept-graph",
  failure: "additive",
  when: (c) => c.glossary.length > 0 && !!c.env.DB && c.vector.length > 0,
  run: async (c) => {
    const numbers = new Set<string>();
    // the terms are independent — resolve them in PARALLEL; a serial loop
    // paid up to 3 sequential D1 round trips on the hot path
    const termRows = await Promise.all(
      c.glossary
        .slice(0, 3)
        .filter((gl) => gl.term.length >= 3)
        .map((gl) =>
          c.env.DB.prepare(
            "SELECT e.src AS doc FROM graph_edges e JOIN graph_nodes c ON e.dst = c.id WHERE e.kind = 'defines' AND c.kind = 'concept' AND (c.label = ?1 OR c.label LIKE ?2) LIMIT 12",
          )
            .bind(gl.term, `%${gl.term}%`)
            .all()
            .catch(() => ({ results: [] })) as Promise<any>,
        ),
    );
    for (const rows of termRows) {
      for (const r of rows.results ?? []) {
        const m = String(r.doc ?? "").match(/^doc:OIML-[A-Z]-(\d+)-/);
        if (m) numbers.add(m[1]!);
      }
    }
    if (numbers.size) {
      const gc = await c.env.VECTORIZE.query(c.vector, {
        topK: 12,
        returnMetadata: "all",
        filter: { doc_number: { $in: [...numbers] } },
      });
      const seenIds0 = new Set(c.matches.map((m: any) => m.id));
      let merged0 = 0;
      for (const m of (gc.matches ?? []).slice(0, 6)) {
        if (!seenIds0.has(m.id)) {
          c.matches.push({ id: m.id, score: m.score * THRESHOLDS.conceptGraphDiscount, metadata: m.metadata });
          seenIds0.add(m.id);
          merged0++;
        }
      }
      if (merged0) console.log("concept graph:", [...numbers].join(","), "— merged", merged0);
    }
  },
};
