// Verdict engine tests against the real model-node content shapes.
// node --test tests/verdict.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, extractChecks, symbolsIn, extractParams, verdictNote, extractParamsWithUnits} from "../workers/worker_public/src/verdict.ts";

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

test("unit semantics: a comparison mixing dimensions voids with its reason", () => {
  const dims = { v: "L^2·M·T^-3·I^-1", m: "L" };
  const v = evaluate(deadLoad, "E_max 30000 v, D_max 26000 m", { dimensions: dims })!;
  assert.equal(v.verdict, "void");
  assert.equal(v.missing.length, 0);
  assert.match(v.void_reason ?? "", /mix dimensions/);
  assert.match(v.void_reason ?? "", /e_max is in/);
  assert.match(v.void_reason ?? "", /d_max is in/);
});

test("unit semantics: same-dimension units evaluate normally", () => {
  const dims = { v: "L^2·M·T^-3·I^-1", mv: "L^2·M·T^-3·I^-1" };
  const v = evaluate(deadLoad, "E_max 30000 V, D_max 26000 mV", { dimensions: dims })!;
  assert.equal(v.verdict, "fail"); // 26000 < 0.9 × 30000, same family
});

test("unit semantics: unknown units fail open — the plain evaluation stands", () => {
  const v = evaluate(deadLoad, "E_max 30000 v, D_max 26000 v", { dimensions: { kg: "M" } })!;
  assert.equal(v.verdict, "fail");
});

test("the extraction captures stated unit tokens", () => {
  const b = extractParamsWithUnits("with E_max 30000 v, is testing to D_max 26 000 m valid?", ["model.parameters.e_max", "model.parameters.d_max"]);
  assert.equal(b.units["model.parameters.e_max"], "v");
  assert.equal(b.units["model.parameters.d_max"], "m");
  assert.equal(b.values["model.parameters.e_max"], 30000);
});

test("the void note narrates the dimension mismatch, not a missing-parameter gap", () => {
  const v = evaluate(deadLoad, "E_max 30000 v, D_max 26000 m", { dimensions: { v: "VOLTAGE", m: "LENGTH" } })!;
  const note = verdictNote(v, { node_id: "/constraint/dead_load_max_geometry" });
  assert.match(note, /VERDICT: VOID — the stated quantities mix dimensions/);
  assert.doesNotMatch(note, /does not state/);
});

test("the plain oiml-r60 projection carries the OCL under `expression` — it evaluates", () => {
  // the exact shape the deployed node store carries for
  // /constraint/dead_load_max_geometry (the model-plane projection):
  // this node bound for its whole life and evaluated to null because
  // extractChecks never read the key
  const plain = {
    expression: "ocl{model.parameters.d_max >= 0.9 * model.parameters.e_max and model.parameters.d_max <= model.parameters.e_max}",
    clause: { clause: "3.6", doc: "urn:oiml:pub:r:60-1:2021" },
    name: "Dead-load maximum geometry",
  };
  const fail = evaluate(plain, "For OIML R 60, /constraint/dead_load_max_geometry: with E_max 30000 v, is testing to D_max 26000 v valid?")!;
  assert.equal(fail.verdict, "fail");
  assert.equal(fail.checks[0].values["model.parameters.d_max"], 26000);
  const pass = evaluate(plain, "with E_max 30000 v, is testing to D_max 28500 v valid?")!;
  assert.equal(pass.verdict, "pass");
});

test("uncertainty: ± binds a first-class tolerance", () => {
  const b = extractParamsWithUnits("the balance reads E_max 30000 ± 60 v", ["model.parameters.e_max"]);
  assert.equal(b.values["model.parameters.e_max"], 30000);
  assert.equal(b.units["model.parameters.e_max"], "v");
  const u = b.uncertainties["model.parameters.e_max"]!;
  assert.equal(u.tol, 60);
  assert.equal(u.unit, "v");
  assert.equal(u.stated, "± 60 v");
  assert.equal(u.relative, false);
});

test("uncertainty: the AsciiMath spelling pm binds the same tolerance", () => {
  const b = extractParamsWithUnits("E_max 30000 pm 60 v", ["model.parameters.e_max"]);
  assert.equal(b.uncertainties["model.parameters.e_max"]!.tol, 60);
  assert.equal(b.uncertainties["model.parameters.e_max"]!.unit, "v");
});

test("uncertainty: relative percent resolves against the value", () => {
  const b = extractParamsWithUnits("E_max 30000 ± 0.2 %", ["model.parameters.e_max"]);
  const u = b.uncertainties["model.parameters.e_max"]!;
  assert.equal(u.relative, true);
  assert.equal(u.tol, 60);
  assert.equal(u.stated, "± 0.2 %");
});

test("uncertainty: tolerance after the unit inherits the value's unit", () => {
  const b = extractParamsWithUnits("E_max 30000 v ± 60", ["model.parameters.e_max"]);
  assert.equal(b.units["model.parameters.e_max"], "v");
  const u = b.uncertainties["model.parameters.e_max"]!;
  assert.equal(u.tol, 60);
  assert.equal(u.unit, "v");
});

test("uncertainty: a unit literally named pm without a tolerance stays a unit", () => {
  const b = extractParamsWithUnits("wavelength 650 pm", ["model.parameters.wavelength"]);
  assert.equal(b.values["model.parameters.wavelength"], 650);
  assert.equal(b.units["model.parameters.wavelength"], "pm");
  assert.equal(b.uncertainties["model.parameters.wavelength"], undefined);
});

test("uncertainty: a band fully inside the limit passes", () => {
  const v = evaluate(deadLoad, "E_max 30000 v, D_max 27500 ± 100 v")!;
  assert.equal(v.verdict, "pass");
  assert.equal(v.void_reason, undefined);
});

test("uncertainty: a band crossing the limit voids with its reason", () => {
  const v = evaluate(deadLoad, "E_max 30000 v, D_max 27000 ± 100 v")!;
  assert.equal(v.verdict, "void");
  assert.match(v.void_reason ?? "", /uncertainty \(± 100 v\) on d_max/);
  assert.match(v.void_reason ?? "", /crosses the decision boundary/);
  assert.match(v.void_reason ?? "", /band edge/);
});

test("uncertainty: a band fully outside the limit still fails", () => {
  const v = evaluate(deadLoad, "E_max 30000 v, D_max 26000 ± 100 v")!;
  assert.equal(v.verdict, "fail");
});

test("uncertainty: the note narrates the band's corners", () => {
  const v = evaluate(deadLoad, "E_max 30000 v, D_max 27000 ± 100 v")!;
  const note = verdictNote(v, { node_id: "/constraint/dead_load_max_geometry" });
  assert.match(note, /band ± 100 v/);
  assert.match(note, /across the band/);
  assert.match(note, /VIOLATED/);
});

test("uncertainty: a pm-stated tolerance evaluates across its band too", () => {
  const v = evaluate(deadLoad, "E_max 30000 v, D_max 27000 pm 100 v")!;
  assert.equal(v.verdict, "void");
});
