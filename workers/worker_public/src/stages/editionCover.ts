// Edition cover (the l6a guarantee): when a pool holds ONLY stale
// editions of a document whose ACTIVE edition the registry knows, fetch
// the current edition's chunks and add them at a discount — the current
// edition must be ABLE to win: edition steering demotes stale siblings
// only when the successor is in the pool ("R 60:2017 answers 'which
// edition applies'" was the observed failure under rerank draws that
// left every 2021 chunk out). One registry read per query; at most
// `maxDocs` documents covered; additive — any failure skips.
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";
import { rowsToHits } from "../lexical.ts";

const maxDocs = 2;

import { refCodec } from "../codecs.ts";
const familyOf = (di: string): string | null => refCodec().familyOf(di);

export const editionCover: Stage = {
  name: "edition-cover",
  failure: "additive",
  when: (c) => !c.filters?.edition && c.hits.length > 1,
  run: async (c) => {
    const poolDocs = new Map<string, Set<string>>();
    for (const h of c.hits) {
      const di = h.metadata.docidentifier;
      const ed = h.metadata.edition;
      if (!di || !ed) continue;
      if (!poolDocs.has(di)) poolDocs.set(di, new Set());
      poolDocs.get(di)!.add(ed);
    }
    const families = [...new Set([...poolDocs.keys()].map(familyOf).filter(Boolean))] as string[];
    if (!families.length) return;
    const ph = families.map(() => "?").join(",");
    const rows = (await c.env.DB.prepare(`SELECT docidentifier, edition FROM documents WHERE family IN (${ph}) AND active = 1`).bind(...families).all()).results ?? [];
    // registry identifiers may carry the edition suffix; chunks never do
    const want: Array<{ di: string; edition: string }> = [];
    for (const r of rows as any[]) {
      const di = String(r.docidentifier ?? "").replace(/:\d{4}$/, "");
      const ed = String(r.edition ?? "");
      if (di && /^\d{4}$/.test(ed) && poolDocs.has(di) && !poolDocs.get(di)!.has(ed)) want.push({ di, edition: ed });
    }
    if (!want.length) return;
    const top = Math.max(...c.hits.map((h) => h.score));
    let added = 0;
    for (const w of want.slice(0, maxDocs)) {
      try {
        // identity resolution, not index filtering: the index's metadata
        // filters are dead on this platform (measured 2026-10-05 — the
        // cover's $and docidentifier/edition query returned empty for
        // its whole life), but the D1 chunks table IS the corpus — the
        // current edition's chunks read directly, text and all
        const rows = await c.env.DB.prepare(
          "SELECT id, doc_id, docidentifier, doctype, doc_number, edition, language, clause_anchor, clause_title, status, superseded_by, corpus, tier, text FROM chunks WHERE docidentifier = ?1 AND edition = ?2 LIMIT 3",
        )
          .bind(w.di, w.edition)
          .all();
        const hits = rowsToHits(rows.results ?? []).map((h) => ({ ...h, score: top * THRESHOLDS.editionCoverDiscount }));
        c.hits.push(...hits);
        added += hits.length;
        console.log("edition cover:", w.di, w.edition, `+${hits.length}`);
      } catch {
        // additive — retrieval stands without the cover
      }
    }
    if (added) c.hits.sort((a, b) => b.score - a.score);
  },
};
