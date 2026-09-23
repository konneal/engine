import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateConditionSets, quantitiesIn } from "../workers/worker_public/src/conditions.ts";

const set40_85 = {
  node_id: "severity-cab-40-degc-85-rh",
  content: { payload: { role: "severity", entries: [
    { quantity_kind: "temperature", value: "40", unit: "degC", tolerance: "2" },
    { quantity_kind: "relative_humidity", value: "85", unit: "%", tolerance: "3" },
  ] } },
};
const set40_93 = {
  node_id: "severity-cab-40-degc-93-rh",
  content: { payload: { role: "severity", entries: [
    { quantity_kind: "temperature", value: "40", unit: "degC", tolerance: "2" },
    { quantity_kind: "relative_humidity", value: "93", unit: "%", tolerance: "3" },
  ] } },
};

test("membership: a stated pair inside a set's bands passes and names the set", () => {
  const v = evaluateConditionSets([set40_93, set40_85], "Is 40 °C at 85 % RH a valid damp heat severity?");
  assert.equal(v?.verdict, "pass");
  assert.deepEqual(v.matched, ["severity-cab-40-degc-85-rh"]);
});

test("out-of-band combination fails and names the nearest set", () => {
  const v = evaluateConditionSets([set40_85, set40_93], "Is 40 °C at 98 % RH a valid severity?");
  assert.equal(v?.verdict, "fail");
  assert.equal(v?.nearest?.node_id, "severity-cab-40-degc-93-rh");
  assert.ok((v?.nearest?.distance ?? 1) > 0);
});

test("quantities parse by unit: %RH, degC, hours and days", () => {
  const q = quantitiesIn("40 °C, 85 %RH, 48 h or 2 days");
  assert.equal(q.temperature, 40);
  assert.equal(q.relative_humidity, 85);
  assert.equal(q.duration, 48);
});

test("no stated quantities: no verdict at all", () => {
  assert.equal(evaluateConditionSets([set40_85], "What is damp heat?"), null);
});
