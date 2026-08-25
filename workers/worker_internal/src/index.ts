// worker_internal: federated OIML + ISO/IEC retrieval for eligible members.
// Structural isolation per CLAUDE.md — the PUBLIC worker holds no binding
// to the internal index; this worker holds both and gates by session role.

import { sessionFrom, INTERNAL_ROLES } from "../../shared/auth";
import { embed } from "../../shared/ai";


export interface Env {
  AI: any;
  PUBLIC: any; // idx_oiml_public_v2
  INTERNAL: any; // idx_iso_internal
  CACHE: KVNamespace;
  SESSION_SECRET: string;
  INDEX_VERSION: string;
}

const MODEL_ANON = "@cf/qwen/qwen3-30b-a3b-fp8";
const MODEL_MEMBER = "@cf/qwen/qwen3.8-27b";
const RERANKER = "@cf/baai/bge-reranker-base";
const RRF_K = 60;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

const err = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

interface ChunkMeta {
  doc_id: string;
  docidentifier: string;
  doctype: string;
  doc_number: string;
  edition: string;
  language: string;
  clause_anchor: string;
  clause_title: string;
  tier: string;
  corpus: string;
  status?: string;
  text_ref: string;
}

interface Hit {
  id: string;
  score: number;
  metadata: ChunkMeta;
  text: string;
}

async function federate(env: Env, query: string, topK = 20): Promise<Hit[]> {
  const vector = await embed(env.AI, query);
  const [pubRes, intRes] = await Promise.all([
    env.PUBLIC.query(vector, { topK, returnMetadata: "all" }),
    env.INTERNAL.query(vector, { topK: Math.min(topK, 10), returnMetadata: "all" }),
  ]);

  const pubHits: Hit[] = (pubRes.matches ?? []).map(toHit);
  const intHits: Hit[] = (intRes.matches ?? []).map(toHit);

  // RRF fusion across both indexes
  const scores = new Map<string, number>();
  const byId = new Map<string, Hit>();
  for (const [ranking, weight] of [[pubHits, 1.0], [intHits, 1.2]] as [Hit[], number][]) {
    ranking.forEach((h, i) => {
      const s = weight / (RRF_K + i + 1);
      scores.set(h.id, (scores.get(h.id) ?? 0) + s);
      byId.set(h.id, h);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => byId.get(id)!)
    .filter(Boolean);
}

function toHit(m: any): Hit {
  return {
    id: m.id,
    score: m.score,
    metadata: (m.metadata ?? {}) as ChunkMeta,
    text: (m.metadata?.chunk_text as string) ?? "",
  };
}

async function rerank(env: Env, query: string, hits: Hit[]): Promise<Hit[]> {
  if (hits.length < 2) return hits;
  try {
    const res: any = await env.AI.run(RERANKER, {
      query,
      contexts: hits.map((h) => ({ text: h.text })),
    });
    const raw = res?.response ?? res?.data;
    if (!Array.isArray(raw)) return hits;
    const scores = hits.map(() => 0);
    raw.forEach((x: any, i: number) => {
      const id = Number.isInteger(x?.id) ? x.id : i;
      if (id >= 0 && id < hits.length) scores[id] = Number(x?.score ?? 0);
    });
    hits.forEach((h, i) => (h.score = scores[i]));
    return hits.sort((a, b) => b.score - a.score);
  } catch {
    return hits;
  }
}

const SYSTEM = [
  "You answer questions about OIML publications AND ISO/IEC conformity assessment standards.",
  "Use ONLY the numbered context passages provided — they come from both the OIML corpus and the internal ISO/IEC corpus.",
  "Cite every claim inline with the passage label, e.g. [ISO/IEC 17025:2017 §7.7] or [OIML R 60-1:2021 §3.9].",
  "ISO/IEC passages are internal — never reproduce them verbatim to unauthenticated users (this API is already role-gated).",
  "If the context does not contain the answer, reply: I don't have information on this.",
  "Be concise. Answer in the question's language.",
].join(" ");

async function generate(env: Env, model: string, messages: any[]): Promise<string | null> {
  try {
    const res: any = await env.AI.run(model, { messages, max_tokens: 3072, reasoning_effort: "low" });
    return typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,cookie" } });
    }

    if (req.method === "GET" && path === "/health") {
      return json({ ok: true, service: "rag-internal", index_version: env.INDEX_VERSION });
    }

    // All other routes require an authenticated session with an internal role
    const session = await sessionFrom(req, env as any);
    if (!session) return err(401, "unauthorized", "Sign in required — this endpoint federates the internal ISO/IEC corpus.");
    const hasInternalRole = session.roles.some((r: string) => (INTERNAL_ROLES as readonly string[]).includes(r));
    if (!hasInternalRole) {
      return err(403, "forbidden", `Your account (${session.roles.join(", ") || "no roles"}) does not include an internal-access role. Required: ${INTERNAL_ROLES.join(", ")}.`);
    }

    if (req.method === "POST" && (path === "/api/ask" || path === "/v1/ask")) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return err(400, "invalid_input", "JSON body required");
      }
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query || query.length > 1200) return err(400, "invalid_input", "query (1-1200 chars) required");

      try {
        let hits = await federate(env, query);
        hits = await rerank(env, query, hits);
        if (!hits.length) {
          return json({ answer: "I don't have information on this.", citations: [], model: MODEL_MEMBER });
        }

        const context = hits
          .map((h, i) => `[${i + 1}] ${h.metadata.docidentifier}:${h.metadata.edition} §${h.metadata.clause_anchor}\n${h.text}`)
          .join("\n\n");
        const messages = [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Question: ${query}\n\nContext passages:\n${context}` },
        ];
        const cites = hits.map((h) => ({
          doc_id: h.metadata.doc_id,
          docidentifier: h.metadata.docidentifier,
          edition: h.metadata.edition,
          language: h.metadata.language,
          clause_anchor: h.metadata.clause_anchor,
          clause_title: h.metadata.clause_title,
          status: h.metadata.status ?? "unknown",
          corpus: h.metadata.corpus,
          snippet: h.text.slice(0, 400),
          score: h.score,
        }));

        // SSE streaming (for the chat UI through the service binding)
        if (body?.stream !== false) {
          const encoder = new TextEncoder();
          const sse = new ReadableStream({
            async start(controller) {
              const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
              send({ type: "citations", citations: cites });
              let answer = "";
              try {
                const res: any = await env.AI.run(MODEL_MEMBER, {
                  messages,
                  stream: true,
                  max_tokens: 3072,
                  reasoning_effort: "low",
                });
                const stream = res && typeof res.getReader === "function" ? res : res?.body;
                if (stream) {
                  const reader = (stream as ReadableStream).getReader();
                  const decoder = new TextDecoder();
                  let buf = "";
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    const parts = buf.split("\n");
                    buf = parts.pop() ?? "";
                    for (const line of parts) {
                      const trimmed = line.trim();
                      if (!trimmed.startsWith("data:")) continue;
                      try {
                        const evt = JSON.parse(trimmed.slice(5).trim());
                        const tok = typeof evt?.response === "string" ? evt.response : evt?.choices?.[0]?.delta?.content;
                        if (tok) { answer += tok; send({ type: "token", v: tok }); }
                      } catch { /* partial JSON */ }
                    }
                  }
                }
              } catch { /* stream failure */ }
              if (!answer) {
                // streaming failed — generate complete
                answer = (await generate(env, MODEL_MEMBER, messages)) ?? "I don't have information on this.";
              }
              send({ type: "done", model: MODEL_MEMBER, federated: true });
              controller.close();
            },
          });
          return new Response(sse, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" },
          });
        }

        // Non-streaming (JSON)
        let answer = await generate(env, MODEL_MEMBER, messages);
        if (!answer) answer = await generate(env, MODEL_ANON, messages);
        if (!answer) return err(502, "generation_failed", "Model unavailable");
        return json({ answer, citations: cites, model: MODEL_MEMBER, federated: true });
      } catch (e: any) {
        return err(503, "retrieval_unavailable", "Search is briefly busy — please retry.");
      }
    }

    if (req.method === "GET" && path === "/api/datasets") {
      return json({
        datasets: [
          { id: "oiml", label: "OIML Publications", enabled: true },
          { id: "iso", label: "ISO/IEC Conformity Assessment", enabled: true, note: "internal tier — you have access" },
        ],
      });
    }

    return err(404, "not_found", "Unknown route");
  },
};
