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
  // verified REST shape first: contexts are [{text}] objects; the binding
  // may instead want plain strings — try both, then the legacy names
  const shapes: Array<unknown> = [
    { query, contexts: texts.map((t) => ({ text: t })) },
    { query, contexts: texts },
    { query, candidates: texts.map((t, i) => ({ id: String(i), text: t })) },
    { query, passages: texts },
  ];
  let lastErr: unknown = null;
  for (const body of shapes) {
    // one retry per shape: a transient capacity error must not silently
    // degrade the pipeline to vector order
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = (await ai.run(model, body)) as any;
        const raw = res?.data ?? res?.result?.data ?? res?.response;
        if (!Array.isArray(raw)) {
          lastErr = new Error(`rerank shape returned ${typeof raw}`);
          break;
        }
        const scores: number[] = new Array(texts.length).fill(NaN);
        raw.forEach((x: any, i: number) => {
          if (typeof x === "number") {
            scores[i] = x;
            return;
          }
          // ids may arrive as numbers or numeric strings; anything else
          // falls back to position — which misorders sorted-by-score
          // responses, so only accept genuinely index-shaped ids
          const rawId = x?.id;
          const id =
            Number.isInteger(rawId)
              ? rawId
              : /^\d+$/.test(String(rawId ?? ""))
                ? Number(rawId)
                : i;
          const n = Number(x?.score ?? x?.relevance_score ?? NaN);
          if (id >= 0 && id < scores.length) scores[id] = n;
        });
        if (scores.some((s) => Number.isFinite(s))) return scores;
        lastErr = new Error("rerank scores unparseable");
      } catch (e) {
        lastErr = e;
      }
    }
  }
  console.error("rerank failed, using vector order:", String(lastErr));
  return null;
}
