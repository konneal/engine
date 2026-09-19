// Contract completion (MECE: ask.ts orchestrates, this module owns the
// two post-generation completions). Both heal the same gap — the answer
// references normative objects that contractV2 did not (or could not)
// resolve into blocks — using the producer's own payloads:
//
//   table completion: the answer presents a numeric value from a table
//     in the answer's document family → resolve and attach that table
//   figure completion (#172): the model names figure units in PROSE as
//     often as in [[u:…]] tokens, and token refs whose unit wasn't in
//     the used passages drop — either way the answer shows no figure
//     while the payload and asset exist; every u:fig mention in the
//     final text (tokenized or not) resolves from D1
//
// Additive throughout: any failure returns what it has.
import type { StoreQuery } from "./ports/store.ts";
import { resolveBlocks, type ResolvedBlock } from "./refs.ts";
import type { Hit } from "./pipeline.ts";

export async function completeTables(
  db: StoreQuery,
  answer: string,
  used: Hit[],
): Promise<ResolvedBlock[]> {
  const blocks: ResolvedBlock[] = [];
  try {
    const answerNums = new Set((answer.match(/\d[\d ,.]{1,8}\d/g) ?? []).map((x) => x.replace(/[ ,.]/g, "")));
    if (!answerNums.size) return blocks;
    // match by docidentifier (the chunks and unit_payloads use different
    // doc_id schemes — 'dirty:r60-1-2006-eng' vs 'mko:oiml-r-60-1' — but
    // both carry the publication name)
    const fams = [...new Set(used.map((h) => h.metadata.docidentifier).filter(Boolean))].slice(0, 3);
    for (const fam of fams) {
      const base = String(fam).replace(/\s*\([A-Z]\)\s*$/, "").split(":")[0].trim();
      const rows = await db
        .prepare("SELECT unit_id, payload FROM unit_payloads WHERE type = 'table' AND docidentifier LIKE ?1 LIMIT 8")
        .bind(`%${base}%`)
        .all<{ unit_id: string; payload: string }>();
      for (const r of rows.results ?? []) {
        const tableNums = new Set((String(r.payload).match(/\d[\d ,.]{1,8}\d/g) ?? []).map((x) => x.replace(/[ ,.]/g, "")));
        let hits = 0;
        for (const n of answerNums) if (tableNums.has(n)) hits++;
        if (hits >= 1) {
          const resolved = await resolveBlocks(db, [r.unit_id]);
          blocks.push(...resolved);
          console.log("contract D1 completion: table", r.unit_id, "in", base, "—", hits, "matching values");
          break;
        }
      }
      if (blocks.length) break;
    }
  } catch {
    // additive; primary results stand
  }
  return blocks;
}

export async function completeFigures(
  db: StoreQuery,
  answer: string,
  alreadyAttached: ResolvedBlock[],
  used: Hit[] = [],
): Promise<ResolvedBlock[]> {
  // the model names figures BOTH ways: unit ids (u:fig-3) and bare
  // producer anchors (fig-2a of D 36) — collect both forms; bare
  // anchors get the unit prefix and D1 resolution drops every candidate
  // that is not a real unit (a bare mention can never fabricate a block)
  const unitForm = (answer.match(/u:fig[\w.-]*/g) ?? []).map((x) => x.replace(/[.,;:)]+$/, ""));
  const bareForm = (answer.match(/\bfig-[\w.-]+\b/g) ?? []).map((x) => x.replace(/[.,;:)]+$/, ""));
  let mentioned = [...new Set([...unitForm, ...bareForm.map((x) => (x.startsWith("u:") ? x : "u:" + x))])].slice(0, 6);
  // natural prose names figures without any identifier at all — "Figure 3
  // of R 60-2 shows…" (the #172 residual): resolve those by number within
  // the publications the answer used, never across the corpus at large
  const proseNums = new Set(
    (answer.match(/\bFig(?:ure|\.)s?\s*([0-9]{1,2}[a-z]?)/g) ?? [])
      .map((x) => x.replace(/\bFig(?:ure|\.)s?\s*/i, "").toLowerCase()),
  );
  if (proseNums.size) {
    const fams = [...new Set(used.map((h) => h.metadata.docidentifier).filter(Boolean))].slice(0, 3);
    for (const fam of fams) {
      const base = String(fam).replace(/\s*\([A-Z]\)\s*$/, "").split(":")[0].trim();
      const rows = await db
        .prepare("SELECT unit_id FROM unit_payloads WHERE type = 'figure' AND docidentifier LIKE ?1 LIMIT 24")
        .bind(`%${base}%`)
        .all<{ unit_id: string }>();
      for (const r of rows.results ?? []) {
        const m = r.unit_id.match(/fig-?([0-9]{1,2}[a-z]?)/i);
        if (m && proseNums.has(m[1].toLowerCase())) mentioned.push(r.unit_id);
      }
    }
    mentioned = [...new Set(mentioned)].slice(0, 6);
  }
  const have = new Set(alreadyAttached.map((b) => b.unit_id));
  const missing = mentioned.filter((id) => !have.has(id));
  if (!missing.length) return [];
  const figs = await resolveBlocks(db, missing);
  if (figs.length) console.log("figure completion:", figs.map((b) => b.unit_id).join(", "), "attached from D1");
  return figs;
}
