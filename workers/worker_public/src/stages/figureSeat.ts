// The figure seat (TODO.sota/18.3's completion — the guaranteed place):
// a figure-SEEKING question deterministically seats the asked document's
// own figure chunks in the window. No embedding contest, no variance —
// the question names a figure; the document's figures get their places;
// the VLM rerank then orders them by image and the seeking completion
// attaches the block from the producer's payload. The D1 read is one
// bounded query (doc_number + block, LIMIT 3), additive, ablatable like
// any stage. Positioned BEFORE the VLM rerank so the rerank sees the
// seated figures and can order them by image.
import { FIGURE_Q } from "./vlmFigureRerank.ts";
import { portStore } from "../env.ts";
import type { Stage } from "./types.ts";
import type { Hit } from "../../../shared/chunk";

export const figureSeat: Stage = {
  name: "figure-seat",
  failure: "additive",
  when: (c) => FIGURE_Q.test(c.query),
  run: async (c) => {
    try {
      const counts = new Map<string, number>();
      for (const h of c.finalHits.slice(0, 5)) {
        const dn = String((h.metadata as any).doc_number ?? "");
        if (dn) counts.set(dn, (counts.get(dn) ?? 0) + 1);
      }
      const docNumber = (c.u as any)?.doc_number ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!docNumber) return;
      const seated = new Set(
        c.finalHits.filter((h: Hit) => (h.metadata as any).block === "figure").map((h: Hit) => String((h.metadata as any).unit_id ?? h.id)),
      );
      const rows = await portStore(c.env)
        .prepare(
          `SELECT id, doc_id, docidentifier, clause_anchor, clause_title, doc_number, edition, language, status, corpus, tier, text, unit_id
           FROM chunks WHERE doc_number = ?1 AND block = 'figure' AND unit_id IS NOT NULL LIMIT 3`,
        )
        .bind(String(docNumber))
        .all();
      const fresh: Hit[] = [];
      for (const r of (rows.results ?? []) as any[]) {
        if (seated.has(String(r.unit_id))) continue;
        fresh.push({
          id: String(r.id),
          score: 0,
          rerank_score: 0,
          text: String(r.text ?? ""),
          metadata: {
            doc_id: String(r.doc_id ?? ""),
            docidentifier: String(r.docidentifier ?? ""),
            doc_number: String(r.doc_number ?? docNumber),
            clause_anchor: r.clause_anchor ? String(r.clause_anchor) : undefined,
            clause_title: r.clause_title ? String(r.clause_title) : undefined,
            edition: r.edition ? String(r.edition) : undefined,
            language: r.language ? String(r.language) : undefined,
            status: r.status ? String(r.status) : undefined,
            corpus: r.corpus ? String(r.corpus) : undefined,
            tier: r.tier ? String(r.tier) : undefined,
            block: "figure",
            unit_id: String(r.unit_id),
          } as any,
        });
      }
      if (!fresh.length) return;
      c.finalHits = [...fresh, ...c.finalHits];
      console.log("figure-seat: seated", fresh.length, "figure chunk(s) of doc", docNumber);
    } catch {
      // additive — the text ranking stands
    }
  },
};
