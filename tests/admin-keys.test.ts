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
  assert.ok(!m[1].includes("[...crypto"), "the inner expression must be interpolated, not literal");
  assert.ok(m[1].startsWith("${P().publisher.id}_${"), "the template shape drifted");
});
