// Section-summary units → leaf evidence (FABLE multi-granularity, the
// RAPTOR extension of TODO.sota/06's catalog row 3): a ranked summary
// is a navigation node, not quotable evidence — the stage descends it
// to source clauses and retires the synthetic node. Two levels:
//   level 1 (section summary): child_anchors are CLAUSE anchors — the
//     same-query vector search finds the clauses within the document.
//   level 2 (document summary): child_anchors are LEVEL-1 UNIT ids —
//     they come back by id (the ≤20 getByIds law), and each consumed
//     section's clauses come from the D1 corpus DIRECTLY (the l6a law:
//     the corpus is the source of truth; the index metadata filters
//     are dead on this index).
// The summary stays only when no child answered (it is then the doc's
// sole representative).
import { THRESHOLDS } from "../config.ts";
import type { ChunkMeta } from "../../../shared/chunk";
import type { Hit } from "../../../shared/chunk";
import type { Stage } from "./types.ts";

const CHUNK_COLS =
  "id, doc_id, docidentifier, doctype, doc_number, edition, language, clause_anchor, clause_title, status, superseded_by, corpus, tier, text, unit_id, block";

/** A level-2 document summary's section children, by id (the ≤20
 *  getByIds law caps each read). */
async function sectionChildren(env: any, unitIds: string[]): Promise<Hit[]> {
  const kids: Hit[] = [];
  for (let i = 0; i < unitIds.length; i += 20) {
    const got = (await env.VECTORIZE.getByIds(unitIds.slice(i, i + 20))) ?? [];
    for (const v of got) {
      if (!v?.metadata?.child_anchors) continue;
      kids.push({
        id: v.id,
        score: 0,
        metadata: v.metadata as ChunkMeta,
        text: String((v.metadata as any).chunk_text ?? ""),
      });
    }
  }
  return kids;
}

/** A section's child clauses, from the D1 corpus directly. */
async function clausesOf(env: any, docId: string, anchors: string[], limit: number): Promise<Hit[]> {
  const marks = anchors.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT ${CHUNK_COLS} FROM chunks WHERE doc_id = ? AND clause_anchor IN (${marks}) LIMIT ${limit}`,
  )
    .bind(docId, ...anchors)
    .all()
    .catch(() => ({ results: [] }));
  return (res.results ?? []).map((r: any) => ({
    id: String(r.id),
    score: 0,
    metadata: r as unknown as ChunkMeta,
    text: String(r.text ?? ""),
  }));
}

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

    if ((sectionHit.metadata as any).summary_level === "2") {
      // document summary → its leading section nodes → their clauses
      const unitIds = sectionHit
        .metadata.child_anchors!.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 12);
      const kids = await sectionChildren(c.env, unitIds);
      // document reading order (child_anchors order) is the doc-scope
      // prior; the summaries were written in it
      const order = new Map(unitIds.map((id, i) => [id, i]));
      kids.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
      const collected: Hit[] = [];
      const consumed: string[] = [];
      for (const kid of kids.slice(0, 2)) {
        const anchors = kid.metadata.child_anchors!.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 25);
        if (!anchors.length) continue;
        const clauses = (await clausesOf(c.env, String(kid.metadata.doc_id), anchors, 6))
          .filter((x) => !c.finalHits.some((h) => h.id === x.id) && !collected.some((h) => h.id === x.id))
          .slice(0, 2)
          .map((x) => ({ ...x, score: sectionHit.score * THRESHOLDS.sectionDescentDiscount }));
        if (clauses.length) {
          collected.push(...clauses);
          consumed.push(kid.id);
        }
      }
      if (collected.length) {
        c.finalHits = [...c.finalHits.filter((h) => h !== sectionHit), ...collected];
        console.log(
          "section descent (doc):",
          sectionHit.metadata.docidentifier,
          "→",
          collected.map((x) => "§" + x.metadata.clause_anchor).join(", "),
        );
      }
      return;
    }

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
