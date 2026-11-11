// The key's OWN day_limit drives BOTH daily counters (the owner's
// 2026-11-09 ruling: the serving cap is for USERS, not operators) —
// the ask counter always did; this pins the TOKEN counter deriving
// from the same number.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenLimit } from "../workers/worker_public/src/quota.ts";

test("a key's token day derives from its own day_limit (asks × 2000)", () => {
  // the default user key (day_limit 2000 asks) reproduces the historic 4M
  assert.equal(tokenLimit({} as any, "key:k1", 2000), 4_000_000);
  // an operator key minted at 50000 asks carries a 100M-token day
  assert.equal(tokenLimit({} as any, "key:op1", 50000), 100_000_000);
  // absent the override (the legacy path), the tier default stands
  assert.equal(tokenLimit({} as any, "key:k1"), 4_000_000);
  // member/anon unaffected
  assert.equal(tokenLimit({} as any, "sub:m1", 50000), 1_500_000);
  assert.equal(tokenLimit({} as any, "anon", 50000), 300_000);
});
