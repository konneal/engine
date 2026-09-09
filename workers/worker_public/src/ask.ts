// The ask path (TODO.impl/30): answer generation, streaming, the answer
// cache, contract completion, verdicts, drafts, live-data and the context
// echo — everything between "request validated" and "response written".
// index.ts routes here; this module owns the answer contract.

import { LIMITS, MODELS, num, sha256Hex, roleModel } from "./config";
import { buildMessages, citations, retrieve, retrievalQuery, identityNote, splitHistory, listwiseRerank, REFUSAL_ANSWER, Hit } from "./pipeline";
import { sessionFrom } from "./auth";
import { retrieveInternal } from "./internal_gateway";
import { understandQuery } from "./understand";
import { gradeRetrieval } from "./grader";
import summarizePrompt from "../prompts/summarize.md";
import { embed, generateOnce } from "./ai";
import { reflect } from "./reflect";
import { checkQuoteAnchors, ANCHOR_CORRECTION_NOTE } from "./anchors";
import { canonicalRefusal } from "./refusal";
import { contractV2, tableRetyped, resolveBlocks } from "./refs";
import { NO_CONTEXT, appliedContext, contextNote, namedDocumentIn, parseContext, resolveDocScope, syntheticUnderstanding } from "./context";
import { exchangeForLiveToken, liveDataConfig, resolveLiveAccount, type LiveRecord } from "./livedata";
import { bindModelNode, modelCitation, modelEcho, modelGroundingBlock, modelNodeRefIn, standardForDocNumber } from "./modelplane";
import { evaluate as machineEvaluate, verdictNote } from "./verdict";
import { detectDraftIntent, prepareDraft } from "./drafts";
import { rawSessionToken } from "./session";
import { cacheKeyMaterial, corpusGen, exactCacheKey, freshRequested, semanticCacheKey } from "./answercache";
import type { Env } from "./env";
export type { Env };
import { json, err, corsHeaders, readJson, validateQuery, type ApiKey } from "./lib/http";
import { clientIp, isExemptIp, checkQuota, telemetry } from "./quota";
import { graphExpand, editionNote } from "./graph";

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

async function cacheGet(env: Env, gen: string, ns: string, query: string, lang?: string) {
  const key = exactCacheKey(env.INDEX_VERSION, gen, ns, await sha256Hex(cacheKeyMaterial(query, lang)));
  const hit = await env.CACHE.get(key, "json");
  return hit ? { key, value: hit as any } : null;
}

// the refusal canonicalizer lives in ./refusal (the pinned sentence, the
// start-anchored variant, and the rag#88 drift family — the same shapes
// the harnesses accept, canonicalized, never more)

/** Start an embed call without awaiting failures — null result means the
 *  caller simply embeds fresh. */
function embedWarm(env: Env, text: string): Promise<number[] | null> {
  return embed(env.AI, MODELS.embed, text).catch(() => null);
}

/** GLM-5.3-Flash is natively multimodal: when the used passages contain
 *  figure units with uploaded assets, attach the actual pixels to the
 *  generation call so the model interprets the producer's figure, not
 *  just its stored caption. Additive — failures simply send no images.
 *  Two hard-won shape rules (probed live, 2026-09-09): images ride their
 *  OWN short trailing user message, never the passages message (long
 *  text + image parts in one message triggers nondeterministic Workers
 *  AI 8005s that scale with payload size), and only the ONE pinned
 *  figure attaches (the type-intent pin already chose the answering
 *  object; a second base64 blob doubles the flake surface for nothing). */
async function attachFigureImages(env: Env, messages: { role: string; content: string }[], usedHits: Hit[]): Promise<void> {
  const figures = usedHits.filter((h) => h.metadata.unit_id && h.metadata.block === "figure").slice(0, 1);
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
  messages.push({
    role: "user",
    content: [
      { type: "text", text: `The original image of figure unit ${names.join(", ")} is attached; interpret it directly when answering about this figure.` },
      ...parts,
    ] as unknown as string,
  });
  console.log("figure images attached:", names.join(", "));
}

async function generateStream(env: Env, model: string, messages: any[]): Promise<ReadableStream<Uint8Array> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
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
    } catch (e) {
      console.error("stream failed:", model, String(e).slice(0, 120));
    }
  }
  return null;
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

  // The draft act (TODO.ai-platform/04): the user asks the assistant to
  // PREPARE an act (the application prefill is the pilot) — never to
  // perform it. The answer depends on the conversation, the account's
  // live standing and the registry, never on the query alone, so a draft
  // ask bypasses both answer caches (read AND write) exactly as a
  // declared-context ask does.
  const draftAct = detectDraftIntent(q.query);

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
  // fresh (regenerate) skips the cache read; contextual follow-ups,
  // declared-context asks, draft asks and image asks skip the cache
  // entirely — the answer depends on the conversation / declared context
  // / image, not the query text alone. The fresh parse is answercache's
  // single freshRequested, honored at every answer-cache read below.
  const fresh = freshRequested(body);
  // the corpus-generation stamp (KV sys:corpus_gen) namespaces both
  // answer caches; corpus surgery bumps it (scripts/invalidate_answer_
  // cache.py) and old-generation entries miss (oimlsmart/rag#72)
  const gen = await corpusGen(env.CACHE);
  const cached = fresh || contextual || declaredCtx || draftAct || userImage ? null : await cacheGet(env, gen, ns, q.query, q.lang);
  const wantsStream = body?.stream === true || (tier === "anon" && body?.stream !== false);

  if (cached) {
    telemetry(env, ctx, tier, "ask", null, true, (cached.value.answer ?? "").length, cached.value.query_hash, q.lang);
    // echo the context the CACHED answer was computed under — the payload
    // stores it (cacheable excludes declared-context answers, but a model
    // node named in the question binds WITHOUT a chip and its echo must
    // survive the cache, not silently flatten to "none")
    const cctx = cached.value.context_applied ?? NO_CONTEXT;
    if (wantsStream) {
      // a cache hit must still speak SSE — the chat client parses a stream
      return sseResponse([{ type: "citations", citations: cached.value.citations ?? [], quota, context_applied: cctx }, { type: "token", v: cached.value.answer ?? "" }, { type: "done", model: cached.value.model ?? MODELS.member, query_hash: cached.value.query_hash, context_applied: cctx }], corsHeaders(req));
    }
    return json({ ...cached.value, cached: true, quota, context_applied: cctx });
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
  // fresh already bypassed the exact cache above and bypasses this one.
  let understanding: any = null;
  // a query naming a model node (/req/…, /term/…) is node-SCOPED: its
  // embedding sits near every other node-scoped ask about the same
  // standard, and the single-entry semantic bucket then serves one
  // node's answer for another (observed run-to-run across the golden
  // model legs). Node-scoped queries use the exact cache only.
  const nodeScoped = !!modelNodeRefIn(q.query) || !!modelNodeRefIn(declaredCtx?.label);
  if (!cached && !nodeScoped && !contextual && !declaredCtx && !draftAct && !q.lang && !userImage && !fresh) {
    const wv0 = (await warmEmbed) ?? null;
    if (wv0) {
      const sc0 = await semanticCacheGet(env, gen, wv0);
      if (sc0) {
        console.log("semantic cache hit (pre-understanding)");
        telemetry(env, ctx, tier, "ask", null, true, sc0.answer.length, sc0.query_hash, q.lang);
        const cctx0 = sc0.context_applied ?? NO_CONTEXT;
        if (wantsStream) {
          return sseResponse([{ type: "citations", citations: sc0.citations ?? [], context_applied: cctx0 }, { type: "token", v: sc0.answer }, { type: "done", model: sc0.model, query_hash: sc0.query_hash, similar: true, context_applied: cctx0 }], corsHeaders(req));
        }
        return json({ ...sc0, similar: true, context_applied: cctx0, ...(exempt ? {} : { quota }) });
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
  const docScope = declaredCtx && declaredCtx.kind !== "account" ? await resolveDocScope(env, declaredCtx) : null;
  const named = declaredCtx && declaredCtx.kind !== "account" ? namedDocumentIn(q.query) : null;
  let ctxApplied;
  let declaredScoped = false;
  if (!declaredCtx) {
    ctxApplied = NO_CONTEXT;
  } else if (declaredCtx.kind === "account") {
    // Provisional echo (TODO.ai-platform/03): the live read's outcome
    // refines it after the conversational branch — a conversational turn
    // never reads the account. The account context NEVER scopes corpus
    // retrieval (scoped_to stays null; the corpus answers the regulatory
    // half, the records answer the account half).
    ctxApplied = appliedContext(declaredCtx, null);
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
  // asks and image asks always run live; fresh regenerates, bypassing
  // this cache too)
  if (understanding?.intent !== "conversational" && !nodeScoped && !contextual && !declaredCtx && !draftAct && !userImage && !fresh) {
    const warmVec = (await warmEmbed) ?? null;
    if (warmVec) {
      const sc = await semanticCacheGet(env, gen, warmVec);
      if (sc) {
        console.log("semantic cache hit");
        telemetry(env, ctx, tier, "ask", null, true, sc.answer.length, sc.query_hash, q.lang);
        const cctx = sc.context_applied ?? NO_CONTEXT;
        if (wantsStream) {
          return sseResponse([{ type: "citations", citations: sc.citations ?? [], context_applied: cctx }, { type: "token", v: sc.answer }, { type: "done", model: sc.model, query_hash: sc.query_hash, similar: true, context_applied: cctx }], corsHeaders(req));
        }
        return json({ ...sc, similar: true, context_applied: cctx, ...(exempt ? {} : { quota }) });
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

  // ── The draft act (TODO.ai-platform/04) — the assistant PREPARES, the
  // user commits in the platform's real UI. Branched after the
  // conversational route (a draft ask is not one) and before retrieval
  // (the draft grounds in the conversation + the registry anchor, not
  // the corpus passages). THE SERVICE NEVER WRITES: the only credential
  // in play is the read-scoped delegation (the RFC 8693 exchange, the
  // same one the "my account" reads ride), and it only ever feeds the
  // ROLE check — the refusal speaks the platform's own vocabulary. The
  // draft rides the response's `draft` field to the panel, which hands
  // it to the platform's real form; the commit is the user's own click.
  if (draftAct) {
    const draftCtxApplied = declaredCtx ? appliedContext(declaredCtx, null) : NO_CONTEXT;
    const queryHash = await sha256Hex(q.query);
    // The delegation's honest states, computed exactly as the live-data
    // path computes them (livedata.ts): the member's session → the
    // exchange → the read-scoped token whose roles the draft reads.
    const liveCfg = liveDataConfig(env);
    const sessionRaw = rawSessionToken(req);
    let delegation;
    if (!member || !sessionRaw) delegation = { status: "unsigned" as const };
    else if (!liveCfg) delegation = { status: "not_configured" as const };
    else {
      const exchanged = await exchangeForLiveToken(env, sessionRaw);
      delegation = exchanged.ok
        ? { status: "ok" as const, token: exchanged.token }
        : { status: exchanged.reason };
    }
    const verdict = await prepareDraft(env, {
      act: draftAct,
      query: q.query,
      history: keptHistory,
      member,
      delegation,
      platformClientId: liveCfg?.platformClientId,
      model: roleModel(env, "understand"),
    });
    console.log("draft act:", draftAct, "→", verdict.status === "draft" ? `draft (${Object.keys(verdict.draft.fields).length} fields)` : `refused (${verdict.reason})`);
    const citations = verdict.citation ? [{ ...verdict.citation, corpus: "oiml" }] : [];
    const draftPayload = verdict.status === "draft" ? verdict.draft : undefined;
    telemetry(env, ctx, tier, "ask", model, true, verdict.answer.length, queryHash, q.lang);
    if (wantsStream) {
      return sseResponse(
        [
          { type: "citations", citations, context_applied: draftCtxApplied, ...(draftPayload ? { draft: draftPayload } : {}), ...(exempt ? {} : { quota }) },
          { type: "token", v: verdict.answer },
          { type: "done", model, query_hash: queryHash, context_applied: draftCtxApplied },
        ],
        corsHeaders(req),
      );
    }
    return json({ answer: verdict.answer, citations, model, query_hash: queryHash, follow_ups: [], context_applied: draftCtxApplied, ...(draftPayload ? { draft: draftPayload } : {}), ...(exempt ? {} : { quota }) });
  }

  // (declared before the retrieval try: the account block, the refusal
  // gate, the prompt and the response all read them)
  let liveRecords: LiveRecord[] | undefined;
  // set by the contract check when the answer presents a served table's
  // data without its reference and the corrected retry still omitted the
  // token — the worker then attaches the table block itself
  let accountNote: string | undefined;
  // ── The model plane's node binding (TODO.ai-platform/05) ──
  // "this requirement" on a model surface grounds in the model NODE
  // itself (its constraint, its provenance, its tests): the declared
  // entity label leads with the canonical node id (the platform's
  // publish contract); a question may name one too. The standard comes
  // from the DECLARED or question-NAMED publication only — understand's
  // LLM extraction is an inference and never narrows the bind (the
  // wave-02 lesson); scope-less binds hold only when the node id is
  // unambiguous across the indexed standards.
  const modelDocHint = named ?? docScope ?? namedDocumentIn(q.query);
  const boundModel = await bindModelNode(env, {
    label: declaredCtx?.label,
    query: q.query,
    standard: standardForDocNumber(modelDocHint?.doc_number),
  });
  if (boundModel) {
    ctxApplied = { ...ctxApplied, model: modelEcho(boundModel) };
    console.log("model plane: bound", boundModel.node_id, `[${boundModel.standard}]`, boundModel.clause?.urn ?? "no-clause");
  }
  const modelNote = boundModel ? modelGroundingBlock(boundModel) : undefined;
  // ── the verdict engine (TODO.era3/01) ──
  // the worker EXECUTES the bound node's machine checks against the
  // question's stated values; the model narrates the computed verdict
  // and the verdict BLOCK is server-built — data, never generated prose
  const machineVerdict = boundModel ? machineEvaluate(boundModel.content, q.query) : null;
  const machineNote = machineVerdict && boundModel ? verdictNote(machineVerdict, boundModel) : undefined;
  const verdictBlock = machineVerdict
    ? {
        unit_id: boundModel!.node_id,
        type: "verdict",
        docidentifier: `OIML SMART model (${boundModel!.standard})`,
        payload: {
          verdict: machineVerdict.verdict,
          on_violation: machineVerdict.on_violation,
          violation_meaning: machineVerdict.violation_meaning,
          missing: machineVerdict.missing,
          checks: machineVerdict.checks,
        },
      }
    : null;
  if (machineVerdict) console.log("verdict engine:", boundModel!.node_id, "→", machineVerdict.verdict.toUpperCase(), machineVerdict.missing.length ? `(missing ${machineVerdict.missing.join(",")})` : "");
  try {
    const tR = Date.now();
    // ── The "my account" live read (TODO.ai-platform/03) — resolved
    // HERE, after the conversational branch (a conversational turn never
    // reads the account) and before retrieval (the records join the
    // prompt beside the corpus passages). The cones bind exactly as for
    // the user's own browser: the exchange (the identity service's RFC
    // 8693 session delegation) re-judges the standing live, and the
    // platform's API enforces the visibility — this service only ever
    // maps what the platform answered. Every failure degrades honestly:
    // the answer runs on the corpus and the context line says WHY the
    // live data was not read.
    if (declaredCtx?.kind === "account") {
      const live = await resolveLiveAccount(env, rawSessionToken(req), member);
      if (live.status === "ok") {
        liveRecords = live.records;
        ctxApplied = appliedContext(declaredCtx, null, undefined, {
          read_at: live.readAt,
          stores: live.stores,
          records: live.records.length,
        });
        const lines = live.records.map(
          (r) => `- ${r.label} [${[r.status, r.detail].filter(Boolean).join("; ")}] ${r.url}`,
        );
        accountNote =
          `Live account data (read ${live.readAt} from the user's own OIML SMART account — exactly what they may see, never more):\n` +
          (lines.length ? lines.join("\n") : "(the account surfaces answered empty)") +
          `\nAnswer account questions from these records ONLY: name the record when you use it, never invent one, and say honestly when they do not hold the answer. The corpus passages still ground the regulatory claims (the requirements, the procedures); the records are the user's own work.`;
        console.log("live data:", live.records.length, "records from", live.stores.join("+") || "none");
      } else {
        const note =
          live.reason === "sign_in_required" ? "sign-in-required"
          : live.reason === "window_expired" ? "live-window-expired"
          : "live-unavailable";
        ctxApplied = appliedContext(declaredCtx, null, note);
        accountNote =
          live.reason === "sign_in_required"
            ? "Context note: the user asked with the 'my account' context but is not signed in — the account data was NOT read; answer from the corpus and say so."
            : live.reason === "window_expired"
              ? "Context note: the user's live access window lapsed — the account data was NOT read; answer from the corpus, say the live read did not happen, and suggest signing in again to refresh it."
              : "Context note: the live account read was refused or unreachable — the account data was NOT read; answer from the corpus and say so honestly.";
        console.log("live data: not read —", live.reason);
      }
    }
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
  } catch (e) {
    console.log("ask: retrieval failed:", String(e).slice(0, 300));
    telemetry(env, ctx, tier, "ask", MODELS.embed, false, 0, await sha256Hex(q.query), q.lang);
    return err(503, "retrieval_unavailable", "Search is briefly busy — please retry in a moment.");
  }
  const { hits } = retrieved;
  if (hits.length === 0 && !liveRecords?.length && !boundModel) {
    const answer = REFUSAL_ANSWER;
    const out = { answer, citations: [], model, query_hash: await sha256Hex(q.query), context_applied: ctxApplied };
    telemetry(env, ctx, tier, "ask", model, true, answer.length, out.query_hash, q.lang);
    return json({ ...out, ...(exempt ? {} : { quota }) });
  }

  const processNote = understanding?.process_intent
    ? "Retrieval note: these passages come from the OIML Certification System documents because they govern certification/application procedures for OIML publications."
    : undefined;
  // the vocabulary binding (L2): the corpus's defined-term candidates for
  // the question's subject — the model adjudicates among them and uses
  // the corpus term (with its defining publication) when it names the
  // subject; everyday words stop hiding the defined term
  // filter the note by the understanding's own defined_terms when it
  // identified them — the note bridges everyday words to the corpus
  // term; when the understanding already named the right term, offering
  // wrong alternatives (creep when the question is about months of use)
  // gives the answer model a way to pick the wrong one
  const glossaryForNote = (() => {
    const g = retrieved.glossary ?? [];
    if (!g.length) return g;
    const dt = (understanding?.defined_terms ?? []).map((s: string) => s.toLowerCase());
    if (!dt.length) return g;
    const matched = g.filter((x) => dt.some((d: string) => x.term.toLowerCase().includes(d.split(" ")[0]) || d.includes(x.term.toLowerCase().split(" ")[0])));
    return matched.length ? matched : g; // understanding named terms the glossary didn't carry — keep all
  })();
  const vocabNote = glossaryForNote.length
    ? "Vocabulary binding — defined terms in the indexed corpus that may name this question's subject:\n" +
      glossaryForNote.map((g) => `- ${g.term} (${g.docidentifier}): ${g.definition}`).join("\n") +
      "\nIf the question describes a symptom or behavior in everyday words, OPEN the answer by naming the matching defined term, quote its definition, and cite its defining publication; keep using that term throughout. Match TIME SCALE carefully: change under a constant load over minutes/hours is creep; change over months/years of use is span stability or durability — do not call long-term drift creep."
    : undefined;
  const { messages, usedHits } = buildMessages(
    q.query,
    hits,
    q.lang,
    keptHistory,
    [processNote, eNote, contextNote(declaredCtx, docScope), accountNote, modelNote, vocabNote, machineNote].filter(Boolean).join("\n") || undefined,
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
  // The bound model node leads the citations (TODO.ai-platform/05): the
  // panel's first citation card IS the model node — its constraint, its
  // provenance — ahead of the prose passages.
  const cites = boundModel ? [modelCitation(boundModel), ...citations(usedHits)] : citations(usedHits);

  if (wantsStream) {
    const stream = await generateStream(env, model, messages);
    if (stream) {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          send({ type: "citations", citations: cites, context_applied: ctxApplied, ...(liveRecords ? { records: liveRecords } : {}), ...(exempt ? {} : { quota }) });
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
          send({ type: "done", model, query_hash: queryHash, follow_ups: understanding?.follow_ups ?? [], blocks: verdictBlock ? [...c2.blocks, verdictBlock] : c2.blocks, context_applied: ctxApplied });
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
            if (wv) semanticCachePut(env, ctx, gen, wv, { answer: canonical, citations: cites, model, query_hash: queryHash });
            ctx.waitUntil(
              env.CACHE.put(exactCacheKey(env.INDEX_VERSION, gen, ns, await sha256Hex(cacheKeyMaterial(q.query, q.lang))), JSON.stringify({ answer: canonical, citations: cites, model, query_hash: queryHash }), { expirationTtl: LIMITS.cacheTtlSec }),
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
    // the fallback is a text-only model: image parts must be flattened
    // out first or it errors on (or silently ignores) the pixels the
    // primary was carrying
    const flat = messages.map((m: any) =>
      typeof m.content === "string"
        ? m
        : { ...m, content: m.content.filter((p: any) => p?.type === "text").map((p: any) => p?.text ?? "").join("\n") },
    );
    answer = await generateOnce(env, MODELS.fallback, flat);
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
    // presenting a served table's DATA without its unit reference is the
    // same contract violation as retyping it — the HARD RULE wants the
    // token wherever the table's values carry the answer
    const unreferenced = (() => {
      if (!hasTableUnit || answer.includes("[[u:")) return false;
      const norm = (s: string) => (s.match(/\d[\d ,.]{1,8}\d/g) ?? []).map((x) => x.replace(/[ ,.]/g, ""));
      const nums = norm(answer);
      if (nums.length < 2) return false;
      const tableNums = new Set(
        norm(used.filter((h: Hit) => h.metadata.unit_id && h.metadata.block === "table").map((h: Hit) => h.text).join(" ")),
      );
      return nums.filter((n) => tableNums.has(n)).length >= 2;
    })();
    if (anchors.violations.length > 0 || retyped || unreferenced) {
      console.log("contract check:", anchors.violations.length, "anchor violations; tableRetyped:", retyped, "; tableDataUnreferenced:", unreferenced, "— regenerating");
      // name the EXACT unit the token must reference — a generic note
      // leaves the model guessing which id to write
      const tableUnitId = unreferenced
        ? used.find((h: Hit) => h.metadata.unit_id && h.metadata.block === "table")?.metadata.unit_id
        : undefined;
      const note = retyped || unreferenced
        ? `Correction notice: your draft reproduced a table as markdown or presented a served table's data without its reference. Rewrite the answer: describe the table in prose, cite the clause, and write the reference token [[u:${tableUnitId ?? "<unit id>"}]] exactly where the table belongs. Do not render any table as markdown.`
        : ANCHOR_CORRECTION_NOTE;
      const corrected = await generateOnce(env, model, [...messages, { role: "system", content: note }]);
      if (corrected) {
        const correctedAnswer = canonicalRefusal(corrected);
        const retryAnchors = checkQuoteAnchors(correctedAnswer, used.map((h: Hit) => h.text));
        const retryRetyped = tableRetyped(correctedAnswer, hasTableUnit);
        if (retryAnchors.violations.length < anchors.violations.length || (!retryRetyped && retyped) || (unreferenced && correctedAnswer.includes("[[u:"))) {
          answer = correctedAnswer;
        }
      }
    }
    // contract COMPLETION (the verdict-block philosophy): if the answer
    // presents a served table's data and the model still did not write
    // the reference after the corrected retry, the worker attaches the
    // block itself — the renderer draws from the blocks array, so the
    // table reaches the user exactly from the producer's payload with or
    // without the model's inline token. The contract is mechanical, not
    // a hope: two generation samples failing no longer ships a violation.
    // ALWAYS complete the contract when a table unit was served and the
    // model didn't reference it — the block is additive (the renderer
    // shows it from the producer's payload regardless of the inline
    // token), so there is no reason to condition on number-matching
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
  const finalCites = boundModel ? [modelCitation(boundModel), ...citations(used)] : citations(used);
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
  // contract completion — POST-c2ns: if the final blocks array carries
  // no table but the answer presents a numeric value from a table in the
  // answer's document family, the worker resolves and attaches it from
  // D1 directly. Running AFTER contractV2 closes the gap where the model
  // wrote [[u:…]] in the retry (completion check saw it, skipped the
  // fallback) but contractV2 then dropped the reference because the unit
  // wasn't in the used passages — leaving no block and no token.
  let completionBlocks: Awaited<ReturnType<typeof resolveBlocks>> = [];
  if (!answer.includes(REFUSAL_ANSWER) && !c2ns.blocks.some((b: any) => b.type === "table")) {
    try {
      const answerNums = new Set((answer.match(/\d[\d ,.]{1,8}\d/g) ?? []).map((x) => x.replace(/[ ,.]/g, "")));
      if (answerNums.size >= 1) {
        // match by docidentifier (the chunks and unit_payloads use
        // different doc_id schemes — 'dirty:r60-1-2006-eng' vs
        // 'mko:oiml-r-60-1' — but both carry the publication name)
        const fams = [...new Set(used.map((h: Hit) => h.metadata.docidentifier).filter(Boolean))].slice(0, 3);
        for (const fam of fams) {
          const base = String(fam).replace(/\s*\([A-Z]\)\s*$/, "").split(":")[0].trim();
          const rows = await env.DB.prepare(
            "SELECT unit_id, payload FROM unit_payloads WHERE type = 'table' AND docidentifier LIKE ?1 LIMIT 8",
          ).bind(`%${base}%`).all<{ unit_id: string; payload: string }>();
          for (const r of rows.results ?? []) {
            const tableNums = new Set((String(r.payload).match(/\d[\d ,.]{1,8}\d/g) ?? []).map((x) => x.replace(/[ ,.]/g, "")));
            let hits = 0;
            for (const n of answerNums) if (tableNums.has(n)) hits++;
            if (hits >= 1) {
              completionBlocks = await resolveBlocks(env.DB, [r.unit_id]);
              console.log("contract D1 completion: table", r.unit_id, "in", base, "—", hits, "matching values");
              break;
            }
          }
          if (completionBlocks.length) break;
        }
      }
    } catch {
      // additive; primary results stand
    }
  }
  if (completionBlocks.length) console.log("contract completion:", completionBlocks.length, "table block(s) attached server-side");
  const out = { answer, citations: finalCites, model: MODELS.member, query_hash: queryHash, follow_ups: understanding?.follow_ups ?? [], blocks: [...c2ns.blocks, ...(verdictBlock ? [verdictBlock] : []), ...completionBlocks], context_applied: ctxApplied, ...(liveRecords ? { records: liveRecords } : {}) };
  const cacheable = !contextual && !declaredCtx && !answer.includes(REFUSAL_ANSWER) && finalAnchors.violations.length === 0;
  if (cacheable) {
    const warmVec = (await warmEmbed) ?? null;
    if (warmVec) semanticCachePut(env, ctx, gen, warmVec, out);
  }
  if (cacheable) {
    const ck = exactCacheKey(env.INDEX_VERSION, gen, ns, await sha256Hex(cacheKeyMaterial(q.query, q.lang)));
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



/** RAGAS-style metric battery (G13): judge an (question, answer, passages)
 *  triple — faithfulness, answer relevancy, context precision. Driven by
 *  tests/eval-suite.mjs; prompts are data; refuses nothing, judges only. */





// ── Semantic answer cache (G6) ──
// Near-duplicate queries re-pay the whole pipeline. Bucket KV by a
// leading-dimension signature of the query embedding; confirm with full
// cosine >= 0.97 before serving. Same INDEX_VERSION + corpus-generation
// namespace as the answer cache (deploys and corpus surgery invalidate
// both). Single entry per bucket (v1): collisions overwrite, never mix.
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

async function semanticCacheGet(env: Env, gen: string, vec: number[]): Promise<{ answer: string; citations: unknown[]; model: string; query_hash: string; context_applied?: unknown } | null> {
  try {
    const raw = await env.CACHE.get(semanticCacheKey(env.INDEX_VERSION, gen, scSignature(vec)), "json") as any;
    if (!raw?.v || !Array.isArray(raw.v) || raw.v.length !== vec.length) return null;
    if (cosine(raw.v, vec) < 0.97) return null;
    return raw;
  } catch {
    return null;
  }
}

function semanticCachePut(env: Env, ctx: ExecutionContext, gen: string, vec: number[], payload: { answer: string; citations: unknown[]; model: string; query_hash: string }): void {
  const v = vec.map((x) => Number(x.toFixed(3)));
  ctx.waitUntil(
    env.CACHE.put(semanticCacheKey(env.INDEX_VERSION, gen, scSignature(vec)), JSON.stringify({ v, ...payload }), { expirationTtl: LIMITS.cacheTtlSec }),
  );
}

// ── the route table (TODO.impl/03) ───────────────────────────────────────

export { handleAsk };
