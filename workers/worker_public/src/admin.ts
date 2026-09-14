// Admin-surface handlers: enrichment, section units, captions, vector
// ops, judging, API-key management — every ADMIN_TOKEN-gated route's
// behavior lives here (TODO.impl/23); index.ts only registers them.
import { MODELS, num, sha256Hex, today } from "./config";
import { embed } from "./ai";
import { err, json, corsHeaders, readJson } from "./lib/http";
import type { Env } from "./env";
import enrichmentPrompt from "../prompts/enrichment.md";
import sectionSummaryPrompt from "../prompts/section-summary.md";
import relevancyPrompt from "../prompts/relevancy.md";
import precisionPrompt from "../prompts/precision.md";
import { scoreFaithfulness } from "./faithfulness";
import { scoreJudge } from "./grader";
import { portModelRunner } from "./env.ts";
import { P } from "./profile.ts";
import { fill, promptVars } from "./pipeline.ts";

/** Contextual enrichment (quality-first lane): for each chunk, write a
 *  situating context (KV-cached per chunk id), embed context+text, and
 *  upsert in place — the enrichment persists into every future retrieval
 *  of that chunk. Driven by ingest/enrich.py in resumable batches. */
export async function handleEnrich(env: Env, ctx: ExecutionContext, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const chunks = Array.isArray(body?.chunks) ? body.chunks : [];
  if (chunks.length === 0 || chunks.length > 8) return err(400, "invalid_input", "chunks: 1-8 required");
  const force = body?.force === true;
  // mode:"context" generates/returns the situating preamble WITHOUT
  // embedding or upserting — the comparison-lane builders use it so lane
  // chunks can never land in the production index (the 2026-09-02
  // incident: 1,126 lane vectors entered production through this
  // endpoint's upsert side effect). Default mode stays the production
  // enrichment flow (context + embed + upsert in place).
  const contextOnly = body?.mode === "context";
  // mode:"ab" (the enrichment effort experiment): generate WITHOUT any
  // side effect — no KV cache read or write, no embed, no upsert — with
  // an explicit effort. The A/B compares low vs high effort on identical
  // chunks; polluting the production context cache would decide the
  // experiment before the judge does.
  const abMode = body?.mode === "ab";
  const effort = body?.effort === "high" ? "high" : "low";
  // ab-mode only: an admin-gated system-prompt override, so experiment
  // harnesses can run judged comparisons through the binding lane — the
  // REST ai/run token flakes 401 on this account (three waves running)
  const abPrompt = abMode && typeof body?.prompt === "string" ? body.prompt.slice(0, 4000) : null;
  const model = typeof env.ENRICH_MODEL === "string" && env.ENRICH_MODEL ? env.ENRICH_MODEL : MODELS.enrich;

  const usage = { prompt_tokens: 0, completion_tokens: 0, requests: 0, cache_hits: 0 };
  const results = await Promise.all(
    chunks.map(async (c: any) => {
      if (!c?.id || typeof c?.text !== "string" || !c?.metadata) return { id: c?.id ?? null, ok: false, error: "invalid chunk" };
      try {
        const cacheKey = `e:${c.id}`;
        let context = force || abMode ? null : await env.CACHE.get(cacheKey);
        const cached = !!context;
        if (!context) {
          const m = c.metadata;
          const head = `${m.docidentifier ?? m.doc_id}${m.clause_anchor ? " §" + m.clause_anchor : ""}${m.clause_title ? " — " + m.clause_title : ""}`;
          const res: any = await env.AI.run(model, {
            messages: [
              { role: "system", content: (abMode && abPrompt) || fill(enrichmentPrompt, promptVars()).trimEnd() },
              { role: "user", content: abMode && abPrompt ? String(body?.user_text ?? "").slice(0, 4000) : `${head}\n\n${c.text.slice(0, 1500)}` },
            ],
            max_tokens: 1600,
            // measured (2026-09-12, TODO.impl/62): high effort beats low
            // 58% vs 25% on blind pairwise judging at equal length — the
            // enrichment lane is one-time and quality-first, so the win
            // compounds into every future retrieval
            reasoning_effort: abMode ? effort : "high",
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
          if (!abMode) ctx.waitUntil(env.CACHE.put(cacheKey, context, { expirationTtl: 2_592_000 }));
        } else {
          usage.cache_hits += 1;
        }
        if (contextOnly) return { id: c.id, ok: true, cached, context };
        const original = typeof c.metadata.chunk_text === "string" && c.metadata.chunk_text ? c.metadata.chunk_text : c.text;
        const enriched = `${context}\n\n${original}`;
        const vector = await embed(portModelRunner(env), MODELS.embed, enriched.slice(0, 6000));
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

/** Section-summary units (FABLE/BEAR multi-granularity, arXiv:2601.18116):
 *  the corpus's clause chunks start at depth 2 ("3.1"), so the tree has no
 *  depth-1 nodes. This endpoint writes them: a summary of each top-level
 *  clause generated from its child chunks' excerpts (quality-first lane,
 *  KV-cached per unit id), embedded as toc-path ⊕ summary à la FABLE's
 *  internal-node indexing, and upserted as a navigation node — serving
 *  descends from it to quotable leaf clauses (pipeline.ts section
 *  descent). Credential, batching and ledger mirror /admin/enrich. */
export async function handleSectionUnit(env: Env, ctx: ExecutionContext, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const units = Array.isArray(body?.units) ? body.units : [];
  if (units.length === 0 || units.length > 6) return err(400, "invalid_input", "units: 1-6 required");
  const model = typeof env.ENRICH_MODEL === "string" && env.ENRICH_MODEL ? env.ENRICH_MODEL : MODELS.enrich;

  const usage = { prompt_tokens: 0, completion_tokens: 0, requests: 0, cache_hits: 0 };
  const results = await Promise.all(
    units.map(async (u: any) => {
      const m = u?.metadata ?? {};
      if (!u?.id || typeof u?.id !== "string" || !m?.doc_id || !m?.clause_anchor || !Array.isArray(u?.children) || u.children.length === 0) {
        return { id: u?.id ?? null, ok: false, error: "invalid unit (id, metadata.doc_id, metadata.clause_anchor, children required)" };
      }
      try {
        const cacheKey = `s:${u.id}`;
        let summary = body?.force === true ? null : await env.CACHE.get(cacheKey);
        const cached = !!summary;
        if (!summary) {
          const head = `${m.docidentifier ?? m.doc_id} §${m.clause_anchor}${m.clause_title ? " — " + m.clause_title : ""}`;
          const listing = u.children
            .slice(0, 12)
            .map((c: any) => `§${c.anchor ?? ""}${c.title ? " " + c.title : ""} — ${String(c.excerpt ?? "").slice(0, 260)}`)
            .join("\n");
          const res: any = await env.AI.run(model, {
            messages: [
              { role: "system", content: sectionSummaryPrompt.trimEnd() },
              { role: "user", content: `${head}\n\nSub-clauses:\n${listing}` },
            ],
            max_tokens: 1600, // parity with the chunk-enrichment call — 900 starved ~40% of section summaries (model-card budget rule)
            reasoning_effort: "low",
          });
          const raw = typeof res?.response === "string" && res.response.trim() ? res.response : res?.choices?.[0]?.message?.content;
          summary = typeof raw === "string" ? raw.trim().replace(/^["']|["']$/g, "").slice(0, 500) : "";
          if (!summary) return { id: u.id, ok: false, error: "empty summary" };
          if (res?.usage) {
            usage.prompt_tokens += Number(res.usage.prompt_tokens ?? 0);
            usage.completion_tokens += Number(res.usage.completion_tokens ?? 0);
          }
          usage.requests += 1;
          ctx.waitUntil(env.CACHE.put(cacheKey, summary, { expirationTtl: 2_592_000 }));
        } else {
          usage.cache_hits += 1;
        }
        const childAnchors = u.children.map((c: any) => c.anchor).filter(Boolean).join(",");
        const text = `§${m.clause_anchor}${m.clause_title ? " " + m.clause_title : ""} — ${summary}\nCovers: ${childAnchors}`;
        const vectorText = `${m.docidentifier ?? m.doc_id} §${m.clause_anchor} ${text}`.slice(0, 2000);
        const vector = await embed(portModelRunner(env), MODELS.embed, vectorText);
        await env.VECTORIZE.upsert([
          { id: u.id, values: vector, metadata: { ...m, chunk_text: text, section_summary: "1", child_anchors: childAnchors, ctx: "1" } },
        ]);
        return { id: u.id, ok: true, cached, children: u.children.length };
      } catch (e: any) {
        return { id: u.id, ok: false, error: String(e?.message ?? e).slice(0, 200) };
      }
    }),
  );
  const ok = results.filter((r: any) => r.ok).length;
  console.log("section units:", ok, "/", results.length, "usage:", JSON.stringify(usage));
  if (usage.requests > 0) {
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

/** Ops access to the Vectorize binding (get/upsert by id) for offline
 *  passes like embedding smoothing (G-ETSI-4) — the binding is the
 *  credential, admin-token gated exactly like /admin/enrich. */
/** One-time figure captioning (TODO.remaining/03): fetch the unit's asset
 *  from R2, describe it with the vision-capable answer model, store the
 *  description into unit_payloads. Admin-gated; idempotent. */
export async function handleCaption(env: Env, req: Request): Promise<Response> {
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
    // chunked: spreading the whole byte array blows the V8 stack on large
    // assets (the 389KB u:figure-1)
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const b64 = btoa(binary);
    let res: any = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await env.AI.run(MODELS.member, {
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
      } catch {
        // transient Workers AI flake (8005) — retry once
      }
    }
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    if (!text?.trim()) return err(502, "generation_failed", "vision model returned no description");
    const desc = text.trim().slice(0, 600);
    await env.DB.prepare("UPDATE unit_payloads SET payload = json_set(payload, '$.description', ?1) WHERE unit_id = ?2").bind(desc, unitId).run();
    return json({ ok: true, unit_id: unitId, description: desc });
  } catch (e) {
    return err(502, "caption_failed", String(e).slice(0, 200));
  }
}

export async function handleVectors(env: Env, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const mode = body?.mode;
  try {
    if (mode === "get") {
      const ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === "string").slice(0, 100) : [];
      if (!ids.length) return err(400, "invalid_input", "ids: 1-100 required");
      // getByIds above ~20 ids returns EMPTY (observed: 16/20 fine, 24+
      // silently zero) — chunk server-side so the documented 100 actually
      // works instead of lying to callers
      const vectors: any[] = [];
      for (let i = 0; i < ids.length; i += 20) {
        const got = (await env.VECTORIZE.getByIds(ids.slice(i, i + 20))) ?? [];
        for (const v of got) vectors.push({ id: v.id, values: v.values, metadata: v.metadata ?? null });
      }
      return json({ vectors });
    }
    if (mode === "upsert") {
      const vectors = Array.isArray(body?.vectors)
        ? body.vectors.filter((v: any) => v && typeof v.id === "string" && Array.isArray(v.values))
        : [];
      if (!vectors.length || vectors.length > 100) return err(400, "invalid_input", "vectors: 1-100 required");
      await env.VECTORIZE.upsert(vectors);
      return json({ ok: true, upserted: vectors.length });
    }
    if (mode === "embed") {
      // comparison-lane indexing (TODO.model-rag): embed text via the
      // binding's model so lane builders don't need AI REST scope
      const texts = Array.isArray(body?.texts) ? body.texts.filter((t: unknown) => typeof t === "string").slice(0, 16) : [];
      if (!texts.length) return err(400, "invalid_input", "texts: 1-16 required");
      const vectors: number[][] = [];
      for (const t of texts) {
        const v = await embed(portModelRunner(env), MODELS.embed, t.slice(0, 6000));
        vectors.push(v);
      }
      return json({ vectors });
    }
    return err(400, "invalid_input", "mode must be get, upsert, or embed");
  } catch (e) {
    return err(502, "vectorize_failed", String(e).slice(0, 200));
  }
}

export async function handleJudge(env: Env, req: Request): Promise<Response> {
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
    passages.length ? scoreJudge(env.AI, MODELS.grader, fill(precisionPrompt, promptVars()), `Question: ${question}\n\nPassages:\n${passagesText}`) : Promise.resolve(null),
  ]);
  return json({
    question_hash: await sha256Hex(question),
    faithfulness: faith ? faith.score : null,
    answer_relevancy: relevancy,
    context_precision: precision,
  });
}

export async function handleCreateKey(env: Env, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  if (!body?.name || typeof body.name !== "string") return err(400, "invalid_input", "name is required");
  const dayLimit = Number.isFinite(Number(body.day_limit)) && Number(body.day_limit) > 0 ? Number(body.day_limit) : num(env as any, "KEY_DAY_ASK_DEFAULT", 2000);
  const raw = `${P().publisher.id}_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const id = crypto.randomUUID();
  const keyHash = await sha256Hex(raw);
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, day_limit, created_at, revoked) VALUES (?1,?2,?3,?4,?5,0)",
  )
    .bind(id, body.name, keyHash, dayLimit, new Date().toISOString())
    .run();
  return json({ id, name: body.name, day_limit: dayLimit, key: raw, note: "Store this key now — it is not retrievable again." });
}

export async function handleListKeys(env: Env, req: Request): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const rows = await env.DB.prepare(
    "SELECT id, name, day_limit, created_at, revoked FROM api_keys ORDER BY created_at DESC",
  ).all();
  return json({ keys: rows.results, ...corsHeaders(req) });
}

/** Revoke an API key (soft: revoked = 1 — the hash row stays for
 *  audit; authenticate() already excludes revoked keys). */
export async function handleRevokeKey(env: Env, req: Request, id: string): Promise<Response> {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const r = await env.DB.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ?1 AND revoked = 0").bind(id).run();
  return json({ ok: true, updated: r.meta?.changes ?? 0 });
}
