// API key generation (the 2026-09-14 regression: a de-publisher-izing
// edit dropped the inner interpolation and the "key" was literal
// template source text). The shape is pinned: publisher prefix + 48
// hex chars, and it is never deterministic source text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { P, setProfile } from "../workers/worker_public/src/profile.ts";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";

test("the key template in admin.ts interpolates the random hex (no literal source text)", () => {
  const src = readFileSync("workers/worker_public/src/admin.ts", "utf8");
  const m = src.match(/const raw = `([^`]*crypto\.getRandomValues[^`]*)`;/);
  assert.ok(m, "the key-generation template not found");
  assert.ok(m[1].includes("${[...crypto"), "the inner expression must be interpolated (${[...]), not literal source text");
  assert.ok(m[1].startsWith("${P().publisher.id}_${"), "the template shape drifted");
});

// ── the owner-member law (2026-10-12): a member-owned key shares HER
//    credit cap — one bucket, never a multiplied allowance ──
test("api_keys carries owner_sub and authenticate selects it", () => {
  const schema = readFileSync("workers/worker_public/schema.sql", "utf8");
  assert.match(schema, /owner_sub TEXT/);
  const auth = readFileSync("workers/worker_public/src/lib/http.ts", "utf8");
  assert.match(auth, /owner_sub FROM api_keys/);
});

test("the mint records the owner member", () => {
  const admin = readFileSync("workers/worker_public/src/admin.ts", "utf8");
  assert.match(admin, /member_sub/);
  assert.match(admin, /owner_sub, created_at/);
});
