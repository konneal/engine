// Workers AI request/response shapes vary across model generations
// (embeddings and rerankers especially). These helpers try the known
// shapes in order, remember the winner for the isolate's lifetime, and
// normalize the response. Failures fall back to the next shape; total
// failure throws for embeddings (fatal) or returns null for rerank
// (non-fatal — vector order is used instead).

type AnyAi = { run: (model: string, body: unknown) => Promise<unknown> };

let embedShapeOrder: string[] | null = null;
const EMBED_SHAPES: Record<string, (t: string) => unknown> = {
  // "text" first: the verified request shape for qwen3-embedding-0.6b —
  // every wrong-shape attempt also burns AI rate budget.
  text: (t) => ({ text: [t] }),
  "input.input": (t) => ({ input: { input: [t] } }),
  array: (t) => ({ input: [t] }),
};

function extractVec(res: unknown): number[] | null {
  const r = res as any;
  const d = r?.data ?? r?.result?.data;
  if (Array.isArray(d)) {
    const first = d[0];
    if (Array.isArray(first)) return first.map(Number);
    if (first && Array.isArray(first.embedding)) return first.embedding.map(Number);
  }
  if (Array.isArray(r?.embedding)) return r.embedding.map(Number);
  return null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function embed(ai: AnyAi, model: string, text: string): Promise<number[]> {
  const names = embedShapeOrder ?? Object.keys(EMBED_SHAPES);
  for (const name of names) {
    // Transient failures (capacity/rate limits shared with ingest) get a
    // short retry ladder on the same shape before moving on.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await ai.run(model, EMBED_SHAPES[name](text));
        const vec = extractVec(res);
        if (vec && vec.length > 0) {
          embedShapeOrder = [name, ...names.filter((n) => n !== name)];
          return vec;
        }
      } catch {
        // retry same shape, then fall through to the next shape
      }
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
  }
  throw new Error(`embedding failed for all request shapes (${model})`);
}

export async function rerank(
  ai: AnyAi,
  model: string,
  query: string,
  texts: string[],
): Promise<number[] | null> {
  const shapes: Array<unknown> = [
    { query, candidates: texts.map((t, i) => ({ id: String(i), text: t })) },
    { query, passages: texts },
    { input: { query, passages: texts } },
  ];
  for (const body of shapes) {
    try {
      const res = (await ai.run(model, body)) as any;
      const raw = res?.data ?? res?.result?.data ?? res?.response;
      if (!Array.isArray(raw)) continue;
      const scores = raw.map((x: any) => {
        const n = typeof x === "number" ? x : Number(x?.score ?? x?.relevance_score ?? NaN);
        return Number.isFinite(n) ? n : NaN;
      });
      if (scores.length === texts.length && scores.some((s) => Number.isFinite(s))) {
        return scores;
      }
    } catch {
      // try next shape
    }
  }
  return null;
}
