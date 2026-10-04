// The deterministic engines as tools: the verdict engine's checks
// evaluate against stated quantities, void names the parameters the
// question did not state, the node lookup refuses ambiguity, licensed
// nodes get the boundary, and the condition-set check gates licensed
// sets behind entitlements exactly as the ask path does.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool } from "../workers/worker_public/src/tools.ts";
import { setProfile } from "../workers/worker_public/src/profile.ts";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";

const NODE = JSON.stringify({
  acceptance_criteria: { limit: { expression: "E_R", operator: "<=", threshold_expression: "0.5 * vmin" } },
  on_violation: "invalid",
});
const nodeDb = (results: unknown[]) => ({
  // both query shapes: bound (by node id / standard) and unbound (the
  // un-scoped condition-set sweep)
  prepare: () => ({ bind: () => ({ all: async () => ({ results }) }), all: async () => ({ results }) }),
});

test("verdict.evaluate: a stated combination yields pass with the check's values", async () => {
  setProfile(PROFILE);
  const db = nodeDb([{ standard: "oiml-r60", kind: "requirement", name: "Repeatability", content: NODE }]);
  const r = await runTool({ DB: db }, { name: "verdict.evaluate", args: { node_id: "/req/metrological/repeatability", question: "E_R is 0.1 and vmin is 0.4" } }, "mcp");
  assert.ok(r);
  const v = JSON.parse(r.output);
  assert.equal(v.verdict, "pass");
  assert.equal(v.checks.length, 1);
  assert.deepEqual(v.checks[0].values, { E_R: 0.1, vmin: 0.4 });
});

test("verdict.evaluate: an understated question returns void with the missing names, never a guess", async () => {
  setProfile(PROFILE);
  const db = nodeDb([{ standard: "oiml-r60", kind: "requirement", name: "Repeatability", content: NODE }]);
  const r = await runTool({ DB: db }, { name: "verdict.evaluate", args: { node_id: "/req/metrological/repeatability", question: "E_R is 0.1" } }, "mcp");
  assert.ok(r);
  const v = JSON.parse(r.output);
  assert.equal(v.verdict, "void");
  assert.ok(v.missing.includes("vmin"));
});

test("verdict.evaluate: an ambiguous node id resolves to nothing, no silent pick", async () => {
  setProfile(PROFILE);
  const db = nodeDb([
    { standard: "oiml-r60", kind: "requirement", name: "a", content: NODE },
    { standard: "oiml-r91", kind: "requirement", name: "b", content: NODE },
  ]);
  const r = await runTool({ DB: db }, { name: "verdict.evaluate", args: { node_id: "/req/x", question: "E_R is 0.1 and vmin is 0.4" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /indexed under several standards/);
});

test("verdict.evaluate: a licensed node gets the boundary, never an evaluation", async () => {
  setProfile(PROFILE); // fixture-ab-99 is the declared licensed package
  const db = nodeDb([{ standard: "fixture-ab-99", kind: "requirement", name: "x", content: NODE }]);
  const r = await runTool({ DB: db }, { name: "verdict.evaluate", args: { node_id: "/req/lic", question: "E_R is 0.1 and vmin is 0.4" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /licensed publication/);
});

test("conditions.check: licensed sets are invisible without the entitlement", async () => {
  setProfile(PROFILE);
  const SET = JSON.stringify({ payload: { entries: [{ quantity: "temperature", value: 40, unit: "°C", tolerance: 2 }] } });
  const db = nodeDb([{ node_id: "/condition/fixture-1", standard: "fixture-ab-99", content: SET }]);
  const r = await runTool({ DB: db }, { name: "conditions.check", args: { question: "temperature 40 °C" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /No condition sets are indexed/);
  const r2 = await runTool({ DB: db }, { name: "conditions.check", args: { question: "temperature 40 °C", licensed_standards: ["std:fixture-ab-99"] } }, "mcp");
  assert.ok(r2);
  assert.ok(!/No condition sets/.test(r2.output), "the entitled caller sees the set");
});

test("conditions.check: a statement without quantities says so, never guesses", async () => {
  setProfile(PROFILE);
  const SET = JSON.stringify({ payload: { entries: [{ quantity: "temperature", value: 40, unit: "°C", tolerance: 2 }] } });
  const db = nodeDb([{ node_id: "/condition/pub-1", standard: "oiml-r60", content: SET }]);
  const r = await runTool({ DB: db }, { name: "conditions.check", args: { question: "is this okay generally" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /No quantities were recognized/);
});
