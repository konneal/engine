/** The Cloudflare reference adapters — the ONLY module where provider
 *  APIs appear. Domain modules import the port interfaces; the purity
 *  lint (npm run lint:ports) fails any other file that names a
 *  provider binding type. Zero runtime change: each adapter forwards
 *  to the binding the call sites used to touch directly. */
import type { ModelRunner, GenerateRequest, GenerateResult } from "../model.ts";
import type { VectorIndex, VectorMatch, VectorQuery, VectorUpsert } from "../vector.ts";
import type { Kv } from "../kv.ts";
import type { Blobs } from "../blobs.ts";
import type { Runtime } from "../runtime.ts";

const by20 = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += 20) out.push(xs.slice(i, i + 20));
  return out;
};

const RERANK_SHAPES = (query: string, texts: string[]) => [
  { query, contexts: texts.map((t) => ({ text: t })) },
  { query, contexts: texts },
  { query, candidates: texts.map((t, i) => ({ id: String(i), text: t })) },
  { query, passages: texts },
];

export function cfModelRunner(ai: unknown): ModelRunner {
  const A = ai as any;
  return {
    async embed(texts: string[]) {
      const res: any = await A.run("@cf/qwen/qwen3-embedding-0.6b", { text: texts });
      const shape = res?.data ?? res?.shape ?? res;
      return Array.isArray(shape) ? shape : (shape?.data ?? []);
    },
    async rerank(model, query, texts) {
      for (const body of RERANK_SHAPES(query, texts)) {
        try {
          const res: any = await A.run(model, body);
          const raw = res?.data ?? res?.result?.data ?? res?.response;
          if (!Array.isArray(raw)) continue;
          const scores: number[] = new Array(texts.length).fill(NaN);
          raw.forEach((x: any, i: number) => {
            if (typeof x === "number") {
              scores[i] = x;
              return;
            }
            const id = Number(x?.id ?? x?.index ?? i);
            const s = Number(x?.score ?? x?.relevance_score);
            if (Number.isInteger(id) && id >= 0 && id < texts.length && Number.isFinite(s)) scores[id] = s;
          });
          if (scores.some((s) => Number.isFinite(s))) return scores;
        } catch {
          // next shape
        }
      }
      return null;
    },
    async run(req: GenerateRequest): Promise<GenerateResult> {
      const res: any = await (ai as any).run(req.model, {
        messages: req.messages,
        max_tokens: req.maxTokens,
        ...(req.effort ? { reasoning_effort: req.effort } : {}),
        ...(req.temperature != null ? { temperature: req.temperature } : {}),
        ...(req.topP != null ? { top_p: req.topP } : {}),
        ...(req.topK != null ? { top_k: req.topK } : {}),
        ...(req.stream ? { stream: true } : {}),
      });
      if (req.stream && res && typeof res.getReader === "function") return { text: null, stream: res };
      if (req.stream && res?.body && typeof res.body.getReader === "function") return { text: null, stream: res.body };
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
      return { text: typeof text === "string" ? text : null };
    },
  };
}

export function cfVectorIndex(index: unknown): VectorIndex {
  const ix = index as any;
  return {
    async query(q: VectorQuery) {
      const r = await ix.query(q.vector, {
        topK: q.topK,
        returnMetadata: "all",
        ...(q.filter ? { filter: q.filter } : {}),
      });
      return (r.matches ?? r).map((m: any) => ({ id: m.id, score: m.score, metadata: m.metadata ?? null }));
    },
    async upsert(vectors: VectorUpsert[]) {
      // the adapter law: batches above the provider cap go in chunks
      for (const group of by20(vectors)) await ix.upsert(group);
    },
    async getByIds(ids: string[]) {
      // getByIds above ~20 returns EMPTY silently — chunk, always
      const out: VectorMatch[] = [];
      for (const group of by20(ids)) {
        const got = await ix.getByIds(group);
        out.push(...(got ?? []).map((m: any) => ({ id: m.id, score: 0, metadata: m.metadata ?? null })));
      }
      return out;
    },
  };
}

export function cfKv(ns: unknown): Kv {
  const kv = ns as any;
  return {
    get: (key) => kv.get(key),
    put: (key, value, opts) => kv.put(key, value, opts?.ttlSec ? { expirationTtl: opts.ttlSec } : undefined),
  };
}

export function cfBlobs(bucket: unknown): Blobs {
  const r2 = bucket as any;
  return {
    async get(key) {
      const obj = await r2.get(key);
      if (!obj) return null;
      return { body: obj.body, contentType: obj.httpMetadata?.contentType };
    },
    async put(key, value, contentType) {
      await r2.put(key, value, contentType ? { httpMetadata: { contentType } } : undefined);
    },
  };
}

export function cfRuntime(ctx: { waitUntil(p: Promise<unknown>): void } | undefined): Runtime {
  return {
    defer(fn) {
      if (ctx) ctx.waitUntil(fn());
      else void fn();
    },
  };
}
