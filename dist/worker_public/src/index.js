import {
  handleSearch
} from "../../chunk-ACH3SUYT.js";
import {
  bindModelNode,
  checkQuoteAnchors,
  handleAsk,
  handleMemories,
  modelGroundingBlock,
  scoreJudge,
  standardForDocNumber
} from "../../chunk-L63E7GRC.js";
import {
  buildMessages,
  citations,
  editionNote,
  embed,
  fill,
  ftsMatchQuery,
  generateOnce,
  graphExpand,
  handleCallback,
  handleLogin,
  handleLogout,
  handleMe,
  namedDocumentIn,
  opTokenMember,
  parseAppliedContext,
  portModelRunner,
  promptVars,
  refCodec,
  retrieve,
  sessionFrom,
  telemetry,
  understandQuery
} from "../../chunk-2AQYUGLB.js";
import {
  authenticate,
  corsHeaders,
  err,
  json,
  readJson,
  validateQuery,
  withCors
} from "../../chunk-R2V3X6SQ.js";
import {
  canonicalRefusal
} from "../../chunk-A3QHHUN5.js";
import {
  entitlementScope,
  standardKeysFrom
} from "../../chunk-4GJGBGJK.js";
import {
  LIMITS,
  MODELS,
  STARTERS,
  SUGGESTIONS,
  datasetsFor,
  num,
  roleModel,
  sha256Hex,
  today
} from "../../chunk-V46XM2GU.js";
import {
  P,
  setProfile
} from "../../chunk-3FYJM7LH.js";

// workers/worker_public/src/conversations.ts
var ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
async function ownedConversation(env, sub, id) {
  if (!ID_RE.test(id)) return null;
  const row = await env.DB.prepare(
    "SELECT id, sub, title, created_at, updated_at FROM conversations WHERE id = ?1 AND sub = ?2"
  ).bind(id, sub).first();
  return row ?? null;
}
async function handleConversations(env, sub, req, route) {
  const { method, id } = route;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (method === "GET" && !id) {
    const rows = await env.DB.prepare(
      "SELECT c.id, c.title, c.updated_at, c.project_id, COUNT(m.id) AS messages FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id WHERE c.sub = ?1 GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 50"
    ).bind(sub).all();
    return json({ conversations: rows.results ?? [] });
  }
  if (method === "POST" && !id) {
    const body = await req.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.slice(0, 120) : "";
    const cid = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO conversations (id, sub, title, created_at, updated_at) VALUES (?1,?2,?3,?4,?4)"
    ).bind(cid, sub, title, now).run();
    return json({ id: cid }, 201);
  }
  if (id && method === "GET") {
    const conv = await ownedConversation(env, sub, id);
    if (!conv) return err(404, "not_found", "No such conversation");
    let msgs;
    try {
      msgs = await env.DB.prepare(
        "SELECT id, role, content, citations, model, context_applied, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC"
      ).bind(id).all();
    } catch {
      msgs = await env.DB.prepare(
        "SELECT id, role, content, citations, model, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC"
      ).bind(id).all();
    }
    return json({
      conversation: { id: conv.id, title: conv.title, createdAt: conv.created_at, updatedAt: conv.updated_at },
      messages: (msgs.results ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        citations: m.citations ? JSON.parse(m.citations) : null,
        model: m.model,
        context_applied: m.context_applied ? JSON.parse(m.context_applied) : null,
        at: m.created_at
      }))
    });
  }
  if (id && method === "PATCH") {
    const body = await req.json().catch(() => null);
    if (typeof body?.title !== "string" || !body.title.trim() || body.title.length > 120) {
      return err(400, "invalid_input", "title (1-120 chars) is required");
    }
    const conv = await ownedConversation(env, sub, id);
    if (!conv) return err(404, "not_found", "No such conversation");
    await env.DB.prepare("UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3 AND sub = ?4").bind(body.title.trim(), now, id, sub).run();
    return json({ ok: true });
  }
  if (id && method === "DELETE") {
    const conv = await ownedConversation(env, sub, id);
    if (!conv) return err(404, "not_found", "No such conversation");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?1").bind(id),
      env.DB.prepare("DELETE FROM conversations WHERE id = ?1 AND sub = ?2").bind(id, sub)
    ]);
    return json({ ok: true });
  }
  return err(405, "method_not_allowed", "Unsupported method");
}
async function handleAppendMessage(env, sub, req, convId) {
  const body = await req.json().catch(() => null);
  const role = body?.role;
  const content = typeof body?.content === "string" ? body.content : "";
  if (role !== "user" && role !== "assistant" || !content.trim() || content.length > LIMITS.maxOutputTokens * 4) {
    return err(400, "invalid_input", "role (user|assistant) and content are required");
  }
  let citations2 = null;
  if (body?.citations != null) {
    if (!Array.isArray(body.citations) || body.citations.length > 16) {
      return err(400, "invalid_input", "citations must be an array of at most 16 items");
    }
    citations2 = JSON.stringify(body.citations);
  }
  const applied = parseAppliedContext(body?.context_applied);
  const conv = await ownedConversation(env, sub, convId);
  if (!conv) return err(404, "not_found", "No such conversation");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const mid = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO messages (id, conversation_id, role, content, citations, model, context_applied, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
      ).bind(mid, convId, role, content, citations2, typeof body?.model === "string" ? body.model.slice(0, 80) : null, applied ? JSON.stringify(applied) : null, now),
      env.DB.prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2 AND sub = ?3").bind(now, convId, sub)
    ]);
  } catch (e) {
    if (!String(e).includes("context_applied")) throw e;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO messages (id, conversation_id, role, content, citations, model, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)"
      ).bind(mid, convId, role, content, citations2, typeof body?.model === "string" ? body.model.slice(0, 80) : null, now),
      env.DB.prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2 AND sub = ?3").bind(now, convId, sub)
    ]);
  }
  return json({ id: mid }, 201);
}

// workers/worker_public/src/projects.ts
var MAX_FILES = 10;
var MAX_CONTENT = 8e3;
var MAX_NAME = 64;
var PROJECT_ID_RE = /^p:[a-f0-9]{16}$/;
var FILE_ID_RE = /^pf:[a-f0-9]{16}$/;
var hex16 = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function ownedProject(env, sub, id) {
  if (!PROJECT_ID_RE.test(id)) return null;
  return await env.DB.prepare("SELECT id, name, created_at FROM projects WHERE id = ?1 AND sub = ?2").bind(id, sub).first();
}
async function handleProjects(env, sub, req, route) {
  const { method, id } = route;
  if (method === "GET") {
    const rows = (await env.DB.prepare(
      "SELECT p.id, p.name, p.created_at, (SELECT COUNT(*) FROM project_files f WHERE f.project_id = p.id) AS file_count, (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS conversation_count FROM projects p WHERE p.sub = ?1 ORDER BY p.created_at DESC"
    ).bind(sub).all()).results ?? [];
    return json({ projects: rows });
  }
  if (method === "POST") {
    const body = await req.json().catch(() => null);
    if (body && (typeof body.project_id === "string" || body.project_id === null)) {
      const convId = String(body.conversation_id ?? "");
      if (!/^[a-zA-Z0-9_-]{8,64}$/.test(convId)) return err(400, "invalid_input", "bad conversation id");
      const target = body.project_id === null ? null : String(body.project_id);
      if (target && !await ownedProject(env, sub, target)) return err(404, "not_found", "no such project");
      const r = await env.DB.prepare("UPDATE conversations SET project_id = ?1 WHERE id = ?2 AND sub = ?3").bind(target, convId, sub).run();
      if (!r.meta?.changes) return err(404, "not_found", "no such conversation");
      return json({ ok: true });
    }
    if (typeof body?.id === "string" && PROJECT_ID_RE.test(body.id)) {
      if (!await ownedProject(env, sub, body.id)) return err(404, "not_found", "no such project");
      const name2 = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
      if (!name2) return err(400, "invalid_input", "name required");
      await env.DB.prepare("UPDATE projects SET name = ?1 WHERE id = ?2 AND sub = ?3").bind(name2, body.id, sub).run();
      return json({ ok: true, id: body.id });
    }
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
    if (!name) return err(400, "invalid_input", "name required");
    const pid = "p:" + hex16();
    await env.DB.prepare("INSERT INTO projects (id, sub, name, created_at) VALUES (?1, ?2, ?3, ?4)").bind(pid, sub, name, Date.now()).run();
    return json({ ok: true, id: pid });
  }
  if (method === "DELETE") {
    if (!id || !PROJECT_ID_RE.test(id)) return err(400, "invalid_input", "bad project id");
    if (!await ownedProject(env, sub, id)) return err(404, "not_found", "no such project");
    await env.DB.batch([
      env.DB.prepare("UPDATE conversations SET project_id = NULL WHERE project_id = ?1 AND sub = ?2").bind(id, sub),
      env.DB.prepare("DELETE FROM project_files WHERE project_id = ?1").bind(id),
      env.DB.prepare("DELETE FROM projects WHERE id = ?1 AND sub = ?2").bind(id, sub)
    ]);
    return json({ ok: true });
  }
  return err(405, "method_not_allowed", "GET, POST or DELETE");
}
async function handleProjectFiles(env, sub, req, route) {
  const { method, id } = route;
  if (method === "GET") {
    if (!id || !PROJECT_ID_RE.test(id)) return err(400, "invalid_input", "bad project id");
    if (!await ownedProject(env, sub, id)) return err(404, "not_found", "no such project");
    const rows = (await env.DB.prepare("SELECT id, name, content, updated_at FROM project_files WHERE project_id = ?1 ORDER BY updated_at DESC").bind(id).all()).results ?? [];
    return json({ files: rows });
  }
  if (method === "POST") {
    const body = await req.json().catch(() => null);
    const projectId = typeof body?.project_id === "string" ? body.project_id : "";
    if (!PROJECT_ID_RE.test(projectId) || !await ownedProject(env, sub, projectId)) return err(404, "not_found", "no such project");
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
    const content = typeof body?.content === "string" ? body.content.slice(0, MAX_CONTENT) : "";
    if (!name || !content.trim()) return err(400, "invalid_input", "name and content are required");
    const now = Date.now();
    if (typeof body?.id === "string" && FILE_ID_RE.test(body.id)) {
      const r = await env.DB.prepare(
        "UPDATE project_files SET name = ?1, content = ?2, updated_at = ?3 WHERE id = ?4 AND project_id = ?5"
      ).bind(name, content, now, body.id, projectId).run();
      if (!r.meta?.changes) return err(404, "not_found", "no such file");
      return json({ ok: true, id: body.id });
    }
    const count = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM project_files WHERE project_id = ?1").bind(projectId).first())?.n ?? 0);
    if (count >= MAX_FILES) return err(400, "quota_exceeded", `at most ${MAX_FILES} files per project`);
    const fid = "pf:" + hex16();
    await env.DB.prepare(
      "INSERT INTO project_files (id, project_id, name, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)"
    ).bind(fid, projectId, name, content, now).run();
    return json({ ok: true, id: fid });
  }
  if (method === "DELETE") {
    if (!id || !FILE_ID_RE.test(id)) return err(400, "invalid_input", "bad file id");
    await env.DB.prepare(
      "DELETE FROM project_files WHERE id = ?1 AND project_id IN (SELECT id FROM projects WHERE sub = ?2)"
    ).bind(id, sub).run();
    return json({ ok: true });
  }
  return err(405, "method_not_allowed", "GET, POST or DELETE");
}

// workers/worker_public/src/share.ts
var SLUG_RE = /^[a-z0-9]{10}$/;
function makeSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}
async function handleShareConversation(env, ownerSub, title, messages) {
  if (messages.length === 0 || messages.length > 100) {
    return err(400, "invalid_input", "Cannot share an empty or oversized conversation");
  }
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const count = Number(await env.CACHE.get(`sh:${day}:${ownerSub.slice(0, 20)}`) ?? "0");
  if (count >= 10) return err(429, "rate_limited", "Daily share limit reached");
  await env.CACHE.put(`sh:${day}:${ownerSub.slice(0, 20)}`, String(count + 1), { expirationTtl: 9e4 });
  const slug = makeSlug();
  const cleanMessages = messages.slice(0, 50).map((m) => {
    const citations2 = Array.isArray(m.citations) ? m.citations : typeof m.citations === "string" ? (() => {
      try {
        return JSON.parse(m.citations);
      } catch {
        return null;
      }
    })() : null;
    const read = m.read && typeof m.read === "object" ? {
      intent: String(m.read.intent ?? ""),
      doc: m.read.doc ?? null,
      edition: m.read.edition ?? null,
      term: m.read.term ?? null,
      terms: Array.isArray(m.read.terms) ? m.read.terms.slice(0, 4).map(String) : [],
      lang: m.read.lang ?? null
    } : void 0;
    return {
      role: m.role === "user" ? "user" : "assistant",
      content: (m.content ?? "").slice(0, LIMITS.maxOutputTokens * 2),
      citations: citations2,
      ...m.model ? { model: String(m.model).slice(0, 80) } : {},
      ...Array.isArray(m.blocks) ? { blocks: m.blocks.slice(0, 12) } : {},
      ...read ? { read } : {}
    };
  });
  await env.DB.prepare(
    "INSERT INTO shared_conversations (slug, owner_sub, title, messages, created_at) VALUES (?1,?2,?3,?4,?5)"
  ).bind(slug, ownerSub, title.slice(0, 120), JSON.stringify(cleanMessages), (/* @__PURE__ */ new Date()).toISOString()).run();
  return json({ slug, url: `/c/${slug}` }, 201);
}
async function handleGetShared(env, slug) {
  if (!SLUG_RE.test(slug)) return err(400, "invalid_input", "Invalid link");
  const row = await env.DB.prepare("SELECT title, messages, created_at FROM shared_conversations WHERE slug = ?1").bind(slug).first();
  if (!row) return err(404, "not_found", "This shared link has expired or was removed");
  return json({
    title: row.title,
    created_at: row.created_at,
    messages: JSON.parse(row.messages)
  });
}

// workers/worker_public/prompts/faithfulness.md
var faithfulness_default = `You are a factuality judge. Given an answer and the retrieved passages it was based on, identify any claims in the answer that are NOT directly supported by the passages. Reply with ONLY a JSON object: {"score": 0.0-1.0, "ungrounded_claims": ["claim text", ...]} \u2014 score is the fraction of claims that ARE grounded in the passages; if every claim is supported, score is 1.0 and ungrounded_claims is [].

Passages prefixed [M] are this service's own machine-computed model data (typed blocks the answer was given) \u2014 a claim restating [M] content is grounded.
`;

// workers/worker_public/src/verdict-parse.ts
function coerceVerdict(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const raw = obj.score;
  const score = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(score)) return null;
  const claims = obj.ungrounded_claims;
  return {
    score: Math.max(0, Math.min(1, score)),
    ungrounded_claims: Array.isArray(claims) ? claims.map(String).slice(0, 5) : []
  };
}
function parseVerdict(text) {
  const stripped = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim();
  try {
    const whole = coerceVerdict(JSON.parse(stripped));
    if (whole) return whole;
  } catch {
  }
  let verdict = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const v = coerceVerdict(JSON.parse(stripped.slice(start, i + 1)));
          if (v) verdict = v;
        } catch {
        }
      }
    }
  }
  return verdict;
}

// workers/worker_public/src/faithfulness-context.ts
function buildJudgeContext(passages, machine = []) {
  const context = passages.slice(0, 8).map((p, i) => {
    const text = typeof p === "string" ? p : p.text;
    const limit = typeof p !== "string" && p.table ? 2400 : 1400;
    return `[${i + 1}] ${text.replace(/\s+/g, " ").slice(0, limit)}`;
  }).join("\n");
  const machineContext = machine.length ? "\n" + machine.slice(0, 6).map((m) => `[M] ${m.replace(/\s+/g, " ").slice(0, 400)}`).join("\n") : "";
  return context + machineContext;
}

// workers/worker_public/src/faithfulness.ts
async function scoreFaithfulness(ai, model, answer, passages, machine = []) {
  if (!answer || !passages.length) return null;
  const context = buildJudgeContext(passages, machine);
  const t0 = Date.now();
  const timeout = new Promise((r) => setTimeout(() => {
    console.log(`faithfulness: timeout (${Date.now() - t0}ms)`);
    r(null);
  }, 24e4));
  const call = (async () => {
    const res = await ai.run(model, {
      messages: [
        {
          role: "system",
          content: faithfulness_default.trimEnd()
        },
        { role: "user", content: `Answer:
${answer.slice(0, 2e3)}

Passages:
${context}${machine.length ? buildJudgeContext([], machine) : ""}` }
      ],
      max_tokens: 6144,
      reasoning_effort: "low",
      // DeepSeek-V4 card: temp 1.0 / top_p 1.0
      temperature: 1,
      top_p: 1
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    const verdict = parseVerdict(text ?? "");
    if (!verdict) {
      console.log(`faithfulness: no parse (${Date.now() - t0}ms, text ${(text ?? "").length} chars) raw=${JSON.stringify((text ?? "").replace(/\s+/g, " ").slice(0, 500))}`);
      return null;
    }
    return verdict;
  })();
  return await Promise.race([call, timeout]);
}

// workers/worker_public/prompts/enrichment.md
var enrichment_default = "You write a retrieval context for a passage from {{CORPUS_KIND}}. The context is prepended to the passage before embedding so a semantic search can locate the passage even when the query uses different vocabulary than the passage itself.\n\nWrite ONE concise sentence (at most 40 words) that situates the passage: name the publication by its exact {{PUBLISHER_NAME}} identifier (including part or annex when applicable) and what the passage covers \u2014 paraphrasing the topic in words DIFFERENT from the passage's own. Do not copy the passage verbatim, do not add facts that are not derivable from the passage or its header, do not answer or explain the content. Reply with the context sentence only \u2014 no quotes, no preamble.\n";

// workers/worker_public/prompts/section-summary.md
var section_summary_default = "You summarize one numbered clause of a metrology publication for a retrieval index. You are given the publication, the clause number, and excerpts of its sub-clauses.\n\nWrite a dense summary of 3 to 5 sentences stating what the clause governs and how its sub-clauses divide the subject. Name each sub-clause number together with its topic, in document order.\n\nPlain factual prose. No preamble, no headings, no bullet list, no quotation marks around the whole text. Write in the same language as the excerpts.\n";

// workers/worker_public/prompts/relevancy.md
var relevancy_default = `You judge ANSWER RELEVANCY for a legal-metrology Q&A system. Given the user's question and the assistant's answer, score how completely and directly the answer addresses the question actually asked: 1.0 = fully addresses it; 0.5 = partially (addresses an adjacent aspect or half the question); 0.0 = does not address it (includes refusals when the question IS answerable from a standards corpus). A correct refusal to an unanswerable question scores 1.0. Reply with ONLY: {"score": 0.0-1.0}
`;

// workers/worker_public/prompts/precision.md
var precision_default = 'You judge CONTEXT PRECISION for a retrieval system over {{PUBLISHER_NAME}} publications. Given the question and the ranked passages (in the order they were presented), score the fraction of passages that contain material USEFUL for answering the question: 1.0 = all useful; 0.5 = half; 0.0 = none. Judge each passage on its own content, not its rank. Reply with ONLY: {"score": 0.0-1.0}\n';

// workers/worker_public/src/admin.ts
async function handleEnrich(env, ctx, req) {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const chunks = Array.isArray(body?.chunks) ? body.chunks : [];
  if (chunks.length === 0 || chunks.length > 8) return err(400, "invalid_input", "chunks: 1-8 required");
  const force = body?.force === true;
  const contextOnly = body?.mode === "context";
  const abMode = body?.mode === "ab";
  const effort = body?.effort === "high" ? "high" : "low";
  const abPrompt = abMode && typeof body?.prompt === "string" ? body.prompt.slice(0, 4e3) : null;
  const model = typeof env.ENRICH_MODEL === "string" && env.ENRICH_MODEL ? env.ENRICH_MODEL : MODELS.enrich;
  const usage = { prompt_tokens: 0, completion_tokens: 0, requests: 0, cache_hits: 0 };
  const results = await Promise.all(
    chunks.map(async (c) => {
      if (!c?.id || typeof c?.text !== "string" || !c?.metadata) return { id: c?.id ?? null, ok: false, error: "invalid chunk" };
      try {
        const cacheKey = `e:${c.id}`;
        let context = force || abMode ? null : await env.CACHE.get(cacheKey);
        const cached = !!context;
        if (!context) {
          const m = c.metadata;
          const head = `${m.docidentifier ?? m.doc_id}${m.clause_anchor ? " \xA7" + m.clause_anchor : ""}${m.clause_title ? " \u2014 " + m.clause_title : ""}`;
          const res = await env.AI.run(model, {
            messages: [
              { role: "system", content: abMode && abPrompt || fill(enrichment_default, promptVars()).trimEnd() },
              { role: "user", content: abMode && abPrompt ? String(body?.user_text ?? "").slice(0, 4e3) : `${head}

${c.text.slice(0, 1500)}` }
            ],
            max_tokens: 1600,
            // measured (2026-09-12, TODO.impl/62): high effort beats low
            // 58% vs 25% on blind pairwise judging at equal length — the
            // enrichment lane is one-time and quality-first, so the win
            // compounds into every future retrieval
            reasoning_effort: abMode ? effort : "high"
          });
          const raw = typeof res?.response === "string" && res.response.trim() ? res.response : res?.choices?.[0]?.message?.content;
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
          if (!abMode) ctx.waitUntil(env.CACHE.put(cacheKey, context, { expirationTtl: 2592e3 }));
        } else {
          usage.cache_hits += 1;
        }
        if (contextOnly) return { id: c.id, ok: true, cached, context };
        const original = typeof c.metadata.chunk_text === "string" && c.metadata.chunk_text ? c.metadata.chunk_text : c.text;
        const enriched = `${context}

${original}`;
        const vector = await embed(portModelRunner(env), MODELS.embed, enriched.slice(0, 6e3));
        await env.VECTORIZE.upsert([{ id: c.id, values: vector, metadata: { ...c.metadata, chunk_text: enriched, ctx: "1" } }]);
        return { id: c.id, ok: true, cached, context };
      } catch (e) {
        return { id: c.id, ok: false, error: String(e?.message ?? e).slice(0, 200) };
      }
    })
  );
  const ok = results.filter((r) => r.ok).length;
  console.log("enrich:", ok, "/", results.length, "usage:", JSON.stringify(usage));
  if (usage.requests > 0) {
    ctx.waitUntil(
      env.DB.prepare(
        "INSERT INTO spend (day, tier, model, requests) VALUES (?1,'enrich',?2,?3) ON CONFLICT(day, tier, model) DO UPDATE SET requests = requests + ?3"
      ).bind(today(), model, usage.requests).run()
    );
  }
  return json({ results, usage });
}
async function handleSectionUnit(env, ctx, req) {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const units = Array.isArray(body?.units) ? body.units : [];
  if (units.length === 0 || units.length > 6) return err(400, "invalid_input", "units: 1-6 required");
  const model = typeof env.ENRICH_MODEL === "string" && env.ENRICH_MODEL ? env.ENRICH_MODEL : MODELS.enrich;
  const usage = { prompt_tokens: 0, completion_tokens: 0, requests: 0, cache_hits: 0 };
  const results = await Promise.all(
    units.map(async (u) => {
      const m = u?.metadata ?? {};
      if (!u?.id || typeof u?.id !== "string" || !m?.doc_id || !m?.clause_anchor || !Array.isArray(u?.children) || u.children.length === 0) {
        return { id: u?.id ?? null, ok: false, error: "invalid unit (id, metadata.doc_id, metadata.clause_anchor, children required)" };
      }
      try {
        const cacheKey = `s:${u.id}`;
        let summary = body?.force === true ? null : await env.CACHE.get(cacheKey);
        const cached = !!summary;
        if (!summary) {
          const head = `${m.docidentifier ?? m.doc_id} \xA7${m.clause_anchor}${m.clause_title ? " \u2014 " + m.clause_title : ""}`;
          const listing = u.children.slice(0, 12).map((c) => `\xA7${c.anchor ?? ""}${c.title ? " " + c.title : ""} \u2014 ${String(c.excerpt ?? "").slice(0, 260)}`).join("\n");
          const res = await env.AI.run(model, {
            messages: [
              { role: "system", content: section_summary_default.trimEnd() },
              { role: "user", content: `${head}

Sub-clauses:
${listing}` }
            ],
            max_tokens: 1600,
            // parity with the chunk-enrichment call — 900 starved ~40% of section summaries (model-card budget rule)
            reasoning_effort: "low"
          });
          const raw = typeof res?.response === "string" && res.response.trim() ? res.response : res?.choices?.[0]?.message?.content;
          summary = typeof raw === "string" ? raw.trim().replace(/^["']|["']$/g, "").slice(0, 500) : "";
          if (!summary) return { id: u.id, ok: false, error: "empty summary" };
          if (res?.usage) {
            usage.prompt_tokens += Number(res.usage.prompt_tokens ?? 0);
            usage.completion_tokens += Number(res.usage.completion_tokens ?? 0);
          }
          usage.requests += 1;
          ctx.waitUntil(env.CACHE.put(cacheKey, summary, { expirationTtl: 2592e3 }));
        } else {
          usage.cache_hits += 1;
        }
        const childAnchors = u.children.map((c) => c.anchor).filter(Boolean).join(",");
        const text = `\xA7${m.clause_anchor}${m.clause_title ? " " + m.clause_title : ""} \u2014 ${summary}
Covers: ${childAnchors}`;
        const vectorText = `${m.docidentifier ?? m.doc_id} \xA7${m.clause_anchor} ${text}`.slice(0, 2e3);
        const vector = await embed(portModelRunner(env), MODELS.embed, vectorText);
        await env.VECTORIZE.upsert([
          { id: u.id, values: vector, metadata: { ...m, chunk_text: text, section_summary: "1", child_anchors: childAnchors, ctx: "1" } }
        ]);
        return { id: u.id, ok: true, cached, children: u.children.length };
      } catch (e) {
        return { id: u.id, ok: false, error: String(e?.message ?? e).slice(0, 200) };
      }
    })
  );
  const ok = results.filter((r) => r.ok).length;
  console.log("section units:", ok, "/", results.length, "usage:", JSON.stringify(usage));
  if (usage.requests > 0) {
    ctx.waitUntil(
      env.DB.prepare(
        "INSERT INTO spend (day, tier, model, requests) VALUES (?1,'enrich',?2,?3) ON CONFLICT(day, tier, model) DO UPDATE SET requests = requests + ?3"
      ).bind(today(), model, usage.requests).run()
    );
  }
  return json({ results, usage });
}
async function handleCaption(env, req) {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const unitId = typeof body?.unit_id === "string" ? body.unit_id : "";
  const context = typeof body?.context === "string" ? body.context.slice(0, 400) : "";
  if (!unitId) return err(400, "invalid_input", "unit_id required");
  try {
    const row = await env.DB.prepare("SELECT payload, docidentifier FROM unit_payloads WHERE unit_id = ?1").bind(unitId).first();
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
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const b64 = btoa(binary);
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await env.AI.run(MODELS.member, {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `Describe this figure from ${row.docidentifier}${context ? ` (${context})` : ""} for a reader who cannot see it: what is plotted/shown, the axes or structure, and the normative point it makes. 2-3 plain sentences.` },
                { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
              ]
            }
          ],
          max_tokens: 1024,
          // GLM-5.3-Flash defaults to reasoning_effort "max" when the parameter
          // is absent — max-effort reasoning starves a 1024-token budget and
          // the caption comes back empty (the u:fig-2 straggler)
          reasoning_effort: "low"
        });
      } catch {
      }
    }
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    if (!text?.trim()) return err(502, "generation_failed", "vision model returned no description");
    const trimmed = text.trim();
    const cap = 900;
    const desc = trimmed.length <= cap ? trimmed : (() => {
      const cut = trimmed.slice(0, cap);
      const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
      return end === -1 ? cut.slice(0, cut.lastIndexOf(" ")) : cut.slice(0, end + 1);
    })();
    await env.DB.prepare("UPDATE unit_payloads SET payload = json_set(payload, '$.description', ?1) WHERE unit_id = ?2").bind(desc, unitId).run();
    return json({ ok: true, unit_id: unitId, description: desc });
  } catch (e) {
    return err(502, "caption_failed", String(e).slice(0, 200));
  }
}
async function handleVectors(env, req) {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const mode = body?.mode;
  try {
    if (mode === "get") {
      const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, 100) : [];
      if (!ids.length) return err(400, "invalid_input", "ids: 1-100 required");
      const vectors = [];
      for (let i = 0; i < ids.length; i += 20) {
        const got = await env.VECTORIZE.getByIds(ids.slice(i, i + 20)) ?? [];
        for (const v of got) vectors.push({ id: v.id, values: v.values, metadata: v.metadata ?? null });
      }
      return json({ vectors });
    }
    if (mode === "upsert") {
      const vectors = Array.isArray(body?.vectors) ? body.vectors.filter((v) => v && typeof v.id === "string" && Array.isArray(v.values)) : [];
      if (!vectors.length || vectors.length > 100) return err(400, "invalid_input", "vectors: 1-100 required");
      await env.VECTORIZE.upsert(vectors);
      return json({ ok: true, upserted: vectors.length });
    }
    if (mode === "embed") {
      const texts = Array.isArray(body?.texts) ? body.texts.filter((t) => typeof t === "string").slice(0, 16) : [];
      if (!texts.length) return err(400, "invalid_input", "texts: 1-16 required");
      const vectors = [];
      for (const t of texts) {
        const v = await embed(portModelRunner(env), MODELS.embed, t.slice(0, 6e3));
        vectors.push(v);
      }
      return json({ vectors });
    }
    return err(400, "invalid_input", "mode must be get, upsert, or embed");
  } catch (e) {
    return err(502, "vectorize_failed", String(e).slice(0, 200));
  }
}
async function handleJudge(env, req) {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  const question = typeof body?.question === "string" ? body.question.slice(0, 2e3) : "";
  const answer = typeof body?.answer === "string" ? body.answer.slice(0, 4e3) : "";
  const passages = Array.isArray(body?.passages) ? body.passages.filter((p) => typeof p === "string").map((p) => p.slice(0, 2e3)).slice(0, 8) : [];
  if (!question || !answer) return err(400, "invalid_input", "question and answer required");
  const passagesText = passages.map((p, i) => `[${i + 1}] ${p}`).join("\n");
  const [faith, relevancy, precision] = await Promise.all([
    passages.length ? scoreFaithfulness(env.AI, roleModel(env, "grader"), answer, passages, (Array.isArray(body?.blocks) ? body.blocks : []).map((b) => [b?.payload?.check, b?.payload?.meaning].filter((x) => typeof x === "string").join(" \u2014 ")).filter(Boolean)) : Promise.resolve(null),
    scoreJudge(env.AI, roleModel(env, "grader"), relevancy_default, `Question: ${question}

Answer:
${answer}`),
    passages.length ? scoreJudge(env.AI, roleModel(env, "grader"), fill(precision_default, promptVars()), `Question: ${question}

Passages:
${passagesText}`) : Promise.resolve(null)
  ]);
  return json({
    question_hash: await sha256Hex(question),
    faithfulness: faith ? faith.score : null,
    answer_relevancy: relevancy,
    context_precision: precision
  });
}
async function handleKeyUsage(env, req) {
  const key = await authenticate(env, req);
  if (!key) return err(401, "unauthorized", "Provide the key's own credential as the bearer token");
  const today2 = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const [row, week] = await Promise.all([
    env.DB.prepare("SELECT name, day_limit FROM api_keys WHERE id = ?1").bind(key.id).first(),
    env.DB.prepare(
      "SELECT day, COUNT(*) AS requests, SUM(ok) AS ok FROM queries WHERE key_id = ?1 AND day >= date('now','-7 days') GROUP BY day ORDER BY day DESC"
    ).bind(key.id).all()
  ]);
  const usedUnits = Number(await env.CACHE.get(`q:ask:key:${key.id}`) ?? "0");
  return json({
    key: { name: row?.name ?? key.name, day_limit: row?.day_limit ?? key.day_limit },
    today: { date: today2, used_units: usedUnits },
    week: week.results ?? []
  });
}
async function handleCreateKey(env, req) {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const body = await readJson(req);
  if (!body?.name || typeof body.name !== "string") return err(400, "invalid_input", "name is required");
  const dayLimit = Number.isFinite(Number(body.day_limit)) && Number(body.day_limit) > 0 ? Number(body.day_limit) : num(env, "KEY_DAY_ASK_DEFAULT", 2e3);
  const raw = `${P().publisher.id}_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const id = crypto.randomUUID();
  const keyHash = await sha256Hex(raw);
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, day_limit, created_at, revoked) VALUES (?1,?2,?3,?4,?5,0)"
  ).bind(id, body.name, keyHash, dayLimit, (/* @__PURE__ */ new Date()).toISOString()).run();
  return json({ id, name: body.name, day_limit: dayLimit, key: raw, note: "Store this key now \u2014 it is not retrievable again." });
}
async function handleListKeys(env, req) {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const rows = await env.DB.prepare(
    "SELECT id, name, day_limit, created_at, revoked FROM api_keys ORDER BY created_at DESC"
  ).all();
  return json({ keys: rows.results, ...corsHeaders(req) });
}
async function handleRevokeKey(env, req, id) {
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const r = await env.DB.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ?1 AND revoked = 0").bind(id).run();
  return json({ ok: true, updated: r.meta?.changes ?? 0 });
}

// workers/worker_public/prompts/research.md
var research_default = `You are a sufficiency judge for a research loop over {{PUBLISHER_NAME}} publications. Given the research question and the passages collected so far (across iterations), decide whether the collected evidence is SUFFICIENT to write a complete, well-grounded answer.

Reply with ONLY a JSON object:
{"sufficient": true|false, "missing": "short description of what is still missing (empty string when sufficient)"}

Rules:
- "sufficient" means: the passages cover every distinct aspect the question asks about, with enough normative detail (values, clauses, conditions) to answer without speculation.
- If one more retrieval round could plausibly find the missing piece (a specific publication, clause, or value named or implied by the question), set sufficient=false and describe the missing piece precisely \u2014 it becomes the next retrieval query's focus.
- Do NOT demand exhaustive coverage beyond the question's scope. Answering the question well is the bar, not collecting everything.
- If the corpus clearly does not contain the answer (question off-corpus), set sufficient=true so the loop stops and the answer says so.
`;

// workers/worker_public/src/research.ts
async function handleResearch(env, ctx, req, session) {
  if (!session) {
    return err(403, "forbidden", `Deep research is a member feature \u2014 sign in with your ${P().publisher.product_name} account.`);
  }
  const body = await readJson(req);
  const q = validateQuery(body);
  if (!q) return err(400, "invalid_input", `query is required (1-${LIMITS.maxInputChars} chars)`);
  const maxIters = Math.min(Math.max(Number(body?.max_iterations) || 3, 1), 3);
  if (body?.stream === true) {
    const enc = new TextEncoder();
    const started = Date.now();
    const stream = new ReadableStream({
      async start(ctrl) {
        const send = (e) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}

`));
        try {
          const out2 = await run(env, ctx, q, maxIters, send);
          send({ type: "done", ...out2 });
        } catch (e) {
          send({ type: "error", message: String(e?.message ?? e).slice(0, 200) });
        } finally {
          ctrl.close();
        }
      }
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
        ...corsHeaders(req)
      }
    });
    void started;
  }
  const out = await run(env, ctx, q, maxIters);
  return json({ ...out, ...corsHeaders(req) });
}
async function run(env, ctx, q, maxIters, emit) {
  const started = Date.now();
  const queryHash = await sha256Hex(q.query);
  const understanding = await understandQuery(portModelRunner(env), MODELS.understand, q.query, [], []);
  const graphDocNumbers = await graphExpand(env, understanding);
  const eNote = await editionNote(env, understanding);
  const accumulated = /* @__PURE__ */ new Map();
  let iterations = 0;
  let focus = understanding?.standalone_query?.trim() || q.query;
  let judge = null;
  for (let i = 0; i < maxIters; i++) {
    iterations = i + 1;
    emit?.({ type: "pass", n: iterations, of: maxIters, phase: "retrieving" });
    let retrieved;
    try {
      retrieved = await retrieve(env, q.query, {
        understanding: i === 0 ? understanding : { ...understanding, standalone_query: focus, query_variants: [], hypothetical_answer: void 0 },
        graphDocNumbers
      });
    } catch {
      break;
    }
    for (const h of retrieved.hits.slice(0, LIMITS.rerankKeep)) {
      if (!accumulated.has(h.id)) accumulated.set(h.id, h);
    }
    const passages = [...accumulated.values()];
    const KEEP_RECENT = 10;
    const older = passages.slice(0, Math.max(0, passages.length - KEEP_RECENT));
    const recent = passages.slice(-KEEP_RECENT);
    const digest = older.length ? `Earlier evidence (digest, ${older.length} passages):
${older.map((h) => `- ${h.metadata.docidentifier ?? ""} \xA7${h.metadata.clause_anchor ?? ""}: ${h.text.replace(/\s+/g, " ").slice(0, 160)}`).join("\n")}

` : "";
    judge = await (async () => {
      try {
        const res = await env.AI.run(MODELS.grader, {
          messages: [
            { role: "system", content: fill(research_default, promptVars()).trimEnd() },
            { role: "user", content: `Research question: ${q.query}

${digest}Collected passages (${recent.length}):
${recent.map((h, n) => `[${n + 1}] ${h.metadata.docidentifier ?? ""} \xA7${h.metadata.clause_anchor ?? ""}: ${h.text.slice(0, 700)}`).join("\n")}` }
          ],
          max_tokens: 3072,
          reasoning_effort: "low",
          temperature: 1,
          top_p: 1
        });
        const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
        let parsed = null;
        for (const m of (text ?? "").matchAll(/\{[^{}]*\}/g)) {
          try {
            const obj = JSON.parse(m[0]);
            if (typeof obj.sufficient === "boolean") parsed = obj;
          } catch {
          }
        }
        return parsed ? { sufficient: parsed.sufficient, missing: String(parsed.missing ?? "") } : null;
      } catch {
        return null;
      }
    })();
    console.log("research iter", iterations, "passages", passages.length, "sufficient:", judge?.sufficient);
    emit?.({
      type: "pass",
      n: iterations,
      of: maxIters,
      phase: "judged",
      passages: passages.length,
      sufficient: judge?.sufficient ?? null,
      ...judge && !judge.sufficient && judge.missing ? { missing: judge.missing.slice(0, 300) } : {}
    });
    if (!judge || judge.sufficient || !judge.missing) break;
    focus = `${understanding?.standalone_query?.trim() || q.query} ${judge.missing}`.slice(0, LIMITS.maxInputChars);
  }
  const used = [...accumulated.values()];
  if (!used.length) {
    throw new Error("Search is briefly busy \u2014 please retry in a moment.");
  }
  const { messages, usedHits } = buildMessages(q.query, used, q.lang, [], eNote || void 0, void 0, LIMITS.inputTokenBudget);
  let answer = await generateOnce(env, MODELS.research, messages);
  if (answer === null) answer = await generateOnce(env, MODELS.fallback, messages);
  if (answer === null) {
    telemetry(env, ctx, "member", "research", MODELS.research, false, 0, queryHash, q.lang);
    throw new Error("The generation model is unavailable; please retry.");
  }
  answer = canonicalRefusal(answer);
  const anchors = checkQuoteAnchors(answer, used.map((h) => h.text));
  if (anchors.violations.length) console.log("research anchors:", anchors.violations.length, "unverified");
  const out = {
    answer,
    citations: citations(usedHits),
    model: MODELS.research,
    query_hash: queryHash,
    research: { iterations, passages: used.length, elapsed_ms: Date.now() - started, sufficient: judge?.sufficient ?? null }
  };
  telemetry(env, ctx, "member", "research", MODELS.research, true, answer.length, queryHash, q.lang);
  emit?.({ type: "pass", n: iterations, of: maxIters, phase: "writing", passages: used.length });
  return out;
}

// workers/worker_public/src/mcp-proto.ts
var PROTOCOL_VERSION = "2025-06-18";
var TOOLS = [
  {
    name: "ask",
    description: "Ask the corpus a question; returns a citation-grounded answer with the passages it rests on.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question (1-8000 chars)" },
        lang: { type: "string", description: "Answer language hint (e.g. en, fr)" }
      },
      required: ["query"]
    }
  },
  {
    name: "retrieve",
    description: "Retrieve the top passages for a query (hybrid dense + metadata steering, reranked).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        k: { type: "number", description: "Hits to return (default 5)" }
      },
      required: ["query"]
    }
  }
];
function dispatch(method, params, callTool) {
  switch (method) {
    case "initialize":
      return Promise.resolve({ ok: true, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "rag", version: "1.0.0" } } });
    case "notifications/initialized":
    case "ping":
      return Promise.resolve({ ok: true, accepted: true });
    case "tools/list":
      return Promise.resolve({ ok: true, result: { tools: TOOLS } });
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      if (!TOOLS.some((t) => t.name === name)) {
        return Promise.resolve({ ok: false, code: -32602, message: `unknown tool: ${name}` });
      }
      return callTool(name, params?.arguments ?? {}).then(
        (payload) => ({ ok: true, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })
      );
    }
    default:
      return Promise.resolve({ ok: false, code: -32601, message: `method not found: ${method}` });
  }
}

// workers/worker_public/src/mcp.ts
async function handleMcp(env, ctx, req, tier, key) {
  const body = await readJson(req);
  const method = typeof body?.method === "string" ? body.method : null;
  const id = body?.id ?? null;
  const out = await dispatch(method, body?.params, async (name, args) => {
    const inner = new Request("https://internal/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // stream:false forces the JSON lane (anon defaults to SSE)
      body: JSON.stringify({ ...args, stream: false })
    });
    const res = name === "ask" ? await (await import("../../ask-I3PTT3MW.js")).handleAsk(env, ctx, inner, tier, key) : await (await import("../../search-EC665NLS.js")).handleSearch(env, ctx, inner, tier, key);
    return res.json().catch(() => ({ error: { message: "tool transport failed", status: res.status } }));
  });
  if (out.ok && "accepted" in out) return new Response(null, { status: 202 });
  if (out.ok) {
    if (out.result?.serverInfo) out.result.serverInfo.name = `${P().publisher.id}-rag`;
    return json({ jsonrpc: "2.0", id, result: out.result });
  }
  return json({ jsonrpc: "2.0", id, error: { code: out.code, message: out.message } });
}

// workers/shared/router.ts
function routeMatchesPath(pattern, path) {
  const segments = path.split("/").filter(Boolean);
  const patternSegs = pattern.split("/").filter(Boolean);
  if (patternSegs.length !== segments.length && !patternSegs[patternSegs.length - 1]?.startsWith("*")) return null;
  const params = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const ps = patternSegs[i];
    if (ps.startsWith("*")) return params;
    if (ps.startsWith(":")) {
      params[ps.slice(1)] = segments[i];
    } else if (ps !== segments[i]) {
      return null;
    }
  }
  return params;
}
function matchRoute(routes, method, path) {
  for (const route of routes) {
    if (route.method !== method && route.method !== "*") continue;
    const params = routeMatchesPath(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}

// workers/worker_public/src/openapi-surface.gen.ts
var OPENAPI_SURFACE = [
  {
    "method": "POST",
    "pattern": "/api/ask",
    "operationId": "askAnonymous"
  },
  {
    "method": "POST",
    "pattern": "/v1/ask",
    "operationId": "askKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/search",
    "operationId": "search"
  },
  {
    "method": "POST",
    "pattern": "/v1/search",
    "operationId": "searchKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/absence",
    "operationId": "absence"
  },
  {
    "method": "POST",
    "pattern": "/v1/absence",
    "operationId": "absenceKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/verify",
    "operationId": "verify"
  },
  {
    "method": "POST",
    "pattern": "/v1/verify",
    "operationId": "verifyKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/research",
    "operationId": "research"
  },
  {
    "method": "POST",
    "pattern": "/v1/research",
    "operationId": "researchKeyed"
  },
  {
    "method": "POST",
    "pattern": "/mcp",
    "operationId": "mcp"
  },
  {
    "method": "GET",
    "pattern": "/api/datasets",
    "operationId": "datasets"
  },
  {
    "method": "GET",
    "pattern": "/v1/usage",
    "operationId": "keyUsage"
  },
  {
    "method": "GET",
    "pattern": "/health",
    "operationId": "health"
  },
  {
    "method": "GET",
    "pattern": "/api/conversations",
    "operationId": "listConversations"
  },
  {
    "method": "POST",
    "pattern": "/api/conversations",
    "operationId": "createConversation"
  },
  {
    "method": "GET",
    "pattern": "/api/conversations/:id",
    "operationId": "getConversation"
  },
  {
    "method": "PATCH",
    "pattern": "/api/conversations/:id",
    "operationId": "renameConversation"
  },
  {
    "method": "DELETE",
    "pattern": "/api/conversations/:id",
    "operationId": "deleteConversation"
  },
  {
    "method": "POST",
    "pattern": "/api/conversations/:id/messages",
    "operationId": "appendMessage"
  },
  {
    "method": "POST",
    "pattern": "/api/conversations/:id/share",
    "operationId": "shareConversation"
  },
  {
    "method": "GET",
    "pattern": "/api/shared/:slug",
    "operationId": "getShared"
  },
  {
    "method": "GET",
    "pattern": "/api/memories",
    "operationId": "listMemories"
  },
  {
    "method": "POST",
    "pattern": "/api/memories",
    "operationId": "createMemory"
  },
  {
    "method": "DELETE",
    "pattern": "/api/memories/:id",
    "operationId": "deleteMemory"
  },
  {
    "method": "GET",
    "pattern": "/api/projects",
    "operationId": "listProjects"
  },
  {
    "method": "POST",
    "pattern": "/api/projects",
    "operationId": "createProject"
  },
  {
    "method": "DELETE",
    "pattern": "/api/projects/:id",
    "operationId": "deleteProject"
  },
  {
    "method": "GET",
    "pattern": "/api/projects/:id/files",
    "operationId": "listProjectFiles"
  },
  {
    "method": "POST",
    "pattern": "/api/projects/:id/files",
    "operationId": "attachProjectFile"
  },
  {
    "method": "DELETE",
    "pattern": "/api/project-files/:id",
    "operationId": "detachProjectFile"
  },
  {
    "method": "POST",
    "pattern": "/api/lane",
    "operationId": "laneQuery"
  },
  {
    "method": "POST",
    "pattern": "/v1/lane",
    "operationId": "laneKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/feedback",
    "operationId": "feedback"
  },
  {
    "method": "POST",
    "pattern": "/v1/admin/enrich",
    "operationId": "adminEnrich"
  },
  {
    "method": "POST",
    "pattern": "/admin/enrich",
    "operationId": "adminEnrichAlias"
  },
  {
    "method": "POST",
    "pattern": "/v1/admin/section",
    "operationId": "adminSection"
  },
  {
    "method": "POST",
    "pattern": "/admin/section",
    "operationId": "adminSectionAlias"
  },
  {
    "method": "POST",
    "pattern": "/admin/vectors",
    "operationId": "adminVectors"
  },
  {
    "method": "POST",
    "pattern": "/admin/caption",
    "operationId": "adminCaption"
  },
  {
    "method": "POST",
    "pattern": "/v1/admin/judge",
    "operationId": "adminJudge"
  },
  {
    "method": "POST",
    "pattern": "/admin/judge",
    "operationId": "adminJudgeAlias"
  },
  {
    "method": "DELETE",
    "pattern": "/v1/admin/keys/:id",
    "operationId": "adminRevokeKey"
  },
  {
    "method": "GET",
    "pattern": "/auth/me",
    "operationId": "authMe"
  },
  {
    "method": "GET",
    "pattern": "/auth/login",
    "operationId": "authLogin"
  },
  {
    "method": "GET",
    "pattern": "/auth/callback",
    "operationId": "authCallback"
  },
  {
    "method": "POST",
    "pattern": "/auth/logout",
    "operationId": "authLogout"
  },
  {
    "method": "GET",
    "pattern": "/auth/logout",
    "operationId": "authLogoutLink"
  },
  {
    "method": "GET",
    "pattern": "/v1/admin/stats",
    "operationId": "adminStats"
  },
  {
    "method": "GET",
    "pattern": "/v1/admin/keys",
    "operationId": "adminListKeys"
  },
  {
    "method": "POST",
    "pattern": "/v1/admin/keys",
    "operationId": "adminCreateKey"
  }
];

// workers/worker_public/src/index.ts
async function serveIndexPage(c) {
  const target = new URL(c.path === "/index.html" ? "/" : c.path, c.url);
  const asset = await c.env.ASSETS.fetch(new Request(target, { method: "GET" }));
  if (asset.status === 200) {
    return new Response(asset.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
        ...corsHeaders(c.req)
      }
    });
  }
  return err(404, "not_found", "Page not found");
}
async function memoriesRoute(c) {
  const session = await sessionFrom(c.req, c.env);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to use memory files"), corsHeaders(c.req));
  return withCors(await handleMemories(c.env, session.sub, c.req, { method: c.req.method, id: c.params.id }), corsHeaders(c.req));
}
async function projectsRoute(c) {
  const session = await sessionFrom(c.req, c.env);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to use projects"), corsHeaders(c.req));
  return withCors(await handleProjects(c.env, session.sub, c.req, { method: c.req.method, id: c.params.id }), corsHeaders(c.req));
}
async function projectFilesRoute(c) {
  const session = await sessionFrom(c.req, c.env);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to use projects"), corsHeaders(c.req));
  return withCors(await handleProjectFiles(c.env, session.sub, c.req, { method: c.req.method, id: c.params.id }), corsHeaders(c.req));
}
async function conversationsRoute(c) {
  const session = await sessionFrom(c.req, c.env);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to sync your conversations across devices"), corsHeaders(c.req));
  return withCors(await handleConversations(c.env, session.sub, c.req, { method: c.req.method, id: c.params.id }), corsHeaders(c.req));
}
async function appendMessageRoute(c) {
  const session = await sessionFrom(c.req, c.env);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to sync your conversations across devices"), corsHeaders(c.req));
  return withCors(await handleAppendMessage(c.env, session.sub, c.req, c.params.id), corsHeaders(c.req));
}
async function shareRoute(c) {
  const session = await sessionFrom(c.req, c.env);
  if (!session) return err(401, "unauthorized", "Sign in to share conversations");
  const convId = c.params.id;
  const conv = await c.env.DB.prepare("SELECT id, sub, title FROM conversations WHERE id = ?1 AND sub = ?2").bind(convId, session.sub).first();
  if (!conv) return err(404, "not_found", "No such conversation");
  const msgs = await c.env.DB.prepare("SELECT role, content, citations, model FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC").bind(convId).all();
  return handleShareConversation(c.env, session.sub, conv.title, msgs.results ?? []);
}
async function getSharedRoute(c) {
  return handleGetShared(c.env, c.params.slug ?? "");
}
async function datasetsRoute(c) {
  const session = await sessionFrom(c.req, c.env);
  return json({ datasets: datasetsFor(session), suggestions: SUGGESTIONS(), starters: STARTERS() }, 200, corsHeaders(c.req));
}
async function healthRoute(c) {
  return json({ ok: true, service: "rag-public", index_version: c.env.INDEX_VERSION, ...corsHeaders(c.req) });
}
async function tierFor(c) {
  const isApi = c.path.startsWith("/v1/");
  let key = null;
  if (isApi) {
    key = await authenticate(c.env, c.req);
    if (!key) return err(401, "unauthorized", `Provide a valid API key: Authorization: Bearer ${P().publisher.id}_...`);
  }
  let tier = isApi ? "key" : "anon";
  if (!isApi && await sessionFrom(c.req, c.env)) tier = "member";
  else if (!isApi && await opTokenMember(c.env, { issuer: (c.env.OIDC_ISSUER ?? "").trim(), clientId: String(c.env.OIDC_CLIENT_ID ?? "") }, c.req)) tier = "member";
  return { tier, key };
}
async function mcpRoute(c) {
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  return withCors(await handleMcp(c.env, c.ctx, c.req, t.tier, t.key), corsHeaders(c.req));
}
async function askRoute(c) {
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  return withCors(await handleAsk(c.env, c.ctx, c.req, t.tier, t.key), corsHeaders(c.req));
}
async function searchRoute(c) {
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  return withCors(await handleSearch(c.env, c.ctx, c.req, t.tier, t.key), corsHeaders(c.req));
}
async function adminStatsRoute(c) {
  const { env, req, ctx } = c;
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const [byDay, byModel, feedback, convCount, cacheMix, durations, retriesRow] = await Promise.all([
    env.DB.prepare("SELECT day, tier, COUNT(*) as n, SUM(ok) as ok FROM queries WHERE day >= date('now','-7 days') GROUP BY day, tier ORDER BY day DESC").all(),
    env.DB.prepare("SELECT model, SUM(requests) as requests FROM spend WHERE day >= date('now','-7 days') GROUP BY model ORDER BY requests DESC").all(),
    env.DB.prepare("SELECT rating, COUNT(*) as n FROM feedback GROUP BY rating").all(),
    env.DB.prepare("SELECT COUNT(*) as n FROM conversations").first(),
    env.DB.prepare("SELECT COALESCE(cache, 'miss') AS cache, COUNT(*) AS n FROM queries WHERE day >= date('now','-7 days') AND route = 'ask' GROUP BY cache").all(),
    env.DB.prepare("SELECT duration_ms FROM queries WHERE day >= date('now','-7 days') AND route = 'ask' AND duration_ms IS NOT NULL").all(),
    env.DB.prepare("SELECT COALESCE(SUM(retries), 0) AS total, SUM(CASE WHEN retries > 0 THEN 1 ELSE 0 END) AS answers FROM queries WHERE day >= date('now','-7 days') AND route = 'ask'").all()
  ]);
  const retries = retriesRow?.results?.[0] ?? { total: 0, answers: 0 };
  const ds = durations.results.map((r) => r.duration_ms).sort((a, b) => a - b);
  const pct = (q) => ds.length ? ds[Math.min(ds.length - 1, Math.floor(q * ds.length))] : null;
  const totalQueries = byDay.results.reduce((a, r) => a + (r.n || 0), 0) || 0;
  const totalOk = byDay.results.reduce((a, r) => a + (r.ok || 0), 0) || 0;
  const errorRate = totalQueries > 0 ? ((totalQueries - totalOk) / totalQueries * 100).toFixed(1) : "0";
  ctx.waitUntil(env.DB.batch([
    env.DB.prepare("DELETE FROM queries WHERE day < date('now','-90 days')"),
    env.DB.prepare("DELETE FROM spend WHERE day < date('now','-90 days')"),
    env.DB.prepare("DELETE FROM feedback WHERE ts < datetime('now','-90 days')")
  ]));
  return json({
    window: "7 days",
    queries_by_day: byDay.results,
    spend_by_model: byModel.results,
    feedback: feedback.results,
    cache_mix_7d: cacheMix.results,
    latency_ms: ds.length ? { n: ds.length, p50: pct(0.5), p95: pct(0.95) } : null,
    generate_retries_7d: { total: Number(retries.total) || 0, answers_retried: Number(retries.answers) || 0 },
    conversations: convCount?.n ?? 0,
    error_rate_pct: errorRate,
    index_version: env.INDEX_VERSION,
    pruned: "telemetry >90d"
  }, 200, corsHeaders(req));
}
async function absenceRoute(c) {
  const { env, req } = c;
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  const body = await readJson(req);
  const namedStd = namedDocumentIn(String(body?.standard ?? ""));
  const standard = standardForDocNumber(namedStd?.doc_number ?? String(body?.standard ?? "").trim());
  const topic = String(body?.topic ?? "").trim().toLowerCase();
  if (!standard || !topic) return err(400, "invalid_input", "standard and topic are required");
  try {
    const nodes = (await env.DB.prepare("SELECT node_id, kind, name, content FROM model_nodes WHERE standard = ?1").bind(standard).all()).results ?? [];
    const tokens = topic.split(/\s+/).filter((t2) => t2.length > 2);
    const matches = [];
    for (const n of nodes) {
      const hay = `${n.name ?? ""} ${n.content ?? ""}`.toLowerCase();
      if (tokens.some((tok) => hay.includes(tok))) {
        matches.push({ node_id: n.node_id, kind: n.kind });
      }
    }
    const chunks = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE corpus = 'smart-model' AND (docidentifier LIKE ?1 OR doc_id LIKE ?2)").bind(`%${body?.standard}%`, `%${body?.standard}%`).first();
    return json({
      standard,
      topic,
      enumerated: { model_nodes: nodes.length, smart_model_chunks: chunks?.n ?? 0 },
      matches: matches.slice(0, 20),
      verdict: matches.length === 0 ? "absent" : "present",
      scope: `the machine-readable model of ${standard} (all model nodes) \u2014 the enumeration is exhaustive over that scope; prose outside the modeled families is not claimed`
    });
  } catch (e) {
    return err(502, "absence_failed", String(e).slice(0, 200));
  }
}
async function verifyRoute(c) {
  const { env, req } = c;
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  const body = await readJson(req);
  const answer = typeof body?.answer === "string" ? body.answer : "";
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!answer || !query) return err(400, "invalid_input", "answer and query are required");
  try {
    const u = await understandQuery(env.AI, roleModel(env, "understand"), query, [], []);
    let lexicalBoost;
    let editionSteer = null;
    try {
      const fam = u?.doc_number ? refCodec().familyOf(u.doc_number) : null;
      if (fam) {
        const row = await env.DB.prepare("SELECT edition FROM documents WHERE family = ?1 AND active = 1 ORDER BY edition DESC LIMIT 1").bind(fam).first().catch(() => null);
        if (row?.edition) {
          lexicalBoost = String(row.edition);
          editionSteer = { doc_number: fam.split("-").pop() ?? "", edition: String(row.edition) };
        }
      }
    } catch {
    }
    const bound = await bindModelNode(env, { query, standardKeys: entitlementScope(standardKeysFrom(body)) });
    const modelGrounding = bound && !bound.gated ? modelGroundingBlock(bound) : null;
    const supplied = (Array.isArray(body?.passages) ? body.passages : []).map((p) => typeof p === "string" ? p : p?.text ?? "").map((p) => p.trim()).filter(Boolean).slice(0, 8);
    let passages;
    let structured = [];
    if (supplied.length) {
      passages = supplied;
      structured = supplied.map((p) => ({ text: p }));
    } else {
      const retrieved = await retrieve(env, query, { understanding: u, standardKeys: entitlementScope(standardKeysFrom(body)), lexicalBoost, editionSteer });
      passages = retrieved.hits.map((h) => h.text);
      structured = retrieved.hits.map((h) => ({ text: h.text, table: h.metadata.block === "table" || void 0 }));
    }
    const anchors = checkQuoteAnchors(answer, passages);
    const refs = [...answer.matchAll(/\[\[u:([^\]]+)\]\]/g)].map((m) => m[1]);
    const validRefs = refs.filter((r) => supplied.length ? supplied.some((p) => p.includes(`u:${r}`)) : structured.some((h) => h.text && !h.table));
    const checks = [
      { name: "quote_anchors", deterministic: true, pass: anchors.violations.length === 0, detail: `${anchors.violations.length} of ${anchors.total} quoted spans absent from the retrieved passages` },
      { name: "unit_references", deterministic: true, pass: refs.length === validRefs.length, detail: refs.length ? `${validRefs.length}/${refs.length} unit references resolve to served units` : "no unit references" },
      { name: "citations_present", deterministic: true, pass: new RegExp(`\\[[^\\]]*(${P().publisher.name})[^\\]]*\\]`).test(answer), detail: "normative claims should carry a passage citation" }
    ];
    const machine = (Array.isArray(body?.blocks) ? body.blocks : []).filter((b) => b?.type === "verdict" && b?.payload).map((b) => [b.payload.check, b.payload.meaning, b.payload.definition, b.payload.violation_meaning].filter((x) => typeof x === "string" && x).join(" \u2014 ")).filter(Boolean);
    if (modelGrounding) machine.unshift(modelGrounding);
    const faith = await scoreFaithfulness(
      env.AI,
      roleModel(env, "grader"),
      answer,
      structured,
      machine
    );
    return json({
      checks,
      judged: faith ? { name: "faithfulness", deterministic: false, score: faith.score, ungrounded_claims: faith.ungrounded_claims.slice(0, 5) } : null,
      passages_used: passages.length
    });
  } catch (e) {
    return err(502, "verify_failed", String(e).slice(0, 200));
  }
}
async function laneRoute(c) {
  const { env, req } = c;
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  const body = await readJson(req);
  const laneName = String(body?.lane ?? "");
  const query = String(body?.query ?? "").trim();
  const laneBindings = {
    primmel: env.EXP_PRIMMEL,
    composed: env.EXP_COMPOSED,
    plain: env.EXP_PLAIN,
    adoc: env.EXP_ADC,
    mko: env.EXP_MKO,
    primmel_flat: env.EXP_PFLAT
  };
  const laneTables = {
    primmel: "chunks_primmel",
    composed: "chunks_composed",
    plain: "chunks_plain",
    adoc: "chunks_adoc",
    mko: "chunks_mko",
    primmel_flat: "chunks_primmel_flat"
  };
  const binding = laneBindings[laneName];
  const table = laneTables[laneName];
  if (!binding || !table) {
    return err(400, "invalid_lane", `lane must be one of: ${Object.keys(laneBindings).join(", ")}`);
  }
  if (!query || query.length > 2e3) return err(400, "invalid_input", "query required (1-2000 chars)");
  try {
    const vector = await embed(env.AI, MODELS.embed, query);
    const dense = await binding.query(vector, { topK: 20, returnMetadata: "all" });
    const hits = (dense.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata ?? {},
      text: m.metadata?.chunk_text ?? ""
    }));
    let lexical = [];
    try {
      const match = ftsMatchQuery(query);
      if (match) {
        const res = await env.EXP_DB.prepare(
          `SELECT c.id, c.docidentifier, c.clause_anchor, c.clause_title, c.unit_id, c.block,
                  c.text, c.source_lane, c.linked_clause, bm25(${table}_fts) AS rank
             FROM ${table}_fts
             JOIN ${table} c ON c.rowid = ${table}_fts.rowid
            WHERE ${table}_fts MATCH ?1
            ORDER BY rank LIMIT ?2`
        ).bind(match, 10).all();
        lexical = (res.results ?? []).map((r) => ({
          id: r.id,
          score: 1 / (1 + Math.max(0, r.rank)),
          metadata: {
            docidentifier: r.docidentifier,
            clause_anchor: r.clause_anchor,
            clause_title: r.clause_title,
            unit_id: r.unit_id,
            block: r.block,
            source_lane: r.source_lane,
            linked_clause: r.linked_clause
          },
          text: r.text
        }));
      }
    } catch (e) {
      console.log("lane lexical failed:", String(e).slice(0, 100));
    }
    const seen = /* @__PURE__ */ new Set();
    const fused = [...hits, ...lexical.filter((h) => !seen.has(h.id) && !hits.some((d) => d.id === h.id))];
    hits.forEach((h) => seen.add(h.id));
    lexical.forEach((h) => {
      if (!seen.has(h.id)) {
        fused.push(h);
        seen.add(h.id);
      }
    });
    return json({
      lane: laneName,
      query,
      hits: fused.slice(0, 10).map((h) => ({
        id: h.id,
        score: h.score,
        docidentifier: h.metadata?.docidentifier ?? "",
        clause_anchor: h.metadata?.clause_anchor ?? "",
        clause_title: h.metadata?.clause_title ?? "",
        unit_id: h.metadata?.unit_id ?? "",
        block: h.metadata?.block ?? "",
        source_lane: h.metadata?.source_lane ?? "",
        linked_clause: h.metadata?.linked_clause ?? "",
        text: String(h.text ?? "").slice(0, 400)
      }))
    });
  } catch (e) {
    return err(502, "lane_query_failed", String(e).slice(0, 200));
  }
}
async function feedbackRoute(c) {
  const body = await readJson(c.req);
  const queryHash = typeof body?.query_hash === "string" ? body.query_hash : "";
  const rating = Number(body?.rating);
  if (!/^[a-f0-9]{64}$/.test(queryHash) || ![1, -1].includes(rating)) {
    return withCors(err(400, "invalid_input", "query_hash and rating (1 or -1) are required"), corsHeaders(c.req));
  }
  await c.env.DB.prepare("INSERT INTO feedback (query_hash, rating, ts) VALUES (?1,?2,?3)").bind(queryHash, rating, (/* @__PURE__ */ new Date()).toISOString()).run();
  return json({ ok: true, ...corsHeaders(c.req) });
}
async function unitAssetRoute(c) {
  const m = c.path.match(/^\/assets\/(u:[A-Za-z0-9_-]+)\.(png|jpe?g|gif|svg|webp)$/);
  if (!m) return err(404, "not_found", "Unknown asset");
  const obj = await c.env.UNIT_ASSETS.get(m[1] + "." + m[2]);
  if (!obj) return new Response("not found", { status: 404 });
  const types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };
  return new Response(obj.body, { headers: { "content-type": types[m[2]] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", ...corsHeaders(c.req) } });
}
async function docsRoute(c) {
  const m = c.path.match(/^\/docs\/([a-z0-9-]+)\.(html|anchors\.json)$/);
  if (!m) return err(404, "not_found", "Unknown document");
  const obj = await c.env.UNIT_ASSETS.get(`docs/${m[1]}.${m[2]}`);
  if (!obj) return new Response("not found", { status: 404 });
  const type = m[2] === "html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
  return new Response(obj.body, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", ...corsHeaders(c.req) } });
}
async function researchRoute(c) {
  const session = c.env.SESSION_SECRET ? await sessionFrom(c.req, c.env) : null;
  return handleResearch(c.env, c.ctx, c.req, session);
}
function permissionsCatalog() {
  const groups = [];
  const perms = [];
  for (const d of P().datasets ?? []) {
    if (d.session && d.permission) {
      perms.push({
        id: "ai.dataset.externally-licensed",
        description: `Access the ${d.label} dataset (federated, externally licensed content)`
      });
    }
  }
  if (P().publisher.features?.drafts) {
    perms.push({ id: "ai.drafts", description: "Ask the assistant to prepare draft acts" });
  }
  perms.push({ id: "ai.memories", description: "Personalized memory files on the assistant" });
  perms.push({ id: "ai.research", description: "Deep-research multi-pass questions" });
  perms.push({ id: "ai.keys.admin", description: "Create and revoke API keys" });
  groups.push({ id: "ai", description: `${P().publisher.product_name} gated capabilities`, permissions: perms });
  return {
    version: 1,
    verbs: ["read", "write", "admin"],
    groups
  };
}
async function openapiCatalogRoute(c) {
  return json(
    {
      openapi: "3.1.0",
      info: { title: `${P().publisher.product_name} API`, version: c.env.INDEX_VERSION ?? "0" },
      paths: {},
      "x-permissions-catalog": permissionsCatalog()
    },
    200,
    corsHeaders(c.req)
  );
}
var INFRA_ROUTES = [
  { method: "GET", pattern: "/", handler: serveIndexPage },
  { method: "GET", pattern: "/api/", handler: serveIndexPage },
  { method: "GET", pattern: "/api/openapi.json", handler: openapiCatalogRoute },
  { method: "GET", pattern: "/index.html", handler: serveIndexPage },
  { method: "GET", pattern: "/assets/*", handler: unitAssetRoute },
  { method: "GET", pattern: "/docs/*", handler: docsRoute }
];
var OPENAPI_HANDLERS = {
  askAnonymous: askRoute,
  askKeyed: askRoute,
  search: searchRoute,
  searchKeyed: searchRoute,
  absence: absenceRoute,
  absenceKeyed: absenceRoute,
  verify: verifyRoute,
  verifyKeyed: verifyRoute,
  research: researchRoute,
  researchKeyed: researchRoute,
  laneQuery: laneRoute,
  laneKeyed: laneRoute,
  mcp: mcpRoute,
  feedback: feedbackRoute,
  datasets: datasetsRoute,
  keyUsage: async (c) => withCors(await handleKeyUsage(c.env, c.req), corsHeaders(c.req)),
  health: healthRoute,
  authLogin: (c) => handleLogin(c.env, c.req),
  authCallback: (c) => handleCallback(c.env, c.req),
  authMe: async (c) => withCors(await handleMe(c.env, c.req), corsHeaders(c.req)),
  authLogout: (c) => handleLogout(c.env, c.req),
  authLogoutLink: (c) => handleLogout(c.env, c.req),
  listConversations: conversationsRoute,
  createConversation: conversationsRoute,
  getConversation: conversationsRoute,
  renameConversation: conversationsRoute,
  deleteConversation: conversationsRoute,
  appendMessage: appendMessageRoute,
  shareConversation: shareRoute,
  getShared: getSharedRoute,
  listMemories: memoriesRoute,
  createMemory: memoriesRoute,
  deleteMemory: memoriesRoute,
  listProjects: projectsRoute,
  createProject: projectsRoute,
  deleteProject: projectsRoute,
  listProjectFiles: projectFilesRoute,
  attachProjectFile: projectFilesRoute,
  detachProjectFile: projectFilesRoute,
  adminStats: adminStatsRoute,
  adminListKeys: (c) => handleListKeys(c.env, c.req),
  adminCreateKey: (c) => handleCreateKey(c.env, c.req),
  adminRevokeKey: (c) => handleRevokeKey(c.env, c.req, c.params.id),
  adminEnrich: (c) => handleEnrich(c.env, c.ctx, c.req),
  adminEnrichAlias: (c) => handleEnrich(c.env, c.ctx, c.req),
  adminSection: (c) => handleSectionUnit(c.env, c.ctx, c.req),
  adminSectionAlias: (c) => handleSectionUnit(c.env, c.ctx, c.req),
  adminVectors: (c) => handleVectors(c.env, c.req),
  adminCaption: (c) => handleCaption(c.env, c.req),
  adminJudge: (c) => handleJudge(c.env, c.req),
  adminJudgeAlias: (c) => handleJudge(c.env, c.req)
};
var ROUTES = [
  ...INFRA_ROUTES,
  ...OPENAPI_SURFACE.map((r) => ({
    method: r.method,
    pattern: r.pattern,
    handler: OPENAPI_HANDLERS[r.operationId]
  }))
];
var src_default = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const matched = matchRoute(ROUTES, req.method, path);
    if (matched) {
      return matched.route.handler({ env, req, ctx, url, path, params: matched.params });
    }
    if (ROUTES.some((r) => routeMatchesPath(r.pattern, path))) {
      return err(405, "method_not_allowed", `The path is served, but not with ${req.method}`);
    }
    return err(404, "not_found", "Unknown route");
  }
};
export {
  ROUTES,
  src_default as default,
  setProfile
};
