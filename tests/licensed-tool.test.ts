// The licensed library tool: the entitlement predicate is the ask
// path's own (declared keys validate, forged keys drop), the
// unentitled caller receives the boundary refusal and never a node,
// and the entitled caller gets the clause's typed nodes with honest
// clause-level absence.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool } from "../workers/worker_public/src/tools.ts";
import { setProfile } from "../workers/worker_public/src/profile.ts";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";

const NODES = [
  { node_id: "/req/fixture/chamber/humidity-limits", kind: "requirement", name: "Humidity limits", clause_ref: "5", content: '{"acceptance_criteria":{"items":[{"description":"relative humidity 25 °C ± 3 K"}]}}' },
];
const dbWith = (results: unknown[]) => ({
  prepare: () => ({ bind: () => ({ all: async () => ({ results }) }) }),
});

test("an unentitled caller receives the boundary refusal, never a node", async () => {
  setProfile(PROFILE); // declares std:fixture-ab-99, package fixture-ab-99, doc ab-99
  const r = await runTool({ DB: dbWith(NODES) }, { name: "licensed.section", args: { doc: "ab-99", clause: "5", licensed_standards: [] } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /licensed publication/);
  assert.ok(!r.output.includes("humidity-limits"), "no node id leaks through the boundary");
  assert.ok(!r.output.includes("25 °C"), "no parameter leaks through the boundary");
});

test("a forged key does not widen scope — it drops like the ask path's", async () => {
  setProfile(PROFILE);
  const r = await runTool({ DB: dbWith(NODES) }, { name: "licensed.section", args: { doc: "ab-99", clause: "5", licensed_standards: ["std:everything"] } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /licensed publication/);
});

test("an entitled caller gets the clause's typed nodes with parsed content", async () => {
  setProfile(PROFILE);
  const r = await runTool({ DB: dbWith(NODES) }, { name: "licensed.section", args: { doc: "IEC ab-99", clause: "5", licensed_standards: ["std:fixture-ab-99"] } }, "mcp");
  assert.ok(r);
  const nodes = JSON.parse(r.output);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].node_id, "/req/fixture/chamber/humidity-limits");
  assert.equal(nodes[0].content.acceptance_criteria.items.length, 1);
});

test("a clause without nodes states absence and lists the clauses that exist", async () => {
  setProfile(PROFILE);
  const db = {
    prepare: (sql: string) => ({
      bind: (..._a: unknown[]) => ({
        all: async () => ({
          results: sql.includes("DISTINCT") ? [{ clause_ref: "5" }, { clause_ref: "7" }, { clause_ref: "9" }] : [],
        }),
      }),
    }),
  };
  const r = await runTool({ DB: db }, { name: "licensed.section", args: { doc: "ab-99", clause: "12", licensed_standards: ["std:fixture-ab-99"] } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /No typed nodes are indexed for ab-99 §12/);
  assert.match(r.output, /clauses with typed nodes: 5, 7, 9/);
});

test("a non-licensed document points at the public tool, honestly", async () => {
  setProfile(PROFILE);
  const r = await runTool({ DB: dbWith([]) }, { name: "licensed.section", args: { doc: "99999-1", clause: "1", licensed_standards: ["std:fixture-ab-99"] } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /not among the licensed standards/);
  assert.match(r.output, /docs\.section/);
});
