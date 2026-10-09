// The declared context's hard seal (TODO.ai-platform/02) — pool-level,
// after every lane has merged, before rerank + the top-N cut. Nothing
// outside the declared family competes for the window; everything
// inside it does.
import { matchesDocScope } from "../context.ts";
import type { ChunkMeta, Hit } from "../../../shared/chunk";
import type { Stage } from "./types.ts";

/** The sealed family's chunks, from the D1 corpus directly (the l6a
 *  law): the declared context's guarantee is that the publication CAN
 *  answer — a generic question's global ranking need not contain the
 *  family at all, so an emptied pool pulls the family's own text. */
async function familyChunks(env: any, familyNumber: string, query: string, keep: number): Promise<Hit[]> {
  const rows = await env.DB.prepare(
    "SELECT id, doc_id, docidentifier, doctype, doc_number, edition, language, clause_anchor, clause_title, status, superseded_by, corpus, tier, text, unit_id, block, bm25(chunks_fts) AS rank FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid WHERE chunks_fts MATCH ?1 AND c.doc_number = ?2 ORDER BY rank LIMIT ?3",
  )
    .bind(query.replace(/["'^]/g, " ").trim() || familyNumber, familyNumber, keep)
    .all()
    .catch(() => ({ results: [] }));
  return (rows.results ?? []).map((r: any) => ({
    id: String(r.id),
    score: 0,
    metadata: r as unknown as ChunkMeta,
    text: String(r.text ?? ""),
  }));
}

export const seal: Stage = {
  name: "seal",
  when: (c) => !!c.opts.sealScope || !!c.opts.editionSteer || !!c.opts.editionExclude,
  run: async (c) => {
    const before = c.hits.length;
    const scope = c.opts.sealScope!;
    if (scope) {
        c.hits = c.hits.filter((h) => matchesDocScope(h.metadata, scope.doc_number) && (!scope.edition || h.metadata.edition === scope.edition));
      console.log("context seal:", before, "→", c.hits.length, "candidates within", `doc#${scope.doc_number}${scope.edition ? "@" + scope.edition : ""}`);
      if (c.hits.length === 0) {
        // the declared-context guarantee: the family's own text enters
        // even when no global ranking carried it — the FTS ranking over
        // the family grain (the part identity steers by docidentifier
        // downstream, the same grain law matchesDocScope enforces)
        const familyNumber = scope.doc_number.includes("-") ? scope.doc_number.split("-")[0] : scope.doc_number;
        const pulled = (await familyChunks(c.env, familyNumber, c.rq || c.query, 12))
          .filter((h) => matchesDocScope(h.metadata, scope.doc_number) && (!scope.edition || h.metadata.edition === scope.edition))
          .slice(0, 8)
          .map((h) => ({ ...h, score: 0.5 }));
        if (pulled.length) {
          c.hits = pulled;
          console.log("context seal: pool empty — pulled", pulled.length, "family chunks from the corpus for", `doc#${scope.doc_number}`);
        }
      }
      return;
    }
    const exclude = c.opts.editionExclude!;
    if (exclude) {
      const before = c.hits.length;
      c.hits = c.hits.filter((h) => !(h.metadata.doc_number === exclude.doc_number && h.metadata.edition !== exclude.edition));
      console.log("edition exclude:", before, "→", c.hits.length, "after dropping superseded candidates of", `doc#${exclude.doc_number}@${exclude.edition}`);
      return;
    }
    const steer = c.opts.editionSteer!;
    const current: typeof c.hits = [];
    const superseded: typeof c.hits = [];
    for (const h of c.hits) {
      const same = h.metadata.doc_number === steer.doc_number;
      (same && h.metadata.edition !== steer.edition ? superseded : current).push(h);
    }
    c.hits = [...current, ...superseded];
    console.log("edition steer:", superseded.length, "superseded candidates demoted behind", current.length, "current-edition candidates of", `doc#${steer.doc_number}@${steer.edition}`);
  },
};
