// Unit tests for the refusal canonicalizer — the runtime side of the
// rag#88 refusal family: every shape the harnesses accept canonicalizes
// to the pinned sentence, never more. Runs on plain node (type
// stripping, no build step): node --test tests/refusal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheableAnswer, canonicalRefusal, exciseMisplacedPin, refusalAnswer } from "../workers/worker_public/src/refusal.ts";
import { setProfile } from "../workers/worker_public/src/profile.ts";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";

// the pinned-sentence family is publisher data; these tests pin the
// OIML shape (the reference deployment's), so the profile declares it
setProfile({
  ...PROFILE,
  publisher: { ...PROFILE.publisher, name: "OIML" },
  prompts: { ...PROFILE.prompts, vars: { ...PROFILE.prompts.vars, refusal_sentence: "I don't have information on this in the indexed OIML publications." } },
});
const REFUSAL_ANSWER = refusalAnswer();

test("the pinned sentence passes through untouched", () => {
  assert.equal(canonicalRefusal(REFUSAL_ANSWER), REFUSAL_ANSWER);
});

test("preface + pinned (rag#88): the pinned sentence anywhere already satisfies the contract", () => {
  const answer = `General note first. ${REFUSAL_ANSWER} Maybe ask about load cells instead.`;
  assert.equal(canonicalRefusal(answer), answer);
});

test("paraphrase of the pinned sentence normalizes, redirect tail kept (pre-rag#88 variant)", () => {
  const answer = "I don't have information on how to make lasagna in the indexed OIML publications. Try asking about load cells instead.";
  assert.equal(canonicalRefusal(answer), `${REFUSAL_ANSWER} Try asking about load cells instead.`);
});

test("drift: a can't-help preface redirect with no pinned sentence canonicalizes", () => {
  const answer = "I'm afraid I can't help with that one — the indexed OIML publications cover legal metrology, not cooking.";
  assert.equal(canonicalRefusal(answer), REFUSAL_ANSWER);
});

test("drift: the cannot/unable family, 'indexed' optional", () => {
  const answer = "I cannot answer cooking questions — the OIML publications cover legal metrology.";
  assert.equal(canonicalRefusal(answer), REFUSAL_ANSWER);
});

test("drift: 'no real answer to give' paraphrase — the refusal sentence swaps, the redirect tail survives", () => {
  const answer = "Oh, I've no real answer to give! I answer questions about OIML legal-metrology publications — ask me about load cells!";
  assert.equal(
    canonicalRefusal(answer),
    `${REFUSAL_ANSWER} I answer questions about OIML legal-metrology publications — ask me about load cells!`,
  );
});

test("drift mid-answer: the refusal sentence splices out, context before and after preserved", () => {
  const answer = "Here is some context. I can't help with that one — the indexed OIML publications cover metrology. Hope that helps.";
  assert.equal(canonicalRefusal(answer), `Here is some context. ${REFUSAL_ANSWER} Hope that helps.`);
});

test("control: a real in-corpus answer is byte-identical", () => {
  const answer = "A load cell is a force transducer that converts a force into an electrical signal [OIML R 60-1:2021 §4.1].";
  assert.equal(canonicalRefusal(answer), answer);
});

test("control: mentioning the OIML publications without a refusal marker is not a refusal", () => {
  const answer = "You can apply R 60 here; the indexed OIML publications list it as the load-cell recommendation.";
  assert.equal(canonicalRefusal(answer), answer);
});

test("control: a plain apology outside the drift family is not a refusal", () => {
  const answer = "I'm sorry the earlier answer was unclear — the class III limit is 0.5e [OIML R 76-1:2006 §3.2].";
  assert.equal(canonicalRefusal(answer), answer);
});

test("control: the empty answer is untouched", () => {
  assert.equal(canonicalRefusal(""), "");
});

test("drift: 'metrology documents' naming — the 2026-09-14 smoke shape — canonicalizes", () => {
  const answer =
    "I can't help with that — none of the passages relate to cooking or recipes; they cover OIML metrology documents.\n\nI can instead answer questions about OIML publications — for example, definitions like maximum permissible error.";
  const out = canonicalRefusal(answer);
  assert.ok(out.includes(REFUSAL_ANSWER), "the pinned sentence must appear");
  assert.ok(!out.includes("can't help"), "the drift sentence must be replaced");
});



// ── the walls (2026-10-10): trivia-drift canonicalization + the
//    misplaced-pin excision on cited answers ──

test("trivia refusals in the model's own words canonicalize to the pin", () => {
  const t = canonicalRefusal("I don't have information on the Eiffel Tower's height — that's general knowledge, not covered by legal metrology. I can answer questions about the indexed publications.");
  assert.ok(t.startsWith(refusalAnswer()));
});

test("a cited answer never carries the pinned sentence — the wall excises it", () => {
  const cited = `The requirements are set by R 60 [1]. ${refusalAnswer()} The limit depends on p_LC [2].`;
  const out = exciseMisplacedPin(cited, true);
  assert.ok(!out.includes(refusalAnswer()));
  assert.ok(out.includes("R 60 [1]"));
  assert.ok(out.includes("p_LC [2]"));
});

test("an uncited answer keeps its pin — the wall never touches true refusals", () => {
  const pure = `${refusalAnswer()} I can answer questions about the indexed publications instead.`;
  assert.equal(exciseMisplacedPin(pure, false), pure);
});

test("a scope DISCUSSION inside a real answer is never excised", () => {
  const real = "This exemption falls outside the scope of R 60's metrological requirements [1], so the verifying authority may apply national rules.";
  assert.equal(exciseMisplacedPin(real, true), real);
});

// ── the redirect-only openers (2026-10-11 smoke): the pinned sentence
//    replaced by a scope OFFER ──

test("loose: the happy-to-help opener ending in 'instead' canonicalizes on a knowledge seek", () => {
  const answer = "I'm happy to help with questions about OIML legal-metrology publications — Recommendations, Documents, Guides, Basic publications, or the OIML Certification System — instead.";
  assert.equal(canonicalRefusal(answer, { cited: false, conversational: false }), REFUSAL_ANSWER);
});

test("loose: the can-answer opener with the scope list canonicalizes on a knowledge seek", () => {
  const answer = "I can answer questions about OIML legal-metrology publications — Recommendations, Documents, Guides and Basic publications — such as OIML B 20:2024 on the use of OIML logos.";
  assert.equal(canonicalRefusal(answer, { cited: false, conversational: false }), REFUSAL_ANSWER);
});

test("drift: the redirect TAIL after a real answer is preserved, not canonicalized", () => {
  const answer = "The certificate R60/2021-A-NL1-26.12 is valid [register snapshot]. I'm happy to help with questions about OIML legal-metrology publications instead.";
  assert.equal(canonicalRefusal(answer), answer);
});

test("control: a real answer opening with capability phrasing is untouched", () => {
  const answer = "I can answer that from R 60-1 §4.1: the maximum number of verification intervals is set by the class.";
  assert.equal(canonicalRefusal(answer), answer);
});

// ── the cache law (2026-10-11, the poisoned-entry lesson) ──

test("the pin is never cacheable", () => {
  assert.equal(cacheableAnswer(REFUSAL_ANSWER), false);
});

test("a real cited answer is cacheable", () => {
  const answer = "A load cell is a force transducer that converts a force into an electrical signal [OIML R 60-1:2021 §4.1].";
  assert.equal(cacheableAnswer(answer), true);
});

test("a drifted refusal is NOT cacheable — the wall would rewrite it (the poisoned-entry law)", () => {
  const drift = "I'm here for questions about OIML publications, certification workflows and the OIML-CS — not recipes.";
  assert.equal(cacheableAnswer(drift, { cited: false, conversational: false }), false);
});

test("the same shape on a conversational turn is cacheable — it is the answer", () => {
  const identity = "I'm here for questions about OIML publications, certification workflows and the OIML-CS — not recipes.";
  assert.equal(cacheableAnswer(identity, { cited: false, conversational: true }), true);
});

// ── the loose family (2026-10-11, third smoke shape): question-class ×
//    citation-state gated — the surface form that ANSWERS a
//    conversational question is never a refusal ──

test("loose: the identity-preface offer (the third smoke shape) canonicalizes on a knowledge seek", () => {
  const answer = "I'm a metrology assistant — I can answer questions about OIML Recommendations, Documents, Guides and Basic publications, such as how to get instruments certified or which edition of a publication applies.";
  assert.equal(canonicalRefusal(answer, { cited: false, conversational: false }), REFUSAL_ANSWER);
});

test("loose: the assistant-on-platform offer (the ops smoke shape) canonicalizes on a knowledge seek", () => {
  const answer = "I'm Ommisa, the assistant on the OIML SMART certification platform — I can help with OIML publications, certification procedures, and your application workflow instead.";
  assert.equal(canonicalRefusal(answer, { cited: false, conversational: false }), REFUSAL_ANSWER);
});

test("loose control: the same offer is the ANSWER on a conversational turn — untouched", () => {
  const answer = "I'm Ommisa, the assistant on the OIML SMART certification platform — I can help with OIML publications, certification procedures, and your application workflow instead.";
  assert.equal(canonicalRefusal(answer, { cited: false, conversational: true }), answer);
});

test("loose control: a cited answer's offer sentence is content — untouched", () => {
  const answer = "I can help with questions about OIML publications [1]. R 60 covers load cells [2].";
  assert.equal(canonicalRefusal(answer, { cited: true, conversational: false }), answer);
});

test("loose: the 'I'm here for questions about' shape (the fourth, ops 0.2.133 deploy) canonicalizes", () => {
  const answer = "I'm here for questions about OIML publications, certification workflows and the OIML-CS — not recipes.";
  assert.equal(canonicalRefusal(answer, { cited: false, conversational: false }), REFUSAL_ANSWER);
});

test("loose control: 'instead' in a sentence with citation apparatus is content — untouched", () => {
  const answer = "I recommend calibrating the instrument to §4.2 of R 60 instead.";
  assert.equal(canonicalRefusal(answer, { cited: false, conversational: false }), answer);
});

test("loose: multi-sentence drift — the offer sentence swaps, surrounding text survives", () => {
  const answer = "I'm a metrology assistant. I can answer questions about OIML legal-metrology publications instead.";
  assert.equal(
    canonicalRefusal(answer, { cited: false, conversational: false }),
    `I'm a metrology assistant. ${REFUSAL_ANSWER}`,
  );
});
