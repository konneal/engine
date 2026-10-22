// Extractive prompt compression (TODO.sota/02 row 5, LLMLingua-class
// adapted to the edge runtime): no second model, fully deterministic —
// sentences are scored by query-term density with a numeric-evidence
// bump (metrology answers live or die on numbers) and kept in reading
// order within a character budget. The consumer picks the budget; the
// compressor never grows text, never reorders it, and never invents.

const STOP = new Set(
  "the a an and or of to in on for with by as at is are was were be been from that this these those it its their there which who what when where how why not no than then also such may must shall can could should would per within under over into about between during before after each any all more most less least other only same both few many some own very one two".split(
    " ",
  ),
);

export function tokens(text: string): string[] {
  // numeric tokens survive at ANY length: "R 60", "15", "50 000" are the
  // domain's own vocabulary, and the 3-char floor exists to drop prose
  // fragments ("of", "a"), not identifiers
  return (text.toLowerCase().match(/[a-z0-9]+(?:[.][0-9]+)?/g) ?? []).filter(
    (t) => /^[0-9]/.test(t) || (t.length >= 3 && !STOP.has(t)),
  );
}

export function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\r/g, "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

/** Query-term density, with a numeric sentence boosted: a sentence that
 *  states values, tolerances or clause numbers is evidence even when it
 *  repeats few query words. */
export function scoreSentence(sentence: string, qTerms: Set<string>): number {
  const toks = tokens(sentence);
  if (!toks.length) return 0;
  let hits = 0;
  for (const t of toks) if (qTerms.has(t)) hits += 1;
  const density = hits / Math.sqrt(toks.length);
  const numeric = /\d/.test(sentence) ? 0.35 : 0;
  return density + numeric;
}

/** Compress to at most `budgetChars` characters: the lead sentence is
 *  always kept (it carries the subject), the rest by score, emitted in
 *  reading order. No sentence scores above zero → plain truncation of
 *  the lead at a word boundary (never empty when input is non-empty). */
export function compressText(text: string, query: string, budgetChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.length <= budgetChars) return clean;
  const qTerms = new Set(tokens(query));
  const sentences = splitSentences(clean);
  if (sentences.length <= 1) {
    const cut = clean.slice(0, Math.max(0, budgetChars));
    const end = cut.lastIndexOf(" ");
    return (end > 40 ? cut.slice(0, end) : cut).trim();
  }
  const scored = sentences.map((s, i) => ({ s, i, score: scoreSentence(s, qTerms) }));
  const keep = new Set<number>([0]);
  const ranked = scored.slice(1).sort((a, b) => b.score - a.score || a.i - b.i);
  let used = sentences[0].length + 1;
  for (const r of ranked) {
    if (used + r.s.length + 1 > budgetChars) continue;
    keep.add(r.i);
    used += r.s.length + 1;
  }
  const out = scored
    .filter((r) => keep.has(r.i))
    .map((r) => r.s)
    .join(" ")
    .trim();
  return out.slice(0, budgetChars);
}
