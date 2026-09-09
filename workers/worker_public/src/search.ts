// Passage search: retrieval without generation (TODO.impl/23).
import { LIMITS, MODELS, num, sha256Hex } from "./config";
import { retrieve } from "./pipeline";
import { understandQuery } from "./understand";
import { sessionFrom } from "./auth";
import { err, json, corsHeaders, readJson, validateQuery, type ApiKey } from "./lib/http";
import { checkQuota, clientIp, telemetry } from "./quota";
import { graphExpand } from "./graph";
import type { Env } from "./env";
import type { Hit } from "../../shared/chunk.ts";

export async function handleSearch(
  env: Env,
  ctx: ExecutionContext,
  req: Request,
  tier: "anon" | "key" | "member",
  key: ApiKey | null,
): Promise<Response> {
  const body = await readJson(req);
  const q = validateQuery(body);
  if (!q) return err(400, "invalid_input", `query is required (1-${LIMITS.maxInputChars} chars)`);

  const member = tier === "member" ? await sessionFrom(req, env as any) : null;
  const limit = tier === "key" || member ? Number.MAX_SAFE_INTEGER : num(env as any, "ANON_DAY_SEARCH", 50);
  const bucketId = tier === "key" ? `key:${key!.id}` : member ? `sub:${member.sub}` : clientIp(req);
  const quota = await checkQuota(env, "search", bucketId, limit);
  if (!quota.ok) {
    return err(429, "quota_exceeded", `Daily search limit reached (${quota.limit}). Try again tomorrow.`);
  }

  const understanding = await understandQuery(env.AI, MODELS.understand, q.query, []);
  const graphDocNumbers = await graphExpand(env, understanding);
  let retrieved;
  try {
    retrieved = await retrieve(env, q.query, { understanding, graphDocNumbers });
  } catch {
    return err(503, "retrieval_unavailable", "Search is briefly busy — please retry in a moment.");
  }
  const { hits, filters } = retrieved;
  const results = hits.map((h: Hit) => ({
    doc_id: h.metadata.doc_id,
    docidentifier: h.metadata.docidentifier,
    edition: h.metadata.edition,
    language: h.metadata.language,
    clause_anchor: h.metadata.clause_anchor,
    clause_title: h.metadata.clause_title,
    status: h.metadata.status ?? "unknown",
    superseded_by: h.metadata.superseded_by || undefined,
    text: h.text,
    score: h.rerank_score ?? h.score,
  }));
  telemetry(env, ctx, tier, "search", MODELS.embed, true, 0, await sha256Hex(q.query), q.lang);
  return json({ results, filters, quota, ...corsHeaders(req) });
}
