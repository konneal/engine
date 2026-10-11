// workers/worker_public/src/ports/cloudflare/adapters.ts
var EMBED_REQUEST_SHAPES = {
  // "text" first: the verified request shape for qwen3-embedding-0.6b
  text: (texts) => ({ text: texts }),
  "input.input": (texts) => ({ input: { input: texts } }),
  array: (texts) => ({ input: texts })
};
var embedRequestWinner = null;
function extractVecBatch(res, n) {
  const r = res;
  const d = r?.data ?? r?.result?.data;
  const rows = Array.isArray(d) ? d : Array.isArray(r?.embedding) ? [r.embedding] : null;
  if (!rows) return null;
  const out = [];
  for (const row of rows.slice(0, n)) {
    const vec = Array.isArray(row) ? row : Array.isArray(row?.embedding) ? row.embedding : null;
    if (!vec || vec.length === 0) return null;
    out.push(vec.map(Number));
  }
  return out.length === n ? out : null;
}
var by20 = (xs) => {
  const out = [];
  for (let i = 0; i < xs.length; i += 20) out.push(xs.slice(i, i + 20));
  return out;
};
var RERANK_SHAPES = (query, texts) => [
  { query, contexts: texts.map((t) => ({ text: t })) },
  { query, contexts: texts },
  { query, candidates: texts.map((t, i) => ({ id: String(i), text: t })) },
  { query, passages: texts }
];
function cfModelRunner(ai) {
  const A = ai;
  return {
    async embed(texts) {
      const order = embedRequestWinner ? [embedRequestWinner] : Object.keys(EMBED_REQUEST_SHAPES);
      for (const name of order) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await A.run("@cf/qwen/qwen3-embedding-0.6b", EMBED_REQUEST_SHAPES[name](texts));
            const vecs = extractVecBatch(res, texts.length);
            if (vecs) {
              embedRequestWinner = name;
              return vecs;
            }
          } catch {
          }
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
      throw new Error(`embedding failed for all request shapes (${texts.length} text(s))`);
    },
    async rerank(model, query, texts) {
      for (const body of RERANK_SHAPES(query, texts)) {
        try {
          const res = await A.run(model, body);
          const raw = res?.data ?? res?.result?.data ?? res?.response;
          if (!Array.isArray(raw)) continue;
          const scores = new Array(texts.length).fill(NaN);
          raw.forEach((x, i) => {
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
        }
      }
      return null;
    },
    async run(req) {
      const res = await ai.run(req.model, {
        messages: req.messages,
        max_tokens: req.maxTokens,
        ...req.effort ? { reasoning_effort: req.effort } : {},
        ...req.temperature != null ? { temperature: req.temperature } : {},
        ...req.topP != null ? { top_p: req.topP } : {},
        ...req.topK != null ? { top_k: req.topK } : {},
        ...req.stream ? { stream: true } : {}
      });
      if (req.stream && res && typeof res.getReader === "function") return { text: null, stream: res };
      if (req.stream && res?.body && typeof res.body.getReader === "function") return { text: null, stream: res.body };
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
      return { text: typeof text === "string" ? text : null };
    }
  };
}
function cfVectorIndex(index) {
  const ix = index;
  return {
    async query(q) {
      const r = await ix.query(q.vector, {
        topK: q.topK,
        returnMetadata: "all",
        ...q.filter ? { filter: q.filter } : {}
      });
      return (r.matches ?? r).map((m) => ({ id: m.id, score: m.score, metadata: m.metadata ?? null }));
    },
    async upsert(vectors) {
      for (const group of by20(vectors)) await ix.upsert(group);
    },
    async getByIds(ids) {
      const out = [];
      for (const group of by20(ids)) {
        const got = await ix.getByIds(group);
        out.push(...(got ?? []).map((m) => ({ id: m.id, score: 0, metadata: m.metadata ?? null })));
      }
      return out;
    }
  };
}
function cfKv(ns) {
  const kv = ns;
  return {
    get: (key) => kv.get(key),
    put: (key, value, opts) => kv.put(key, value, opts?.ttlSec ? { expirationTtl: opts.ttlSec } : void 0)
  };
}
function cfBlobs(bucket) {
  const r2 = bucket;
  return {
    async get(key) {
      const obj = await r2.get(key);
      if (!obj) return null;
      return { body: obj.body, contentType: obj.httpMetadata?.contentType };
    },
    async put(key, value, contentType) {
      await r2.put(key, value, contentType ? { httpMetadata: { contentType } } : void 0);
    },
    async delete(key) {
      await r2.delete(key);
    }
  };
}
function cfStore(db) {
  return db;
}
function cfRuntime(ctx) {
  return {
    defer(fn) {
      if (ctx) ctx.waitUntil(fn());
      else void fn();
    }
  };
}

// workers/worker_public/src/env.ts
function portModelRunner(env) {
  return cfModelRunner(env.AI);
}
function portIndex(env, which = "public") {
  const b = which === "public" ? env.VECTORIZE : which === "primmel" ? env.EXP_PRIMMEL : which === "composed" ? env.EXP_COMPOSED : which === "plain" ? env.EXP_PLAIN : which === "adoc" ? env.EXP_ADC : which === "mko" ? env.EXP_MKO : which === "pflat" ? env.EXP_PFLAT : env.GLOSSARY;
  return cfVectorIndex(b);
}
function portKv(env) {
  return cfKv(env.CACHE);
}
function portBlobs(env) {
  return cfBlobs(env.UNIT_ASSETS);
}
function portStore(env) {
  return cfStore(env.DB);
}
function hasLane(env, which) {
  switch (which) {
    case "glossary":
      return !!env.GLOSSARY;
  }
}
function portRuntime(ctx) {
  return cfRuntime(ctx);
}

export {
  cfBlobs,
  portModelRunner,
  portIndex,
  portKv,
  portBlobs,
  portStore,
  hasLane,
  portRuntime
};
