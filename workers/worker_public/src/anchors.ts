// Deterministic quote-anchor verification (G11 enforcement): every
// bracketed citation carrying a quoted segment — [OIML R 76:2004 §3.2:
// "…"] — must quote text that exists in the passages the answer was built
// from. This is the mechanical half of the "mechanically checkable"
// promise: the model is trusted to cite, the anchor is trusted to nobody.
export interface AnchorCheck {
  total: number;
  violations: string[];
}

const normalize = (s: string): string =>
  s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/­/g, "")
    .replace(/[     ]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

// quoted segments inside a bracketed anchor: "…" (curly quotes and
// guillemets are normalized to straight quotes before matching)
const ANCHOR = /\[[^\[\]\n]*\]/g;

export function checkQuoteAnchors(answer: string, passages: string[]): AnchorCheck {
  const flat = answer.replace(/[“”‟«»]/g, '"');
  const hay = normalize(passages.join("\n\n"));
  const violations: string[] = [];
  let total = 0;
  for (const anchor of flat.matchAll(ANCHOR)) {
    for (const q of anchor[0].matchAll(/"([^"\n]+)"/g)) {
      total++;
      if (!hay.includes(normalize(q[1]))) violations.push(anchor[0]);
    }
  }
  return { total, violations };
}

export const ANCHOR_CORRECTION_NOTE =
  "Correction notice: your draft quoted text that does not appear verbatim in the provided passages. " +
  "Rewrite the answer — every quoted phrase must be an exact copy from a passage, or cite the clause without quoting.";
