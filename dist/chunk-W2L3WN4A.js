import {
  P
} from "./chunk-MB74PTRM.js";

// workers/worker_public/src/refusal.ts
function refusalAnswer() {
  return P().prompts.vars.refusal_sentence;
}
var REFUSAL_VARIANT = /^\s*I don[’']?t have information on .{1,120}? in the indexed OIML (?:publications|passages|documents|corpus)\.?/i;
var REFUSAL_DRIFT = [
  /\b(can'?t|cannot|couldn'?t|unable)\b[^.]{0,120}?\b(indexed )?OIML publications\b/i,
  /\bno real answer to give\b[^.]{0,120}?\bOIML\b/i,
  /\b(?:falls|well) outside\b[^.]{0,120}?\b(?:what I can answer|my scope|the scope of)\b/i,
  /\boutside (?:of )?what (?:I|this service) can answer\b/i,
  // "I can't answer that — weather forecasting is outside my scope":
  // requires the refusal verb, so a scope DISCUSSION inside a real answer
  // ("this exemption is outside the scope of R 60") never matches
  /\bI can[’']?t answer\b[^.]{0,100}?\bscope\b/i,
  /^\s*I don[’']?t have any indexed OIML \w+(?:s)? (?:covering|about|on)\b/im
];
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
  const variant = answer.match(REFUSAL_VARIANT);
  if (variant) return answer.replace(variant[0], CANON);
  for (const drift of REFUSAL_DRIFT) {
    const m = drift.exec(answer);
    if (!m) continue;
    return answer.slice(0, sentenceStart(answer, m.index)) + CANON + answer.slice(sentenceEnd(answer, m.index));
  }
  return answer;
}

export {
  refusalAnswer,
  canonicalRefusal
};
