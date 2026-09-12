// Quota + telemetry: per-bucket daily counters (KV) and the D1
// queries/spend ledger writes (TODO.impl/23).
import { sha256Hex, today } from "./config";
import type { Env } from "./env";

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
  ctx: ExecutionContext,
  tier: string,
  route: string,
  model: string | null,
  ok: boolean,
  answerChars: number,
  queryHash: string,
  lang?: string,
) {
  const day = today();
  ctx.waitUntil(
    env.DB.batch([
      env.DB.prepare(
        "INSERT INTO queries (ts, day, tier, route, model, ok, answer_chars, query_hash, lang) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
      ).bind(new Date().toISOString(), day, tier, route, model, ok ? 1 : 0, answerChars, queryHash, lang ?? null),
      env.DB.prepare(
        "INSERT INTO spend (day, tier, model, requests) VALUES (?1,?2,?3,1) ON CONFLICT(day, tier, model) DO UPDATE SET requests = requests + 1",
      ).bind(day, tier, model ?? "none"),
    ]),
  );
}
