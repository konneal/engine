// The selective brute-force escalation's pure halves (TODO.sota/21):
// the assembly order + cap, the citation contract, the daily budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleDocument, verifyAnchors, escalationAllowed, chargeEscalation } from "../workers/worker_public/src/escalation.ts";

const rows = [
  { text: "5.1 General requirements apply.", clause_anchor: "5.1" },
  { text: "5.3.2 The MPE shall be within Table 4.", clause_anchor: "5.3.2" },
  { text: "6.2 Zero-setting performed before the test.", clause_anchor: "6.2" },
];
const store = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: rows }),
    }),
  }),
};

test("assembleDocument walks reading order and collects the clause set with prefixes", async () => {
  const doc = await assembleDocument(store as any, "OIML R 60", 900_000);
  assert.ok(doc);
  assert.equal(doc!.text, rows.map((r) => r.text).join("\n\n"));
  assert.ok(doc!.clauses.has("5.3.2"));
  assert.ok(doc!.clauses.has("5.3"), "the dotted prefixes verify shorter citations");
  assert.ok(doc!.clauses.has("5"));
  assert.equal(doc!.truncated, false);
});

test("assembleDocument truncates at the cap and reports it", async () => {
  const doc = await assembleDocument(store as any, "OIML R 60", 40);
  assert.ok(doc);
  assert.equal(doc!.truncated, true);
  assert.ok(doc!.text.length <= 40 + rows[0].text.length + 2, "the cap holds mid-document");
});

test("the citation contract: cited clauses must resolve in the document", () => {
  const clauses = new Set(["5", "5.1", "5.3", "5.3.2", "6", "6.2"]);
  assert.equal(verifyAnchors("Per clause 5.3.2 the MPE applies.", clauses).ok, true);
  assert.equal(verifyAnchors("See 6.2 for zero-setting.", clauses).ok, true);
  const missing = verifyAnchors("Per clause 7.4.1 and 5.3.2.", clauses);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["7.4.1"]);
  assert.equal(verifyAnchors("No clause cited here.", clauses).ok, true, "no citations = nothing to verify");
});

test("the daily budget counts and caps per bucket", async () => {
  const kv = new Map<string, string>();
  assert.equal(await escalationAllowed({ get: (k: string) => kv.get(k) ?? null }, "sub:member-1", 2, "2026-11-08"), true);
  await chargeEscalation({ get: (k: string) => kv.get(k) ?? null, put: (k: string, v: string) => { kv.set(k, v); } } as any, "sub:member-1", "2026-11-08");
  await chargeEscalation({ get: (k: string) => kv.get(k) ?? null, put: (k: string, v: string) => { kv.set(k, v); } } as any, "sub:member-1", "2026-11-08");
  assert.equal(await escalationAllowed({ get: (k: string) => kv.get(k) ?? null }, "sub:member-1", 2, "2026-11-08"), false);
  assert.equal(await escalationAllowed({ get: (k: string) => kv.get(k) ?? null }, "sub:member-2", 2, "2026-11-08"), true, "the cap is per bucket");
});
