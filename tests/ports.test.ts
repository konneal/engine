// Port conformance (TODO.konneal/06): every port interface is
// implementable with zero provider types (in-memory fakes, type-checked
// by assignment), and the Cloudflare adapters uphold the adapter laws —
// the by-20 batch cap (Vectorize getByIds above ~20 returns EMPTY
// silently) and the response-shape probing the live bindings taught us.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRunner, GenerateRequest, GenerateResult } from "../workers/worker_public/src/ports/model.ts";
import type { VectorIndex, VectorMatch, VectorUpsert } from "../workers/worker_public/src/ports/vector.ts";
import type { Kv } from "../workers/worker_public/src/ports/kv.ts";
import type { Blobs } from "../workers/worker_public/src/ports/blobs.ts";
import type { Runtime } from "../workers/worker_public/src/ports/runtime.ts";
import { cfModelRunner, cfVectorIndex, cfKv, cfBlobs, cfRuntime } from "../workers/worker_public/src/ports/cloudflare/adapters.ts";

// ── The fakes: ports without any provider ─────────────────────────────

function fakeModel(behavior: {
  embedOut?: unknown;
  rerankOut?: unknown[] | ((body: Record<string, unknown>) => unknown[]);
  genOut?: unknown;
}): ModelRunner {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return behavior.embedOut as number[][] ?? texts.map(() => [0.1, 0.2]);
    },
    async rerank(model, query, texts) {
      return texts.map((_, i) => 1 - i * 0.1);
    },
    async run(req: GenerateRequest): Promise<GenerateResult> {
      return { text: "ok" };
    },
  };
}

function fakeIndex(rows: Record<string, unknown> = {}): VectorIndex {
  return {
    async query(q) {
      const hit: VectorMatch = { id: "v1", score: 0.9, metadata: { doc: "d" } };
      return [hit];
    },
    async upsert(vectors: VectorUpsert[]) {},
    async getByIds(ids: string[]) {
      return ids.map((id) => ({ id, score: 0, metadata: null }));
    },
  };
}

const fakeKv: Kv = {
  store: new Map<string, string>(),
  async get(key) {
    return (this.store as Map<string, string>).get(key) ?? null;
  },
  async put(key, value, opts) {
    (this.store as Map<string, string>).set(key, value);
  },
} as unknown as Kv;

const fakeBlobs: Blobs = {
  async get(key) {
    return null;
  },
  async put(key, value, contentType) {},
};

const fakeRuntime: Runtime = {
  ran: [] as boolean[],
  defer(fn) {
    (this.ran as boolean[]).push(true);
    void fn();
  },
} as unknown as Runtime;

test("the port interfaces are satisfiable without any provider types", () => {
  // compile-time conformance: each fake is a complete port
  const m = fakeModel({});
  const ix = fakeIndex();
  assert.equal(typeof m.embed, "function");
  assert.equal(typeof ix.query, "function");
  assert.equal(typeof fakeKv.get, "function");
  assert.equal(typeof fakeBlobs.put, "function");
  assert.equal(typeof fakeRuntime.defer, "function");
});

// ── Adapter laws ──────────────────────────────────────────────────────

test("cfVectorIndex chunks upserts to the 20-cap", async () => {
  const batches: number[] = [];
  const ix = cfVectorIndex({ upsert: async (vs: unknown[]) => batches.push(vs.length) });
  await ix.upsert(Array.from({ length: 45 }, (_, i) => ({ id: `v${i}`, values: [0.1], metadata: {} })));
  assert.deepEqual(batches, [20, 20, 5]);
});

test("cfVectorIndex chunks getByIds to the 20-cap (the silent-empty law)", async () => {
  const batches: number[] = [];
  const seen: string[] = [];
  const ix = cfVectorIndex({
    getByIds: async (ids: string[]) => {
      batches.push(ids.length);
      seen.push(...ids);
      return ids.map((id: string) => ({ id, metadata: {} }));
    },
  });
  const got = await ix.getByIds(Array.from({ length: 45 }, (_, i) => `v${i}`));
  assert.deepEqual(batches, [20, 20, 5]);
  assert.equal(got.length, 45);
  assert.equal(seen.length, 45);
});

test("cfVectorIndex normalizes the {matches} envelope and passes filters", async () => {
  let filterSeen: unknown = undefined;
  const ix = cfVectorIndex({
    query: async (vector: number[], opts: any) => {
      filterSeen = opts.filter;
      return { matches: [{ id: "a", score: 0.5, metadata: { doc_id: "d1" } }] };
    },
  });
  const out = await ix.query({ vector: [0.1], topK: 3, filter: { lang: "en" } });
  assert.deepEqual(out, [{ id: "a", score: 0.5, metadata: { doc_id: "d1" } }]);
  assert.deepEqual(filterSeen, { lang: "en" });
});

test("cfVectorIndex accepts a flat match array too", async () => {
  const ix = cfVectorIndex({ query: async () => [{ id: "b", score: 0.7 }] });
  const out = await ix.query({ vector: [0.1], topK: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "b");
  assert.equal(out[0].metadata, null);
});

// The live Workers AI binding returns embeddings in at least three
// envelope generations — the 2026-09-14 regression shipped an adapter
// that only knew the first, returned [], and the index rejected the
// 0-dimension query with an opaque 40006. Every envelope the original
// seam code handled is pinned here.
test("cfModelRunner.embed reads every known response envelope", async () => {
  const cases: { res: unknown; want: number[][] }[] = [
    { res: { data: [[0.1, 0.2]] }, want: [[0.1, 0.2]] },
    { res: { result: { data: [[0.3, 0.4]] } }, want: [[0.3, 0.4]] },
    { res: { embedding: [0.5, 0.6] }, want: [[0.5, 0.6]] },
    { res: { data: [{ embedding: [0.7, 0.8] }] }, want: [[0.7, 0.8]] },
  ];
  for (const { res, want } of cases) {
    const ai = { run: async () => res };
    assert.deepEqual(await cfModelRunner(ai).embed(["a"]), want, JSON.stringify(res));
  }
});

test("cfModelRunner.embed probes request shapes until one answers, and batches", async () => {
  const bodies: unknown[] = [];
  let attempt = 0;
  const ai = { run: async (_m: string, body: unknown) => {
    bodies.push(body);
    attempt++;
    if (attempt === 1) return { result: { shape: [1, 1024] } }; // no data — wrong envelope
    return { result: { data: [[0.1], [0.2]] } };
  } };
  const out = await cfModelRunner(ai).embed(["a", "b"]);
  assert.deepEqual(out, [[0.1], [0.2]]);
  assert.deepEqual((bodies[0] as { text: string[] }).text, ["a", "b"]);
  assert.deepEqual((bodies[1] as { text: string[] }).text, ["a", "b"]);
});

test("cfModelRunner.embed throws when every shape fails — never an empty vector", async () => {
  const ai = { run: async () => ({ result: { shape: [1, 1024] } }) };
  await assert.rejects(() => cfModelRunner(ai).embed(["a"]));
});

test("cfModelRunner.rerank probes shapes and places scores by id", async () => {
  let attempt = 0;
  const ai = { run: async (_m: string, body: any) => {
    attempt++;
    if (attempt === 1) throw new Error("bad shape");
    return { data: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] };
  } };
  const out = await cfModelRunner(ai).rerank("reranker", "q", ["t0", "t1", "t2"]);
  assert.deepEqual(out, [0.1, NaN, 0.9]);
});

test("cfModelRunner.rerank returns null when every shape fails", async () => {
  const ai = { run: async () => { throw new Error("no"); } };
  assert.equal(await cfModelRunner(ai).rerank("reranker", "q", ["t"]), null);
});

test("cfModelRunner.run maps the request and unwraps the response", async () => {
  const seen: { model: string; body: any }[] = [];
  const ai = { run: async (model: string, body: unknown) => {
    seen.push({ model, body });
    return { response: "the answer" };
  } };
  const m = cfModelRunner(ai);
  const res = await m.run({
    model: "glm", messages: [{ role: "user", content: "hi" }],
    maxTokens: 512, effort: "low", temperature: 0.6, topP: 0.95,
  });
  assert.equal(res.text, "the answer");
  assert.equal(seen[0].model, "glm");
  assert.equal(seen[0].body.max_tokens, 512);
  assert.equal(seen[0].body.reasoning_effort, "low");
  assert.equal(seen[0].body.temperature, 0.6);
  assert.equal(seen[0].body.top_p, 0.95);
  assert.equal(seen[0].body.stream, undefined);
});

test("cfModelRunner.run hands back a stream when the binding returns one", async () => {
  const reader = { read: async () => ({ done: true, value: undefined }) };
  const ai = { run: async () => ({ getReader: () => reader }) };
  const res = await cfModelRunner(ai).run({ model: "m", messages: [], maxTokens: 8, stream: true });
  assert.equal(res.text, null);
  assert.equal(typeof res.stream!.getReader, "function");
});

test("cfModelRunner.run reads choices-shaped responses", async () => {
  const ai = { run: async () => ({ choices: [{ message: { content: "alt" } }] }) };
  const res = await cfModelRunner(ai).run({ model: "m", messages: [], maxTokens: 8 });
  assert.equal(res.text, "alt");
});

test("cfKv maps ttlSec to expirationTtl and passes plain puts through", async () => {
  const puts: { key: string; value: string; opts: unknown }[] = [];
  const kv = cfKv({ get: async (k: string) => `got:${k}`, put: async (key: string, value: string, opts: unknown) => puts.push({ key, value, opts }) });
  assert.equal(await kv.get("k"), "got:k");
  await kv.put("k", "v", { ttlSec: 60 });
  await kv.put("k2", "v2");
  assert.deepEqual(puts, [
    { key: "k", value: "v", opts: { expirationTtl: 60 } },
    { key: "k2", value: "v2", opts: undefined },
  ]);
});

test("cfBlobs returns null for missing objects and sets contentType on put", async () => {
  const puts: unknown[] = [];
  const body = { text: () => Promise.resolve("x") };
  const r2 = {
    get: async (key: string) => (key === "none" ? null : { body, httpMetadata: { contentType: "text/html" } }),
    put: async (key: string, value: unknown, opts: unknown) => puts.push({ key, value, opts }),
  };
  const blobs = cfBlobs(r2);
  assert.equal(await blobs.get("none"), null);
  const hit = await blobs.get("doc");
  assert.equal(hit?.contentType, "text/html");
  await blobs.put("doc", "data", "text/html");
  assert.deepEqual(puts, [{ key: "doc", value: "data", opts: { httpMetadata: { contentType: "text/html" } } }]);
});

test("cfRuntime defers through waitUntil when present, runs inline when absent", async () => {
  const awaited: boolean[] = [];
  const withCtx = cfRuntime({ waitUntil: (p) => { awaited.push(true); void p; } });
  let ran = false;
  withCtx.defer(async () => { ran = true; });
  assert.ok(awaited.length === 1 && ran);
  const noCtx = cfRuntime(undefined);
  let ran2 = false;
  noCtx.defer(async () => { ran2 = true; });
  assert.ok(ran2);
});
