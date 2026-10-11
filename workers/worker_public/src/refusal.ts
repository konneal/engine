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
function refusalPatterns(publisher: string): { variant: RegExp; drift: RegExp[]; wallSafe: RegExp[] } {
  return {
    variant: new RegExp(`^\\s*I don[’']?t have information on .{1,120}? in the indexed ${publisher}(?: \\w+){0,2} (?:publications|passages|documents|corpus)\\.?`, "i"),
    drift: [
      new RegExp(`\\b(can'?t|cannot|couldn'?t|unable)\\b[^.]{0,120}?\\b(indexed )?${publisher}(?: \\w+){0,2} (?:publications|passages|documents|corpus)\\b`, "i"),
      new RegExp(`\\bno real answer to give\\b[^.]{0,120}?\\b${publisher}\\b`, "i"),
      /\b(?:falls|well) outside\b[^.]{0,120}?\b(?:what I can answer|my scope|the scope of)\b/i,
      /\boutside (?:of )?what (?:I|this service) can answer\b/i,
      // "I can't answer that — weather forecasting is outside my scope":
      // requires the refusal verb, so a scope DISCUSSION inside a real answer
      // ("this exemption is outside the scope of R 60") never matches
      /\bI can[’']?t answer\b[^.]{0,100}?\bscope\b/i,
      new RegExp(`^\\s*I don[’']?t have any indexed ${publisher} \\w+(?:s)? (?:covering|about|on)\b`, "im"),
      // trivia refusals in the model's own words (the refuse-trivia
      // flake): out-of-domain content named plainly — the refusal
      // verb is the guard, a scope DISCUSSION inside a real answer
      // ("this exemption is outside the scope of R 60") never matches
      /\bI don[’']?t have (?:any )?information on [^.]{0,80}(?:that[’']?s|—)?\s*(?:general|common) knowledge\b/i,
      /\b(?:that[’']?s|this is) (?:just )?(?:general|common) knowledge[^.]{0,80}(?:outside|beyond|not covered)\b/i,
    ],
    // the misplaced-pin wall's subset: every pattern here carries a
    // first-person refusal verb ("I don't have information", "I can't
    // answer", "that's general knowledge") — a cited answer's scope
    // DISCUSSION ("outside the scope of R 60's requirements") never
    // matches, so the wall can never eat real content
    wallSafe: [
      new RegExp(`\\b(can'?t|cannot|couldn'?t|unable)\\b[^.]{0,120}?\\b(indexed )?${publisher}(?: \\w+){0,2} (?:publications|passages|documents|corpus)\\b`, "i"),
      new RegExp(`\\bno real answer to give\\b[^.]{0,120}?\\b${publisher}\\b`, "i"),
      /\bI don[’']?t have (?:any )?information on [^.]{0,80}(?:that[’']?s|—)?\s*(?:general|common) knowledge\b/i,
      /\b(?:that[’']?s|this is) (?:just )?(?:general|common) knowledge[^.]{0,80}(?:outside|beyond|not covered)\b/i,
      /\bI can[’']?t answer\b[^.]{0,100}?\bscope\b/i,
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

/** The refusal scope (2026-10-11, the third smoke shape): the loose
 *  redirect-offer family is gated by what the PIPELINE knows, not by
 *  ever-more phrase patterns. The model's scope offers keep drifting
 *  ("I'm happy to help … instead", "I can answer questions about …",
 *  "I'm a metrology assistant — I can help with … instead") — the same
 *  surface form that legitimately ANSWERS a conversational question
 *  ("what can you help me with?"). The discriminators: a knowledge-seek
 *  question (the understanding's own class) and an UNCITED answer — a
 *  cited answer's scope talk is content, a conversational turn's scope
 *  talk is the answer itself. */
export interface RefusalScope {
  /** the understanding read the question as a conversational turn */
  conversational?: boolean;
  /** the answer carries citations */
  cited?: boolean;
}

/** A whole-sentence redirect offer in ONE sentence, first person:
 *  the "questions about" marker (four observed shapes carry it —
 *  "I'm happy to help with questions about…", "I can answer questions
 *  about…", "I'm a metrology assistant — I can answer questions
 *  about…", "I'm here for questions about…"), or the "instead" marker
 *  in a sentence with NO citation apparatus (no clause anchors, no
 *  digits — an offer names no provisions). */
function redirectOfferSentences(answer: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < answer.length) {
    const end = sentenceEnd(answer, i);
    const s = answer.slice(i, end);
    if (/\bI\b[^.!?]{0,160}?\bquestions? about\b/i.test(s) || (/\bI\b[^.!?]{0,160}?\binstead\b/i.test(s) && !/[§\[\d]/.test(s))) out.push([i, end]);
    i = end;
    while (i < answer.length && /\s/.test(answer[i] ?? "")) i++;
  }
  return out;
}

/** Normalize a refusal-shaped answer to the pinned sentence. A drift
 *  refusal occupies its own sentence: swap that sentence (preface
 *  included) for the pinned one — the redirect tail survives. An answer
 *  outside the refusal family is returned byte-identical. */
export function canonicalRefusal(answer: string, scope?: RefusalScope): string {
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
  if (scope && !scope.cited && !scope.conversational) {
    const offer = redirectOfferSentences(answer)[0];
    if (offer) return answer.slice(0, offer[0]) + CANON + answer.slice(offer[1]);
  }
  return answer;
}


/** The misplaced-pin wall (2026-10-10): an answer that actually cites
 *  passages is NOT a refusal — but the model sometimes drops the
 *  pinned sentence into an otherwise-correct, well-cited answer as a
 *  sub-topic disclaimer (measured: the refusal pin at char 435 of a
 *  load-cell answer citing R 60). Readers and graders read the pin as
 *  a TOTAL refusal. The wall is deterministic: when the answer cites,
 *  the pin sentence (and its refusal-shaped paraphrases) are excised —
 *  the surrounding content stands on its own. */
export function exciseMisplacedPin(answer: string, cites: boolean): string {
  if (!cites) return answer;
  const CANON = refusalAnswer();
  let out = answer;
  if (out.includes(CANON)) {
    const i = out.indexOf(CANON);
    out = out.slice(0, sentenceStart(out, i)) + out.slice(sentenceEnd(out, i));
  }
  const { wallSafe } = refusalPatterns(P().publisher.name);
  for (const drift of wallSafe) {
    const m = drift.exec(out);
    if (!m) continue;
    out = out.slice(0, sentenceStart(out, m.index)) + out.slice(sentenceEnd(out, m.index));
  }
  return out.replace(/^[ \t\n]+/, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Cacheable under the refusal law (2026-10-11, the poisoned-entry
 *  lesson): "refusals are never cached" was enforced as "answers
 *  containing the pin are never cached" — backwards for DRIFT, which
 *  lacks the pin and cached itself across deploy windows (an edge
 *  instance running pre-wall code wrote a drifted refusal that served
 *  every later ask). An answer is cacheable only when it carries no
 *  pin AND the wall would not rewrite it. */
export function cacheableAnswer(answer: string, scope?: RefusalScope): boolean {
  if (answer.includes(refusalAnswer())) return false;
  return canonicalRefusal(answer, scope) === answer;
}
