// Section-summary units → leaf evidence (FABLE multi-granularity): a
// depth-1 summary vector that ranked is a navigation node, not quotable
// evidence: fetch its top child clauses (metadata-filtered, same query
// vector) so the model gets source text to cite, then retire the
// synthetic summary — the answer contract grounds claims in source
// clauses, never in our own summaries. The summary stays only when no
// child answered (it is then the doc's sole representative).
import { THRESHOLDS } from "../config.ts";
import type { ChunkMeta } from "../../../shared/chunk";
import type { Hit } from "../../../shared/chunk";
import type { Stage } from "./types.ts";

export const sectionDescent: Stage = {
  name: "section-descent",
  failure: "additive",
  when: (c) =>
    !!c.finalHits.find((h) => h.metadata.section_summary === "1" && h.metadata.child_anchors && h.score > 0) &&
    c.vector.length > 0,
  run: async (c) => {
    const sectionHit = c.finalHits.find(
      (h) => h.metadata.section_summary === "1" && h.metadata.child_anchors && h.score > 0,
    )!;
    const kids = sectionHit
      .metadata.child_anchors!.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 25);
    if (kids.length) {
      const cv = await c.env.VECTORIZE.query(c.vector, {
        topK: 3,
        returnMetadata: "all",
        filter: {
          $and: [
            { doc_id: { $eq: sectionHit.metadata.doc_id } },
            { clause_anchor: { $in: kids } },
          ],
        },
      });
      const childHits = (cv.matches ?? [])
        .filter((m: any) => !m.metadata?.section_summary)
        .map((m: any) => ({
          id: m.id,
          score: m.score * THRESHOLDS.sectionDescentDiscount,
          metadata: m.metadata as ChunkMeta,
          text: (m.metadata?.chunk_text as string) ?? "",
        }))
        .filter((x: Hit) => !c.finalHits.some((h) => h.id === x.id))
        .slice(0, 2);
      if (childHits.length) {
        c.finalHits = [...c.finalHits.filter((h) => h !== sectionHit), ...childHits];
        console.log(
          "section descent:",
          sectionHit.metadata.docidentifier,
          "§" + sectionHit.metadata.clause_anchor,
          "→",
          childHits.map((x: Hit) => "§" + x.metadata.clause_anchor).join(", "),
        );
      }
    }
  },
};
