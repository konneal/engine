// The ask path (TODO.impl/30): answer generation, streaming, the answer
// cache, contract completion, verdicts, drafts, live-data and the context
// echo — everything between "request validated" and "response written".
// index.ts routes here; this module owns the answer contract.

import { LIMITS, MODELS, THRESHOLDS, num, sha256Hex, roleModel, answerEffort, requestEffort, effortBudget } from "./config";
import { portModelRunner } from "./env.ts";
import { refCodec } from "./codecs";
import { buildMessages, citations, retrieve, retrievalQuery, identityNote, splitHistory, listwiseRerank, refusalAnswer, Hit } from "./pipeline";
import { sessionFrom } from "./auth";
import { retrieveInternal } from "./internal_gateway";
import { understandQuery } from "./understand";
import { gradeRetrieval } from "./grader";
import summarizePrompt from "../prompts/summarize.md";
import { embed, generateOnce } from "./ai";
import { reflect } from "./reflect";
import { scoreFaithfulness } from "./faithfulness";
import { entailmentVerdict } from "./entailment";
import { checkQuoteAnchors, ANCHOR_CORRECTION_NOTE } from "./anchors";
import { canonicalRefusal } from "./refusal";
import { contractV2, tableRetyped } from "./refs";
import { completeTables, completeFigures } from "./completion";
import { NO_CONTEXT, appliedContext, contextNote, namedDocumentIn, parseContext, resolveDocScope, syntheticUnderstanding } from "./context";
import { liveDataConfig, liveTokenFor, opCfg, opTokenMember, resolveLiveAccount, type LiveRecord } from "./livedata";
import { bindModelNode, bindConstraintByQuantities, licenseBoundaryNote, licenseBoundaryRefusal, licensedEntryForPackage, modelCitation, modelEcho, modelGroundingBlock, standardForDocNumber } from "./modelplane";
import { evaluate as machineEvaluate, verdictNote } from "./verdict";
import { evaluateConditionSets, quantitiesIn, type ConditionVerdict } from "./conditions";
import { evaluateAggregation, type AggregationVerdict } from "./aggregation";
import { matchLicensedTopic, boundaryNoteText } from "./boundary";
import { answerQuality, experimentalSourceLabels, qualityNote } from "./quality";
import { detectDraftIntent, prepareDraft } from "./drafts";
import { detectApiCallIntent, prepareApiCall } from "./apicalls";
import { memoryNote } from "./memories";
import { entitlementScope, resolveRequestScope, requestSalt, standardKeysFrom } from "./requestScope";
import { rawSessionToken, type SessionClaims } from "./session";
import { cacheKeyMaterial, corpusGen, exactCacheKey, freshRequested } from "./answercache";
import type { Env } from "./env";
export type { Env };
import { json, err, corsHeaders, readJson, validateQuery, type ApiKey } from "./lib/http";
import { chargeTokens, checkQuota, clientIp, estimateTokens, telemetry, tokenBudget, usageTotal } from "./quota";
import { graphExpand, editionNote } from "./graph";
import { registerNote, searchRegister, certificateLinks } from "./certificates";
import { TOOL_DECLARATION, parseToolCall, runTool, toolNote } from "./tools";
import { operationsLane } from "./operations.ts";
import { extractNameplate, nameplateRegisterQuery } from "./nameplate.ts";
import { P } from "./profile.ts";

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

async function cacheGet(env: Env, gen: string, ns: string, query: string, lang?: string, salt?: string | null) {
  const key = exactCacheKey(env.INDEX_VERSION, gen, ns, await sha256Hex(cacheKeyMaterial(query, lang, salt)));
  const hit = await env.CACHE.get(key, "json");
  return hit ? { key, value: hit as any } : null;
}

// the refusal canonicalizer lives in ./refusal (the pinned sentence, the
// start-anchored variant, and the rag#88 drift family — the same shapes
// the harnesses accept, canonicalized, never more)

/** Start an embed call without awaiting failures — null result means the
 *  caller simply embeds fresh. */
function embedWarm(env: Env, text: string): Promise<number[] | null> {
  return embed(portModelRunner(env), MODELS.embed, text).catch(() => null);
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
async function attachFigureImages(env: Env, messages: { role: string; content: any }[], usedHits: Hit[], query: string): Promise<void> {
  // Attach only when the question WANTS the drawing (names a figure-ish
  // artifact) or the pinned figure sits in the top prose passage's own
  // clause (it IS the answering object) — a plain definition question
  // gains nothing from pixels and pays the multimodal flake surface
  const figIntent = /\b(fig(ure)?s?|diagram|drawing|graph|chart)\b/i.test(query);
  const topProseAnchor = usedHits.find((h) => !h.metadata.unit_id)?.metadata.clause_anchor;
  const figures = usedHits
    .filter((h) => h.metadata.unit_id && h.metadata.block === "figure")
    .filter((h) => figIntent || (!!h.metadata.clause_anchor && h.metadata.clause_anchor === topProseAnchor))
    .slice(0, 1);
  if (!figures.length) return;
  // the figure is understood together with its context: its own caption,
  // the clause it belongs to, and the same publication's prose that
  // references a figure (where the reader is sent from)
  const fig = figures[0];
  const figAnchor = fig.metadata.clause_anchor ?? "";
  const figTitle = fig.metadata.clause_title ?? "";
  const referencing = usedHits
    .filter((h) => !h.metadata.unit_id && h.metadata.docidentifier === fig.metadata.docidentifier && /\bfig(ure)?s?\.?\s*\d/i.test(h.text ?? ""))
    .slice(0, 2)
    .map((h) => `clause ${h.metadata.clause_anchor ?? ""}${h.metadata.clause_title ? ` (${h.metadata.clause_title})` : ""}: ${(h.text ?? "").slice(0, 400)}`);
  const parts: unknown[] = [];
  const names: string[] = [];
  let figCaption = "";
  for (const h of figures) {
    try {
      const row = await env.DB.prepare("SELECT payload FROM unit_payloads WHERE unit_id = ?1").bind(h.metadata.unit_id!).first<any>();
      const payload = row ? JSON.parse(String(row.payload)) : {};
      const uri = typeof payload.uri === "string" ? payload.uri : "";
      if (typeof payload.caption === "string" && payload.caption.trim()) figCaption = payload.caption.trim();
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
  const context: string[] = [];
  if (figCaption) context.push(`Its caption reads: \"${figCaption}\".`);
  if (figAnchor) context.push(`It belongs to clause ${figAnchor}${figTitle ? ` (${figTitle})` : ""} of its publication.`);
  if (referencing.length) context.push(`The publication's prose references it from — ${referencing.join(" — and from — ")}.`);
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text:
          `The original image of figure unit ${names.join(", ")} is attached; interpret the drawing directly when answering about this figure.` +
          (context.length ? ` To understand what the figure is doing: ${context.join(" ")}` : ""),
      },
      ...parts,
    ] as unknown as string,
  });
  console.log("figure images attached:", names.join(", "));
}

async function generateStream(env: Env, model: string, messages: any[], effort?: string): Promise<ReadableStream<Uint8Array> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res: any = await env.AI.run(model, {
        messages,
        stream: true,
        max_tokens: effortBudget(effort ?? answerEffort(env)),
        reasoning_effort: effort ?? answerEffort(env),
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

/** The prompt's character weight — text parts only, image data URLs
 *  excluded (a photo must not read as half a million characters). */
function messageChars(messages: any[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") n += m.content.length;
    else if (Array.isArray(m.content)) for (const part of m.content) if (part?.type === "text" && typeof part.text === "string") n += part.text.length;
  }
  return n;
}

/** Post-generation true-up: the model's own usage when the stream
 *  reported it, the character estimate otherwise — charged, then the
 *  budget's fresh state returned for the quota payload. */
async function chargeAnswerTokens(env: Env, bucketId: string, stats: { usage?: unknown } | undefined, promptChars: number, answerChars: number): Promise<{ tokens_used: number; token_limit: number }> {
  const total = usageTotal(stats?.usage) ?? estimateTokens(promptChars + answerChars);
  await chargeTokens(env, bucketId, total);
  const budget = await tokenBudget(env, bucketId);
  return { tokens_used: budget.used, token_limit: budget.limit };
}

async function* sseTokens(stream: ReadableStream<Uint8Array>, stats?: { usage?: unknown }): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    // bounded read: a stalled stream (no error, no chunk) delivers what
    // it has instead of hanging the ask at zero tokens
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), 120_000)),
    ]);
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
        if (evt.usage && stats && stats.usage === undefined) stats.usage = evt.usage;
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
  // the latency program's clock: every telemetry write below reports the
  // wall time from request entry to its own exit
  const tStart = Date.now();
  const telemetryMeta = () => ({ durationMs: Date.now() - tStart, keyId: key?.id ?? null, retries: generateRetries });
  // the latency anatomy, surfaced as standard Server-Timing headers on
  // the JSON response — the reduction program's per-stage data
  const stageTiming: Record<string, number> = {};
  let generateRetries = 0;
  // how the question was read, for the reader: the interpretation that
  // steered retrieval — a wrong read is visible before it costs trust
  const readAs = () =>
    understanding
      ? {
          intent: understanding.intent,
          doc: understanding.docidentifier,
          edition: understanding.edition ?? null,
          term: understanding.term,
          terms: (understanding.defined_terms ?? []).slice(0, 4),
          lang: q?.lang ?? null,
        }
      : undefined;
  const serverTiming = () =>
    Object.entries(stageTiming)
      .map(([k, v]) => `${k};dur=${v}`)
      .concat([`generate-retries;desc=count;dur=${generateRetries ?? 0}`, `total;dur=${Date.now() - tStart}`])
      .join(", ");
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
  const draftAct = P().publisher.features?.drafts ? detectDraftIntent(q.query) : null;
  // The api_call draft (TODO.ai-platform/09): the operations deployment's
  // proposal grammar — one platform operation, bounded by the affordance
  // channel's machine facet (machine acts) or the preference family's
  // closed world (the operation directory). Same cache posture as the
  // prefill draft: the answer depends on the conversation and the
  // account's standing, never on the query alone.
  const apiCallIntent = !draftAct && P().publisher.features?.api_call_drafts ? detectApiCallIntent(q.query, declaredCtx) : null;

  const session = tier === "member" ? await sessionFrom(req, env as any) : null;
  // The Ommisa tier: no service session but a device-grant CLI's opaque
  // bearer → the OP's introspection answer admits a member-READ
  // credential (livedata.ts). No sessionRaw behind it, so the draft and
  // live-data lanes keep their honest "unsigned" refusals.
  const opMember = !session && tier === "member" ? await opTokenMember(env, opCfg(env), req) : null;
  const member: SessionClaims | null = session
    ?? (opMember
      ? {
          sub: opMember.sub,
          roles: [],
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          via: "op-token",
          scope: opMember.scope,
        }
      : null);
  // resolved before the quota check: the effort choice prices the ask
  const effort = requestEffort(env, member, (body as any)?.effort);

  const limit =
    tier === "key" ? key!.day_limit : tier === "member" || member ? num(env as any, "MEMBER_DAY_ASK", 300) : num(env as any, "ANON_DAY_ASK", 20);
  const bucketId = tier === "key" ? `key:${key!.id}` : member ? `sub:${member.sub}` : clientIp(req);
  const quota = await checkQuota(env, "ask", bucketId, limit, effort === "low" ? 1 : 2);
  if (!quota.ok) {
    return err(429, "quota_exceeded", `Daily question limit reached (${quota.limit}). Try again tomorrow.`);
  }
  // the real allowance is the day's TOKENS (the 2026-09-29 shift): the
  // request cap above is the anti-abuse backstop, this is the budget
  const tokBudget = await tokenBudget(env, bucketId);
  if (tokBudget.used >= tokBudget.limit) {
    return err(429, "quota_exceeded", `Daily token budget reached (${tokBudget.limit} tokens). Try again tomorrow.`);
  }
  (quota as any).tokens_used = tokBudget.used;
  (quota as any).token_limit = tokBudget.limit;

  const hardCap = num(env as any, "ANON_DAY_HARD_CAP", 5000);
  if (tier === "anon" && quota.used > hardCap) {
    return err(503, "generation_disabled", "Generation is temporarily paused; search remains available.");
  }
  if ((await env.CACHE.get("sys:generation")) === "off") {
    return err(503, "generation_disabled", "Generation is temporarily paused; search remains available.");
  }

  // the agent's rounds, visible to the user as they happen: each step the
  // assistant takes before and during the answer streams as an event (the
  // owner's 2026-10-04 direction — the user must see the system-to-model
  // questioning sessions, not stare at a spinner)
  const agentSteps: string[] = [];
  const mark = (step: string) => {
    agentSteps.push(step);
    console.log(`agent-step: ${step}`);
  };

  // Members get federated retrieval (OIML + ISO/IEC) merged into the same
  // pipeline via the service binding; rag-public never touches the
  // internal index itself, and generation/rerank stay in ONE pipeline.
  // The key-tier licensed federation (the LIVE_MEMBER_TOKEN retirement):
  // an API-key caller with a VALIDATED entitlement set rides the same
  // lane — the key is re-verified server-side by the internal worker and
  // the entitlement set is the licensed scope the hard cut honors.
  const service = env.INTERNAL_SERVICE;
  const fedAuth = {
    cookie: req.headers.get("cookie") ?? "",
    authorization: req.headers.get("authorization") ?? "",
  };
  const keyLicensed = tier === "key" && standardKeysFrom(body).size > 0;
  // Dataset scope + memory selection (MECE: the derivation lives in
  // ./requestScope; this path only wires it). A request that explicitly
  // disables every dataset is a user error.
  const scope = resolveRequestScope(body, member, { keyWithEntitlements: keyLicensed });
  if ("error" in scope) return err(400, "invalid_input", "datasets: at least one dataset must stay enabled");
  const { corpora, narrowed, isoOn } = scope;
  // The license entitlement set (TODO.external-refs/08): request-scoped,
  // validated against the profile's declared licensed list; the hard
  // retrieval scope it feeds is fail-closed (an unentitled ask — empty
  // set, the anon default — never sees licensed chunks, citation-level
  // metadata stays). It salts the answer cache with the effort segment
  // below.
  const standardKeys = entitlementScope(scope.standardKeys);
  // Personalized memory files (#171): member-scoped, selected per ask;
  // the note rides buildMessages as a trusted-user-facts preamble, and
  // the selections SALT the answer cache (requestScope.requestSalt).
  const [memNote, memoryUsed] = member && scope.memoryIds.length ? await memoryNote(env, member.sub, scope.memoryIds) : [null, []];
  const requestSaltStr = requestSalt(scope, memoryUsed);
  // per-request depth toggle (⚡ fast / 🧠 thorough): effort changes the
  // answer, so it salts the cache with the selections above
  const salt = requestSaltStr ? `${requestSaltStr}|effort:${effort}` : `effort:${effort}`;
  const federate = (member || keyLicensed) && service && isoOn
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
  // Tier-2 image reuse (TODO.new-era/8): stored attachments materialize
  // as the question's image. Explicit attachment_ids win (member-gated,
  // ownership-checked, at most one — the multimodal shape rule); with
  // none given, the conversation's most recent image re-attaches itself,
  // so "identify this" works turns after the upload.
  let storedImage: string | null = null;
  const attachIds: string[] = Array.isArray(body?.attachment_ids)
    ? body.attachment_ids.filter((x: unknown) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 2)
    : [];
  if (attachIds.length && env.DB && member) {
    for (const aid of attachIds) {
      const row = await env.DB.prepare("SELECT mime, r2_key FROM attachments WHERE id = ?1 AND sub = ?2").bind(aid, member.sub).first<{ mime: string; r2_key: string }>();
      if (!row) continue;
      try {
        const obj = await (env as any).CHAT_UPLOADS.get(row.r2_key);
        if (!obj) continue;
        const b64 = btoa(String.fromCharCode(...new Uint8Array(await obj.arrayBuffer())));
        storedImage = `data:${row.mime};base64,${b64}`;
        break; // the multimodal shape rule: one image per question
      } catch {
        /* the object's gone — ask without it */
      }
    }
  }
  const effectiveImage = userImage ?? storedImage;
  // history compaction: turns beyond the budget slice are summarized into a
  // continuity block (below) instead of silently dropped
  const budget = num(env as any, "INPUT_TOKEN_BUDGET", LIMITS.inputTokenBudget);
  const { kept: keptHistory, overflow } = splitHistory(history, budget);
  const summary = overflow.length >= 2 ? ((await summarizeHistory(env, MODELS.understand, overflow)) ?? undefined) : undefined;
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
  const withImage = effectiveImage || storedImage;
  const cached = fresh || contextual || declaredCtx || draftAct || apiCallIntent || withImage ? null : await cacheGet(env, gen, ns, q.query, q.lang, salt);
  const wantsStream = body?.stream === true || (tier === "anon" && body?.stream !== false);

  if (cached) {
    telemetry(env, ctx, tier, "ask", null, true, (cached.value.answer ?? "").length, cached.value.query_hash, q.lang, "exact", telemetryMeta());
    // echo the context the CACHED answer was computed under — the payload
    // stores it (cacheable excludes declared-context answers, but a model
    // node named in the question binds WITHOUT a chip and its echo must
    // survive the cache, not silently flatten to "none")
    const cctx = cached.value.context_applied ?? NO_CONTEXT;
    if (wantsStream) {
      // a cache hit must still speak SSE — the chat client parses a stream
      return sseResponse([
        { type: "citations", citations: cached.value.citations ?? [], quota, context_applied: cctx, ...(cached.value.source_quality ? { source_quality: cached.value.source_quality, confidence_note: cached.value.confidence_note ?? null, ...(cached.value.experimental_sources ? { experimental_sources: cached.value.experimental_sources } : {}), ...(cached.value.entailment ? { entailment: cached.value.entailment } : {}) } : {}) },
        { type: "token", v: cached.value.answer ?? "" },
        { type: "done", model: cached.value.model ?? MODELS.member, query_hash: cached.value.query_hash, served_from: "cache", context_applied: cctx },
      ], corsHeaders(req));
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

  // Tier-2 continuation: no new image, but the conversation carries one —
  // its most recent stored image re-attaches to this question. The query
  // scopes by the CONVERSATION'S OWNER (the messages table carries no
  // sub; ownership rides the conversation row) and the whole resolution
  // fails open: an optional feature never takes the ask down.
  try {
    if (!effectiveImage && !attachIds.length && conversationId && env.DB && member) {
      const prior = await env.DB.prepare(
        "SELECT m.attachment_id AS aid, a.mime, a.r2_key FROM messages m JOIN attachments a ON a.id = m.attachment_id JOIN conversations c ON c.id = m.conversation_id AND c.sub = ?2 WHERE m.conversation_id = ?1 AND m.role = 'user' AND m.attachment_id IS NOT NULL ORDER BY m.created_at DESC LIMIT 1",
      ).bind(conversationId, member.sub).first<{ aid: string; mime: string; r2_key: string }>();
      if (prior) {
          const obj = await (env as any).CHAT_UPLOADS.get(prior.r2_key);
          if (obj) {
            const bytes = new Uint8Array(await obj.arrayBuffer());
            let bin = "";
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            storedImage = `data:${prior.mime};base64,${btoa(bin)}`;
          }
      }
    }
  } catch {
    /* the reuse path is optional — the ask answers without the image */
  }

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
    const understandingP = understandQuery(portModelRunner(env), roleModel(env, "understand"), q.query, history, convEntities);
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
    stageTiming.understand = Date.now() - t0;
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
    // chip-less but the question TEXT names a publication: the same
    // deterministic naming the chip path uses must scope retrieval here
    // too — leaving it to the understanding model's extraction made
    // "What is OIML D 29?" a coin flip (nodoc → unscoped pool loses D 29
    // to R 29 and D-family neighbors; doc#29 → scoped pool answers). The
    // text is the user's own words; the LLM understanding augments but
    // never gates an explicit naming.
    const bare = understanding?.process_intent ? null : namedDocumentIn(q.query);
    if (bare && understanding?.doc_number !== bare.doc_number) {
      understanding = {
        ...(understanding ?? syntheticUnderstanding(bare)),
        docidentifier: bare.label,
        doc_number: bare.doc_number,
        edition: bare.edition ?? understanding?.edition ?? null,
      };
      console.log("question names", bare.label, "— scoping retrieval from the text");
    }
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
  // the certificate register as a database (TODO.new-era/6): a
  // register-shaped question queries the D1 table directly and the rows
  // join the prompt as an authoritative note — exact matches, never a
  // similarity guess about certification standing
  let register = await searchRegister(env.DB, q.query);
  // the nameplate bridge (TODO.new-era/6's image lane): a certificate
  // question WITH a photograph carries its manufacturer in the pixels —
  // one vision call extracts it, and those tokens re-query the register.
  // Fires whenever a photo is present: the text lane's tokens are the
  // question's stopwords ("this", "have") and can match an unrelated
  // holder, and the photograph's own reading is authoritative over them.
  const bridgeImage = userImage ?? storedImage;
  if (bridgeImage && /certificate|certified|certification/i.test(q.query)) {
    mark("Reading the nameplate photograph");
    const np = await extractNameplate((env as any).AI, MODELS.member, bridgeImage);
    if (np?.manufacturer) {
      const bridged = await searchRegister(env.DB, nameplateRegisterQuery(np, q.query), true);
      if (bridged?.rows?.length) {
        register = bridged;
        console.log("nameplate-bridge:", np.manufacturer, np.model ?? "", "→", bridged.rows.length, "register rows");
      }
    }
  }
  console.log("register-search:", JSON.stringify({ shaped: !!register, tokens: register?.tokens ?? null, rows: register?.rows?.length ?? null, first: register?.rows?.[0]?.num ?? null }));
  const regNote = register ? [registerNote(register.rows), certificateLinks(register.rows)].filter(Boolean).join("\n") : undefined;
  const ops = await operationsLane(env.DB, q.query);

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
      const stream = await generateStream(env, model, messages, effort);
      if (stream) {
        const encoder = new TextEncoder();
        const sse = new ReadableStream({
          async start(controller) {
            const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            // the reading arrives first — a conversational turn is still a reading
            if (readAs()) send({ type: "read", read: readAs() });
            send({ type: "citations", citations: [], context_applied: NO_CONTEXT, quota, });
            const stats: { usage?: unknown } = {};
            let full = "";
            try {
              for await (const tok of sseTokens(stream, stats)) {
                full += tok;
                send({ type: "token", v: tok });
              }
            } catch {
              // stream ended prematurely — deliver what we have
            }
            const tq = await chargeAnswerTokens(env, bucketId, stats, messageChars(messages), full.length);
            send({ type: "quota", quota: { ...quota, ...tq } });
            send({ type: "done", model, query_hash: queryHash, context_applied: NO_CONTEXT, read: readAs() });
            telemetry(env, ctx, tier, "ask", model, true, full.length, queryHash, q.lang, undefined, telemetryMeta());
            controller.close();
          },
        });
        return new Response(sse, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...corsHeaders(req) },
        });
      }
    }
    let answer = await generateOnce(env, model, messages, effort);
    if (answer === null) answer = await generateOnce(env, MODELS.fallback, messages, effort);
    if (answer === null) {
      telemetry(env, ctx, tier, "ask", model, false, 0, queryHash, q.lang, undefined, telemetryMeta());
      return err(502, "generation_failed", "The generation model is unavailable; please retry.");
    }
    telemetry(env, ctx, tier, "ask", model, true, answer.length, queryHash, q.lang, undefined, telemetryMeta());
    return json({ answer, citations: [], model, query_hash: queryHash, follow_ups: [], context_applied: NO_CONTEXT, read: readAs(), quota, });
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
      const exchanged = await liveTokenFor(env, sessionRaw, member);
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
    const citations = verdict.citation ? [{ ...verdict.citation, corpus: P().publisher.id }] : [];
    const draftPayload = verdict.status === "draft" ? verdict.draft : undefined;
    telemetry(env, ctx, tier, "ask", model, true, verdict.answer.length, queryHash, q.lang, undefined, telemetryMeta());
    if (wantsStream) {
      return sseResponse(
        [
          ...(readAs() ? [{ type: "read", read: readAs() }] : []),
          { type: "citations", citations, context_applied: draftCtxApplied, ...(draftPayload ? { draft: draftPayload } : {}), quota, },
          { type: "token", v: verdict.answer },
          { type: "done", model, query_hash: queryHash, context_applied: draftCtxApplied, read: readAs() },
        ],
        corsHeaders(req),
      );
    }
    const tq = await chargeAnswerTokens(env, bucketId, undefined, q.query.length, verdict.answer.length);
    return json({ answer: verdict.answer, citations, model, query_hash: queryHash, follow_ups: [], context_applied: draftCtxApplied, read: readAs(), ...(draftPayload ? { draft: draftPayload } : {}), quota: { ...quota, ...tq } });
  }

  // ── The api_call draft (TODO.ai-platform/09) — the operations
  // assistant's proposal grammar (apicalls.ts): one platform operation,
  // prepared as a draft, bounded by the affordance channel's machine
  // facet or the preference family's closed world. THE SERVICE NEVER
  // WRITES here either: the draft rides the response's `draft` field;
  // the panel pre-flights it against the platform's specification and
  // the platform's own gates judge the execution. Branched where the
  // prefill draft branches — the draft grounds in the conversation +
  // the operation directory, not the corpus passages.
  if (apiCallIntent) {
    const callCtxApplied = declaredCtx ? appliedContext(declaredCtx, null) : NO_CONTEXT;
    const queryHash = await sha256Hex(q.query);
    const verdict = await prepareApiCall(env, {
      intent: apiCallIntent,
      query: q.query,
      history: keptHistory,
      member,
      declared: declaredCtx,
      model: roleModel(env, "acts"),
    });
    console.log("api_call draft:", apiCallIntent, "→", verdict.status === "draft" ? `draft (${verdict.draft.call.method} ${verdict.draft.call.path})` : `refused (${verdict.reason})`);
    const draftPayload = verdict.status === "draft" ? verdict.draft : undefined;
    telemetry(env, ctx, tier, "ask", model, true, verdict.answer.length, queryHash, q.lang, undefined, telemetryMeta());
    if (wantsStream) {
      return sseResponse(
        [
          ...(readAs() ? [{ type: "read", read: readAs() }] : []),
          { type: "citations", citations: [], context_applied: callCtxApplied, ...(draftPayload ? { draft: draftPayload } : {}), quota, },
          { type: "token", v: verdict.answer },
          { type: "done", model, query_hash: queryHash, context_applied: callCtxApplied, read: readAs() },
        ],
        corsHeaders(req),
      );
    }
    const tq = await chargeAnswerTokens(env, bucketId, undefined, q.query.length, verdict.answer.length);
    return json({ answer: verdict.answer, citations: [], model, query_hash: queryHash, follow_ups: [], context_applied: callCtxApplied, read: readAs(), ...(draftPayload ? { draft: draftPayload } : {}), quota: { ...quota, ...tq } });
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
  const boundModel = P().publisher.features?.model_plane
    ? (await bindModelNode(env, {
        label: declaredCtx?.label,
        query: q.query,
        standard: standardForDocNumber(modelDocHint?.doc_number),
        standardKeys,
      })) ?? (await bindConstraintByQuantities(env, q.query, standardKeys))
    : null;
  if (boundModel) {
    ctxApplied = { ...ctxApplied, model: modelEcho(boundModel) };
    console.log("model plane: bound", boundModel.node_id, `[${boundModel.standard}]`, boundModel.clause?.urn ?? "no-clause", boundModel.gated ? "(gated: license)" : "");
  }
  // A GATED binding (licensed package, unentitled caller) keeps its
  // citation + echo — metadata the honesty posture keeps — and withholds
  // the grounding block and the verdict engine: no licensed machine
  // content enters the prompt by the binding lane either.
  const modelNote = boundModel && !boundModel.gated ? modelGroundingBlock(boundModel) : undefined;
  // ── the verdict engine (TODO.era3/01) ──
  // the worker EXECUTES the bound node's machine checks against the
  // question's stated values; the model narrates the computed verdict
  // and the verdict BLOCK is server-built — data, never generated prose
  const machineVerdict = boundModel && !boundModel.gated ? machineEvaluate(boundModel.content, q.query) : null;
  const machineNote = machineVerdict && boundModel ? verdictNote(machineVerdict, boundModel) : undefined;
  // ── condition-set membership (konneal/engine#90): the test-method
  // packages' severity menus as machine-verifiable membership. Fires
  // when no explicit node binding ran and the question states
  // quantities alongside severity vocabulary; the candidate sets come
  // from the model node store (kind condition_set), license-gated like
  // every model lane.
  // the model lanes' node store read: the doc hint joins the STANDARD id
  // (iec-60068-2-78 carries the part; oiml-r60 does not) — when the hint
  // names a part of a part-less package ("R 60-1"), retry on the stem
  const modelNodeRows = async (kind: string, docNum: string | undefined) => {
    const attempt = (num: string | undefined) => {
      const sql = num
        ? `SELECT standard, node_id, content FROM model_nodes WHERE kind = '${kind}' AND standard LIKE '%' || ?1`
        : `SELECT standard, node_id, content FROM model_nodes WHERE kind = '${kind}'`;
      return num ? env.DB.prepare(sql).bind(num) : env.DB.prepare(sql);
    };
    let rows = await attempt(docNum).all().catch(() => ({ results: [] }));
    if (!(rows.results ?? []).length && docNum && docNum.includes("-")) {
      rows = await attempt(docNum.replace(/-\d+$/, "")).all().catch(() => ({ results: [] }));
    }
    return rows;
  };
  let conditionVerdict: ConditionVerdict | null = null;
  let conditionStandard: string | null = null;
  if (!machineVerdict && !boundModel && P().publisher.features?.model_plane) {
    const ql = q.query.toLowerCase();
    const severityWord = /\b(severity|test|valid|tolerance|condition|within)\b/.test(ql);
    const stated = quantitiesIn(q.query);
    if (severityWord && Object.keys(stated).length >= 1) {
      const docNum = modelDocHint?.doc_number;
      // the doc number joins the STANDARD id (iec-60068-2-78), which is
      // the doc number prefixed with the package-family prefix
      const rows = await modelNodeRows("condition_set", docNum);
      const candidates = (rows.results ?? []).filter((r: any) => {
        const entry = licensedEntryForPackage(String(r.standard));
        return !entry || (standardKeys?.has(entry.key) ?? false);
      });
      const v = evaluateConditionSets(
        candidates.map((r: any) => ({ node_id: String(r.node_id), content: JSON.parse(String(r.content ?? "{}")) })),
        q.query,
      );
      if (v) {
        conditionVerdict = v;
        conditionStandard = String((rows.results?.[0] as any)?.standard ?? "");
      }
    }
  }
  const conditionNote = conditionVerdict && conditionStandard
    ? `${conditionVerdict.note} (computed from the ${conditionStandard} condition sets — machine evaluation, cite the package's clause.)`
    : undefined;
  const verdictBlock = machineVerdict
    ? {
        unit_id: boundModel!.node_id,
        type: "verdict",
        docidentifier: `${P().publisher.name} model (${boundModel!.standard})`,
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
  const conditionBlock = conditionVerdict
    ? {
        unit_id: conditionVerdict.matched[0] ?? conditionVerdict.nearest!.node_id,
        type: "verdict",
        docidentifier: `${P().publisher.name} model (${conditionStandard})`,
        payload: {
          verdict: conditionVerdict.verdict,
          missing: [],
          checks: conditionVerdict.checks.map((c) => ({
            expression: `${c.quantity_kind} within ${c.band}`,
            values: { stated: c.stated },
            result: c.in_band,
          })),
          ...(conditionVerdict.nearest
            ? { nearest: conditionVerdict.nearest }
            : { matched: conditionVerdict.matched }),
        },
      }
    : null;
  if (conditionVerdict) console.log("condition engine:", conditionVerdict.matched.join("|") || conditionVerdict.nearest!.node_id, "→", conditionVerdict.verdict.toUpperCase());
  // ── table-payload aggregation (konneal/engine#91): count / min / max
  // / interval lookup over the typed table nodes — deterministic
  // arithmetic where the answer IS the table's content. Fires when no
  // node binding, machine verdict or condition verdict ran; the
  // candidates are license-gated like every model lane.
  let aggregationVerdict: AggregationVerdict | null = null;
  let aggregationStandard: string | null = null;
  if (!machineVerdict && !boundModel && !conditionVerdict && P().publisher.features?.model_plane) {
    const docNum = modelDocHint?.doc_number;
    const rows = await modelNodeRows("table", docNum);
    const candidates = (rows.results ?? []).filter((r: any) => {
      const entry = licensedEntryForPackage(String(r.standard));
      return !entry || (standardKeys?.has(entry.key) ?? false);
    });
    const v = evaluateAggregation(
      candidates.map((r: any) => ({ node_id: String(r.node_id), content: JSON.parse(String(r.content ?? "{}")) })),
      q.query,
    );
    if (v) {
      aggregationVerdict = v;
      aggregationStandard = String((rows.results?.[0] as any)?.standard ?? "");
    }
  }
  const aggregationNote = aggregationVerdict
    ? `${aggregationVerdict.note}${aggregationStandard ? ` (standard ${aggregationStandard}.)` : ""}`
    : undefined;
  const aggregationBlock = aggregationVerdict
    ? {
        unit_id: aggregationVerdict.table,
        type: "verdict",
        docidentifier: `${P().publisher.name} model table${aggregationStandard ? ` (${aggregationStandard})` : ""}`,
        payload: {
          check: `${aggregationVerdict.operation}: ${aggregationVerdict.column ?? aggregationVerdict.table_title ?? aggregationVerdict.table} = ${aggregationVerdict.value}${aggregationVerdict.unit ? ` ${aggregationVerdict.unit}` : ""}`,
          meaning: aggregationVerdict.table_title,
          operation: aggregationVerdict.operation,
          value: aggregationVerdict.value,
          unit: aggregationVerdict.unit,
          row: aggregationVerdict.row,
        },
      }
    : null;
  if (aggregationVerdict) console.log("aggregation engine:", aggregationVerdict.operation, aggregationVerdict.table, "→", aggregationVerdict.value);
  // ── the licensed boundary note (TODO.rag/12): an unentitled question
  // that is topically ABOUT a licensed standard gets the boundary
  // posture — the citation graph names the public publications that
  // reference the licensed document, and the note instructs the model
  // to attribute, never to recite the licensed parameters.
  let boundaryNote: string | null = null;
  // the boost rides RETRIEVAL (the lexical lane below): chunks whose
  // prose references the licensed document — the referencing
  // publication's own clause — surface for a question the document's
  // vocabulary alone would miss
  let boundaryBoost: string | undefined;
  let licensedDocNumbers: string[] | undefined;
  // the EDITION boost: the grounding pool tilts to the publication's
  // ACTIVE edition (the graph's own registry) — the dirty corpus's
  // superseded editions otherwise outrank the current ones on shared
  // vocabulary, and the answer's current-edition values then read as
  // ungrounded against superseded passages. The family key is the
  // profile codec's (familyOf) — no publisher grammar here.
  let editionBoost: string | undefined;
  try {
    const fam = understanding?.doc ? refCodec().familyOf(understanding.doc) : null;
    if (fam) {
      const row = await env.DB.prepare("SELECT edition FROM documents WHERE family = ?1 AND active = 1 ORDER BY edition DESC LIMIT 1")
        .bind(fam).first<any>().catch(() => null);
      if (row?.edition) editionBoost = String(row.edition);
    }
  } catch {
    // a registry hiccup degrades to unsteered retrieval
  }
  const lexicalBoost = [boundaryBoost, editionBoost].filter(Boolean).join(" ") || undefined;
  if (P().sources?.licensed?.length) {
    const match = matchLicensedTopic(q.query, P().sources.licensed);
    if (match && (standardKeys?.has(match.entry.key) ?? false)) {
      // the entitled caller: the licensed lane pulls the package's own
      // units so they compete with (and outrank) the public restatements
      licensedDocNumbers = match.entry.package ? [match.entry.package] : undefined;
    } else if (match && !(standardKeys?.has(match.entry.key) ?? false)) {
      const docNum = match.entry.doc_number ?? "";
      boundaryBoost = docNum || undefined;
      let citing: string[] = [];
      if (docNum) {
        const rows = await env.DB.prepare(
          "SELECT n.label AS label FROM graph_edges e JOIN graph_nodes n ON e.src = n.id WHERE e.kind = 'cites' AND e.dst LIKE ?1 LIMIT 4",
        ).bind(`%${docNum}%`).all().catch(() => ({ results: [] }));
        citing = (rows.results ?? []).map((r: any) => String(r.label ?? "").replace(/^doc:/, ""));
      }
      boundaryNote = boundaryNoteText(match, citing);
    }
  }
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
          `Live account data (read ${live.readAt} from ${P().prompts.vars.account_note_source ?? `the user's own ${P().publisher.product_name} account`} — exactly what they may see, never more):\n` +
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
      sealScope: declaredScoped ? docScope : null, optimisticHits, optimisticVec,
      datasetScope: narrowed ? corpora : null, standardKeys, lexicalBoost, licensedDocNumbers });
    stageTiming["retrieve-core"] = Date.now() - tR;
    console.log("stage: retrieve", Date.now() - tR, "ms");
    // ── TTFT surgery: the two post-retrieval LLM calls run IN PARALLEL —
    // they consume the same candidate list (grade is coarse: good/weak;
    // listwise reorders survivors). Doc-scoped queries skip the grade
    // entirely (the filter already pins the corpus; grading adds only latency).
    const docScoped = !!(understanding?.doc_number);
    // the grader rides roleModel with the judges: the GRADER_MODEL secret
    // governs every grading path, and this one had kept reading the static
    // config (the retired model) like the judge route did
    const gradePromise = docScoped
      ? Promise.resolve("skipped-doc-scoped" as const)
      : (() => {
          const tg = Date.now();
          return gradeRetrieval(env.AI, roleModel(env, "grader"), q.query, retrieved.hits.map((h: Hit) => h.text))
            .catch(() => null)
            .finally(() => (stageTiming["grade"] = Date.now() - tg));
        })();
    if (retrieved.hits.length >= 4 && (member || understanding?.complexity === "complex")) {
      const tl = Date.now();
      const reordered = await listwiseRerank(env, MODELS.listwise, understanding?.standalone_query || q.query, retrieved.hits);
      stageTiming.listwise = Date.now() - tl;
      if (reordered) {
        console.log("listwise: reordered", reordered[0]?.metadata?.docidentifier ?? "?", "to top");
        retrieved = { ...retrieved, hits: reordered };
      }
    }
    const grade = await gradePromise;
    stageTiming.retrieve = Date.now() - tR;
    console.log("stage: grade+listwise", Date.now() - tR, "ms since retrieve start | grade:", grade);
    if (grade === "weak" && understanding?.docidentifier) {
      const broaden = `${understanding.standalone_query || q.query} ${understanding.docidentifier}`.trim();
      const tc = Date.now();
      const second = await retrieve(env, q.query, { prev, understanding, queryOverride: broaden, federate, datasetScope: narrowed ? corpora : null, standardKeys, sealScope: declaredScoped ? docScope : null, lexicalBoost });
      const grade2 = await gradeRetrieval(env.AI, roleModel(env, "grader"), q.query, second.hits.map((h: Hit) => h.text));
      stageTiming.corrective = Date.now() - tc;
      if (grade2 === "good") retrieved = second; // corrective retry must be strictly better
    }
  } catch (e) {
    console.log("ask: retrieval failed:", String(e).slice(0, 300));
    telemetry(env, ctx, tier, "ask", MODELS.embed, false, 0, await sha256Hex(q.query), q.lang, undefined, telemetryMeta());
    return err(503, "retrieval_unavailable", "Search is briefly busy — please retry in a moment.");
  }
  const { hits } = retrieved;
  if (hits.length === 0 && !liveRecords?.length && (!boundModel || boundModel.gated)) {
    // the license boundary refusal (TODO.external-refs/08) outranks the
    // plain "no information" sentence when the question's publication is
    // licensed and unentitled: name the standard, state the boundary,
    // point at the declare flow
    const answer =
      licenseBoundaryRefusal(modelDocHint?.doc_number ?? understanding?.doc_number ?? null, standardKeys) ?? refusalAnswer();
    const out = { answer, citations: [], model, query_hash: await sha256Hex(q.query), context_applied: ctxApplied };
    telemetry(env, ctx, tier, "ask", model, true, answer.length, out.query_hash, q.lang, undefined, telemetryMeta());
    return json({ ...out, quota, });
  }

  const processNote = understanding?.process_intent
    ? P().retrieval.process_note
    : undefined;
  // the license boundary (TODO.external-refs/08): the question's named or
  // understood publication is licensed and the caller's set lacks the key
  // — the refusal-class note rides the retrieval-note channel beside the
  // other structured facts
  const licenseNote = licenseBoundaryNote(modelDocHint?.doc_number ?? understanding?.doc_number ?? null, standardKeys);
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
  // the matched operations ride as CITABLE PASSAGES ahead of the
  // retrieved hits — the refusal logic and the citation machinery key on
  // passages, and a side-note cannot outrank the passages' silence
  const opsHits: Hit[] = ops.matched.map((m) => ({
    id: `ops:${m.anchor}`,
    score: 0.999,
    metadata: {
      doc_id: "smart-ops:catalog",
      docidentifier: m.docidentifier ?? "Platform API",
      doctype: "api-operation",
      doc_number: "",
      edition: "",
      language: "en",
      clause_anchor: m.anchor,
      clause_title: `Platform operation ${m.anchor}`,
      tier: "curated",
      corpus: "smart-ops",
      text_ref: "",
    },
    text: `${m.anchor} — ${m.text}`,
  }));
  const { messages, usedHits } = buildMessages(
    q.query,
    [...opsHits, ...hits],
    q.lang,
    keptHistory,
    // stage-extracted graph facts (GraphRAG) ride the same note channel
    [ops.note, processNote, eNote, regNote, contextNote(declaredCtx, docScope), accountNote, modelNote, vocabNote, memNote, machineNote, conditionNote, aggregationNote, boundaryNote, licenseNote, ...(retrieved.notes ?? [])].filter(Boolean).join("\n") || undefined,
    summary,
    budget,
  );
  await attachFigureImages(env, messages, usedHits, q.query);
  // the agent loop (the owner's 2026-09-28 direction): ONE bounded tool
  // round, armed only where a tool can help. The model may call
  // the registry tools through the strict line protocol; the worker
  // executes it deterministically and the ATTRIBUTED result joins the
  // messages — what the tool returned, for the string it asked. The
  // invocations record into pendingTools; the stream emits them as its
  // first events (the UI shows what the agent consulted).
  const pendingTools: { name: string; query: string; output: string }[] = [];
  // On an IMAGE turn the probe CARRIES THE IMAGE (2026-10-03, the owner's
  // architecture): the model that reads the plate is the model that issues
  // the tool call — one reader, one tool, no parallel extraction racing a
  // second vision pass that drifts hour to hour. The old probe dropped the
  // image-bearing message, which is why the private bridge had to exist.
  if (/certificate|certified|certification/i.test(q.query) && env.DB) {
    try {
      const imageTurn = typeof withImage === "string";
      if (imageTurn) mark("Reading the photograph to identify the instrument");
      const probeMessages: any[] = [...messages.slice(0, -1), { role: "user", content: `${TOOL_DECLARATION}\n\n${imageTurn ? "A photograph of the instrument is attached after this message. Transcribe the maker, model and any printed certificate number you can read FROM THE PHOTOGRAPH ITSELF, then emit the TOOL line with those tokens as the query — never invented, and never tokens taken from any register content elsewhere in the context (a register row's holder is not the plate's maker; observed live 2026-10-04)." : ""}\n\n${q.query}`.replace("\n\n\n\n", "\n\n") }];
      if (imageTurn) probeMessages.push({ role: "user", content: [{ type: "image_url", image_url: { url: withImage } }] });
      const probe = await (env as any).AI.run(model, {
        messages: probeMessages,
        max_tokens: 600,
        reasoning_effort: imageTurn ? "high" : "low",
      });
      const probeText = typeof probe?.response === "string" ? probe.response : probe?.choices?.[0]?.message?.content ?? "";
      const call = parseToolCall(probeText);
      if (call) {
        mark(`Searching the certificate register for “${String(call.args?.query ?? "")}”`);
        const result = await runTool(env, call);
        if (result) {
          messages.push({ role: "system", content: toolNote(result) });
          pendingTools.push(result);
          console.log("agent-tool:", result.name, JSON.stringify(result.query), "->", result.output.slice(0, 80));
        }
      }
    } catch {
      /* the loop is optional — the answer proceeds without the tool */
    }
  }
  if (withImage) {
    // the user's own image rides on the question message — retrieval stays
    // text-driven; the answer model reads the image as question context.
    // A markings/nameplate/certificate photo gets a TRANSCRIPTION note:
    // read the inscriptions verbatim first, then interpret from the
    // passages (the marking requirements are corpus content) — never
    // invent a marking that cannot be read.
    const wantsMarkings = /\b(mark(ing|ings)?|nameplate|label|inscription|engrav|sticker|plate)\b|certificat/i.test(q.query);
    const last = messages[messages.length - 1];
    const note = wantsMarkings
      ? "\n\n(The user attached a photo with this question. First transcribe every inscription you can actually read in the image — names, model references, accuracy classes, numeric values with their units, certificate or approval numbers — quoting them verbatim. Then answer the question from the numbered passages, citing the requirement each interpretation rests on. If an inscription is unreadable, say so; never invent a marking.)"
      : "\n\n(The user attached an image with this question; interpret it directly when answering.)";

    // the image rides its OWN SHORT TRAILING MESSAGE — never inside the
    // passage-bearing user message. Long text + image parts in ONE message
    // is the documented instability shape (2026-09-09); it was reintroduced
    // here, and the live "blindness" on photo answers (2026-10-03) was this
    // violation, not the model: the probe and extraction calls, which keep
    // the image on its own message, read the same plate every time.
    if (typeof last.content === "string") {
      last.content = last.content + note;
    } else {
      const textPart = last.content.find((p: any) => p.type === "text");
      if (textPart) textPart.text += note;
    }
    messages.push({ role: "user", content: [{ type: "image_url", image_url: { url: withImage } }] });
    console.log("user image attached to generation");
  }
  const queryHash = await sha256Hex(q.query);
  // The bound model node leads the citations (TODO.ai-platform/05): the
  // panel's first citation card IS the model node — its constraint, its
  // provenance — ahead of the prose passages.
  const cites = boundModel ? [modelCitation(boundModel), ...citations(usedHits)] : citations(usedHits);

  if (wantsStream) {
    const stream = await generateStream(env, model, messages, effort);
    if (stream) {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          // the agent trace arrives first: every questioning round the
          // assistant ran — the photograph read, the register search, any
          // re-answer — so the user watched what happened, not a spinner
          for (const step of agentSteps) {
            try { send({ type: "agent", step }); } catch { /* never block the answer */ }
          }
          for (const t of pendingTools) {
            try { send({ type: "tool", name: t.name, query: t.query }); } catch { /* never block the answer */ }
          }
          send({ type: "read", read: readAs() });
          const sourceQuality = answerQuality(cites.map((c: any) => c.quality));
          send({ type: "citations", citations: cites, context_applied: ctxApplied, ...(sourceQuality ? { source_quality: sourceQuality, confidence_note: qualityNote(sourceQuality), ...(sourceQuality === "ocr" ? { experimental_sources: experimentalSourceLabels(cites) } : {}) } : {}), ...(liveRecords ? { records: liveRecords } : {}), quota, });
          const stats: { usage?: unknown } = {};
          let full = "";
          try {
            for await (const tok of sseTokens(stream, stats)) {
              full += tok;
              send({ type: "token", v: tok });
            }
          } catch {
            // stream ended prematurely — deliver what we have
          }
          const tq = await chargeAnswerTokens(env, bucketId, stats, messageChars(messages), full.length);
          send({ type: "quota", quota: { ...quota, ...tq } });
          // the blind-answer guard ON THE STREAM PATH (the JSON path has
          // had it since 0.2.80): an image rode the turn, the register
          // note carries rows, and the streamed text is the no-information
          // refusal — the multimodal call answered around the photograph.
          // One bounded regeneration: the retry sentinel tells the client
          // to clear the buffer, the agent step says why, and the fresh
          // tokens stream as the answer.
          if (withImage && register?.rows?.length && full.includes(refusalAnswer())) {
            console.log("blind-answer(stream): regenerating once");
            mark("Re-answering from the register results");
            send({ type: "retry" });
            const regen = await generateStream(env, model, [
              ...messages.slice(0, -1),
              { role: "user", content: "The photograph was attached and the register note lists actual matching certificate rows. Present those rows — number, holder, model, status, and every document link — as the answer. Do not claim that nothing was provided." },
              messages[messages.length - 1],
            ], effort);
            if (regen) {
              full = "";
              try {
                for await (const tok of sseTokens(regen)) {
                  full += tok;
                  send({ type: "token", v: tok });
                }
              } catch { /* deliver what we have */ }
            }
          }
          const canonical0 = canonicalRefusal(full);
          // answer contract v2: validate [[u:]] refs, resolve typed blocks
          const c2 = canonical0.includes(refusalAnswer())
            ? { text: canonical0, blocks: [], dropped: [] as string[] }
            : await contractV2(env.DB, canonical0, usedHits);
          send({ type: "done", model, query_hash: queryHash, follow_ups: understanding?.follow_ups ?? [], blocks: [...c2.blocks, ...(verdictBlock ? [verdictBlock] : []), ...(conditionBlock ? [conditionBlock] : []), ...(aggregationBlock ? [aggregationBlock] : [])], context_applied: ctxApplied, read: readAs(),
            // the evidence view's ground truth: the exact passages this
            // answer was built from, compact — cache hits carry none,
            // because the cache stores the answer and never the passages
            passages: usedHits.slice(0, 8).map((h: Hit) => ({ d: h.metadata.docidentifier ?? "", a: h.metadata.clause_anchor ?? "", t: (h.text ?? "").slice(0, (h.metadata as any).block === "table" ? 1400 : 600), b: (h.metadata as any).block === "table" || undefined, ...((h.metadata as any).table_selection ? { s: (h.metadata as any).table_selection } : {}) })) });
          telemetry(env, ctx, tier, "ask", model, true, c2.text.length, queryHash, q.lang, undefined, telemetryMeta());
          const canonical = c2.text;

          // the entailment gate, streaming shape (TODO.new-era/10): the
          // measurement runs AFTER done — the chips, follow-ups and evidence
          // never wait on the grader; a final confidence event refreshes the
          // note when the measurement lands. Budgeted and fail-open like the
          // JSON path's gate.
          let streamedEntailment: { support: string; score: number; ungrounded?: string[] } | null = null;
          let streamedNote = "";
          if (THRESHOLDS.entailmentGate && sourceQuality && usedHits.length && !canonical.includes(refusalAnswer())) {
            const raced = await Promise.race([
              scoreFaithfulness(env.AI, roleModel(env, "grader"), canonical, usedHits.map((h: Hit) => h.text)),
              new Promise<null>((r) => setTimeout(() => r(null), THRESHOLDS.entailmentBudgetMs)),
            ]);
            if (raced) {
              const v = entailmentVerdict(raced.score, THRESHOLDS.entailmentSupportedFloor, THRESHOLDS.entailmentPartialFloor);
              streamedEntailment = { support: v.support, score: Math.round(raced.score * 100) / 100, ...(raced.ungrounded_claims?.length ? { ungrounded: raced.ungrounded_claims.slice(0, 3) } : {}) };
              streamedNote = v.note;
              if (v.support !== "supported") console.log("entailment(stream):", v.support, raced.score);
              send({ type: "confidence", source_quality: sourceQuality, confidence_note: streamedNote || qualityNote(sourceQuality), ...(streamedEntailment ? { entailment: streamedEntailment } : {}) });
            }
          }
          // streamed answers can't be regenerated mid-flight; enforcement
          // is that an unverified answer is never served from cache again
          const streamedAnchors = checkQuoteAnchors(canonical, usedHits.map((h: Hit) => h.text));
          const streamedRetyped = tableRetyped(canonical, usedHits.some((h: Hit) => h.metadata.unit_id && h.metadata.block === "table"));
          const streamed = { total: streamedAnchors.total, violations: streamedRetyped ? ["table-retyped"] : streamedAnchors.violations };
          if (streamed.violations.length > 0) {
            console.log("anchors:", streamed.violations.length, "of", streamed.total, "unverified — not caching");
          }
          if (streamed.violations.length === 0 && canonical.length > 0 && !contextual && !declaredCtx && !canonical.includes(refusalAnswer())) {
            ctx.waitUntil(
              env.CACHE.put(exactCacheKey(env.INDEX_VERSION, gen, ns, await sha256Hex(cacheKeyMaterial(q.query, q.lang, salt))), JSON.stringify({ answer: canonical, citations: cites, model, query_hash: queryHash, ...(sourceQuality ? { source_quality: sourceQuality, confidence_note: streamedNote || qualityNote(sourceQuality) } : {}), ...(streamedEntailment ? { entailment: streamedEntailment } : {}) }), { expirationTtl: LIMITS.cacheTtlSec }),
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

  const tGen = Date.now();
  let answer = await generateOnce(env, model, messages, effort);
  if (answer === null) {
    generateRetries += 1;
    // the fallback is a text-only model: image parts must be flattened
    // out first or it errors on (or silently ignores) the pixels the
    // primary was carrying — and the figure-attach NOTE with them: a
    // message saying "the image is attached" to a model that cannot see
    // images gets ANSWERED ("I don't have access to the original
    // image…") instead of the question (observed in the wild). The
    // user-image message keeps its text (the question) minus its note.
    const isFigureAttachMessage = (m: any) =>
      Array.isArray(m.content) &&
      m.content.some((part: any) => part?.type === "text" && /^The original image of figure unit /.test(part.text ?? ""));
    const flat = messages
      .filter((m: any) => !isFigureAttachMessage(m))
      .map((m: any) =>
        typeof m.content === "string"
          ? m
          : { ...m, content: m.content.filter((p: any) => p?.type === "text").map((p: any) => (p?.text ?? "").replace(/\n?\(The user attached an image with this question; interpret it directly when answering\.\)/, "")).join("\n") },
      );
    answer = await generateOnce(env, MODELS.fallback, flat, effort);
  }
  if (answer) answer = canonicalRefusal(answer);
  stageTiming.generate = Date.now() - tGen;

  // ── Deterministic quote-anchor + table-retyping check ──
  // One corrective regeneration when an anchor quotes text absent from
  // the passages or a typed table was retyped as markdown; the retry
  // wins only if it verifies better.
  let used = usedHits;
  if (answer && !answer.includes(refusalAnswer())) {
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
      generateRetries += 1;
      const corrected = await generateOnce(env, model, [...messages, { role: "system", content: note }], effort);
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
  if (answer && !answer.includes(refusalAnswer())) {
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
        datasetScope: narrowed ? corpora : null,
        standardKeys,
      });
      if (retryRetrieve.hits.length > 0) {
        const { messages: retryMessages, usedHits: retryUsed } = buildMessages(q.query, retryRetrieve.hits, q.lang, keptHistory, undefined, summary, budget);
        const retryAnswer = await generateOnce(env, model, retryMessages, effort);
        // the answer now comes from the retry passages — citations must follow
        if (retryAnswer) {
          answer = canonicalRefusal(retryAnswer);
          used = retryUsed;
        }
      }
    }
  }

  if (answer === null) {
    telemetry(env, ctx, tier, "ask", model, false, 0, queryHash, q.lang, undefined, telemetryMeta());
    return err(502, "generation_failed", "The generation model is unavailable; please retry.");
  }
  const finalCites = boundModel ? [modelCitation(boundModel), ...citations(used)] : citations(used);
  const c2ns = answer.includes(refusalAnswer())
    ? { text: answer, blocks: [] as Awaited<ReturnType<typeof contractV2>>["blocks"], dropped: [] as string[] }
    : await contractV2(env.DB, answer, used);
  answer = c2ns.text;
  const finalAnchors = answer.includes(refusalAnswer())
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
  let completionBlocks: Awaited<ReturnType<typeof completeTables>> = [];
  if (!answer.includes(refusalAnswer()) && !c2ns.blocks.some((b: any) => b.type === "table")) {
    completionBlocks = await completeTables(env.DB, answer, used);
    if (completionBlocks.length) console.log("contract completion:", completionBlocks.length, "table block(s) attached server-side");
  }

  // figure completion (#172) — see ./completion for the rationale
  completionBlocks.push(...(await completeFigures(env.DB, answer, [...c2ns.blocks, ...completionBlocks], used)));

  // the blind-answer regeneration (2026-10-03, live on the photo case):
  // the multimodal call can answer AROUND an attached image — a 200 whose
  // text claims nothing was provided — while the bridge succeeded and the
  // register note carries actual rows. One bounded regeneration, decided on
  // that exact signature; the retry carries a sterner ground instruction.
  if (withImage && register?.rows?.length && answer.includes(refusalAnswer())) {
    console.log("blind-answer: the register note carried rows but the answer refused — regenerating once");
    mark("Re-answering from the register results");
    const regen = await generateOnce(env, model, [
      ...messages.slice(0, -1),
      { role: "user", content: "The photograph was attached and the register note lists actual matching certificate rows. Present those rows — number, holder, model, status, and every document link — as the answer. Do not claim that nothing was provided." },
      messages[messages.length - 1],
    ], effort);
    if (regen && !regen.includes(refusalAnswer())) {
      answer = canonicalRefusal(regen);
      console.log("blind-answer: regeneration grounded");
    }
  }

  const jsonQuality = answerQuality(finalCites.map((c: any) => c.quality));
  // the entailment gate (TODO.new-era/10): the eval battery's faithfulness
  // scorer, promoted onto the serving path — the confidence line states a
  // measurement (claim support in the cited passages), not only the source
  // rung. Budgeted and fail-open: a slow or unparseable check leaves the
  // rung note untouched; refusals and uncited answers have nothing to gate.
  let entailment: { support: string; score: number; ungrounded?: string[] } | null = null;
  let entailmentNote = "";
  if (THRESHOLDS.entailmentGate && jsonQuality && used.length && !answer.includes(refusalAnswer())) {
    const raced = await Promise.race([
      scoreFaithfulness(env.AI, roleModel(env, "grader"), answer, (used as Hit[]).map((h: Hit) => h.text)),
      new Promise<null>((r) => setTimeout(() => r(null), THRESHOLDS.entailmentBudgetMs)),
    ]);
    if (raced) {
      const v = entailmentVerdict(raced.score, THRESHOLDS.entailmentSupportedFloor, THRESHOLDS.entailmentPartialFloor);
      entailment = { support: v.support, score: Math.round(raced.score * 100) / 100, ...(raced.ungrounded_claims?.length ? { ungrounded: raced.ungrounded_claims.slice(0, 3) } : {}) };
      entailmentNote = v.note;
      if (v.support !== "supported") console.log("entailment:", v.support, raced.score, raced.ungrounded_claims?.slice(0, 2));
    }
  }
  const out = { answer, citations: finalCites, ...(jsonQuality ? { source_quality: jsonQuality, confidence_note: entailmentNote || qualityNote(jsonQuality), ...(entailment ? { entailment } : {}), ...(jsonQuality === "ocr" ? { experimental_sources: experimentalSourceLabels(finalCites) } : {}) } : {}), model: MODELS.member, query_hash: queryHash, follow_ups: understanding?.follow_ups ?? [], blocks: [...c2ns.blocks, ...(verdictBlock ? [verdictBlock] : []), ...(conditionBlock ? [conditionBlock] : []), ...(aggregationBlock ? [aggregationBlock] : []), ...completionBlocks], context_applied: ctxApplied, ...(liveRecords ? { records: liveRecords } : {}) };
  const cacheable = !contextual && !declaredCtx && !answer.includes(refusalAnswer()) && finalAnchors.violations.length === 0;
  if (cacheable) {
    const ck = exactCacheKey(env.INDEX_VERSION, gen, ns, await sha256Hex(cacheKeyMaterial(q.query, q.lang, salt)));
    ctx.waitUntil(env.CACHE.put(ck, JSON.stringify(out), { expirationTtl: LIMITS.cacheTtlSec }));
  }
  telemetry(env, ctx, tier, "ask", model, true, answer.length, queryHash, q.lang, undefined, telemetryMeta());
  // grounding transparency for integrators (and the eval battery): the
  // passages the answer was actually built from — response-only, never
  // stored in the answer cache
  const contextOut = used.map((h: Hit) => ({
    doc_id: h.metadata.doc_id,
    clause_anchor: h.metadata.clause_anchor,
    text: h.text.slice(0, 1200),
    ...((h.metadata as any).table_selection ? { sel: (h.metadata as any).table_selection } : {}),
  }));
  const tq = await chargeAnswerTokens(env, bucketId, undefined, messageChars(messages), answer.length);
  return json({ ...out, context: contextOut, read: readAs(), quota: { ...quota, ...tq } }, 200, { ...corsHeaders(req), "server-timing": serverTiming() });
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

// ── the route table (TODO.impl/03) ───────────────────────────────────────

export { handleAsk };
