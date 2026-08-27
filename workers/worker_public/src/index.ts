import { LIMITS, MODELS, datasetsFor, SUGGESTIONS, num, sha256Hex, today } from "./config";
import { buildMessages, citations, retrieve, retrievalQuery, identityNote, splitHistory, listwiseRerank, REFUSAL_ANSWER, Hit } from "./pipeline";
import { handleCallback, handleLogin, handleLogout, handleMe, sessionFrom } from "./auth";
import { handleAppendMessage, handleConversations } from "./conversations";
import { handleShareConversation, handleGetShared } from "./share";
import { retrieveInternal } from "./internal_gateway";
import { understandQuery } from "./understand";
import { gradeRetrieval } from "./grader";
import summarizePrompt from "../prompts/summarize.md";
import relevancyPrompt from "../prompts/relevancy.md";
import precisionPrompt from "../prompts/precision.md";
import { embed } from "./ai";
import { scoreFaithfulness } from "./faithfulness";
import enrichmentPrompt from "../prompts/enrichment.md";
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
  ENRICH_MODEL?: string;
  EXEMPT_IPS?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  SESSION_SECRET?: string;
  INTERNAL_SERVICE?: { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> };
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

// the model occasionally paraphrases the refusal sentence ("...information
// on how to make lasagna in the indexed..."); the API contract is the
// exact canonical sentence — normalize variants, keep the redirect tail
const REFUSAL_VARIANT = /^\s*I don[’']?t have information on .{1,120}? in the indexed OIML publications\.?/i;
function canonicalRefusal(answer: string): string {
  if (answer.includes(REFUSAL_ANSWER)) return answer;
  const m = answer.match(REFUSAL_VARIANT);
  return m ? answer.replace(m[0], REFUSAL_ANSWER) : answer;
}

/** Start an embed call without awaiting failures — null result means the
 *  caller simply embeds fresh. */
function embedWarm(env: Env, text: string): Promise<number[] | null> {
  return embed(env.AI, MODELS.embed, text).catch(() => null);
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

/** Compact overflow history into a short continuity summary. Null = keep
 *  nothing (degrades to plain truncation, never to failure). */
async function summarizeHistory(
  env: Env,
  model: string,
  turns: Array<{ role: string; content: string }>,
): Promise<string | null> {
  try {
    const convo = turns
      .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 1200)}`)
      .join("\n")
      .slice(0, 24000);
    const res: any = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content: summarizePrompt.trimEnd(),
        },
        { role: "user", content: convo },
      ],
      max_tokens: 900,
      reasoning_effort: "low",
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 1200) : null;
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

  // Members get federated retrieval (OIML + ISO/IEC) merged into the same
  // pipeline via the service binding; rag-public never touches the
  // internal index itself, and generation/rerank stay in ONE pipeline.
  const service = env.INTERNAL_SERVICE;
  const cookie = req.headers.get("cookie") ?? "";
  const federate = member && service
    ? (q2: string) => retrieveInternal(service, cookie, q2)
    : undefined;

  const ns = tier === "key" ? `k:${key!.id}` : member ? `m:${member.sub}` : "anon";
  const model = member ? MODELS.member : MODELS.anon;
  const prev = typeof body?.prev === "string" ? body.prev.slice(0, 800) : undefined;
  const rawHistory = Array.isArray(body?.history) ? body.history : [];
  const history = rawHistory
    .filter((h: any) => (h?.role === "user" || h?.role === "assistant") && typeof h?.content === "string" && h.content.trim())
    .slice(-24)
    .map((h: any) => ({ role: h.role, content: h.content.slice(0, 4000) }));
  const contextual = history.length > 0;
  // history compaction: turns beyond the budget slice are summarized into a
  // continuity block (below) instead of silently dropped
  const budget = num(env as any, "INPUT_TOKEN_BUDGET", LIMITS.inputTokenBudget);
  const { kept: keptHistory, overflow } = splitHistory(history, budget);
  const summary = overflow.length >= 2 ? ((await summarizeHistory(env.AI, MODELS.anon, overflow)) ?? undefined) : undefined;
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

  // warm the folded-query embedding concurrently with understanding —
  // retrieval reuses it when the understanding leaves the query as-is
  const warmQuery = retrievalQuery(q.query, prev);
  const warmEmbed = embedWarm(env, warmQuery);
  const understanding = cached ? null : await understandQuery(env.AI, MODELS.anon, q.query, history);
  console.log("understand:", understanding?.intent ?? "null", understanding?.doc_number ? `doc#${understanding.doc_number}${understanding.edition ? "@" + understanding.edition : ""}` : "nodoc", "|", q.query.slice(0, 50));
  const graphDocNumbers = await graphExpand(env, understanding);

  // Conversational route, decided by query UNDERSTANDING (any language, any
  // phrasing) — not string matching. No retrieval: nothing in the corpus
  // answers "who are you". The model speaks for itself from the service
  // facts in identityNote (composed from the DATASETS catalog).
  if (understanding?.intent === "conversational") {
    const queryHash = await sha256Hex(q.query);
    const messages = [
      { role: "system", content: identityNote(!!member) },
      ...(summary ? [{ role: "system", content: `Earlier in this conversation (summarized for continuity):\n${summary}` }] : []),
      ...keptHistory.slice(-6),
      { role: "user", content: q.query },
    ];
    if (wantsStream) {
      const stream = await generateStream(env, model, messages);
      if (stream) {
        const encoder = new TextEncoder();
        const sse = new ReadableStream({
          async start(controller) {
            const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            send({ type: "citations", citations: [], ...(exempt ? {} : { quota }) });
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
            controller.close();
          },
        });
        return new Response(sse, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...corsHeaders(req) },
        });
      }
    }
    let answer = await generateOnce(env, model, messages);
    if (answer === null && model !== MODELS.anon) answer = await generateOnce(env, MODELS.anon, messages);
    if (answer === null) {
      telemetry(env, ctx, tier, "ask", model, false, 0, queryHash, q.lang);
      return err(502, "generation_failed", "The generation model is unavailable; please retry.");
    }
    telemetry(env, ctx, tier, "ask", model, true, answer.length, queryHash, q.lang);
    return json({ answer, citations: [], model, query_hash: queryHash, follow_ups: [], ...(exempt ? {} : { quota }) });
  }

  try {
    retrieved = await retrieve(env, q.query, { prev, understanding, federate, warmEmbed, graphDocNumbers });
    // cascade final tier: joint listwise reordering for hard/member
    // queries (cross-encoder already pruned; this orders the survivors)
    if (retrieved.hits.length >= 4 && (member || understanding?.complexity === "complex")) {
      const reordered = await listwiseRerank(env, MODELS.listwise, understanding?.standalone_query || q.query, retrieved.hits);
      if (reordered) {
        console.log("listwise: reordered", reordered[0]?.metadata?.docidentifier ?? "?", "to top");
        retrieved = { hits: reordered, filters: retrieved.filters };
      }
    }
    // CRAG: grade the passages; a weak grade earns ONE corrective
    // re-retrieval with the document identifier made explicit
    const grade = await gradeRetrieval(env.AI, MODELS.grader, q.query, retrieved.hits.map((h: Hit) => h.text));
    console.log("grade:", grade);
    if (grade === "weak" && understanding?.docidentifier) {
      const broaden = `${understanding.standalone_query || q.query} ${understanding.docidentifier}`.trim();
      const second = await retrieve(env, q.query, { prev, understanding, queryOverride: broaden, federate });
      const grade2 = await gradeRetrieval(env.AI, MODELS.grader, q.query, second.hits.map((h: Hit) => h.text));
      if (grade2 === "good") retrieved = second; // corrective retry must be strictly better
    }
  } catch {
    telemetry(env, ctx, tier, "ask", MODELS.embed, false, 0, await sha256Hex(q.query), q.lang);
    return err(503, "retrieval_unavailable", "Search is briefly busy — please retry in a moment.");
  }
  const { hits } = retrieved;
  if (hits.length === 0) {
    const answer = REFUSAL_ANSWER;
    const out = { answer, citations: [], model, query_hash: await sha256Hex(q.query) };
    telemetry(env, ctx, tier, "ask", model, true, answer.length, out.query_hash, q.lang);
    return json({ ...out, ...(exempt ? {} : { quota }) });
  }

  const { messages, usedHits } = buildMessages(
    q.query,
    hits,
    q.lang,
    keptHistory,
    understanding?.process_intent
      ? "Retrieval note: these passages come from the OIML Certification System documents because they govern certification/application procedures for OIML publications."
      : undefined,
    summary,
    budget,
  );
  const queryHash = await sha256Hex(q.query);
  const cites = citations(usedHits);

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
          send({ type: "done", model, query_hash: queryHash, follow_ups: understanding?.follow_ups ?? [] });
          telemetry(env, ctx, tier, "ask", model, true, full.length, queryHash, q.lang);
          const canonical = canonicalRefusal(full);
          if (canonical.length > 0 && !contextual && !canonical.includes(REFUSAL_ANSWER)) {
            ctx.waitUntil(
              env.CACHE.put(await cacheKey(env, ns, q.query, q.lang), JSON.stringify({ answer: canonical, citations: cites, model, query_hash: queryHash }), { expirationTtl: LIMITS.cacheTtlSec }),
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
  if (answer === null && model !== MODELS.anon) {
    answer = await generateOnce(env, MODELS.anon, messages);
  }

  // ── Self-RAG reflection loop ──
  // The model critiques its own answer; if claims are ungrounded, retry
  // retrieval with the missing-info hint (max one retry).
  // Ref: selfrag.github.io; arXiv 2606.05658 bounded reflection
  if (answer) answer = canonicalRefusal(answer);
  if (answer && !answer.includes(REFUSAL_ANSWER)) {
    const reflection = await reflect(env.AI, MODELS.grader, q.query, answer, hits.map((h: Hit) => h.text));
    console.log("reflection:", reflection ? (reflection.grounded ? "grounded" : "ungrounded") : "null");
    if (reflection && !reflection.grounded && reflection.missing_info) {
      // re-retrieve targeting what was missing
      const retryRetrieve = await retrieve(env, q.query, {
        prev,
        understanding: { ...understanding, standalone_query: `${understanding?.standalone_query || q.query} ${reflection.missing_info}` } as any,
      });
      if (retryRetrieve.hits.length > 0) {
        const { messages: retryMessages } = buildMessages(q.query, retryRetrieve.hits, q.lang, keptHistory, undefined, summary, budget);
        const retryAnswer = await generateOnce(env, model, retryMessages);
        if (retryAnswer) answer = retryAnswer; // better-grounded answer wins
      }
    }
  }

  if (answer === null) {
    telemetry(env, ctx, tier, "ask", model, false, 0, queryHash, q.lang);
    return err(502, "generation_failed", "The generation model is unavailable; please retry.");
  }
  const out = { answer, citations: cites, model: MODELS.anon, query_hash: queryHash, follow_ups: understanding?.follow_ups ?? [] };
  if (!contextual && !answer.includes(REFUSAL_ANSWER)) {
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


/** Contextual enrichment (quality-first lane): for each chunk, write a
 *  situating context (KV-cached per chunk id), embed context+text, and
 *  upsert in place — the enrichment persists into every future retrieval
 *  of that chunk. Driven by ingest/enrich.py in resumable batches. */
async function handleEnrich(env: Env, ctx: ExecutionContext, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const chunks = Array.isArray(body?.chunks) ? body.chunks : [];
  if (chunks.length === 0 || chunks.length > 8) return err(400, "invalid_input", "chunks: 1-8 required");
  const force = body?.force === true;
  const model = typeof env.ENRICH_MODEL === "string" && env.ENRICH_MODEL ? env.ENRICH_MODEL : MODELS.enrich;

  const usage = { prompt_tokens: 0, completion_tokens: 0, requests: 0, cache_hits: 0 };
  const results = await Promise.all(
    chunks.map(async (c: any) => {
      if (!c?.id || typeof c?.text !== "string" || !c?.metadata) return { id: c?.id ?? null, ok: false, error: "invalid chunk" };
      try {
        const cacheKey = `e:${c.id}`;
        let context = force ? null : await env.CACHE.get(cacheKey);
        const cached = !!context;
        if (!context) {
          const m = c.metadata;
          const head = `${m.docidentifier ?? m.doc_id}${m.clause_anchor ? " §" + m.clause_anchor : ""}${m.clause_title ? " — " + m.clause_title : ""}`;
          const res: any = await env.AI.run(model, {
            messages: [
              { role: "system", content: enrichmentPrompt.trimEnd() },
              { role: "user", content: `${head}\n\n${c.text.slice(0, 1500)}` },
            ],
            max_tokens: 1600,
            reasoning_effort: "low",
          });
          const raw = typeof res?.response === "string" && res.response.trim()
            ? res.response
            : res?.choices?.[0]?.message?.content;
          context = typeof raw === "string" ? raw.trim().replace(/^["\']|[\"']$/g, "").slice(0, 400) : "";
          if (!context) {
            console.log("enrich raw keys:", Object.keys(res ?? {}), "sample:", JSON.stringify(res).slice(0, 300));
            return { id: c.id, ok: false, error: "empty enrichment" };
          }
          if (res?.usage) {
            usage.prompt_tokens += Number(res.usage.prompt_tokens ?? 0);
            usage.completion_tokens += Number(res.usage.completion_tokens ?? 0);
          }
          usage.requests += 1;
          ctx.waitUntil(env.CACHE.put(cacheKey, context, { expirationTtl: 2_592_000 }));
        } else {
          usage.cache_hits += 1;
        }
        const original = typeof c.metadata.chunk_text === "string" && c.metadata.chunk_text ? c.metadata.chunk_text : c.text;
        const enriched = `${context}\n\n${original}`;
        const vector = await embed(env.AI, MODELS.embed, enriched.slice(0, 6000));
        await env.VECTORIZE.upsert([{ id: c.id, values: vector, metadata: { ...c.metadata, chunk_text: enriched, ctx: "1" } }]);
        return { id: c.id, ok: true, cached, context };
      } catch (e: any) {
        return { id: c.id, ok: false, error: String(e?.message ?? e).slice(0, 200) };
      }
    }),
  );
  const ok = results.filter((r: any) => r.ok).length;
  console.log("enrich:", ok, "/", results.length, "usage:", JSON.stringify(usage));
  if (usage.requests > 0) {
    // ledger: enrichment spend shows up in /v1/admin/stats like serving
    ctx.waitUntil(
      env.DB.prepare(
        "INSERT INTO spend (day, tier, model, requests) VALUES (?1,'enrich',?2,?3) ON CONFLICT(day, tier, model) DO UPDATE SET requests = requests + ?3",
      )
        .bind(today(), model, usage.requests)
        .run(),
    );
  }
  return json({ results, usage });
}


/** RAGAS-style metric battery (G13): judge an (question, answer, passages)
 *  triple — faithfulness, answer relevancy, context precision. Driven by
 *  tests/eval-suite.mjs; prompts are data; refuses nothing, judges only. */
async function scoreJudge(
  ai: any,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<number | null> {
  try {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 8000));
    const call = (async () => {
      const res: any = await ai.run(model, {
        messages: [
          { role: "system", content: systemPrompt.trimEnd() },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 900,
        reasoning_effort: "low",
      });
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
      const m = (text ?? "").match(/\{[\s\S]*?\}/);
      if (!m) return null;
      const score = JSON.parse(m[0]).score;
      return typeof score === "number" ? Math.max(0, Math.min(1, score)) : null;
    })();
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  }
}

async function handleJudge(env: Env, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const question = typeof body?.question === "string" ? body.question.slice(0, 2000) : "";
  const answer = typeof body?.answer === "string" ? body.answer.slice(0, 4000) : "";
  const passages = Array.isArray(body?.passages)
    ? body.passages.filter((p: unknown) => typeof p === "string").map((p: string) => p.slice(0, 600)).slice(0, 8)
    : [];
  if (!question || !answer) return err(400, "invalid_input", "question and answer required");

  const passagesText = passages.map((p: string, i: number) => `[${i + 1}] ${p}`).join("\n");
  const [faith, relevancy, precision] = await Promise.all([
    passages.length ? scoreFaithfulness(env.AI, MODELS.grader, answer, passages) : Promise.resolve(null),
    scoreJudge(env.AI, MODELS.grader, relevancyPrompt, `Question: ${question}\n\nAnswer:\n${answer}`),
    passages.length ? scoreJudge(env.AI, MODELS.grader, precisionPrompt, `Question: ${question}\n\nPassages:\n${passagesText}`) : Promise.resolve(null),
  ]);
  return json({
    question_hash: await sha256Hex(question),
    faithfulness: faith ? faith.score : null,
    answer_relevancy: relevancy,
    context_precision: precision,
  });
}


/** Graph expansion (G8 query lane): map understanding's term / named
 *  document onto the D1 projection (graph_nodes / graph_edges) and return
 *  the doc_numbers the graph says are relevant. Mirrors graph.py's node-id
 *  format (doc:OIML-R-60-1-2017, concept:<id>). */
function docNumberOf(nodeId: string): string | null {
  // doc:OIML-R-60-1-2017 → "60" | doc:OIML-B-18-2025 → "18"
  const m = nodeId.match(/^doc:OIML-[A-Z]-(\d+)-/);
  return m ? m[1] : null;
}

async function graphExpand(env: Env, u: { term?: string | null; defined_terms?: string[]; docidentifier?: string | null } | null): Promise<string[] | undefined> {
  if (!env.DB || !u) return undefined;
  const numbers = new Set<string>();
  const terms = [...(u.defined_terms ?? []), ...(u.term ? [u.term] : [])].filter((t) => t.length >= 3);
  try {
    for (const term of terms.slice(0, 4)) {
      const rows = await env.DB.prepare(
        "SELECT e.src AS doc FROM graph_edges e JOIN graph_nodes c ON e.dst = c.id WHERE e.kind = 'defines' AND c.kind = 'concept' AND (c.label = ?1 OR c.label LIKE ?2) LIMIT 12",
      )
        .bind(term, `%${term}%`)
        .all<{ doc: string }>();
      for (const r of rows.results ?? []) {
        const n = docNumberOf(r.doc);
        if (n) numbers.add(n);
      }
    }
    // NOTE: the docidentifier branch is deliberately absent — a named
    // document already gets the exact doc_number filter; merging its
    // annex/variant neighbors only pollutes doc-level queries. The graph
    // lane exists for VOCABULARY MISMATCH (everyday words → defined term
    // → defining documents), which no filter can express.
  } catch {
    return numbers.size ? [...numbers] : undefined;
  }
  console.log("graphExpand: terms", JSON.stringify(terms), "→", JSON.stringify([...numbers]));
  return numbers.size ? [...numbers].slice(0, 6) : undefined;
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
      return json({ datasets: datasetsFor(session), suggestions: SUGGESTIONS });
    }

    if (req.method === "GET" && (path === "/v1/admin/stats" || path === "/v1/admin/stats/")) {
      if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
      const [byDay, byModel, feedback, convCount] = await Promise.all([
        env.DB.prepare("SELECT day, tier, COUNT(*) as n, SUM(ok) as ok FROM queries WHERE day >= date('now','-7 days') GROUP BY day, tier ORDER BY day DESC").all(),
        env.DB.prepare("SELECT model, SUM(requests) as requests FROM spend WHERE day >= date('now','-7 days') GROUP BY model ORDER BY requests DESC").all(),
        env.DB.prepare("SELECT rating, COUNT(*) as n FROM feedback GROUP BY rating").all(),
        env.DB.prepare("SELECT COUNT(*) as n FROM conversations").first(),
      ]);
      const totalQueries = (byDay.results as any[]).reduce((a, r) => a + (r.n || 0), 0) || 0;
      const totalOk = (byDay.results as any[]).reduce((a, r) => a + (r.ok_count || 0), 0) || 0;
      const errorRate = totalQueries > 0 ? (((totalQueries - totalOk) / totalQueries) * 100).toFixed(1) : "0";
      ctx.waitUntil(env.DB.batch([
        env.DB.prepare("DELETE FROM queries WHERE day < date('now','-90 days')"),
        env.DB.prepare("DELETE FROM spend WHERE day < date('now','-90 days')"),
        env.DB.prepare("DELETE FROM feedback WHERE ts < datetime('now','-90 days')"),
      ]));
      return json({
        window: "7 days",
        queries_by_day: byDay.results,
        spend_by_model: byModel.results,
        feedback: feedback.results,
        conversations: (convCount as any)?.n ?? 0,
        error_rate_pct: errorRate,
        index_version: env.INDEX_VERSION,
        pruned: "telemetry >90d",
      }, 200, corsHeaders(req));
    }

    if (req.method === "POST" && path.startsWith("/api/conversations/") && path.endsWith("/share")) {
      const session = await sessionFrom(req, env as any);
      if (!session) return err(401, "unauthorized", "Sign in to share conversations");
      const parts = path.split("/").filter(Boolean);
      const convId = parts[2];
      const conv = await env.DB.prepare("SELECT id, sub, title FROM conversations WHERE id = ?1 AND sub = ?2").bind(convId, session.sub).first();
      if (!conv) return err(404, "not_found", "No such conversation");
      const msgs = await env.DB.prepare("SELECT role, content, citations, model FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC").bind(convId).all();
      return handleShareConversation(env, session.sub, (conv as any).title, msgs.results ?? []);
    }

    if (req.method === "GET" && path.startsWith("/api/shared/")) {
      const slug = path.split("/").filter(Boolean)[2] ?? "";
      return handleGetShared(env, slug);
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

    if (req.method === "POST" && (path === "/admin/enrich" || path === "/v1/admin/enrich")) return handleEnrich(env, ctx, req);
    if (req.method === "POST" && (path === "/admin/judge" || path === "/v1/admin/judge")) return handleJudge(env, req);
    if (req.method === "POST" && path === "/v1/admin/keys") return handleCreateKey(env, req);
    if (req.method === "GET" && path === "/v1/admin/keys") return handleListKeys(env, req);

    return err(404, "not_found", "Unknown route");
  },
};
