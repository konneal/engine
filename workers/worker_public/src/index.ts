import { MODELS, datasetsFor, SUGGESTIONS, roleModel } from "./config";
export { setProfile } from "./profile.ts";
import { retrieve } from "./pipeline";
import type { Hit } from "./pipeline";
import { handleCallback, handleLogin, handleLogout, handleMe, sessionFrom } from "./auth";
import { handleAppendMessage, handleConversations } from "./conversations";
import { handleMemories } from "./memories";
import { handleProjects, handleProjectFiles } from "./projects";
import { handleShareConversation, handleGetShared } from "./share";
import { understandQuery } from "./understand";
import { embed } from "./ai";
import { ftsMatchQuery } from "./lexical";
import { scoreFaithfulness } from "./faithfulness";
import { checkQuoteAnchors } from "./anchors";
import { namedDocumentIn } from "./context";
import { standardForDocNumber } from "./modelplane";
import type { Env } from "./env";
export type { Env };
import { json, err, corsHeaders, withCors, readJson, authenticate, type ApiKey } from "./lib/http";

import { handleSearch } from "./search";
import { handleEnrich, handleSectionUnit, handleCaption, handleVectors, handleJudge, handleCreateKey, handleListKeys, handleRevokeKey } from "./admin";
import { handleResearch } from "./research";
import { handleAsk } from "./ask";

// One named handler per HTTP route, declared in ROUTES below and
// dispatched by lib/router.ts's matchRoute. Adding a route = one entry +
// its handler; entry order is irrelevant (every pattern is
// segment-exact). Dual-published routes (/api for the browser, /v1 for
// keyed integrators) point at the SAME handler — the tier split is the
// handler's, derived from the path. Mirrored in docs/spec-api.md.

import { matchRoute, type RouteContext, type Route } from "./lib/router";
import { P } from "./profile.ts";

async function serveIndexPage(c: RouteContext): Promise<Response> {
  // HTML pages are served through the worker with must-revalidate so a
  // deploy can never leave the edge serving HTML that references
  // deleted fingerprinted assets.
  const target = new URL(c.path === "/index.html" ? "/" : c.path, c.url);
  const asset = await c.env.ASSETS.fetch(new Request(target, { method: "GET" }));
  if (asset.status === 200) {
    return new Response(asset.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
        ...corsHeaders(c.req),
      },
    });
  }
  return err(404, "not_found", "Page not found");
}

async function memoriesRoute(c: RouteContext): Promise<Response> {
  const session = await sessionFrom(c.req, c.env as any);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to use memory files"), corsHeaders(c.req));
  return withCors(await handleMemories(c.env, session.sub, c.req, { method: c.req.method, id: c.params.id }), corsHeaders(c.req));
}

async function projectsRoute(c: RouteContext): Promise<Response> {
  const session = await sessionFrom(c.req, c.env as any);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to use projects"), corsHeaders(c.req));
  return withCors(await handleProjects(c.env, session.sub, c.req, { method: c.req.method, id: c.params.id }), corsHeaders(c.req));
}

async function projectFilesRoute(c: RouteContext): Promise<Response> {
  const session = await sessionFrom(c.req, c.env as any);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to use projects"), corsHeaders(c.req));
  return withCors(await handleProjectFiles(c.env, session.sub, c.req, { method: c.req.method, id: c.params.id }), corsHeaders(c.req));
}

async function conversationsRoute(c: RouteContext): Promise<Response> {
  const session = await sessionFrom(c.req, c.env as any);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to sync your conversations across devices"), corsHeaders(c.req));
  return withCors(await handleConversations(c.env, session.sub, c.req, { method: c.req.method, id: c.params.id }), corsHeaders(c.req));
}

async function appendMessageRoute(c: RouteContext): Promise<Response> {
  const session = await sessionFrom(c.req, c.env as any);
  if (!session) return withCors(err(401, "unauthorized", "Sign in to sync your conversations across devices"), corsHeaders(c.req));
  return withCors(await handleAppendMessage(c.env, session.sub, c.req, c.params.id!), corsHeaders(c.req));
}

async function shareRoute(c: RouteContext): Promise<Response> {
  const session = await sessionFrom(c.req, c.env as any);
  if (!session) return err(401, "unauthorized", "Sign in to share conversations");
  const convId = c.params.id;
  const conv = await c.env.DB.prepare("SELECT id, sub, title FROM conversations WHERE id = ?1 AND sub = ?2").bind(convId, session.sub).first();
  if (!conv) return err(404, "not_found", "No such conversation");
  const msgs = await c.env.DB.prepare("SELECT role, content, citations, model FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC").bind(convId).all();
  return handleShareConversation(c.env, session.sub, (conv as any).title, msgs.results ?? []);
}

async function getSharedRoute(c: RouteContext): Promise<Response> {
  return handleGetShared(c.env, c.params.slug ?? "");
}

async function datasetsRoute(c: RouteContext): Promise<Response> {
  const session = await sessionFrom(c.req, c.env as any);
  return json({ datasets: datasetsFor(session), suggestions: SUGGESTIONS() }, 200, corsHeaders(c.req));
}

async function healthRoute(c: RouteContext): Promise<Response> {
  return json({ ok: true, service: "rag-public", index_version: c.env.INDEX_VERSION, ...corsHeaders(c.req) });
}

/** The /v1 vs /api tier split: /v1 requires an API key; /api is the
 *  browser surface (anonymous, or member via a valid session cookie or
 *  the bubble bridge's Bearer token). Returns the 401 itself on a bad
 *  key. */
async function tierFor(c: RouteContext): Promise<{ tier: "anon" | "key" | "member"; key: ApiKey | null } | Response> {
  const isApi = c.path.startsWith("/v1/");
  let key: ApiKey | null = null;
  if (isApi) {
    key = await authenticate(c.env, c.req);
    if (!key) return err(401, "unauthorized", `Provide a valid API key: Authorization: Bearer ${P().publisher.id}_...`);
  }
  let tier: "anon" | "key" | "member" = isApi ? "key" : "anon";
  if (!isApi && c.env.SESSION_SECRET && (await sessionFrom(c.req, c.env as any))) tier = "member";
  return { tier, key };
}

async function askRoute(c: RouteContext): Promise<Response> {
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  return withCors(await handleAsk(c.env, c.ctx, c.req, t.tier, t.key), corsHeaders(c.req));
}

async function searchRoute(c: RouteContext): Promise<Response> {
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  return withCors(await handleSearch(c.env, c.ctx, c.req, t.tier, t.key), corsHeaders(c.req));
}

async function adminStatsRoute(c: RouteContext): Promise<Response> {
  const { env, req, ctx } = c;
  if (!env.ADMIN_TOKEN) return err(501, "admin_disabled", "ADMIN_TOKEN secret is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return err(401, "unauthorized", "Invalid admin token");
  const [byDay, byModel, feedback, convCount, cacheMix] = await Promise.all([
    env.DB.prepare("SELECT day, tier, COUNT(*) as n, SUM(ok) as ok FROM queries WHERE day >= date('now','-7 days') GROUP BY day, tier ORDER BY day DESC").all(),
    env.DB.prepare("SELECT COALESCE(cache, 'miss') AS cache, COUNT(*) AS n FROM queries WHERE day >= date('now','-7 days') AND route = 'ask' GROUP BY cache").all(),
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
    cache_mix_7d: cacheMix.results,
    conversations: (convCount as any)?.n ?? 0,
    error_rate_pct: errorRate,
    index_version: env.INDEX_VERSION,
    pruned: "telemetry >90d",
  }, 200, corsHeaders(req));
}

// ── Provable absence (TODO.era3/02): deterministic enumeration proof ──
async function absenceRoute(c: RouteContext): Promise<Response> {
  const { env, req } = c;
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  const body = await readJson(req);
  const namedStd = namedDocumentIn(String(body?.standard ?? ""));
  const standard = standardForDocNumber(namedStd?.doc_number ?? String(body?.standard ?? "").trim());
  const topic = String(body?.topic ?? "").trim().toLowerCase();
  if (!standard || !topic) return err(400, "invalid_input", "standard (e.g. \"R 60\") and topic are required");
  try {
    const nodes = (await env.DB.prepare("SELECT node_id, kind, name, content FROM model_nodes WHERE standard = ?1").bind(standard).all()).results ?? [];
    const tokens = topic.split(/\s+/).filter((t: string) => t.length > 2);
    const matches: unknown[] = [];
    for (const n of nodes as any[]) {
      const hay = `${n.name ?? ""} ${n.content ?? ""}`.toLowerCase();
      if (tokens.some((tok: string) => hay.includes(tok))) {
        matches.push({ node_id: n.node_id, kind: n.kind });
      }
    }
    const chunks = (await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE corpus = 'smart-model' AND (docidentifier LIKE ?1 OR doc_id LIKE ?2)").bind(`%${body?.standard}%`, `%${body?.standard}%`).first()) as any;
    return json({
      standard,
      topic,
      enumerated: { model_nodes: nodes.length, smart_model_chunks: chunks?.n ?? 0 },
      matches: matches.slice(0, 20),
      verdict: matches.length === 0 ? "absent" : "present",
      scope: `the model plane of ${standard} (all model nodes) — the enumeration is exhaustive over that scope; prose outside the modeled families is not claimed`,
    });
  } catch (e) {
    return err(502, "absence_failed", String(e).slice(0, 200));
  }
}

// ── Self-verification (TODO.era3/03): the deterministic battery, exposed ──
async function verifyRoute(c: RouteContext): Promise<Response> {
  const { env, req } = c;
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  const body = await readJson(req);
  const answer = typeof body?.answer === "string" ? body.answer : "";
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!answer || !query) return err(400, "invalid_input", "answer and query are required");
  try {
    const u = await understandQuery(env.AI, roleModel(env, "understand"), query, [], []);
    const retrieved = await retrieve(env, query, { understanding: u });
    const passages = retrieved.hits.map((h: Hit) => h.text);
    const anchors = checkQuoteAnchors(answer, passages);
    const refs = [...answer.matchAll(/\[\[u:([^\]]+)\]\]/g)].map((m) => m[1]);
    const validRefs = refs.filter((r) => retrieved.hits.some((h: Hit) => h.metadata.unit_id === r));
    const checks = [
      { name: "quote_anchors", deterministic: true, pass: anchors.violations.length === 0, detail: `${anchors.violations.length} of ${anchors.total} quoted spans absent from the retrieved passages` },
      { name: "unit_references", deterministic: true, pass: refs.length === validRefs.length, detail: refs.length ? `${validRefs.length}/${refs.length} unit references resolve to served units` : "no unit references" },
      { name: "citations_present", deterministic: true, pass: new RegExp(`\\[[^\\]]*(${P().publisher.name})[^\\]]*\\]`).test(answer), detail: "normative claims should carry a passage citation" },
    ];
    const faith = await scoreFaithfulness(env.AI, roleModel(env, "grader"), answer, retrieved.hits.map((h: Hit) => h.text));
    return json({
      checks,
      judged: faith ? { name: "faithfulness", deterministic: false, score: faith.score, ungrounded_claims: faith.ungrounded_claims.slice(0, 5) } : null,
      passages_used: retrieved.hits.length,
    });
  } catch (e) {
    return err(502, "verify_failed", String(e).slice(0, 200));
  }
}

// comparison lane query (TODO.model-rag): direct retrieval against a
// comparison index, bypassing the full ask pipeline — for the annealment
// runner and the /compare demo
async function laneRoute(c: RouteContext): Promise<Response> {
  const { env, req } = c;
  const t = await tierFor(c);
  if (t instanceof Response) return t;
  const body = await readJson(req);
  const laneName = String(body?.lane ?? "");
  const query = String(body?.query ?? "").trim();
  const laneBindings: Record<string, any> = {
    primmel: env.EXP_PRIMMEL,
    composed: env.EXP_COMPOSED,
    plain: env.EXP_PLAIN,
    adoc: env.EXP_ADC,
    mko: env.EXP_MKO,
    primmel_flat: env.EXP_PFLAT,
  };
  const laneTables: Record<string, string> = {
    primmel: "chunks_primmel",
    composed: "chunks_composed",
    plain: "chunks_plain",
    adoc: "chunks_adoc",
    mko: "chunks_mko",
    primmel_flat: "chunks_primmel_flat",
  };
  const binding = laneBindings[laneName];
  const table = laneTables[laneName];
  if (!binding || !table) {
    return err(400, "invalid_lane", `lane must be one of: ${Object.keys(laneBindings).join(", ")}`);
  }
  if (!query || query.length > 2000) return err(400, "invalid_input", "query required (1-2000 chars)");

  try {
    // embed the query
    const vector = await embed(env.AI, MODELS.embed, query);
    // dense retrieval from the comparison index
    const dense = await binding.query(vector, { topK: 20, returnMetadata: "all" });
    const hits = (dense.matches ?? []).map((m: any) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata ?? {},
      text: m.metadata?.chunk_text ?? "",
    }));
    // lexical retrieval from the comparison D1
    let lexical: any[] = [];
    try {
      // the FTS MATCH construction is the LEXICAL module's (one stopword
      // list, one term policy — the lane's SQL stays lane-specific)
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
        lexical = (res.results ?? []).map((r: any) => ({
          id: r.id,
          score: 1 / (1 + Math.max(0, r.rank)),
          metadata: {
            docidentifier: r.docidentifier,
            clause_anchor: r.clause_anchor,
            clause_title: r.clause_title,
            unit_id: r.unit_id,
            block: r.block,
            source_lane: r.source_lane,
            linked_clause: r.linked_clause,
          },
          text: r.text,
        }));
      }
    } catch (e) {
      console.log("lane lexical failed:", String(e).slice(0, 100));
    }

    // fuse: dedupe by id, dense first, lexical appended
    const seen = new Set<string>();
    const fused = [...hits, ...lexical.filter((h: any) => !seen.has(h.id) && !hits.some((d: any) => d.id === h.id))];
    hits.forEach((h: any) => seen.add(h.id));
    lexical.forEach((h: any) => { if (!seen.has(h.id)) { fused.push(h); seen.add(h.id); } });

    return json({
      lane: laneName,
      query,
      hits: fused.slice(0, 10).map((h: any) => ({
        id: h.id,
        score: h.score,
        docidentifier: h.metadata?.docidentifier ?? "",
        clause_anchor: h.metadata?.clause_anchor ?? "",
        clause_title: h.metadata?.clause_title ?? "",
        unit_id: h.metadata?.unit_id ?? "",
        block: h.metadata?.block ?? "",
        source_lane: h.metadata?.source_lane ?? "",
        linked_clause: h.metadata?.linked_clause ?? "",
        text: String(h.text ?? "").slice(0, 400),
      })),
    });
  } catch (e) {
    return err(502, "lane_query_failed", String(e).slice(0, 200));
  }
}

async function feedbackRoute(c: RouteContext): Promise<Response> {
  const body = await readJson(c.req);
  const queryHash = typeof body?.query_hash === "string" ? body.query_hash : "";
  const rating = Number(body?.rating);
  if (!/^[a-f0-9]{64}$/.test(queryHash) || ![1, -1].includes(rating)) {
    return withCors(err(400, "invalid_input", "query_hash and rating (1 or -1) are required"), corsHeaders(c.req));
  }
  await c.env.DB.prepare("INSERT INTO feedback (query_hash, rating, ts) VALUES (?1,?2,?3)")
    .bind(queryHash, rating, new Date().toISOString())
    .run();
  return json({ ok: true, ...corsHeaders(c.req) });
}

// unit assets (answer contract v2): immutable, unit-keyed figure images
async function unitAssetRoute(c: RouteContext): Promise<Response> {
  const m = c.path.match(/^\/assets\/(u:[A-Za-z0-9_-]+)\.(png|jpe?g|gif|svg|webp)$/);
  if (!m) return err(404, "not_found", "Unknown asset");
  const obj = await c.env.UNIT_ASSETS.get(m[1] + "." + m[2]);
  if (!obj) return new Response("not found", { status: 404 });
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };
  return new Response(obj.body, { headers: { "content-type": types[m[2]] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", ...corsHeaders(c.req) } });
}

// rendered publication documents (metanorma-mirror layer 1/2): the
// clean corpus's own HTML renderings under docs/<slug>.{html,anchors.json},
// immutable — a citation becomes a door into the original document
async function docsRoute(c: RouteContext): Promise<Response> {
  const m = c.path.match(/^\/docs\/([a-z0-9-]+)\.(html|anchors\.json)$/);
  if (!m) return err(404, "not_found", "Unknown document");
  const obj = await c.env.UNIT_ASSETS.get(`docs/${m[1]}.${m[2]}`);
  if (!obj) return new Response("not found", { status: 404 });
  const type = m[2] === "html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
  return new Response(obj.body, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", ...corsHeaders(c.req) } });
}

async function researchRoute(c: RouteContext): Promise<Response> {
  // member-only: a valid RAG session cookie is required (research spend stays with humans)
  const session = c.env.SESSION_SECRET ? await sessionFrom(c.req, c.env as any) : null;
  return handleResearch(c.env, c.ctx, c.req, session);
}

export const ROUTES: Route[] = [
  { method: "GET", pattern: "/", handler: serveIndexPage },
  { method: "GET", pattern: "/api/", handler: serveIndexPage },
  { method: "GET", pattern: "/index.html", handler: serveIndexPage },
  { method: "GET", pattern: "/auth/login", handler: (c) => handleLogin(c.env as any, c.req) },
  { method: "GET", pattern: "/auth/callback", handler: (c) => handleCallback(c.env as any, c.req) },
  { method: "GET", pattern: "/auth/me", handler: async (c) => withCors(await handleMe(c.env as any, c.req), corsHeaders(c.req)) },
  { method: "GET", pattern: "/auth/logout", handler: (c) => handleLogout(c.env as any, c.req) },
  { method: "POST", pattern: "/auth/logout", handler: (c) => handleLogout(c.env as any, c.req) },
  { method: "*", pattern: "/api/conversations", handler: conversationsRoute },
  { method: "*", pattern: "/api/memories", handler: memoriesRoute },
  { method: "*", pattern: "/api/projects", handler: projectsRoute },
  { method: "*", pattern: "/api/projects/:id/files", handler: projectFilesRoute },
  { method: "DELETE", pattern: "/api/project-files/:id", handler: projectFilesRoute },
  { method: "*", pattern: "/api/memories/:id", handler: memoriesRoute },
  { method: "*", pattern: "/api/conversations/:id", handler: conversationsRoute },
  { method: "POST", pattern: "/api/conversations/:id/messages", handler: appendMessageRoute },
  { method: "POST", pattern: "/api/conversations/:id/share", handler: shareRoute },
  { method: "GET", pattern: "/api/shared/:slug", handler: getSharedRoute },
  { method: "GET", pattern: "/api/datasets", handler: datasetsRoute },
  { method: "GET", pattern: "/health", handler: healthRoute },
  { method: "GET", pattern: "/v1/admin/stats", handler: adminStatsRoute },
  { method: "POST", pattern: "/api/ask", handler: askRoute },
  { method: "POST", pattern: "/v1/ask", handler: askRoute },
  { method: "POST", pattern: "/api/absence", handler: absenceRoute },
  { method: "POST", pattern: "/v1/absence", handler: absenceRoute },
  { method: "POST", pattern: "/api/verify", handler: verifyRoute },
  { method: "POST", pattern: "/v1/verify", handler: verifyRoute },
  { method: "POST", pattern: "/api/lane", handler: laneRoute },
  { method: "POST", pattern: "/v1/lane", handler: laneRoute },
  { method: "POST", pattern: "/api/search", handler: searchRoute },
  { method: "POST", pattern: "/v1/search", handler: searchRoute },
  { method: "POST", pattern: "/api/feedback", handler: feedbackRoute },
  { method: "POST", pattern: "/admin/enrich", handler: (c) => handleEnrich(c.env, c.ctx, c.req) },
  { method: "POST", pattern: "/v1/admin/enrich", handler: (c) => handleEnrich(c.env, c.ctx, c.req) },
  { method: "POST", pattern: "/admin/section", handler: (c) => handleSectionUnit(c.env, c.ctx, c.req) },
  { method: "POST", pattern: "/v1/admin/section", handler: (c) => handleSectionUnit(c.env, c.ctx, c.req) },
  { method: "POST", pattern: "/admin/vectors", handler: (c) => handleVectors(c.env, c.req) },
  { method: "POST", pattern: "/admin/caption", handler: (c) => handleCaption(c.env, c.req) },
  { method: "GET", pattern: "/assets/*", handler: unitAssetRoute },
  { method: "GET", pattern: "/docs/*", handler: docsRoute },
  { method: "POST", pattern: "/api/research", handler: researchRoute },
  { method: "POST", pattern: "/v1/research", handler: researchRoute },
  { method: "POST", pattern: "/admin/judge", handler: (c) => handleJudge(c.env, c.req) },
  { method: "POST", pattern: "/v1/admin/judge", handler: (c) => handleJudge(c.env, c.req) },
  { method: "POST", pattern: "/v1/admin/keys", handler: (c) => handleCreateKey(c.env, c.req) },
  { method: "GET", pattern: "/v1/admin/keys", handler: (c) => handleListKeys(c.env, c.req) },
  { method: "DELETE", pattern: "/v1/admin/keys/:id", handler: (c) => handleRevokeKey(c.env, c.req, c.params.id) },
];

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders(req);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const matched = matchRoute(ROUTES, req.method, path);
    if (matched) {
      return matched.route.handler({ env, req, ctx, url, path, params: matched.params });
    }
    return err(404, "not_found", "Unknown route");
  },
};

