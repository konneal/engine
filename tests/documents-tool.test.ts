// The documents-registry tool: family lookups carry every edition with
// its derived status, the ACTIVE flag rides the successor chain's
// terminal, and the absence of a family is stated, never improvised.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool, TOOLS_REGISTRY } from "../workers/worker_public/src/tools.ts";

const dbWith = (results: unknown[]) => ({
  prepare: () => ({ bind: () => ({ all: async () => ({ results }) }) }),
});

test("the registry carries the documents tool for the mcp audience only", () => {
  const spec = TOOLS_REGISTRY.find((t) => t.name === "documents.family");
  assert.ok(spec, "documents.family is registered");
  assert.deepEqual(spec.audiences, ["mcp"]);
});

test("a family's editions render with status, ACTIVE flag and supersession", async () => {
  const db = dbWith([
    { docidentifier: "OIML R 60:2000 (PE)", derived_status: "superseded", active: 0, succ: "OIML R 60:2017+Amendment:2019" },
    { docidentifier: "OIML R 60:2017+Amendment:2019", derived_status: "in-force", active: 1, succ: null },
  ]);
  const r = await runTool({ DB: db }, { name: "documents.family", args: { family: "R-60" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /OIML R 60:2000 \(PE\) — superseded → superseded by OIML R 60:2017\+Amendment:2019/);
  assert.match(r.output, /OIML R 60:2017\+Amendment:2019 — in-force \[ACTIVE\]/);
});

test("an unknown family is stated plainly, never improvised", async () => {
  const r = await runTool({ DB: dbWith([]) }, { name: "documents.family", args: { family: "R-999" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /No editions are registered for the family R-999/);
});

test("a malformed family key dispatches to nothing", async () => {
  const r = await runTool({ DB: dbWith([]) }, { name: "documents.family", args: { family: "DROP TABLE" } }, "mcp");
  assert.equal(r, null);
});
