import { LIMITS, MODELS, num, sha256Hex, today } from "./config";
import { buildMessages, citations, retrieve, Hit } from "./pipeline";
import { handleCallback, handleLogin, handleLogout, handleMe, sessionFrom } from "./auth";
import { handleAppendMessage, handleConversations } from "./conversations";
import { INTERNAL_ROLES } from "./auth";
import { understandQuery } from "./understand";
import { gradeRetrieval } from "./grader";
import { reflect } from "./reflect";

export interface Env {
  AI: any;
  VECTORIZE: any;
  CACHE: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  INDEX_VERSION: string;
  ANON_DAY_ASK: string;
  ANON_DAY_SEARCH: string;
  KEY_DAY_ASK_DEFAULT: string;
  ANON_DAY_HARD_CAP: string;
  ADMIN_TOKEN?: string;
  MEMBER_DAY_ASK?: string;
  EXEMPT_IPS?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  SESSION_SECRET?: string;
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

const err = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed =
    origin === "https://oimlsmart.org" || /^https:\/\/[a-z0-9-]+\.oimlsmart\.org$/.test(origin);
  return allowed
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      }
    : {};
}

async function kvIncr(cache: KVNamespace, key: string): Promise<number> {
  const cur = Number((await cache.get(key)) ?? "0");
  const next = cur + 1;
  await cache.put(key, String(next), { expirationTtl: 90000 });
  return next;
}

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

// operator-exempt IPs (env list, KV sys:exempt_ips override for runtime
// edits) bypass the anon quota — the KV read is cached briefly per isolate
let exemptCache: { at: number; ips: Set<string> } | null = null;
async function isExemptIp(env: Env, ip: string): Promise<boolean> {
  if (((env.EXEMPT_IPS ?? "") + "").split(",").map((s) => s.trim()).includes(ip)) return true;
  const now = Date.now();
  if (!exemptCache || now - exemptCache.at > 60_000) {
    const kv = (await env.CACHE.get("sys:exempt_ips")) ?? "";
    exemptCache = { at: now, ips: new Set(kv.split(/[\s,]+/).filter(Boolean)) };
  }
  return exemptCache.ips.has(ip);
}

async function checkQuota(
  env: Env,
  bucket: string,
  id: string,
  limit: number,
): Promise<{ ok: boolean; used: number; limit: number }> {
  const used = await kvIncr(env.CACHE, `q:${today()}:${bucket}:${await sha256Hex(id)}`);
  return { ok: used <= limit, used, limit };
}

interface ApiKey {
  id: string;
  name: string;
  day_limit: number;
}

async function authenticate(env: Env, req: Request): Promise<ApiKey | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const keyHash = await sha256Hex(m[1].trim());
  const row = await env.DB.prepare(
    "SELECT id, name, day_limit FROM api_keys WHERE key_hash = ?1 AND revoked = 0",
  )
    .bind(keyHash)
    .first<ApiKey>();
  return row ?? null;
}

async function readJson(req: Request): Promise<any | null> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") return null;
    return body;
  } catch {
    return null;
  }
}

function validateQuery(body: any): { query: string; lang?: string } | null {
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > LIMITS.maxInputChars) return null;
  const lang = typeof body?.lang === "string" && /^[a-z]{2}$/.test(body.lang) ? body.lang : undefined;
  return { query, lang };
}

async function cacheGet(env: Env, ns: string, query: string, lang?: string) {
  const key = `a:${env.INDEX_VERSION}:${ns}:${await sha256Hex(
    `${query.toLowerCase().replace(/\s+/g, " ").trim()}|${lang ?? ""}`,
  )}`;
  const hit = await env.CACHE.get(key, "json");
  return hit ? { key, value: hit as any } : null;
}

function telemetry(
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

// self-reflection retry runs at most once per ask
function opts_reflect_retried(): boolean {
  return false;
}

async function generateStream(env: Env, model: string, messages: any[]): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const res: any = await env.AI.run(model, {
      messages,
      stream: true,
      max_tokens: LIMITS.maxOutputTokens,
      reasoning_effort: "low",
    });
    if (res && typeof res.getReader === "function") return res as ReadableStream<Uint8Array>;
    if (res && res.body && typeof res.body.getReader === "function") return res.body;
    return null;
  } catch {
    return null;
  }
}

async function generateOnce(env: Env, model: string, messages: any[]): Promise<string | null> {
  try {
    const res: any = await env.AI.run(model, {
      messages,
      max_tokens: LIMITS.maxOutputTokens,
      reasoning_effort: "low",
    });
    if (typeof res?.response === "string") return res.response;
    if (typeof res?.choices?.[0]?.message?.content === "string") return res.choices[0].message.content;
    return null;
  } catch {
    return null;
  }
}

async function* sseTokens(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        const tok =
          typeof evt?.response === "string"
            ? evt.response
            : evt?.choices?.[0]?.delta?.content;
        if (tok) yield tok;
      } catch {
        // partial JSON in line splitting — ignore
      }
    }
  }
}

async function handleAsk(
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
  const exempt = tier === "anon" ? await isExemptIp(env, clientIp(req)) : false;
  const limit =
    tier === "key" ? key!.day_limit : tier === "member" || member ? num(env as any, "MEMBER_DAY_ASK", 300) : num(env as any, "ANON_DAY_ASK", 20);
  const bucketId = tier === "key" ? `key:${key!.id}` : member ? `sub:${member.sub}` : clientIp(req);
  const quota = await checkQuota(env, "ask", bucketId, limit);
  if (!quota.ok && !exempt) {
    return err(429, "quota_exceeded", `Daily question limit reached (${quota.limit}). Try again tomorrow.`);
  }

  const hardCap = num(env as any, "ANON_DAY_HARD_CAP", 5000);
  if (tier === "anon" && !exempt && quota.used > hardCap) {
    return err(503, "generation_disabled", "Generation is temporarily paused; search remains available.");
  }
  if ((await env.CACHE.get("sys:generation")) === "off") {
    return err(503, "generation_disabled", "Generation is temporarily paused; search remains available.");
  }

  const ns = tier === "key" ? `k:${key!.id}` : member ? `m:${member.sub}` : "anon";
  const model = member ? MODELS.member : MODELS.anon;
  const prev = typeof body?.prev === "string" ? body.prev.slice(0, 400) : undefined;
  const rawHistory = Array.isArray(body?.history) ? body.history : [];
  const history = rawHistory
    .filter((h: any) => (h?.role === "user" || h?.role === "assistant") && typeof h?.content === "string" && h.content.trim())
    .slice(-12)
    .map((h: any) => ({ role: h.role, content: h.content.slice(0, 1200) }));
  const contextual = history.length > 0;
  let retrieved;
  // fresh=true (regenerate) skips the cache read; contextual follow-ups skip
  // the cache entirely — the answer depends on the conversation, not the query
  const cached = body?.fresh === true || contextual ? null : await cacheGet(env, ns, q.query, q.lang);
  const wantsStream = body?.stream === true || (tier === "anon" && body?.stream !== false);
  if (cached) {
    telemetry(env, ctx, tier, "ask", null, true, (cached.value.answer ?? "").length, cached.value.query_hash, q.lang);
    if (wantsStream) {
      // a cache hit must still speak SSE — the chat client parses a stream
      return sseResponse([{ type: "citations", citations: cached.value.citations ?? [], quota }, { type: "token", v: cached.value.answer ?? "" }, { type: "done", model: cached.value.model ?? MODELS.anon, query_hash: cached.value.query_hash }], corsHeaders(req));
    }
    return json({ ...cached.value, cached: true, quota });
  }

  const understanding = cached ? null : await understandQuery(env.AI, MODELS.anon, q.query, history);
  try {
    retrieved = await retrieve(env, q.query, { prev, understanding });
    // CRAG: grade the passages; a weak grade earns ONE corrective
    // re-retrieval with the document identifier made explicit
    const grade = await gradeRetrieval(env.AI, MODELS.grader, q.query, retrieved.hits.map((h: Hit) => h.text));
    if (grade === "weak" && understanding?.docidentifier) {
      const broaden = `${understanding.standalone_query || q.query} ${understanding.docidentifier}`.trim();
      const second = await retrieve(env, q.query, { prev, understanding, queryOverride: broaden });
      const grade2 = await gradeRetrieval(env.AI, MODELS.grader, q.query, second.hits.map((h: Hit) => h.text));
      if (grade2 === "good") retrieved = second; // corrective retry must be strictly better
    }
  } catch {
    telemetry(env, ctx, tier, "ask", MODELS.embed, false, 0, await sha256Hex(q.query), q.lang);
    return err(503, "retrieval_unavailable", "Search is briefly busy — please retry in a moment.");
  }
  const { hits } = retrieved;
  if (hits.length === 0) {
    const answer = "I don't have information on this in the indexed OIML publications.";
    const out = { answer, citations: [], model, query_hash: await sha256Hex(q.query) };
    telemetry(env, ctx, tier, "ask", model, true, answer.length, out.query_hash, q.lang);
    return json({ ...out, ...(exempt ? {} : { quota }) });
  }

  const messages = buildMessages(
    q.query,
    hits,
    q.lang,
    history,
    understanding?.process_intent
      ? "Retrieval note: these passages come from the OIML Certification System documents because they govern certification/application procedures for OIML publications."
      : undefined,
  );
  const queryHash = await sha256Hex(q.query);
  const cites = citations(hits);

  if (wantsStream) {
    const stream = await generateStream(env, model, messages);
    if (stream) {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          send({ type: "citations", citations: cites, ...(exempt ? {} : { quota }) });
          let full = "";
          try {
            for await (const tok of sseTokens(stream)) {
              full += tok;
              send({ type: "token", v: tok });
            }
          } catch {
            // stream ended prematurely — deliver what we have
          }
          send({ type: "done", model, query_hash: queryHash });
          telemetry(env, ctx, tier, "ask", model, true, full.length, queryHash, q.lang);
          if (full.length > 0 && !contextual) {
            ctx.waitUntil(
              env.CACHE.put(await cacheKey(env, ns, q.query, q.lang), JSON.stringify({ answer: full, citations: cites, model, query_hash: queryHash }), { expirationTtl: LIMITS.cacheTtlSec }),
            );
          }
          controller.close();
        },
      });
      return new Response(sse, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
          ...corsHeaders(req),
        },
      });
    }
  }

  let answer = await generateOnce(env, model, messages);

  // ── Self-RAG reflection loop ──
  // The model critiques its own answer; if claims are ungrounded, retry
  // retrieval with the missing-info hint (max one retry).
  // Ref: selfrag.github.io; arXiv 2606.05658 bounded reflection
  if (answer && answer !== "I don't have information on this in the indexed OIML publications.") {
    const reflection = await reflect(env.AI, MODELS.grader, q.query, answer, hits.map((h: Hit) => h.text));
    if (reflection && !reflection.grounded && reflection.missing_info && !opts_reflect_retried()) {
      // re-retrieve targeting what was missing
      const retryRetrieve = await retrieve(env, q.query, {
        prev,
        understanding: { ...understanding, standalone_query: `${understanding?.standalone_query || q.query} ${reflection.missing_info}` } as any,
      });
      if (retryRetrieve.hits.length > 0) {
        const retryMessages = buildMessages(q.query, retryRetrieve.hits, q.lang, history);
        const retryAnswer = await generateOnce(env, model, retryMessages);
        if (retryAnswer) answer = retryAnswer; // better-grounded answer wins
      }
    }
  }

  if (answer === null) {
    telemetry(env, ctx, tier, "ask", model, false, 0, queryHash, q.lang);
    return err(502, "generation_failed", "The generation model is unavailable; please retry.");
  }
  const out = { answer, citations: cites, model: MODELS.anon, query_hash: queryHash };
  if (!contextual) {
    const ck = await cacheKey(env, ns, q.query, q.lang);
    ctx.waitUntil(env.CACHE.put(ck, JSON.stringify(out), { expirationTtl: LIMITS.cacheTtlSec }));
  }
  telemetry(env, ctx, tier, "ask", model, true, answer.length, queryHash, q.lang);
  return json({ ...out, ...(exempt ? {} : { quota }), ...corsHeaders(req) });
}

function sseResponse(events: unknown[], cors: Record<string, string>): Response {
  const encoder = new TextEncoder();
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(encoder.encode(body), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      ...cors,
    },
  });
}

async function cacheKey(env: Env, ns: string, query: string, lang?: string) {
  return `a:${env.INDEX_VERSION}:${ns}:${await sha256Hex(
    `${query.toLowerCase().replace(/\s+/g, " ").trim()}|${lang ?? ""}`,
  )}`;
}

async function handleSearch(
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
  const exempt = tier === "anon" ? await isExemptIp(env, clientIp(req)) : false;
  const limit = tier === "key" || member ? Number.MAX_SAFE_INTEGER : num(env as any, "ANON_DAY_SEARCH", 50);
  const bucketId = tier === "key" ? `key:${key!.id}` : member ? `sub:${member.sub}` : clientIp(req);
  const quota = await checkQuota(env, "search", bucketId, limit);
  if (!quota.ok && !exempt) {
    return err(429, "quota_exceeded", `Daily search limit reached (${quota.limit}). Try again tomorrow.`);
  }

  const understanding = await understandQuery(env.AI, MODELS.anon, q.query, []);
  let retrieved;
  try {
    retrieved = await retrieve(env, q.query, { understanding });
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

async function handleCreateKey(env: Env, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  if (!body?.name || typeof body.name !== "string") return err(400, "invalid_input", "name is required");
  const dayLimit = Number.isFinite(Number(body.day_limit)) && Number(body.day_limit) > 0 ? Number(body.day_limit) : num(env as any, "KEY_DAY_ASK_DEFAULT", 2000);
  const raw = `oiml_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const id = crypto.randomUUID();
  const keyHash = await sha256Hex(raw);
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, day_limit, created_at, revoked) VALUES (?1,?2,?3,?4,?5,0)",
  )
    .bind(id, body.name, keyHash, dayLimit, new Date().toISOString())
    .run();
  return json({ id, name: body.name, day_limit: dayLimit, key: raw, note: "Store this key now — it is not retrievable again." });
}

async function handleListKeys(env: Env, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const rows = await env.DB.prepare(
    "SELECT id, name, day_limit, created_at, revoked FROM api_keys ORDER BY created_at DESC",
  ).all();
  return json({ keys: rows.results, ...corsHeaders(req) });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders(req);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // HTML pages are served through the worker with must-revalidate so a
    // deploy can never leave the edge serving HTML that references deleted
    // fingerprinted assets.
    if (req.method === "GET" && (path === "/" || path === "/api/" || path === "/index.html")) {
      const target = new URL(path === "/index.html" ? "/" : path, url);
      const asset = await env.ASSETS.fetch(new Request(target, { method: "GET" }));
      if (asset.status === 200) {
        return new Response(asset.body, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=0, must-revalidate",
            ...cors,
          },
        });
      }
      return err(404, "not_found", "Page not found");
    }

    if (req.method === "GET" && (path === "/auth/login" || path === "/auth/login/")) return handleLogin(env as any, req);
    if (req.method === "GET" && (path === "/auth/callback" || path === "/auth/callback/")) return handleCallback(env as any, req);
    if (req.method === "GET" && (path === "/auth/me" || path === "/auth/me/")) return handleMe(env as any, req);
    if ((req.method === "GET" || req.method === "POST") && (path === "/auth/logout" || path === "/auth/logout/")) return handleLogout(env as any, req);

    if (path === "/api/conversations" || path.startsWith("/api/conversations/")) {
      const session = await sessionFrom(req, env as any);
      if (!session) return err(401, "unauthorized", "Sign in to sync your conversations across devices");
      const parts = path.split("/").filter(Boolean); // [api, conversations, id?, messages?]
      if (parts.length === 4 && parts[3] === "messages" && req.method === "POST") {
        return handleAppendMessage(env, session.sub, req, parts[2]!);
      }
      if (parts.length > 3) return err(404, "not_found", "Unknown route");
      return handleConversations(env, session.sub, req, { method: req.method, id: parts[2] });
    }

    if (req.method === "GET" && (path === "/api/datasets" || path === "/api/datasets/")) {
      const session = await sessionFrom(req, env as any);
      const roles = session?.roles ?? [];
      const internal = roles.some((r) => INTERNAL_ROLES.includes(r));
      return json({
        datasets: [
          {
            id: "oiml",
            label: "OIML Publications",
            description: "Recommendations, Documents, Basic publications, Guides — English corpus",
            enabled: true,
          },
          {
            id: "iso",
            label: "ISO/IEC Conformity Assessment",
            description: "ISO/IEC 17xxx reference standards (CASCO) — internal, role-gated",
            enabled: internal,
            authenticated: !!session,
            requires: "mc_member, rc_member, executive_secretary or admin",
          },
        ],
      });
    }

    if (req.method === "GET" && path === "/health") {
      return json({ ok: true, service: "rag-public", index_version: env.INDEX_VERSION, ...cors });
    }

    if (req.method === "POST" && (path === "/api/ask" || path === "/v1/ask")) {
      const isApi = path.startsWith("/v1/");
      let key: ApiKey | null = null;
      if (isApi) {
        key = await authenticate(env, req);
        if (!key) return err(401, "unauthorized", "Provide a valid API key: Authorization: Bearer oiml_...");
      }
      // a valid RAG session cookie upgrades the browser tier to member
      let tier: "anon" | "key" | "member" = isApi ? "key" : "anon";
      if (!isApi && env.SESSION_SECRET && (await sessionFrom(req, env as any))) tier = "member";
      return handleAsk(env, ctx, req, tier, key);
    }

    if (req.method === "POST" && (path === "/api/search" || path === "/v1/search")) {
      const isApi = path.startsWith("/v1/");
      let key: ApiKey | null = null;
      if (isApi) {
        key = await authenticate(env, req);
        if (!key) return err(401, "unauthorized", "Provide a valid API key: Authorization: Bearer oiml_...");
      }
      let stier: "anon" | "key" | "member" = isApi ? "key" : "anon";
      if (!isApi && env.SESSION_SECRET && (await sessionFrom(req, env as any))) stier = "member";
      return handleSearch(env, ctx, req, stier, key);
    }

    if (req.method === "POST" && path === "/api/feedback") {
      const body = await readJson(req);
      const queryHash = typeof body?.query_hash === "string" ? body.query_hash : "";
      const rating = Number(body?.rating);
      if (!/^[a-f0-9]{64}$/.test(queryHash) || ![1, -1].includes(rating)) {
        return err(400, "invalid_input", "query_hash and rating (1 or -1) are required");
      }
      await env.DB.prepare("INSERT INTO feedback (query_hash, rating, ts) VALUES (?1,?2,?3)")
        .bind(queryHash, rating, new Date().toISOString())
        .run();
      return json({ ok: true, ...cors });
    }

    if (req.method === "POST" && path === "/v1/admin/keys") return handleCreateKey(env, req);
    if (req.method === "GET" && path === "/v1/admin/keys") return handleListKeys(env, req);

    return err(404, "not_found", "Unknown route");
  },
};
