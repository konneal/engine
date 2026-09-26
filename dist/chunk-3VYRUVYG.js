import {
  checkQuota,
  clientIp,
  graphExpand,
  portModelRunner,
  retrieve,
  sessionFrom,
  telemetry,
  understandQuery
} from "./chunk-JHFYBPRD.js";
import {
  corsHeaders,
  err,
  json,
  readJson,
  validateQuery
} from "./chunk-R2V3X6SQ.js";
import {
  entitlementScope,
  standardKeysFrom
} from "./chunk-4GJGBGJK.js";
import {
  LIMITS,
  MODELS,
  num,
  sha256Hex
} from "./chunk-V46XM2GU.js";

// workers/worker_public/src/search.ts
async function handleSearch(env, ctx, req, tier, key) {
  const body = await readJson(req);
  const q = validateQuery(body);
  if (!q) return err(400, "invalid_input", `query is required (1-${LIMITS.maxInputChars} chars)`);
  const member = tier === "member" ? await sessionFrom(req, env) : null;
  const limit = tier === "key" || member ? Number.MAX_SAFE_INTEGER : num(env, "ANON_DAY_SEARCH", 50);
  const bucketId = tier === "key" ? `key:${key.id}` : member ? `sub:${member.sub}` : clientIp(req);
  const quota = await checkQuota(env, "search", bucketId, limit);
  if (!quota.ok) {
    return err(429, "quota_exceeded", `Daily search limit reached (${quota.limit}). Try again tomorrow.`);
  }
  const understanding = await understandQuery(portModelRunner(env), MODELS.understand, q.query, []);
  const graphDocNumbers = await graphExpand(env, understanding);
  const standardKeys = entitlementScope(standardKeysFrom(body));
  let retrieved;
  try {
    retrieved = await retrieve(env, q.query, { understanding, graphDocNumbers, standardKeys });
  } catch {
    return err(503, "retrieval_unavailable", "Search is briefly busy \u2014 please retry in a moment.");
  }
  const { hits, filters } = retrieved;
  const results = hits.map((h) => ({
    doc_id: h.metadata.doc_id,
    docidentifier: h.metadata.docidentifier,
    edition: h.metadata.edition,
    language: h.metadata.language,
    clause_anchor: h.metadata.clause_anchor,
    clause_title: h.metadata.clause_title,
    status: h.metadata.status ?? "unknown",
    superseded_by: h.metadata.superseded_by || void 0,
    text: h.text,
    score: h.rerank_score ?? h.score
  }));
  telemetry(env, ctx, tier, "search", MODELS.embed, true, 0, await sha256Hex(q.query), q.lang);
  return json({ results, filters, quota, ...corsHeaders(req) });
}

export {
  handleSearch
};
