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
import { embed } from "../ai.ts";
import { MODELS } from "../config.ts";
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
    const { env, u } = c;
    const docNum = String((c as any).__citeDocNum ?? u!.doc_number);
    // the probe: the bibliography's own vocabulary, scoped to the family
    const probe = `bibliography normative references standards cited document ${docNum}`;
    // no edition filter — prior editions may carry what the current dropped
    c.lane["citation-probe"] = (async () => {
      try {
        const v = await embed(env.AI, MODELS.embed, probe);
        const res = await env.VECTORIZE.query(v, {
          topK: 12,
          returnMetadata: "all",
          filter: { doc_number: docNum },
        });
        return toHits(res.matches ?? []);
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
