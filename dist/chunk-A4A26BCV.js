import {
  P
} from "./chunk-3FYJM7LH.js";

// workers/worker_public/src/refusal.ts
function refusalAnswer() {
  return P().prompts.vars.refusal_sentence;
}
function refusalPatterns(publisher) {
  return {
    variant: new RegExp(`^\\s*I don[\u2019']?t have information on .{1,120}? in the indexed ${publisher}(?: \\w+){0,2} (?:publications|passages|documents|corpus)\\.?`, "i"),
    drift: [
      new RegExp(`\\b(can'?t|cannot|couldn'?t|unable)\\b[^.]{0,120}?\\b(indexed )?${publisher}(?: \\w+){0,2} (?:publications|passages|documents|corpus)\\b`, "i"),
      new RegExp(`\\bno real answer to give\\b[^.]{0,120}?\\b${publisher}\\b`, "i"),
      /\b(?:falls|well) outside\b[^.]{0,120}?\b(?:what I can answer|my scope|the scope of)\b/i,
      /\boutside (?:of )?what (?:I|this service) can answer\b/i,
      // "I can't answer that — weather forecasting is outside my scope":
      // requires the refusal verb, so a scope DISCUSSION inside a real answer
      // ("this exemption is outside the scope of R 60") never matches
      /\bI can[’']?t answer\b[^.]{0,100}?\bscope\b/i,
      new RegExp(`^\\s*I don[\u2019']?t have any indexed ${publisher} \\w+(?:s)? (?:covering|about|on)\b`, "im"),
      // trivia refusals in the model's own words (the refuse-trivia
      // flake): out-of-domain content named plainly — the refusal
      // verb is the guard, a scope DISCUSSION inside a real answer
      // ("this exemption is outside the scope of R 60") never matches
      /\bI don[’']?t have (?:any )?information on [^.]{0,80}(?:that[’']?s|—)?\s*(?:general|common) knowledge\b/i,
      /\b(?:that[’']?s|this is) (?:just )?(?:general|common) knowledge[^.]{0,80}(?:outside|beyond|not covered)\b/i
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
      /\bI can[’']?t answer\b[^.]{0,100}?\bscope\b/i
    ]
  };
}
function sentenceStart(answer, i) {
  let s = 0;
  for (const sep of [". ", "! ", "? ", "\n"]) {
    const j = answer.lastIndexOf(sep, i);
    if (j >= 0) s = Math.max(s, j + sep.length);
  }
  return s;
}
function sentenceEnd(answer, i) {
  const m = /[.!?\n]/.exec(answer.slice(i));
  return m ? i + m.index + 1 : answer.length;
}
function canonicalRefusal(answer) {
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
function exciseMisplacedPin(answer, cites) {
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

export {
  refusalAnswer,
  canonicalRefusal,
  exciseMisplacedPin
};
