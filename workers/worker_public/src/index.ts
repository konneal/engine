import { LIMITS, MODELS, num, sha256Hex, today } from "./config";
import { buildMessages, citations, retrieve, Hit } from "./pipeline";

export interface Env {
  AI: any;
  VECTORIZE: any;
  CACHE: KVNamespace;
  DB: D1Database;
  INDEX_VERSION: string;
  ANON_DAY_ASK: string;
  ANON_DAY_SEARCH: string;
  KEY_DAY_ASK_DEFAULT: string;
  ANON_DAY_HARD_CAP: string;
  ADMIN_TOKEN?: string;
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

async function generateStream(env: Env, messages: any[]): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const res: any = await env.AI.run(MODELS.anon, {
      messages,
      stream: true,
      max_tokens: LIMITS.maxOutputTokens,
    });
    if (res && typeof res.getReader === "function") return res as ReadableStream<Uint8Array>;
    if (res && res.body && typeof res.body.getReader === "function") return res.body;
    return null;
  } catch {
    return null;
  }
}

async function generateOnce(env: Env, messages: any[]): Promise<string | null> {
  try {
    const res: any = await env.AI.run(MODELS.anon, {
      messages,
      max_tokens: LIMITS.maxOutputTokens,
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
  tier: "anon" | "key",
  key: ApiKey | null,
): Promise<Response> {
  const body = await readJson(req);
  const q = validateQuery(body);
  if (!q) return err(400, "invalid_input", `query is required (1-${LIMITS.maxInputChars} chars)`);

  const limit = tier === "key" ? key!.day_limit : num(env as any, "ANON_DAY_ASK", 20);
  const bucketId = tier === "key" ? `key:${key!.id}` : clientIp(req);
  const quota = await checkQuota(env, "ask", bucketId, limit);
  if (!quota.ok) {
    return err(429, "quota_exceeded", `Daily question limit reached (${quota.limit}). Try again tomorrow.`);
  }

  const hardCap = num(env as any, "ANON_DAY_HARD_CAP", 5000);
  if (tier === "anon" && quota.used > hardCap) {
    return err(503, "generation_disabled", "Generation is temporarily paused; search remains available.");
  }
  if ((await env.CACHE.get("sys:generation")) === "off") {
    return err(503, "generation_disabled", "Generation is temporarily paused; search remains available.");
  }

  const ns = tier === "key" ? `k:${key!.id}` : "anon";
  const cached = await cacheGet(env, ns, q.query, q.lang);
  if (cached) {
    telemetry(env, ctx, tier, "ask", null, true, (cached.value.answer ?? "").length, cached.value.query_hash, q.lang);
    return json({ ...cached.value, cached: true, quota });
  }

  const { hits } = await retrieve(env, q.query);
  if (hits.length === 0) {
    const answer = "I don't have information on this in the indexed OIML publications.";
    const out = { answer, citations: [], model: MODELS.anon, query_hash: await sha256Hex(q.query) };
    telemetry(env, ctx, tier, "ask", MODELS.anon, true, answer.length, out.query_hash, q.lang);
    return json({ ...out, quota });
  }

  const messages = buildMessages(q.query, hits, q.lang);
  const queryHash = await sha256Hex(q.query);
  const cites = citations(hits);
  const wantsStream = body?.stream === true || (tier === "anon" && body?.stream !== false);

  if (wantsStream) {
    const stream = await generateStream(env, messages);
    if (stream) {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          send({ type: "citations", citations: cites, quota });
          let full = "";
          try {
            for await (const tok of sseTokens(stream)) {
              full += tok;
              send({ type: "token", v: tok });
            }
          } catch {
            // stream ended prematurely — deliver what we have
          }
          send({ type: "done", model: MODELS.anon, query_hash: queryHash });
          telemetry(env, ctx, tier, "ask", MODELS.anon, true, full.length, queryHash, q.lang);
          if (full.length > 0) {
            ctx.waitUntil(
              env.CACHE.put(await cacheKey(env, ns, q.query, q.lang), JSON.stringify({ answer: full, citations: cites, model: MODELS.anon, query_hash: queryHash }), { expirationTtl: LIMITS.cacheTtlSec }),
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

  const answer = await generateOnce(env, messages);
  if (answer === null) {
    telemetry(env, ctx, tier, "ask", MODELS.anon, false, 0, queryHash, q.lang);
    return err(502, "generation_failed", "The generation model is unavailable; please retry.");
  }
  const out = { answer, citations: cites, model: MODELS.anon, query_hash: queryHash };
  const ck = await cacheKey(env, ns, q.query, q.lang);
  ctx.waitUntil(env.CACHE.put(ck, JSON.stringify(out), { expirationTtl: LIMITS.cacheTtlSec }));
  telemetry(env, ctx, tier, "ask", MODELS.anon, true, answer.length, queryHash, q.lang);
  return json({ ...out, quota, ...corsHeaders(req) });
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
  tier: "anon" | "key",
  key: ApiKey | null,
): Promise<Response> {
  const body = await readJson(req);
  const q = validateQuery(body);
  if (!q) return err(400, "invalid_input", `query is required (1-${LIMITS.maxInputChars} chars)`);

  const limit = tier === "key" ? Number.MAX_SAFE_INTEGER : num(env as any, "ANON_DAY_SEARCH", 50);
  const bucketId = tier === "key" ? `key:${key!.id}` : clientIp(req);
  const quota = await checkQuota(env, "search", bucketId, limit);
  if (!quota.ok) {
    return err(429, "quota_exceeded", `Daily search limit reached (${quota.limit}). Try again tomorrow.`);
  }

  const { hits, filters } = await retrieve(env, q.query);
  const results = hits.map((h: Hit) => ({
    doc_id: h.metadata.doc_id,
    docidentifier: h.metadata.docidentifier,
    edition: h.metadata.edition,
    language: h.metadata.language,
    clause_anchor: h.metadata.clause_anchor,
    clause_title: h.metadata.clause_title,
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
      return handleAsk(env, ctx, req, isApi ? "key" : "anon", key);
    }

    if (req.method === "POST" && (path === "/api/search" || path === "/v1/search")) {
      const isApi = path.startsWith("/v1/");
      let key: ApiKey | null = null;
      if (isApi) {
        key = await authenticate(env, req);
        if (!key) return err(401, "unauthorized", "Provide a valid API key: Authorization: Bearer oiml_...");
      }
      return handleSearch(env, ctx, req, isApi ? "key" : "anon", key);
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
