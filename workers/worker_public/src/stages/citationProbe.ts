// Citation probe (deterministic): questions asking what a publication
// CITES/REFERENCES need the bibliography chunks in the pool, but the
// bibliography's embedding rarely matches the question's phrasing —
// and prior editions may carry references the current one dropped.
// This stage pattern-matches the citation question shape and fires a
// supplementary retrieval for the bibliography section, scoped to the
// named document family (all editions). Additive: results join the
// pool; nothing is filtered.
// The gap: "What ISO standards does R 60 cite?" — R 60-1:2021's
// bibliography lists OIML documents only; the ISO/IEC references live
// in the 2017 edition's §22.3 (2026-09-15).
import { toHits, type Stage } from "./types.ts";
import { namedDocumentIn } from "../context.ts";
import type { Hit } from "../../../shared/chunk.ts";

const CITE_PATTERN = /\b(?:cite[sd]?|citing|referenc(?:e|es|ed|ing)|list[s]?|quote[sd]?)\b/i;
const REFS_PATTERN = /\b(?:standard|publication|document|normative|bibliograph)/i;

export const citationProbe: Stage = {
  name: "citation-probe",
  failure: "additive",
  when: (c) => {
    if (!CITE_PATTERN.test(c.query) || !REFS_PATTERN.test(c.query)) return false;
    // the TEXT-derived naming (namedDocumentIn), never the LLM's
    // extraction — the understand model may omit doc_number for this
    // query shape (measured: it did)
    const named = namedDocumentIn(c.query);
    if (!named) return false;
    (c as any).__citeDocNum = named.doc_number;
    return true;
  },
  prefetch: (c) => {
    // deterministic: the chunk store's own bibliography-titled chunks for
    // this document family — no embedding similarity involved (three
    // vector-probe iterations measured: the embedding never matched
    // reliably)
    const docNum = String((c as any).__citeDocNum ?? c.u?.doc_number ?? "");
    c.lane["citation-probe"] = (async () => {
      if (!docNum) return [] as Hit[];
      try {
        const rows = await c.env.DB.prepare(
          "SELECT id FROM chunks_fts WHERE chunks_fts MATCH ?1 AND doc_number = ?2 LIMIT 8",
        )
          .bind("bibliography OR references", docNum)
          .all() as { results?: Array<{ id: string }> };
        const ids = (rows.results ?? []).map((r: { id: string }) => r.id).slice(0, 8);
        if (!ids.length) return [] as Hit[];
        const got = await c.env.VECTORIZE.getByIds(ids);
        // getByIds returns score=0 — the usedHits builder sorts by score
        // and takes the top N, so zero-score hits never make the cut.
        // These are deterministically relevant (the user asked what the
        // document cites; these ARE the bibliography chunks) — give them
        // a score that places them at the head of the pool.
        return (got ?? []).map((h: any) => ({ ...h, score: 10 }));
      } catch {
        return [] as Hit[];
      }
    })();
  },
  run: async (c) => {
    const probes = (await c.lane["citation-probe"]) as Hit[];
    const seen = new Set(c.matches.map((m: any) => m.id));
    let added = 0;
    // only bibliography-shaped chunks (clause title or text mentions it)
    for (const h of probes) {
      if (seen.has(h.id as any)) continue;
      const title = String((h.metadata as any)?.clause_title ?? "");
      const text = String(h.text ?? "");
      if (/bibliograph|normative reference/i.test(title + " " + text.slice(0, 300))) {
        c.matches.push(h);
        seen.add(h.id as any);
        added++;
      }
    }
    if (added) console.log("citation probe: +", added, "bibliography chunks from doc", c.u?.doc_number);
  },
};
