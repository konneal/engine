// Projects: membership-as-move accepts BOTH directions. The 2026-09-16
// bug: the string-only guard on body.project_id let the null (unfile)
// case fall through to the create-project branch and 400. Pinned at
// source level (the handler's import graph isn't node-loadable — see
// admin-keys.test.ts for the same pattern).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the move guard accepts project_id: null (unfile), not strings only", () => {
  const src = readFileSync("workers/worker_public/src/projects.ts", "utf8");
  assert.ok(
    /if \(body && \(typeof body\.project_id === "string" \|\| body\.project_id === null\)\)/.test(src),
    "the guard regressed to string-only — unfiling 400s again",
  );
  // the null branch inside must still bind NULL (not stringify it)
  const m = src.match(/const target = body\.project_id === null \? null : String\(body\.project_id\);/);
  assert.ok(m, "the null→NULL binding drifted");
});
