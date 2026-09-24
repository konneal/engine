// Verdict engine tests against the real model-node content shapes.
// node --test tests/verdict.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, extractChecks, symbolsIn, extractParams, verdictNote } from "../workers/worker_public/src/verdict.ts";

const deadLoad = {
  check: "ocl{model.parameters.d_max >= 0.9 * model.parameters.e_max and model.parameters.d_max <= model.parameters.e_max}",
  on_violation: "invalid",
  violation_meaning: "The declared maximum test load D_max lies outside [0.9·E_max, E_max] — the type evaluation of this transducer is void.",
};
const mpeLimit = {
  acceptance_criteria: {
    limit: { expression: "L_test", operator: "lte", threshold_expression: "E_max", unit: "mass units" },
  },
};

test("extracts OCL and structured checks", () => {
  assert.deepEqual(extractChecks(deadLoad), ["model.parameters.d_max >= 0.9 * model.parameters.e_max and model.parameters.d_max <= model.parameters.e_max"]);
  const st = extractChecks(mpeLimit);
  assert.ok(st.includes("L_test lte E_max"));
});

test("symbols from dotted paths", () => {
  assert.deepEqual(symbolsIn(extractChecks(deadLoad)).sort(), ["model.parameters.d_max", "model.parameters.e_max"]);
});

test("l8b: D_max 26000 vs E_max 30000 violates the 0.9 bound", () => {
  const v = evaluate(deadLoad, "E_max 30000 v, the lab proposes testing to D_max 26000 v")!;
  assert.equal(v.verdict, "fail");
  assert.equal(v.on_violation, "invalid");
  assert.equal(v.checks.length, 1);
  assert.equal(v.checks[0].result, false);
});

test("the boundary case passes exactly at 0.9", () => {
  const v = evaluate(deadLoad, "D_max 27000 v and E_max 30000 v")!;
  assert.equal(v.verdict, "pass");
});

test("missing parameters → void, honestly named", () => {
  const v = evaluate(deadLoad, "is the geometry valid?")!;
  assert.equal(v.verdict, "void");
  assert.deepEqual(v.missing.sort(), ["model.parameters.d_max", "model.parameters.e_max"]);
});

test("counterfactual values are just values (F2)", () => {
  const v = evaluate(deadLoad, "what if D_max were 29500 v with E_max 30000 v?")!;
  assert.equal(v.verdict, "pass");
});

test("thousands separators parse", () => {
  const v = evaluate(deadLoad, "E_max = 30 000 v, D_max = 26 000 v")!;
  assert.equal(v.verdict, "fail");
});

test("note narrates the arithmetic without recomputing", () => {
  const v = evaluate(deadLoad, "E_max 30000 v, D_max 26000 v")!;
  const note = verdictNote(v, { node_id: "/constraint/dead_load_max_geometry" });
  assert.ok(note.includes("d_max >= 0.9 * model.parameters.e_max"));
  assert.ok(note.includes("d_max=26000"));
  assert.ok(note.includes("VIOLATED"));
  assert.ok(note.includes("INVALID"));
});

test("no machine checks → null (node not evaluable)", () => {
  assert.equal(evaluate({ statement: "prose only" }, "any question"), null);
});
