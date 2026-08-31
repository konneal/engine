import { LIMITS, MODELS, datasetsFor, SUGGESTIONS, num, sha256Hex, today, roleModel } from "./config";
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
import researchPromptText from "../prompts/research.md";
import { checkQuoteAnchors, ANCHOR_CORRECTION_NOTE } from "./anchors";
import { contractV2, tableRetyped } from "./refs";
import { NO_CONTEXT, appliedContext, contextNote, namedDocumentIn, parseContext, resolveDocScope, syntheticUnderstanding } from "./context";

export interface Env {
  AI: any;
  VECTORIZE: any;
  CACHE: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  INDEX_VERSION: string;
  UNIT_ASSETS: R2Bucket;
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
    origin === "https://oimlsmart.org" ||
    /^https:\/\/[a-z0-9-]+\.oimlsmart\.org$/.test(origin) ||
    // the local dev posture: the platform and the minisites develop on
    // localhost ports against the live service (the bubble bridge admits
    // the same class; anon quota is per-IP, member auth needs the token)
    /^http:\/\/localhost(:\d{1,5})?$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1(:\d{1,5})?$/.test(origin);
  return allowed
    ? {
        "access-control-allow-origin": origin,
        // PATCH + DELETE: the conversations API speaks them (rename,
        // delete) — the embedded panel preflights cross-origin.
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      }
    : {};
}

/** CORS-complete a handler's response: the browser surface grew
 *  piecemeal (the SSE ask paths carried the headers; the JSON + error
 *  paths and the conversations API did not), which an embedded
 *  cross-origin client reads as opaque network failures. One wrap at
 *  the router keeps every browser-facing answer readable. */
function withCors(res: Response, cors: Record<string, string>): Response {
  if (!cors["access-control-allow-origin"]) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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

/** User-uploaded image for multimodal questions: a data URL
 *  (data:image/(png|jpeg|webp|gif);base64,…) up to 6 MB of payload. The
 *  question text still drives retrieval; the image is CONTEXT for the
 *  answer model (photo of a nameplate, a schematic, a scale dial). Null =
 *  no image; undefined-but-present-invalid throws at the boundary. */
function userImageDataUrl(body: any): string | null {
  const img = body?.image;
  if (img == null) return null;
  if (typeof img !== "string" || img.length > 6_000_000) return null;
  const m = img.match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !m[2]) return null;
  return img;
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

/** GLM-5.3-Flash is natively multimodal: when the used passages contain
 *  figure units with uploaded assets, attach the actual pixels to the
 *  generation call so the model interprets the producer's figure, not
 *  just its stored caption. Additive — failures simply send no images. */
async function attachFigureImages(env: Env, messages: { role: string; content: string }[], usedHits: Hit[]): Promise<void> {
  const figures = usedHits.filter((h) => h.metadata.unit_id && h.metadata.block === "figure").slice(0, 2);
  if (!figures.length) return;
  const parts: unknown[] = [];
  const names: string[] = [];
  for (const h of figures) {
    try {
      const row = await env.DB.prepare("SELECT payload FROM unit_payloads WHERE unit_id = ?1").bind(h.metadata.unit_id!).first<any>();
      const uri = row ? (JSON.parse(String(row.payload)).uri ?? "") : "";
      const m = typeof uri === "string" ? uri.match(/^\/assets\/(.+)/) : null;
      if (!m) continue;
      const obj = await env.UNIT_ASSETS.get(m[1]);
      if (!obj) continue;
      const buf = new Uint8Array(await obj.arrayBuffer());
      const ext = m[1].split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
      let binary = "";
      for (let i = 0; i < buf.length; i += 8192) binary += String.fromCharCode(...buf.subarray(i, i + 8192));
      parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${btoa(binary)}` } });
      names.push(h.metadata.unit_id!);
    } catch {
      // additive — one unreadable asset never blocks the answer
    }
  }
  if (!parts.length) return;
  const last = messages[messages.length - 1];
  last.content = [
    { type: "text", text: `${last.content}\n\nThe original images of figure units ${names.join(", ")} are attached; interpret them directly when answering about these figures.` },
    ...parts,
  ] as unknown as string;
  console.log("figure images attached:", names.join(", "));
}

async function generateStream(env: Env, model: string, messages: any[]): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const res: any = await env.AI.run(model, {
      messages,
      stream: true,
      max_tokens: LIMITS.maxOutputTokens,
      reasoning_effort: "low",
      temperature: 0.6,
      top_p: 0.95,
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
      temperature: 0.6,
      top_p: 0.95,
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
      max_tokens: 2048,
      reasoning_effort: "low",
      // Qwen3 thinking-mode sampling (model card) — prevents the
      // repetition loops that eat the budget before the summary lands
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
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

  // The declared context (TODO.ai-platform/02): the panel's opt-in chips.
  // A declared context makes the answer depend on MORE than the query, so
  // it bypasses both answer caches (read AND write) exactly as a
  // contextual (history-carrying) turn does.
  const declaredCtx = parseContext(body);

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
  const fedAuth = {
    cookie: req.headers.get("cookie") ?? "",
    authorization: req.headers.get("authorization") ?? "",
  };
  const federate = member && service
    ? (q2: string) => retrieveInternal(service, fedAuth, q2)
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
  // user-uploaded image: present-but-invalid is a boundary error (silent
  // drop would answer a DIFFERENT question than the one the user asked)
  const userImage = body?.image != null ? userImageDataUrl(body) : null;
  if (body?.image != null && !userImage) {
    return err(400, "invalid_image", "image must be a data URL (data:image/png|jpeg|webp|gif;base64,…) up to 6 MB");
  }
  // history compaction: turns beyond the budget slice are summarized into a
  // continuity block (below) instead of silently dropped
  const budget = num(env as any, "INPUT_TOKEN_BUDGET", LIMITS.inputTokenBudget);
  const { kept: keptHistory, overflow } = splitHistory(history, budget);
  const summary = overflow.length >= 2 ? ((await summarizeHistory(env.AI, MODELS.understand, overflow)) ?? undefined) : undefined;
  let retrieved;
  // fresh=true (regenerate) skips the cache read; contextual follow-ups and
  // fresh=true (regenerate) skips the cache read; contextual follow-ups,
  // declared-context asks and image asks skip the cache entirely — the
  // answer depends on the conversation / declared context / image, not
  // the query text alone
  const cached = body?.fresh === true || contextual || declaredCtx || userImage ? null : await cacheGet(env, ns, q.query, q.lang);
  const wantsStream = body?.stream === true || (tier === "anon" && body?.stream !== false);

  if (cached) {
    telemetry(env, ctx, tier, "ask", null, true, (cached.value.answer ?? "").length, cached.value.query_hash, q.lang);
    if (wantsStream) {
      // a cache hit must still speak SSE — the chat client parses a stream
      return sseResponse([{ type: "citations", citations: cached.value.citations ?? [], quota, context_applied: NO_CONTEXT }, { type: "token", v: cached.value.answer ?? "" }, { type: "done", model: cached.value.model ?? MODELS.member, query_hash: cached.value.query_hash, context_applied: NO_CONTEXT }], corsHeaders(req));
    }
    return json({ ...cached.value, cached: true, quota, context_applied: NO_CONTEXT });
  }

  // warm the folded-query embedding concurrently with understanding —
  // retrieval reuses it when the understanding leaves the query as-is
  const warmQuery = retrievalQuery(q.query, prev);
  const warmEmbed = embedWarm(env, warmQuery);
  // cross-turn entity memory: resolved entities for this conversation
  // (present when the client passes conversation_id) make pronoun
  // follow-ups O(1) — "it / the 2017 one" resolve against the map
  const conversationId = typeof body?.conversation_id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.conversation_id) ? body.conversation_id : null;
  let convEntities: Array<{ entity: string; kind: string }> = [];
  if (conversationId) {
    try {
      const rows = await env.DB.prepare("SELECT entity, kind FROM conversation_entities WHERE conversation_id = ?1 LIMIT 12").bind(conversationId).all();
      convEntities = (rows.results ?? []) as any;
      if (convEntities.length) console.log("entity map:", convEntities.length, "entries");
    } catch {
      /* memory is additive */
    }
  }
  // ── fast path: standalone (non-contextual) near-duplicate of a recently
  // answered question — serve from the semantic cache WITHOUT paying the
  // understanding call. Contextual turns and declared-context asks never
  // take this path (they always run understanding + live retrieval);
  // fresh=true already bypassed the exact cache above.
  let understanding: any = null;
  if (!cached && !contextual && !declaredCtx && !q.lang && !userImage && body?.fresh !== true) {
    const wv0 = (await warmEmbed) ?? null;
    if (wv0) {
      const sc0 = await semanticCacheGet(env, wv0);
      if (sc0) {
        console.log("semantic cache hit (pre-understanding)");
        telemetry(env, ctx, tier, "ask", null, true, sc0.answer.length, sc0.query_hash, q.lang);
        if (wantsStream) {
          return sseResponse([{ type: "citations", citations: sc0.citations ?? [], context_applied: NO_CONTEXT }, { type: "token", v: sc0.answer }, { type: "done", model: sc0.model, query_hash: sc0.query_hash, similar: true, context_applied: NO_CONTEXT }], corsHeaders(req));
        }
        return json({ ...sc0, similar: true, context_applied: NO_CONTEXT, ...(exempt ? {} : { quota }) });
      }
    }
  }
  // ── Option C: optimistic parallel retrieval ──
  // The dense lane (folded-query embed + unfiltered Vectorize query) runs
  // CONCURRENTLY with understanding instead of after it — the serial
  // understand→retrieve chain collapses to max(understand, dense). The
  // warm embedding IS the folded-query vector retrieve() would compute,
  // and the query is issued with retrieve's exact parameters (topK,
  // no filter), so when understanding emits no filter the optimistic
  // results replace the primary dense query bit-for-bit; with a filter
  // they union in as discounted candidates covering filter misses.
  let optimisticVec: number[] | null = null;
  let optimisticHits: Hit[] = [];
  const t0 = Date.now();
  if (!cached) {
    const understandingP = understandQuery(env.AI, roleModel(env, "understand"), q.query, history, convEntities);
    try {
      optimisticVec = (await warmEmbed) ?? null;
      if (optimisticVec) {
        const ores = await env.VECTORIZE.query(optimisticVec, { topK: LIMITS.retrieveK, returnMetadata: "all" });
        optimisticHits = (ores.matches ?? []).map((m: any) => ({
          id: m.id, score: m.score, metadata: m.metadata, text: (m.metadata?.chunk_text ?? ""),
        })) as Hit[];
      }
    } catch {
      // optimistic path is additive; retrieve() runs its own dense lane
    }
    understanding = await understandingP;
    console.log("stage: understand+optimistic", Date.now() - t0, "ms");
  }
  // ── The declared context's document scope (TODO.ai-platform/02) ──
  // The entity/document chip's corpus reference pins retrieval to that
  // publication FAMILY by writing the same understanding fields a named
  // document in the query would — the whole doc-scoped machinery (the
  // Vectorize filter, the family boost, the typed pin, the grade skip)
  // keys off them. A document named IN THE QUESTION wins over the chip:
  // the context informs, it never overrides the user's explicit words —
  // and context_applied's note says which way it went, never silently.
  // "Named" is read from the question TEXT (namedDocumentIn), never from
  // understand's extraction alone: the LLM also fires on domain priors
  // ("maximum permissible errors" → R 76 with no document named — an
  // inference must never steal the user's explicit chip) and can miss a
  // naming the text plainly carries (the win must not depend on that
  // flake either).
  const docScope = declaredCtx ? await resolveDocScope(env, declaredCtx) : null;
  const named = declaredCtx ? namedDocumentIn(q.query) : null;
  let ctxApplied;
  let declaredScoped = false;
  if (!declaredCtx) {
    ctxApplied = NO_CONTEXT;
  } else if (docScope && (!named || named.doc_number === docScope.doc_number)) {
    // the chip scopes; a same-family document named in the question
    // agrees with it. An understand extraction the text does not name is
    // an inference — the chip overrides it.
    if (understanding?.doc_number && understanding.doc_number !== docScope.doc_number) {
      console.log("context scope: understand's doc#" + understanding.doc_number, "is inferred, not named in the question — the declared", docScope.label, "scopes");
    }
    understanding = {
      ...(understanding ?? syntheticUnderstanding(docScope)),
      docidentifier: docScope.label,
      doc_number: docScope.doc_number,
      edition: docScope.edition ?? understanding?.edition ?? null,
    };
    ctxApplied = appliedContext(declaredCtx, docScope);
    declaredScoped = true;
    console.log("context scope:", docScope.label, `(${declaredCtx.kind})`);
  } else if (docScope && named) {
    // the question names a DIFFERENT publication — the user's explicit
    // words win over the chip, and retrieval follows the named document.
    // When understand extracted the same document its fields stay (they
    // can carry a phrased edition pin the text parse does not read).
    if (understanding?.doc_number !== named.doc_number) {
      understanding = {
        ...(understanding ?? syntheticUnderstanding(named)),
        docidentifier: named.label,
        doc_number: named.doc_number,
        edition: named.edition ?? null,
      };
    }
    ctxApplied = appliedContext(declaredCtx, null, "question-document-wins");
    console.log("context scope: the question names", named.label, "— it wins over the declared", docScope.label);
  } else if (declaredCtx.doc) {
    ctxApplied = appliedContext(declaredCtx, null, "document-not-in-corpus");
    console.log("context scope:", declaredCtx.doc, "not in the corpus — the general corpus answers");
  } else {
    ctxApplied = appliedContext(declaredCtx, null);
  }
  if (conversationId && understanding) {
    const now = Date.now();
    const ents: Array<[string, string]> = [];
    if (understanding.docidentifier) ents.push([understanding.docidentifier, "document"]);
    for (const t of understanding.defined_terms) ents.push([t, "term"]);
    if (ents.length) {
      const upsert = (e: string, k: string) => env.DB.prepare("INSERT OR REPLACE INTO conversation_entities (conversation_id, entity, kind, ts) VALUES (?1, ?2, ?3, ?4)").bind(conversationId, e, k, now).run();
      ctx.waitUntil(Promise.allSettled(ents.map(([e, k]) => upsert(e, k))));
    }
  }
  console.log("understand:", understanding?.intent ?? "null", understanding?.doc_number ? `doc#${understanding.doc_number}${understanding.edition ? "@" + understanding.edition : ""}` : "nodoc", "|", q.query.slice(0, 50));
  const graphDocNumbers = await graphExpand(env, understanding);
  const eNote = await editionNote(env, understanding);

  // semantic cache: near-duplicate of a recently answered question —
  // serves the stored answer with a `similar: true` marker (checked only
  // for standalone knowledge questions; contextual turns, declared-context
  // asks and image asks always run live; fresh=true regenerates,
  // bypassing this cache too)
  if (understanding?.intent !== "conversational" && !contextual && !declaredCtx && !userImage && body?.fresh !== true) {
    const warmVec = (await warmEmbed) ?? null;
    if (warmVec) {
      const sc = await semanticCacheGet(env, warmVec);
      if (sc) {
        console.log("semantic cache hit");
        telemetry(env, ctx, tier, "ask", null, true, sc.answer.length, sc.query_hash, q.lang);
        if (wantsStream) {
          return sseResponse([{ type: "citations", citations: sc.citations ?? [], context_applied: NO_CONTEXT }, { type: "token", v: sc.answer }, { type: "done", model: sc.model, query_hash: sc.query_hash, similar: true, context_applied: NO_CONTEXT }], corsHeaders(req));
        }
        return json({ ...sc, similar: true, context_applied: NO_CONTEXT, ...(exempt ? {} : { quota }) });
      }
    }
  }

  // Conversational route, decided by query UNDERSTANDING (any language, any
  // phrasing) — not string matching. No retrieval: nothing in the corpus
  // answers "who are you". The model speaks for itself from the service
  // facts in identityNote (composed from the DATASETS catalog). A declared
  // context is honestly NOT applied here (nothing grounds a conversational
  // turn) — the echo reports none.
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
            send({ type: "citations", citations: [], context_applied: NO_CONTEXT, ...(exempt ? {} : { quota }) });
            let full = "";
            try {
              for await (const tok of sseTokens(stream)) {
                full += tok;
                send({ type: "token", v: tok });
              }
            } catch {
              // stream ended prematurely — deliver what we have
            }
            send({ type: "done", model, query_hash: queryHash, context_applied: NO_CONTEXT });
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
    if (answer === null) answer = await generateOnce(env, MODELS.fallback, messages);
    if (answer === null) {
      telemetry(env, ctx, tier, "ask", model, false, 0, queryHash, q.lang);
      return err(502, "generation_failed", "The generation model is unavailable; please retry.");
    }
    telemetry(env, ctx, tier, "ask", model, true, answer.length, queryHash, q.lang);
    return json({ answer, citations: [], model, query_hash: queryHash, follow_ups: [], context_applied: NO_CONTEXT, ...(exempt ? {} : { quota }) });
  }

  try {
    const tR = Date.now();
    // The DECLARED context's scope is a HARD seal (TODO.ai-platform/02):
    // the panel's context line claims the grounding, so no passage from
    // outside the declared publication may reach the answer. The seal is
    // applied to the CANDIDATE POOL inside retrieve — the soft-steer
    // widenings (the sparse-filter union, the full-corpus lexical union,
    // the sub-query lanes) can otherwise outscore the filtered dense lane
    // under the cross-encoder and push every in-family passage out of the
    // top-N before a post-hoc seal ever sees one. A document named IN THE
    // QUESTION keeps the soft steer by design (the widen covers sparse
    // publications there).
    retrieved = await retrieve(env, q.query, { prev, understanding, federate, warmEmbed, graphDocNumbers,
      sealScope: declaredScoped ? docScope : null, optimisticHits, optimisticVec });
    console.log("stage: retrieve", Date.now() - tR, "ms");
    // ── TTFT surgery: the two post-retrieval LLM calls run IN PARALLEL —
    // they consume the same candidate list (grade is coarse: good/weak;
    // listwise reorders survivors). Doc-scoped queries skip the grade
    // entirely (the filter already pins the corpus; grading adds only latency).
    const docScoped = !!(understanding?.doc_number);
    const gradePromise = docScoped
      ? Promise.resolve("skipped-doc-scoped" as const)
      : gradeRetrieval(env.AI, MODELS.grader, q.query, retrieved.hits.map((h: Hit) => h.text)).catch(() => null);
    if (retrieved.hits.length >= 4 && (member || understanding?.complexity === "complex")) {
      const reordered = await listwiseRerank(env, MODELS.listwise, understanding?.standalone_query || q.query, retrieved.hits);
      if (reordered) {
        console.log("listwise: reordered", reordered[0]?.metadata?.docidentifier ?? "?", "to top");
        retrieved = { hits: reordered, filters: retrieved.filters };
      }
    }
    const grade = await gradePromise;
    console.log("stage: grade+listwise", Date.now() - tR, "ms since retrieve start | grade:", grade);
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
    const out = { answer, citations: [], model, query_hash: await sha256Hex(q.query), context_applied: ctxApplied };
    telemetry(env, ctx, tier, "ask", model, true, answer.length, out.query_hash, q.lang);
    return json({ ...out, ...(exempt ? {} : { quota }) });
  }

  const processNote = understanding?.process_intent
    ? "Retrieval note: these passages come from the OIML Certification System documents because they govern certification/application procedures for OIML publications."
    : undefined;
  const { messages, usedHits } = buildMessages(
    q.query,
    hits,
    q.lang,
    keptHistory,
    [processNote, eNote, contextNote(declaredCtx, docScope)].filter(Boolean).join("\n") || undefined,
    summary,
    budget,
  );
  await attachFigureImages(env, messages, usedHits);
  if (userImage) {
    // the user's own image rides on the question message — retrieval stays
    // text-driven; the answer model reads the image as question context
    const last = messages[messages.length - 1];
    const note = "\n\n(The user attached an image with this question; interpret it directly when answering.)";
    if (Array.isArray(last.content)) {
      const textPart = last.content.find((p: any) => p.type === "text");
      if (textPart) textPart.text += note;
      last.content = [...last.content, { type: "image_url", image_url: { url: userImage } }] as unknown as string;
    } else {
      last.content = [
        { type: "text", text: last.content + note },
        { type: "image_url", image_url: { url: userImage } },
      ] as unknown as string;
    }
    console.log("user image attached to generation");
  }
  const queryHash = await sha256Hex(q.query);
  const cites = citations(usedHits);

  if (wantsStream) {
    const stream = await generateStream(env, model, messages);
    if (stream) {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          send({ type: "citations", citations: cites, context_applied: ctxApplied, ...(exempt ? {} : { quota }) });
          let full = "";
          try {
            for await (const tok of sseTokens(stream)) {
              full += tok;
              send({ type: "token", v: tok });
            }
          } catch {
            // stream ended prematurely — deliver what we have
          }
          const canonical0 = canonicalRefusal(full);
          // answer contract v2: validate [[u:]] refs, resolve typed blocks
          const c2 = canonical0.includes(REFUSAL_ANSWER)
            ? { text: canonical0, blocks: [], dropped: [] as string[] }
            : await contractV2(env.DB, canonical0, usedHits);
          send({ type: "done", model, query_hash: queryHash, follow_ups: understanding?.follow_ups ?? [], blocks: c2.blocks, context_applied: ctxApplied });
          telemetry(env, ctx, tier, "ask", model, true, c2.text.length, queryHash, q.lang);
          const canonical = c2.text;
          // streamed answers can't be regenerated mid-flight; enforcement
          // is that an unverified answer is never served from cache again
          const streamedAnchors = checkQuoteAnchors(canonical, usedHits.map((h: Hit) => h.text));
          const streamedRetyped = tableRetyped(canonical, usedHits.some((h: Hit) => h.metadata.unit_id && h.metadata.block === "table"));
          const streamed = { total: streamedAnchors.total, violations: streamedRetyped ? ["table-retyped"] : streamedAnchors.violations };
          if (streamed.violations.length > 0) {
            console.log("anchors:", streamed.violations.length, "of", streamed.total, "unverified — not caching");
          }
          if (streamed.violations.length === 0 && canonical.length > 0 && !contextual && !declaredCtx && !canonical.includes(REFUSAL_ANSWER)) {
            const wv = (await warmEmbed) ?? null;
            if (wv) semanticCachePut(env, ctx, wv, { answer: canonical, citations: cites, model, query_hash: queryHash });
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
  if (answer === null) {
    answer = await generateOnce(env, MODELS.fallback, messages);
  }
  if (answer) answer = canonicalRefusal(answer);

  // ── Deterministic quote-anchor + table-retyping check ──
  // One corrective regeneration when an anchor quotes text absent from
  // the passages or a typed table was retyped as markdown; the retry
  // wins only if it verifies better.
  let used = usedHits;
  if (answer && !answer.includes(REFUSAL_ANSWER)) {
    const anchors = checkQuoteAnchors(answer, used.map((h: Hit) => h.text));
    const hasTableUnit = used.some((h: Hit) => h.metadata.unit_id && h.metadata.block === "table");
    const retyped = tableRetyped(answer, hasTableUnit);
    if (anchors.violations.length > 0 || retyped) {
      console.log("contract check:", anchors.violations.length, "anchor violations; tableRetyped:", retyped, "— regenerating");
      const note = retyped
        ? "Correction notice: your draft reproduced a table as markdown although a typed table unit was available. Rewrite the answer: describe the table in prose, cite the clause, and write the reference token [[u:<unit id>]] from the passage header where the table belongs. Do not render any table as markdown."
        : ANCHOR_CORRECTION_NOTE;
      const corrected = await generateOnce(env, model, [...messages, { role: "system", content: note }]);
      if (corrected) {
        const correctedAnswer = canonicalRefusal(corrected);
        const retryAnchors = checkQuoteAnchors(correctedAnswer, used.map((h: Hit) => h.text));
        const retryRetyped = tableRetyped(correctedAnswer, hasTableUnit);
        if (retryAnchors.violations.length < anchors.violations.length || (!retryRetyped && retyped)) {
          answer = correctedAnswer;
        }
      }
    }
  }

  // ── Self-RAG reflection loop ──
  // The model critiques its own answer; if claims are ungrounded, retry
  // retrieval with the missing-info hint (max one retry).
  // Ref: selfrag.github.io; arXiv 2606.05658 bounded reflection
  if (answer && !answer.includes(REFUSAL_ANSWER)) {
    const reflection = await reflect(env.AI, MODELS.grader, q.query, answer, hits.map((h: Hit) => h.text));
    console.log("reflection:", reflection ? (reflection.grounded ? "grounded" : "ungrounded") : "null");
    if (reflection && !reflection.grounded && reflection.missing_info) {
      // re-retrieve targeting what was missing — the declared context's
      // hard seal binds the retry exactly as the first pass
      // (TODO.ai-platform/02)
      const retryRetrieve = await retrieve(env, q.query, {
        prev,
        understanding: { ...understanding, standalone_query: `${understanding?.standalone_query || q.query} ${reflection.missing_info}` } as any,
        sealScope: declaredScoped ? docScope : null,
      });
      if (retryRetrieve.hits.length > 0) {
        const { messages: retryMessages, usedHits: retryUsed } = buildMessages(q.query, retryRetrieve.hits, q.lang, keptHistory, undefined, summary, budget);
        const retryAnswer = await generateOnce(env, model, retryMessages);
        // the answer now comes from the retry passages — citations must follow
        if (retryAnswer) {
          answer = canonicalRefusal(retryAnswer);
          used = retryUsed;
        }
      }
    }
  }

  if (answer === null) {
    telemetry(env, ctx, tier, "ask", model, false, 0, queryHash, q.lang);
    return err(502, "generation_failed", "The generation model is unavailable; please retry.");
  }
  const finalCites = citations(used);
  const c2ns = answer.includes(REFUSAL_ANSWER)
    ? { text: answer, blocks: [] as Awaited<ReturnType<typeof contractV2>>["blocks"], dropped: [] as string[] }
    : await contractV2(env.DB, answer, used);
  answer = c2ns.text;
  const finalAnchors = answer.includes(REFUSAL_ANSWER)
    ? { total: 0, violations: [] as string[] }
    : checkQuoteAnchors(answer, used.map((h: Hit) => h.text));
  if (finalAnchors.violations.length > 0) {
    console.log("anchors:", finalAnchors.violations.length, "of", finalAnchors.total, "unverified — not caching");
  }
  const out = { answer, citations: finalCites, model: MODELS.member, query_hash: queryHash, follow_ups: understanding?.follow_ups ?? [], blocks: c2ns.blocks, context_applied: ctxApplied };
  const cacheable = !contextual && !declaredCtx && !answer.includes(REFUSAL_ANSWER) && finalAnchors.violations.length === 0;
  if (cacheable) {
    const warmVec = (await warmEmbed) ?? null;
    if (warmVec) semanticCachePut(env, ctx, warmVec, out);
  }
  if (cacheable) {
    const ck = await cacheKey(env, ns, q.query, q.lang);
    ctx.waitUntil(env.CACHE.put(ck, JSON.stringify(out), { expirationTtl: LIMITS.cacheTtlSec }));
  }
  telemetry(env, ctx, tier, "ask", model, true, answer.length, queryHash, q.lang);
  // grounding transparency for integrators (and the eval battery): the
  // passages the answer was actually built from — response-only, never
  // stored in the answer cache
  const contextOut = used.map((h: Hit) => ({
    doc_id: h.metadata.doc_id,
    clause_anchor: h.metadata.clause_anchor,
    text: h.text.slice(0, 1200),
  }));
  return json({ ...out, context: contextOut, ...(exempt ? {} : { quota }), ...corsHeaders(req) });
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
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 15000));
    const call = (async () => {
      const res: any = await ai.run(model, {
        messages: [
          { role: "system", content: systemPrompt.trimEnd() },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 3072,
        reasoning_effort: "low",
      });
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
      // reasoning models can emit {...} fragments before the verdict — the
      // LAST flat object with a numeric score wins
      let score: number | null = null;
      for (const m of (text ?? "").matchAll(/\{[^{}]*\}/g)) {
        try {
          const obj = JSON.parse(m[0]);
          if (typeof obj.score === "number") score = obj.score;
        } catch {
          // keep scanning
        }
      }
      return score === null ? null : Math.max(0, Math.min(1, score));
    })();
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  }
}

/** Deep-research mode (G10 v1): bounded agentic loop for members —
 *  retrieve → sufficiency judge → re-retrieve targeting the gap → answer
 *  from the ACCUMULATED evidence. ≤ max_iterations rounds; every
 *  iteration's retrieval goes through the same gated pipeline as a
 *  normal ask. Workflows (durable, resumable) is the documented upgrade
 *  path when runs outgrow a single request. */
async function handleResearch(env: Env, ctx: ExecutionContext, req: Request, session: any): Promise<Response> {
  if (!session) {
    return err(403, "forbidden", "Deep research is a member feature — sign in with your OIML SMART account.");
  }
  const body = await readJson(req);
  const q = validateQuery(body);
  if (!q) return err(400, "invalid_input", `query is required (1-${LIMITS.maxInputChars} chars)`);
  const maxIters = Math.min(Math.max(Number(body?.max_iterations) || 3, 1), 3);

  const started = Date.now();
  const queryHash = await sha256Hex(q.query);
  const understanding = await understandQuery(env.AI, MODELS.understand, q.query, [], []);
  const graphDocNumbers = await graphExpand(env, understanding);
  const eNote = await editionNote(env, understanding);

  const accumulated = new Map<string, Hit>();
  let iterations = 0;
  let focus = understanding?.standalone_query?.trim() || q.query;
  let judge: { sufficient: boolean; missing: string } | null = null;

  for (let i = 0; i < maxIters; i++) {
    iterations = i + 1;
    let retrieved: { hits: Hit[] };
    try {
      retrieved = await retrieve(env, q.query, {
        understanding: i === 0 ? understanding : ({ ...understanding, standalone_query: focus, query_variants: [], hypothetical_answer: undefined } as any),
        graphDocNumbers,
      });
    } catch {
      break;
    }
    for (const h of retrieved.hits.slice(0, LIMITS.rerankKeep)) {
      if (!accumulated.has(h.id)) accumulated.set(h.id, h);
    }
    const passages = [...accumulated.values()];
    // Hierarchical context management (GLM-5 report, their search agents):
    // the judge re-reads the full evidence every round and its context
    // grows without bound. Keep-recent-k: the k most recent findings at
    // full length, everything older as one-line digests. The final ANSWER
    // generation below still sees the full set within the token budget —
    // folding is judge-context only.
    const KEEP_RECENT = 10;
    const older = passages.slice(0, Math.max(0, passages.length - KEEP_RECENT));
    const recent = passages.slice(-KEEP_RECENT);
    const digest = older.length
      ? `Earlier evidence (digest, ${older.length} passages):\n${older.map((h) => `- ${h.metadata.docidentifier ?? ""} §${h.metadata.clause_anchor ?? ""}: ${h.text.replace(/\s+/g, " ").slice(0, 160)}`).join("\n")}\n\n`
      : "";
    judge = await (async () => {
      try {
        const res: any = await env.AI.run(MODELS.grader, {
          messages: [
            { role: "system", content: researchPromptText.trimEnd() },
            { role: "user", content: `Research question: ${q.query}\n\n${digest}Collected passages (${recent.length}):\n${recent.map((h, n) => `[${n + 1}] ${h.metadata.docidentifier ?? ""} §${h.metadata.clause_anchor ?? ""}: ${h.text.slice(0, 700)}`).join("\n")}` },
          ],
          max_tokens: 3072,
          reasoning_effort: "low",
          temperature: 1.0,
          top_p: 1.0,
        });
        const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
        let parsed: any = null;
        for (const m of (text ?? "").matchAll(/\{[^{}]*\}/g)) {
          try {
            const obj = JSON.parse(m[0]);
            if (typeof obj.sufficient === "boolean") parsed = obj;
          } catch { /* keep scanning */ }
        }
        return parsed ? { sufficient: parsed.sufficient, missing: String(parsed.missing ?? "") } : null;
      } catch {
        return null;
      }
    })();
    console.log("research iter", iterations, "passages", passages.length, "sufficient:", judge?.sufficient);
    if (!judge || judge.sufficient || !judge.missing) break;
    // fold, don't accumulate: appending every round's `missing` compounds
    // stale wants; the next retrieval focuses on the ORIGINAL question plus
    // what is still missing now
    focus = `${understanding?.standalone_query?.trim() || q.query} ${judge.missing}`.slice(0, LIMITS.maxInputChars);
  }

  const used = [...accumulated.values()];
  if (!used.length) {
    return err(503, "retrieval_unavailable", "Search is briefly busy — please retry in a moment.");
  }
  const { messages, usedHits } = buildMessages(q.query, used, q.lang, [], eNote || undefined, undefined, LIMITS.inputTokenBudget);
  let answer = await generateOnce(env, MODELS.research, messages);
  if (answer === null) answer = await generateOnce(env, MODELS.fallback, messages);
  if (answer === null) {
    telemetry(env, ctx, "member", "research", MODELS.research, false, 0, queryHash, q.lang);
    return err(502, "generation_failed", "The generation model is unavailable; please retry.");
  }
  answer = canonicalRefusal(answer);
  const anchors = checkQuoteAnchors(answer, used.map((h: Hit) => h.text));
  if (anchors.violations.length) console.log("research anchors:", anchors.violations.length, "unverified");
  const out = {
    answer,
    citations: citations(usedHits),
    model: MODELS.research,
    query_hash: queryHash,
    research: { iterations, passages: used.length, elapsed_ms: Date.now() - started, sufficient: judge?.sufficient ?? null },
  };
  telemetry(env, ctx, "member", "research", MODELS.research, true, answer.length, queryHash, q.lang);
  return json({ ...out, ...corsHeaders(req) });
}

/** Ops access to the Vectorize binding (get/upsert by id) for offline
 *  passes like embedding smoothing (G-ETSI-4) — the binding is the
 *  credential, admin-token gated exactly like /admin/enrich. */
/** One-time figure captioning (TODO.remaining/03): fetch the unit's asset
 *  from R2, describe it with the vision-capable answer model, store the
 *  description into unit_payloads. Admin-gated; idempotent. */
async function handleCaption(env: Env, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const unitId = typeof body?.unit_id === "string" ? body.unit_id : "";
  const context = typeof body?.context === "string" ? body.context.slice(0, 400) : "";
  if (!unitId) return err(400, "invalid_input", "unit_id required");
  try {
    const row = await env.DB.prepare("SELECT payload, docidentifier FROM unit_payloads WHERE unit_id = ?1").bind(unitId).first<any>();
    if (!row) return err(404, "not_found", "no unit_payload row for that id");
    const payload = JSON.parse(String(row.payload));
    const uri = payload.uri ?? "";
    const m = uri.match(/^\/assets\/(.+)/);
    if (!m) return err(400, "invalid_input", "payload has no /assets/ uri (upload the asset first)");
    const obj = await env.UNIT_ASSETS.get(m[1]);
    if (!obj) return err(404, "not_found", `asset ${m[1]} not in R2`);
    const buf = await obj.arrayBuffer();
    const ext = m[1].split(".").pop()?.toLowerCase() ?? "png";
    const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const res: any = await env.AI.run(MODELS.member, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `Describe this figure from ${row.docidentifier}${context ? ` (${context})` : ""} for a reader who cannot see it: what is plotted/shown, the axes or structure, and the normative point it makes. 2-3 plain sentences.` },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
      max_tokens: 1024,
      // GLM-5.3-Flash defaults to reasoning_effort "max" when the parameter
      // is absent — max-effort reasoning starves a 1024-token budget and
      // the caption comes back empty (the u:fig-2 straggler)
      reasoning_effort: "low",
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    if (!text?.trim()) return err(502, "generation_failed", "vision model returned no description");
    const desc = text.trim().slice(0, 600);
    await env.DB.prepare("UPDATE unit_payloads SET payload = json_set(payload, '$.description', ?1) WHERE unit_id = ?2").bind(desc, unitId).run();
    return json({ ok: true, unit_id: unitId, description: desc });
  } catch (e) {
    return err(502, "caption_failed", String(e).slice(0, 200));
  }
}

async function handleVectors(env: Env, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const mode = body?.mode;
  try {
    if (mode === "get") {
      const ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === "string").slice(0, 100) : [];
      if (!ids.length) return err(400, "invalid_input", "ids: 1-100 required");
      const vectors = await env.VECTORIZE.getByIds(ids);
      return json({ vectors: (vectors ?? []).map((v: any) => ({ id: v.id, values: v.values, metadata: v.metadata ?? null })) });
    }
    if (mode === "upsert") {
      const vectors = Array.isArray(body?.vectors)
        ? body.vectors.filter((v: any) => v && typeof v.id === "string" && Array.isArray(v.values))
        : [];
      if (!vectors.length || vectors.length > 100) return err(400, "invalid_input", "vectors: 1-100 required");
      await env.VECTORIZE.upsert(vectors);
      return json({ ok: true, upserted: vectors.length });
    }
    return err(400, "invalid_input", "mode must be get or upsert");
  } catch (e) {
    return err(502, "vectorize_failed", String(e).slice(0, 200));
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


/** Edition registry note (documents table): when the query names a
 *  publication, tell the model which editions are ACTIVE so superseded
 *  passages are treated as such — derived status from successor edges,
 *  not the fallible relaton status field. */
async function editionNote(env: Env, u: { doc_number?: string | null } | null): Promise<string | undefined> {
  if (!env.DB || !u?.doc_number) return undefined;
  try {
    const rows = await env.DB.prepare(
      "SELECT docidentifier FROM documents WHERE family = (SELECT family FROM documents WHERE docidentifier LIKE ?1 || '%:%' LIMIT 1) AND active = 1",
    )
      .bind(`% ${u.doc_number}:%`)
      .all<{ docidentifier: string }>();
    const actives = (rows.results ?? []).map((r) => r.docidentifier);
    if (!actives.length) return undefined;
    return `Publication registry (authoritative): the ACTIVE edition(s) for this publication are ${actives.join(", ")}. Passages from other editions are superseded — use them only for historical comparison and say so.`;
  } catch {
    return undefined;
  }
}


// ── Semantic answer cache (G6) ──
// Near-duplicate queries re-pay the whole pipeline. Bucket KV by a
// leading-dimension signature of the query embedding; confirm with full
// cosine >= 0.97 before serving. Same INDEX_VERSION namespace as the
// answer cache (index changes invalidate both). Single entry per bucket
// (v1): collisions overwrite, never mix.
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function scSignature(v: number[]): string {
  return v.slice(0, 16).map((x) => x.toFixed(2)).join(",");
}

async function semanticCacheGet(env: Env, vec: number[]): Promise<{ answer: string; citations: unknown[]; model: string; query_hash: string } | null> {
  try {
    const raw = await env.CACHE.get(`sc:${env.INDEX_VERSION}:${scSignature(vec)}`, "json") as any;
    if (!raw?.v || !Array.isArray(raw.v) || raw.v.length !== vec.length) return null;
    if (cosine(raw.v, vec) < 0.97) return null;
    return raw;
  } catch {
    return null;
  }
}

function semanticCachePut(env: Env, ctx: ExecutionContext, vec: number[], payload: { answer: string; citations: unknown[]; model: string; query_hash: string }): void {
  const v = vec.map((x) => Number(x.toFixed(3)));
  ctx.waitUntil(
    env.CACHE.put(`sc:${env.INDEX_VERSION}:${scSignature(vec)}`, JSON.stringify({ v, ...payload }), { expirationTtl: LIMITS.cacheTtlSec }),
  );
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
    if (req.method === "GET" && (path === "/auth/me" || path === "/auth/me/")) return withCors(await handleMe(env as any, req), cors);
    if ((req.method === "GET" || req.method === "POST") && (path === "/auth/logout" || path === "/auth/logout/")) return handleLogout(env as any, req);

    if (path === "/api/conversations" || path.startsWith("/api/conversations/")) {
      const session = await sessionFrom(req, env as any);
      if (!session) return withCors(err(401, "unauthorized", "Sign in to sync your conversations across devices"), cors);
      const parts = path.split("/").filter(Boolean); // [api, conversations, id?, messages?]
      if (parts.length === 4 && parts[3] === "messages" && req.method === "POST") {
        return withCors(await handleAppendMessage(env, session.sub, req, parts[2]!), cors);
      }
      if (parts.length > 3) return err(404, "not_found", "Unknown route");
      return withCors(await handleConversations(env, session.sub, req, { method: req.method, id: parts[2] }), cors);
    }

    if (req.method === "GET" && (path === "/api/datasets" || path === "/api/datasets/")) {
      const session = await sessionFrom(req, env as any);
      return json({ datasets: datasetsFor(session), suggestions: SUGGESTIONS }, 200, cors);
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
      // a valid RAG session (cookie, or the bubble bridge's Bearer token)
      // upgrades the browser tier to member
      let tier: "anon" | "key" | "member" = isApi ? "key" : "anon";
      if (!isApi && env.SESSION_SECRET && (await sessionFrom(req, env as any))) tier = "member";
      return withCors(await handleAsk(env, ctx, req, tier, key), cors);
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
      return withCors(await handleSearch(env, ctx, req, stier, key), cors);
    }

    if (req.method === "POST" && path === "/api/feedback") {
      const body = await readJson(req);
      const queryHash = typeof body?.query_hash === "string" ? body.query_hash : "";
      const rating = Number(body?.rating);
      if (!/^[a-f0-9]{64}$/.test(queryHash) || ![1, -1].includes(rating)) {
        return withCors(err(400, "invalid_input", "query_hash and rating (1 or -1) are required"), cors);
      }
      await env.DB.prepare("INSERT INTO feedback (query_hash, rating, ts) VALUES (?1,?2,?3)")
        .bind(queryHash, rating, new Date().toISOString())
        .run();
      return json({ ok: true, ...cors });
    }

    if (req.method === "POST" && (path === "/admin/enrich" || path === "/v1/admin/enrich")) return handleEnrich(env, ctx, req);
    if (req.method === "POST" && (path === "/admin/vectors")) return handleVectors(env, req);
    if (req.method === "POST" && path === "/admin/caption") return handleCaption(env, req);
    // unit assets (answer contract v2): immutable, unit-keyed figure images
    const assetMatch = path.match(/^\/assets\/(u:[A-Za-z0-9_-]+)\.(png|jpe?g|gif|svg|webp)$/);
    if (req.method === "GET" && assetMatch) {
      const obj = await env.UNIT_ASSETS.get(assetMatch[1] + "." + assetMatch[2]);
      if (!obj) return new Response("not found", { status: 404 });
      const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };
      return new Response(obj.body, { headers: { "content-type": types[assetMatch[2]] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", ...corsHeaders(req) } });
    }
    if (req.method === "POST" && (path === "/api/research" || path === "/v1/research")) {
      // member-only: a valid RAG session cookie is required (research spend stays with humans)
      const session = env.SESSION_SECRET ? await sessionFrom(req, env as any) : null;
      return handleResearch(env, ctx, req, session);
    }
    if (req.method === "POST" && (path === "/admin/judge" || path === "/v1/admin/judge")) return handleJudge(env, req);
    if (req.method === "POST" && path === "/v1/admin/keys") return handleCreateKey(env, req);
    if (req.method === "GET" && path === "/v1/admin/keys") return handleListKeys(env, req);

    return err(404, "not_found", "Unknown route");
  },
};
