// worker_internal: federated OIML + ISO/IEC retrieval provider for members.
// Structural isolation per CLAUDE.md — the PUBLIC worker holds no binding
// to the internal index; this worker holds both and gates by session.
// Retrieval-only by design (SSOT): the full serving pipeline — query
// understanding, fusion, reranking, grading, generation — lives in
// worker_public; this worker answers /retrieve with ranked passages.

import { sessionFrom } from "../../shared/auth";
import { embed } from "../../shared/ai";
import { toHits } from "../../shared/chunk";
import { matchRoute, type RouteContext, type Route } from "../../shared/router";
import type { Hit } from "../../shared/chunk";

export type { ChunkMeta, Hit };

export interface Env {
  AI: any;
  PUBLIC: any; // idx_oiml_public_v2
  INTERNAL: any; // idx_iso_internal
  CACHE: KVNamespace;
  SESSION_SECRET: string;
  INDEX_VERSION: string;
  ADMIN_TOKEN?: string;
}

const RRF_K = 60;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

const err = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

/** Query both indexes and RRF-fuse the rankings; internal (ISO/IEC) hits
 *  carry a slight weight so members see them when both corpora match. */
async function federate(env: Env, query: string, topK = 20): Promise<Hit[]> {
  const vector = await embed(env.AI, query);
  const [pubRes, intRes] = await Promise.all([
    env.PUBLIC.query(vector, { topK, returnMetadata: "all" }),
    env.INTERNAL.query(vector, { topK: Math.min(topK, 10), returnMetadata: "all" }),
  ]);
  const scores = new Map<string, number>();
  const byId = new Map<string, Hit>();
  // weighted RRF: the internal corpus outranks the public corpus on
  // tie (federation emphasis — deliberately NOT the shared unweighted
  // fuse; this worker's only job is the merged internal-first ranking)
  const rankings: [Hit[], number][] = [
    [toHits(pubRes.matches ?? []), 1.0],
    [toHits(intRes.matches ?? []), 1.2],
  ];
  for (const [ranking, weight] of rankings) {
    ranking.forEach((h, i) => {
      const s = weight / (RRF_K + i + 1);
      scores.set(h.id, (scores.get(h.id) ?? 0) + s);
      byId.set(h.id, h);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([id]) => byId.get(id)!)
    .filter(Boolean);
}

async function healthRoute(c: RouteContext): Promise<Response> {
  return json({ ok: true, service: "rag-internal", index_version: c.env.INDEX_VERSION });
}

// Index sync through the Vectorize/AI bindings — used by the ingest
// pipeline when no REST API token is provisioned. Guarded by the
// ADMIN_TOKEN secret; batches stay small enough for one request.
async function adminSyncRoute(c: RouteContext): Promise<Response> {
  const { env, req } = c;
  if (!env.ADMIN_TOKEN || req.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
    return err(401, "unauthorized", "admin token required");
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_input", "JSON body required");
  }
  const out = { upserted: 0, deleted: 0, embedded: 0 };
  try {
    if (Array.isArray(body?.upserts)) {
      for (let i = 0; i < body.upserts.length; i += 100) {
        const batch = body.upserts.slice(i, i + 100).filter((v: any) => v?.id && Array.isArray(v?.values) && v?.metadata);
        if (batch.length) await env.INTERNAL.upsert(batch);
        out.upserted += batch.length;
      }
    }
    if (Array.isArray(body?.embedUpserts)) {
      const todo = body.embedUpserts.filter((v: any) => v?.id && typeof v?.text === "string" && v?.metadata);
      for (let i = 0; i < todo.length; i += 16) {
        const batch = todo.slice(i, i + 16);
        const vectors = await Promise.all(batch.map((b: any) => embed(env.AI, b.text.slice(0, 6000))));
        await env.INTERNAL.upsert(batch.map((b: any, j: number) => ({ id: b.id, values: vectors[j], metadata: b.metadata })));
        out.embedded += batch.length;
      }
    }
    if (Array.isArray(body?.deletes)) {
      const ids = body.deletes.filter((x: any) => typeof x === "string");
      for (let i = 0; i < ids.length; i += 100) {
        await env.INTERNAL.deleteByIds(ids.slice(i, i + 100));
        out.deleted += Math.min(100, ids.length - i);
      }
    }
    return json(out);
  } catch (e: any) {
    return err(502, "sync_failed", e?.message ?? "vectorize operation failed");
  }
}

async function retrieveRoute(c: RouteContext): Promise<Response> {
  const session = await sessionFrom(c.req, c.env as any);
  if (!session) return err(401, "unauthorized", "Sign in required — this endpoint federates the internal and public corpora.");
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return err(400, "invalid_input", "JSON body required");
  }
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 1200) return err(400, "invalid_input", "query (1-1200 chars) required");
  try {
    const hits = await federate(c.env, query);
    return json({
      hits: hits.map((h) => ({
        id: h.id,
        score: h.score,
        metadata: { ...h.metadata, chunk_text: undefined },
        text: h.text,
      })),
    });
  } catch {
    return err(503, "retrieval_unavailable", "Federated retrieval is briefly busy.");
  }
}

// the same declarative route table the public worker dispatches through
// (TODO.impl/31) — one HTTP idiom across workers.
const ROUTES: Route[] = [
  { method: "GET", pattern: "/health", handler: healthRoute },
  { method: "POST", pattern: "/admin/sync", handler: adminSyncRoute },
  { method: "POST", pattern: "/retrieve", handler: retrieveRoute },
  { method: "POST", pattern: "/api/retrieve", handler: retrieveRoute },
];

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const matched = matchRoute(ROUTES, req.method, new URL(req.url).pathname);
    if (matched) {
      return matched.route.handler({ env, req, ctx, url: new URL(req.url), path: new URL(req.url).pathname, params: matched.params });
    }
    return err(404, "not_found", "Unknown route");
  },
};
