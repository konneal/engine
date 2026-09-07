// The witness-grading vocabulary, shared by every runner (golden eval,
// annealment, lane matrix). Expectations are declarative regex
// constraints over the response; their semantics live HERE exactly once:
// all patterns match case-insensitively (the annealment ask-mode was
// case-sensitive for citations before — a loosening that can only turn
// a FAIL into a PASS on wording drift, never the reverse).

export const re = (s, flags = "i") => new RegExp(s, flags);
export const one = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Grade a case's expectations against a response projection.
 *  Legs run only for present expectations; `matched` carries the winning
 *  pattern (answer_any) for richer runner messaging. Fields:
 *   - answer: the answer text
 *   - citeText: joined citation text the citation_any regex scans
 *   - anchorText: text the anchor_any regex scans (may equal citeText)
 *   - artifactTypes: per-item block types ("table" | "figure" | …)
 *   - passages: full passage texts (the witness must appear within ONE)
 */
export function gradeWitness(expect, fields) {
  const legs = {};
  const matched = {};
  if (expect.answer_any != null) {
    matched.answer = one(expect.answer_any).find((p) => re(p).test(fields.answer ?? "")) ?? null;
    legs.answer = matched.answer != null;
  }
  if (expect.citation_any != null) legs.citation = re(expect.citation_any).test(fields.citeText ?? "");
  if (expect.anchor_any != null) legs.anchor = re(expect.anchor_any).test(fields.anchorText ?? "");
  if (expect.artifact != null) legs.artifact = (fields.artifactTypes ?? []).includes(expect.artifact);
  if (expect.witness != null) legs.witness = (fields.passages ?? []).some((p) => re(expect.witness).test(p));
  return { ok: Object.values(legs).every(Boolean), legs, matched };
}
