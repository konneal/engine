// Request scope derivation (the dataset-toggle + memory-selection model):
// permission intersection, corpus mapping, the empty-dataset error, and
// the answer-cache salt rule — default requests stay unsalted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRequestScope, requestSalt } from "../workers/worker_public/src/requestScope.ts";

const anon = null;
const member = { sub: "s", roles: [] };
const previewMember = { sub: "s", roles: ["ai-preview"] };

test("default request: everything permitted, no narrowing, no salt", () => {
  for (const m of [anon, member, previewMember]) {
    const sc = resolveRequestScope({}, m) as any;
    assert.ok(!sc.narrowed);
    assert.equal(sc.isoOn, m === previewMember);
    assert.equal(requestSalt(sc, []), null);
  }
});

test("iso requires ai-preview even when requested", () => {
  const sc = resolveRequestScope({ datasets: ["iso"] }, member) as any;
  assert.deepEqual(sc.scopeIds, []); // intersected to nothing
  assert.ok(sc.narrowed);
  assert.equal(sc.isoOn, false);
  const sp = resolveRequestScope({ datasets: ["iso"] }, previewMember) as any;
  assert.equal(sp.isoOn, true);
  assert.ok(sp.corpora.has("iso-internal"));
});

test("oiml maps to its four corpus values", () => {
  const sc = resolveRequestScope({ datasets: ["oiml"] }, anon) as any;
  for (const v of ["oiml", "dirty", "clean", "synthetic"]) assert.ok(sc.corpora.has(v));
  assert.ok(!sc.corpora.has("iso-internal"));
});

test("unknown dataset ids and non-string junk drop silently", () => {
  const sc = resolveRequestScope({ datasets: ["oiml", "nope", 42, null] }, anon) as any;
  assert.deepEqual(sc.scopeIds, ["oiml"]);
});

test("explicitly-empty datasets is the user error", () => {
  assert.deepEqual(resolveRequestScope({ datasets: [] }, member), { error: "empty-datasets" });
});

test("memory ids: member-only, capped at 4, junk dropped", () => {
  assert.deepEqual(resolveRequestScope({ memories: ["m:a", 1, null, "m:b", "m:c", "m:d", "m:e"] }, member).memoryIds,
    ["m:a", "m:b", "m:c", "m:d"]);
  assert.deepEqual(resolveRequestScope({ memories: ["m:a"] }, anon).memoryIds, []);
});

test("salt: narrow scope OR memory selection; deterministic; null when default", () => {
  const narrowed = resolveRequestScope({ datasets: ["oiml"] }, anon) as any;
  const salted = requestSalt(narrowed, []);
  assert.ok(salted && salted.includes('"d"'));
  const full = resolveRequestScope({}, anon) as any;
  assert.equal(requestSalt(full, ["m:a", "m:b"]), JSON.stringify({ m: ["m:a", "m:b"] }));
  assert.equal(requestSalt(full, []), null);
});
