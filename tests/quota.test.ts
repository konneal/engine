import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, tokenLimit, usageTotal } from "../workers/worker_public/src/quota.ts";

test("the estimator is a deterministic chars-over-4 ceiling", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(1), 1);
  assert.equal(estimateTokens(8), 2);
  assert.equal(estimateTokens(9), 3);
});

test("usage totals read the model's own counts, null when absent or empty", () => {
  assert.equal(usageTotal({ prompt_tokens: 1200, completion_tokens: 340 }), 1540);
  assert.equal(usageTotal({ prompt_tokens: 1200 }), 1200);
  assert.equal(usageTotal({}), null);
  assert.equal(usageTotal(null), null);
  assert.equal(usageTotal("x"), null);
});

test("the token limit follows the bucket's tier", () => {
  const env = { ANON_DAY_TOKENS: "300000", MEMBER_DAY_TOKENS: "1500000", KEY_DAY_TOKENS: "4000000" };
  assert.equal(tokenLimit(env as any, "1.2.3.4"), 300000);
  assert.equal(tokenLimit(env as any, "sub:auth|alice"), 1500000);
  assert.equal(tokenLimit(env as any, "key:k_123"), 4000000);
});

test("the token limit falls back to code defaults when the vars are absent", () => {
  assert.equal(tokenLimit({} as any, "1.2.3.4"), 300000);
  assert.equal(tokenLimit({} as any, "sub:auth|alice"), 1500000);
  assert.equal(tokenLimit({} as any, "key:k_123"), 4000000);
});
