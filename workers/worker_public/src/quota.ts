// Quota + telemetry: per-bucket daily counters (KV) and the D1
// queries/spend ledger writes (TODO.impl/23).
import { num, sha256Hex, today } from "./config.ts";
import type { Env } from "./env";
import type { Background } from "./ports/runtime.ts";

export async function kvIncr(cache: KVNamespace, key: string, step = 1): Promise<number> {
  const cur = Number((await cache.get(key)) ?? "0");
  const next = cur + step;
  await cache.put(key, String(next), { expirationTtl: 90000 });
  return next;
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Daily ask quota. `weight` is the effort multiplier: a thorough
 *  (elevated-effort) answer consumes more of the day's budget —
 *  different reasoning efforts naturally cost different quota. */
export async function checkQuota(
  env: Env,
  bucket: string,
  id: string,
  limit: number,
  weight = 1,
): Promise<{ ok: boolean; used: number; limit: number }> {
  const used = await kvIncr(env.CACHE, `q:${today()}:${bucket}:${await sha256Hex(id)}`, weight);
  return { ok: used <= limit, used, limit };
}

export function telemetry(
  env: Env,
  ctx: Background,
  tier: string,
  route: string,
  model: string | null,
  ok: boolean,
  answerChars: number,
  queryHash: string,
  lang?: string,
  cache?: "exact" | "semantic",
  meta?: { durationMs?: number; keyId?: string | null; retries?: number },
) {
  const day = today();
  ctx.waitUntil(
    env.DB.batch([
      env.DB.prepare(
        "INSERT INTO queries (ts, day, tier, route, model, ok, answer_chars, query_hash, lang, cache, duration_ms, key_id, retries) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
      ).bind(new Date().toISOString(), day, tier, route, model, ok ? 1 : 0, answerChars, queryHash, lang ?? null, cache ?? null, meta?.durationMs ?? null, meta?.keyId ?? null, meta?.retries ?? 0),
      env.DB.prepare(
        "INSERT INTO spend (day, tier, model, requests) VALUES (?1,?2,?3,1) ON CONFLICT(day, tier, model) DO UPDATE SET requests = requests + 1",
      ).bind(day, tier, model ?? "none"),
    ]),
  );
}

// ── the token budget (2026-09-29): the daily allowance is TOKENS, not
// questions — an elevated-effort answer over a wide retrieval context
// costs orders of magnitude more than a cached refusal, and one number
// should say so. Charged after generation from the model's own usage
// when the stream reports it, estimated by characters otherwise.
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function tokenTier(bucketId: string): "anon" | "member" | "key" {
  return bucketId.startsWith("key:") ? "key" : bucketId.startsWith("sub:") ? "member" : "anon";
}

export function tokenLimit(env: Env, bucketId: string): number {
  const tier = tokenTier(bucketId);
  return tier === "key"
    ? num(env as any, "KEY_DAY_TOKENS", 4_000_000)
    : tier === "member"
      ? num(env as any, "MEMBER_DAY_TOKENS", 1_500_000)
      : num(env as any, "ANON_DAY_TOKENS", 300_000);
}

export async function tokenBudget(env: Env, bucketId: string): Promise<{ used: number; limit: number }> {
  const used = Number((await env.CACHE.get(`t:${today()}:ask:${await sha256Hex(bucketId)}`)) ?? "0");
  return { used, limit: tokenLimit(env, bucketId) };
}

export async function chargeTokens(env: Env, bucketId: string, tokens: number): Promise<void> {
  if (!(tokens > 0)) return;
  await kvIncr(env.CACHE, `t:${today()}:ask:${await sha256Hex(bucketId)}`, tokens);
}

export function usageTotal(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as any;
  const p = Number(u.prompt_tokens ?? 0);
  const c = Number(u.completion_tokens ?? 0);
  const total = p + c;
  return Number.isFinite(total) && total > 0 ? total : null;
}
