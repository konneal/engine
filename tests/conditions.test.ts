import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateConditionSets, quantitiesIn } from "../workers/worker_public/src/conditions.ts";

const sets = [
  {
    node_id: "severity-cab-40-degc-85-rh",
    content: { payload: { entries: [
      { quantity_kind: "temperature", value: "40", unit: "degC", tolerance: "2", si: { value: 313.15, unit: "K" } },
      { quantity_kind: "relative_humidity", value: "85", unit: "%", tolerance: "3", si: { value: 0.85, unit: "1" } },
    ] } },
  },
  {
    node_id: "severity-cab-40-degc-93-rh",
    content: { payload: { entries: [
      { quantity_kind: "temperature", value: "40", unit: "degC", tolerance: "2", si: { value: 313.15, unit: "K" } },
      { quantity_kind: "relative_humidity", value: "93", unit: "%", tolerance: "3", si: { value: 0.93, unit: "1" } },
    ] } },
  },
];

test("membership in SI: 40 degC at 85 % RH passes and names its set", () => {
  const v = evaluateConditionSets(sets, "Is 40 °C at 85 % RH a valid damp heat severity?");
  assert.equal(v?.verdict, "pass");
  assert.deepEqual(v.matched, ["severity-cab-40-degc-85-rh"]);
});

test("cross-unit: 313 K is the same stated temperature as 40 degC", () => {
  const v = evaluateConditionSets(sets, "Is 313 K at 85 % RH a valid severity?");
  assert.equal(v?.verdict, "pass");
  assert.deepEqual(v.matched, ["severity-cab-40-degc-85-rh"]);
});

test("out-of-band fails and names the nearest set", () => {
  const v = evaluateConditionSets(sets, "Is 40 °C at 98 % RH a valid severity?");
  assert.equal(v?.verdict, "fail");
  assert.equal(v?.nearest?.node_id, "severity-cab-40-degc-93-rh");
});

test("quantities parse by unit with SI normalization", () => {
  const q = quantitiesIn("40 °C, 313 K, 85 %RH, 48 h, 2 days");
  assert.equal(q.temperature.stated, 40);
  assert.equal(q.temperature.si, 313.15);
  assert.equal(q.relative_humidity.si, 0.85);
  assert.equal(q.duration.si, 3600 * 48);
});

test("no stated quantities: no verdict at all", () => {
  assert.equal(evaluateConditionSets(sets, "What is damp heat?"), null);
});
