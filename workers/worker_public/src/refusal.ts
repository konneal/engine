import { P } from "./profile.ts";
/** The one sanctioned refusal sentence (also in prompts/system.md).
 *  Refusals are never cached: a refusal says "retrieval found nothing",
 *  which is a property of the moment, not of the question. */
export function refusalAnswer(): string {
  return P().prompts.vars.refusal_sentence;
}

// the model occasionally paraphrases the refusal sentence ("...information
// on how to make lasagna in the indexed..."); the API contract is the
// exact canonical sentence — normalize variants, keep the redirect tail.
// The patterns are built per call: the publisher token is profile data.
function refusalPatterns(publisher: string): { variant: RegExp; drift: RegExp[] } {
  return {
    variant: new RegExp(`^\\s*I don[’']?t have information on .{1,120}? in the indexed ${publisher}(?: \\w+){0,2} (?:publications|passages|documents|corpus)\\.?`, "i"),
    drift: [
      new RegExp(`\\b(can'?t|cannot|couldn'?t|unable)\\b[^.]{0,120}?\\b(indexed )?${publisher}(?: \\w+){0,2} publications\\b`, "i"),
      new RegExp(`\\bno real answer to give\\b[^.]{0,120}?\\b${publisher}\\b`, "i"),
      /\b(?:falls|well) outside\b[^.]{0,120}?\b(?:what I can answer|my scope|the scope of)\b/i,
      /\boutside (?:of )?what (?:I|this service) can answer\b/i,
      // "I can't answer that — weather forecasting is outside my scope":
      // requires the refusal verb, so a scope DISCUSSION inside a real answer
      // ("this exemption is outside the scope of R 60") never matches
      /\bI can[’']?t answer\b[^.]{0,100}?\bscope\b/i,
      new RegExp(`^\\s*I don[’']?t have any indexed ${publisher} \\w+(?:s)? (?:covering|about|on)\b`, "im"),
    ],
  };
}

/** Start of the sentence containing offset `i` (after the nearest ". ",
 *  "! ", "? ", or newline before it, else the string start). */
function sentenceStart(answer: string, i: number): number {
  let s = 0;
  for (const sep of [". ", "! ", "? ", "\n"]) {
    const j = answer.lastIndexOf(sep, i);
    if (j >= 0) s = Math.max(s, j + sep.length);
  }
  return s;
}

/** End (terminator included) of the sentence containing offset `i`. */
function sentenceEnd(answer: string, i: number): number {
  const m = /[.!?\n]/.exec(answer.slice(i));
  return m ? i + m.index + 1 : answer.length;
}

/** Normalize a refusal-shaped answer to the pinned sentence. A drift
 *  refusal occupies its own sentence: swap that sentence (preface
 *  included) for the pinned one — the redirect tail survives. An answer
 *  outside the refusal family is returned byte-identical. */
export function canonicalRefusal(answer: string): string {
  const CANON = refusalAnswer();
  if (answer.includes(CANON)) return answer;
  const { variant: REFUSAL_VARIANT, drift: REFUSAL_DRIFT } = refusalPatterns(P().publisher.name);
  const variant = answer.match(REFUSAL_VARIANT);
  if (variant) return answer.replace(variant[0], CANON);
  for (const drift of REFUSAL_DRIFT) {
    const m = drift.exec(answer);
    if (!m) continue;
    return answer.slice(0, sentenceStart(answer, m.index)) + CANON + answer.slice(sentenceEnd(answer, m.index));
  }
  return answer;
}
