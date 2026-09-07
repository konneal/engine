// Answer contract v2 — typed-chunk pin (FINAL position): doc-scoped
// queries get ONE typed unit chunk (table first) guaranteed a slot.
// Prose outranks serialized tables under the cross-encoder AND the
// per-doc diversity cap counts typed chunks against the same doc key —
// without this guarantee the model never sees a unit id to reference.
// Includes the small-to-big parent fetch: an embedded object answers
// WITH its clause — if the parent clause's prose passage is not already
// among the finals, one metadata-filtered fetch adds it. The typed unit
// cites; the clause grounds.
import { LIMITS, THRESHOLDS } from "../config.ts";
import type { Hit } from "../../../shared/chunk";
import type { Stage } from "./types.ts";

/** Typed-chunk selection for the pin: among a doc's typed units pick the
 *  one whose text best overlaps the QUERY (the first candidate is wrong as
 *  often as right — annex example tables outrank nothing). Lexical-overlap
 *  heuristic over title + serialized rows; tables, figures and formulas
 *  compete on the same score so a figure question can pin the figure
 *  (which then feeds multimodal generation), while table-value questions
 *  still pin their table on overlap. */
function pickTypedChunk(query: string, candidates: Hit[], ranked: Hit[]): Hit | null {
  if (!candidates.length) return null;
  const pool = candidates;
  const terms = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2);
  // the top-ranked PROSE passage usually sits in the answer clause: a
  // typed chunk from that same clause is the answering object, not a
  // same-topic example from an annex
  const topProse = ranked.find((h) => !h.metadata.unit_id);
  const topAnchor = topProse?.metadata.clause_anchor ?? "";
  let best: Hit | null = null;
  let bestScore = -1;
  for (const h of pool) {
    const hay = `${h.metadata.clause_title ?? ""} ${h.text}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score++;
    if (topAnchor && h.metadata.clause_anchor === topAnchor) score += terms.length; // dominates
    // blank annex FORMS (empty value cells) are not answer tables
    const cells = h.text.split("|").map((x) => x.trim());
    const filled = cells.filter((x) => x.length > 0).length;
    const density = cells.length ? filled / cells.length : 0;
    score += density * 2;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best ?? pool[0];
}

export const typedPin: Stage = {
  name: "typed-pin",
  when: (c) => {
    // family scope: the hard doc filter, else the understanding's
    // family, else the UNION of the vocabulary link's candidate
    // families — a value question can straddle families that define
    // near-identical tables (n_LC class B = 5 000 exists in R 60-1 AND
    // R 76-2); pickTypedChunk's overlap + top-prose-anchor scoring then
    // picks the right table among them instead of the family choice
    // deciding in advance
    const glossaryFamilies = new Set<string>();
    for (const g of c.glossary) if (g.doc_number) glossaryFamilies.add(g.doc_number.split("-")[0]);
    const pinFamily = c.filters?.doc_number ?? c.u?.doc_number ?? null;
    return new Set<string>(pinFamily ? [pinFamily.split("-")[0]] : [...glossaryFamilies]).size > 0;
  },
  run: async (c) => {
    const { query, filters, u, glossary, hits, env, vector } = c;
    const glossaryFamilies = new Set<string>();
    for (const g of glossary) if (g.doc_number) glossaryFamilies.add(g.doc_number.split("-")[0]);
    const pinFamily = filters?.doc_number ?? u?.doc_number ?? null;
    const pinFamilies = new Set<string>(pinFamily ? [pinFamily.split("-")[0]] : [...glossaryFamilies]);
    const base = (dn?: string) => String(dn ?? "").split("-")[0];
    const sameDocTyped = (h: Hit) =>
      !!h.metadata.unit_id && !!h.metadata.block && pinFamilies.has(base(h.metadata.doc_number));
    {
      // the pin guarantees the BEST query-overlap typed unit a slot — not
      // merely "some" typed unit. Hard doc scope pins unconditionally
      // (existing behavior); the glossary-family union (no hard scope)
      // pins only on real query overlap — the picker always returns
      // SOMETHING, and a near-zero-overlap table riding the window on
      // every vocabulary-linked query would be pollution.
      const typed = pickTypedChunk(query, hits.filter(sameDocTyped), hits);
      const hardScope = !!pinFamily;
      const overlap = (() => {
        if (!typed || hardScope) return Infinity;
        const terms = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2);
        const hay = `${typed.metadata.clause_title ?? ""} ${typed.text}`.toLowerCase();
        return terms.filter((t) => hay.includes(t)).length;
      })();
      // tables are exempt from the overlap gate: a table in the window
      // renders as a block and summarizes harmlessly — the pollution
      // concern applies to other typed units, not to the one artifact
      // the answer contract most needs to reach the user
      const tableExempt = typed?.metadata.block === "table";
      if (typed && (overlap >= 3 || tableExempt) && !c.finalHits.some((h) => h.id === typed.id)) {
        c.finalHits = [...c.finalHits.slice(0, LIMITS.rerankKeep - 1), typed];
        console.log("typed pin:", typed.metadata.docidentifier, "§", typed.metadata.clause_anchor, `(${typed.metadata.block})${hardScope ? "" : " [glossary families]"}`);

        const anchor = typed.metadata.clause_anchor;
        const docId = typed.metadata.doc_id;
        const parentPresent = c.finalHits.some(
          (h) => h.metadata.doc_id === docId && h.metadata.clause_anchor === anchor && !h.metadata.unit_id,
        );
        if (anchor && docId && !parentPresent) {
          try {
            const pv = await env.VECTORIZE.query(vector, {
              topK: 4,
              returnMetadata: "all",
              filter: { $and: [{ doc_id: { $eq: docId } }, { clause_anchor: { $eq: anchor } }] },
            });
            const parent = (pv.matches ?? []).map((m: any) => ({ id: m.id, score: m.score, metadata: m.metadata, text: m.metadata?.chunk_text ?? "" })).find((h: any) => !h.metadata?.unit_id);
            if (parent && !c.finalHits.some((h) => h.id === parent.id)) {
              c.finalHits = [...c.finalHits, { ...parent, score: parent.score * THRESHOLDS.smallToBigDiscount }];
              console.log("small-to-big: parent §", anchor, "of", typed.metadata.docidentifier, "added");
            }
          } catch {
            // additive lane; primary results stand
          }
        }
      }
    }
  },
};
