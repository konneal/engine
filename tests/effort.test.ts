// ANSWER_EFFORT: the answer-lane effort lever validates its vocabulary and
// defaults to "low" (the serving-latency pin) on anything else — a typo'd
// var must silently degrade to the known-good setting, never 400 a deploy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerEffort } from "../workers/worker_public/src/config.ts";

test("absent/empty env pins low", () => {
  assert.equal(answerEffort({}), "low");
  assert.equal(answerEffort(undefined), "low");
  assert.equal(answerEffort({ ANSWER_EFFORT: "" }), "low");
});

test("valid efforts pass through", () => {
  for (const v of ["low", "medium", "high", "max"]) {
    assert.equal(answerEffort({ ANSWER_EFFORT: v }), v);
  }
});

test("invalid values fall back to low, not error", () => {
  assert.equal(answerEffort({ ANSWER_EFFORT: "turbo" }), "low");
  assert.equal(answerEffort({ ANSWER_EFFORT: 3 }), "low");
});

import { requestEffort } from "../workers/worker_public/src/config.ts";

const member = { sub: "s" };

test("silent or invalid request falls back to the deployment lever", () => {
  assert.equal(requestEffort({}, member, undefined), "low");
  assert.equal(requestEffort({}, member, "turbo"), "low");
  assert.equal(requestEffort({ ANSWER_EFFORT: "medium" }, member, null), "medium");
});

test("elevated effort is a member lane", () => {
  assert.equal(requestEffort({}, member, "medium"), "medium");
  assert.equal(requestEffort({}, null, "medium"), "low");
  assert.equal(requestEffort({ ANSWER_EFFORT: "high" }, null, "medium"), "high");
});

test("explicit low always wins", () => {
  assert.equal(requestEffort({ ANSWER_EFFORT: "medium" }, member, "low"), "low");
});
