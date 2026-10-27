// The decision pass core (TODO.decisions/01): the derivation parse, the
// bands, the answers matching and the deterministic section — the
// checklist the user reads is server-composed, never model-written.
import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleSection, bandFor, buildDecisionQuestions, matchAnswers,
  parseDerivation,
} from "../workers/worker_public/src/decisions.ts";

test("parseDerivation reads the JSON with mode and requirements", () => {
  const r = parseDerivation('{"mode":"check","requirements":[{"text":"MPE within ±1.5 v at 1,000 v","clause":"5.3.2"},{"text":"zero-setting check performed","clause":"6.2"}]}', 12);
  assert.equal(r.mode, "check");
  assert.equal(r.requirements.length, 2);
  assert.equal(r.requirements[0].clause, "5.3.2");
});

test("parseDerivation tolerates prose around the JSON and caps the list", () => {
  const text = 'Sure. {"requirements":[' + Array.from({ length: 20 }, (_, i) => `{"text":"requirement ${i} wording","clause":"${i}"}`).join(",") + "]} Done.";
  const r = parseDerivation(text, 12);
  assert.equal(r.requirements.length, 12);
});

test("parseDerivation drops fragments and returns the fallback on garbage", () => {
  assert.deepEqual(parseDerivation("no json", 12).requirements, []);
  assert.deepEqual(parseDerivation('{"requirements":[{"text":"tiny"}]}', 5).requirements, []);
  const r = parseDerivation('{"mode":"list","requirements":[{"text":"a proper requirement sentence","clause":""}]}', 5);
  assert.equal(r.mode, "list");
  assert.equal(r.requirements[0].clause, "");
});

test("bandFor maps the probabilities to the three bands", () => {
  assert.equal(bandFor(0.9, 0.8, 0.2), "met");
  assert.equal(bandFor(0.1, 0.8, 0.2), "not-met");
  assert.equal(bandFor(0.5, 0.8, 0.2), "unclear");
});

test("buildDecisionQuestions: check mode asks met-or-not with the state; list mode asks genuineness", () => {
  const reqs = [{ text: "MPE within the limit", clause: "5.3.2" }];
  const check = buildDecisionQuestions("check", reqs, "does my cell comply?", "30 000 v, error 1.2 v");
  assert.match(check.r1.instructions, /met/);
  assert.match(check.r1.instructions, /30 000 v/);
  const list = buildDecisionQuestions("list", reqs, "what are the requirements?", "");
  assert.match(list.r1.instructions, /genuine/);
});

test("matchAnswers keys r1..rN, bands, drops missing and out-of-range", () => {
  const reqs = [{ text: "a", clause: "1" }, { text: "b", clause: "2" }, { text: "c", clause: "3" }];
  const answers = { r1: { type: "noul", noul: 0.9 }, r2: { type: "noul", noul: 0.05 }, r4: { type: "noul", noul: 1 } };
  const items = matchAnswers("check", reqs, answers as any, 0.8, 0.2);
  assert.equal(items.length, 2);
  assert.equal(items[0].band, "met");
  assert.equal(items[1].band, "not-met");
});

test("matchAnswers: list mode bands everything met (presence is the decision)", () => {
  const reqs = [{ text: "a", clause: "1" }];
  const items = matchAnswers("list", reqs, { r1: { type: "noul", noul: 0.7 } }, 0.8, 0.2);
  assert.equal(items[0].band, "met");
  assert.equal(items[0].probability, 0.7);
});

test("assembleSection: the check section marks, cites, and states the probability", () => {
  const section = assembleSection("check", [
    { text: "MPE within the limit", clause: "5.3.2", band: "met", probability: 0.87 },
    { text: "zero-setting performed", clause: "6.2", band: "unclear", probability: 0.5 },
  ]);
  assert.match(section, /Requirements check \(automated\)/);
  assert.match(section, /✓ MPE within the limit — 5\.3\.2 \(87%\) — met/);
  assert.match(section, /\? zero-setting performed/);
});

test("assembleSection: the list section has no bands", () => {
  const section = assembleSection("list", [{ text: "the MPE requirement", clause: "5.3.2", band: "met", probability: 1 }]);
  assert.doesNotMatch(section, /%|\(met\)/);
  assert.match(section, /— 5\.3\.2/);
});

test("assembleSection: empty items compose nothing", () => {
  assert.equal(assembleSection("check", []), "");
});
