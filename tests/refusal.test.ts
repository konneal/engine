// Unit tests for the refusal canonicalizer — the runtime side of the
// rag#88 refusal family: every shape the harnesses accept canonicalizes
// to the pinned sentence, never more. Runs on plain node (type
// stripping, no build step): node --test tests/refusal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalRefusal, refusalAnswer } from "../workers/worker_public/src/refusal.ts";
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

