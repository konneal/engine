// Unit tests for the PPR lane's pure core (TODO.sota/06, catalog row 4):
// deterministic Personalized-PageRank over the undirected adjacency,
// seed preference, dangling-mass handling, and the doc ranking shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRank } from "../workers/worker_public/src/stages/graphPpr.ts";

const E: [string, string][] = [
  ["doc:A", "concept:t1"],        // A defines t1
  ["doc:B", "concept:t1"],        // B defines t1 too
  ["doc:B", "concept:t2"],        // B defines t2
  ["doc:C", "concept:t2"],        // C defines t2 (2 hops from t1)
  ["doc:A", "family:F"],          // A in family F
  ["doc:A2", "family:F"],         // A2 in family F
  ["doc:A", "doc:A3"],            // A3 succeeds A
];

test("seed preference: the seed's own neighborhood outranks the far side", () => {
  const r = pageRank(E, ["concept:t1"]);
  assert.ok((r.get("doc:A") ?? 0) > (r.get("doc:C") ?? 0), "A (1 hop) over C (2 hops)");
  assert.ok((r.get("doc:B") ?? 0) > (r.get("doc:C") ?? 0));
});

test("two seeds spread to both neighborhoods", () => {
  const r = pageRank(E, ["concept:t1", "family:F"]);
  assert.ok((r.get("doc:A") ?? 0) > 0);
  assert.ok((r.get("doc:A2") ?? 0) > 0);
  assert.ok((r.get("doc:C") ?? 0) > 0);
});

test("unknown seeds return an empty ranking (the lane stays silent)", () => {
  assert.equal(pageRank(E, ["concept:nope"]).size, 0);
});

test("deterministic: identical inputs, identical ranks", () => {
  const a = pageRank(E, ["concept:t1"]);
  const b = pageRank(E, ["concept:t1"]);
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test("mass is conserved up to dangling returns (sums to ~1)", () => {
  const r = pageRank(E, ["concept:t1"]);
  const total = [...r.values()].reduce((x, y) => x + y, 0);
  assert.ok(total > 0.95 && total < 1.05, `total ${total}`);
});

test("the isolated node contributes nothing to others", () => {
  const withIso = [...E, ["doc:X", "doc:Y"] as [string, string]];
  const a = pageRank(withIso, ["concept:t1"]);
  const b = pageRank(E, ["concept:t1"]);
  assert.equal(a.get("doc:X"), undefined);
  assert.equal(a.get("doc:A"), b.get("doc:A"));
});
