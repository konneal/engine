import type { ModelRunner } from "./ports/model.ts";
// Model calls go through the ModelRunner port (ports/model.ts); the
// request-shape probing that used to live here is adapter behavior now
// (ports/cloudflare/adapters.ts).
type AnyAi = ModelRunner;



const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function embed(ai: ModelRunner, _model: string, text: string): Promise<number[]> {
  // the adapter owns the request shape; two attempts cover transient
  // capacity errors shared with the ingest lane
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const vecs = await ai.embed([text]);
      if (vecs?.[0]?.length) return vecs[0];
      lastError = new Error("adapter returned no vector");
    } catch (e) {
      lastError = e;
    }
    if (attempt < 2) await delay(250 * (attempt + 1));
  }
  // never return an empty vector — the index rejects it with an opaque
  // 40006; a throw surfaces the real failure through the caller's catch
  throw new Error(`embed failed after retries: ${String(lastError)}`);
}

import { answerEffort, effortBudget } from "./config.ts";

export async function rerank(
  ai: AnyAi,
  model: string,
  query: string,
  texts: string[],
): Promise<number[] | null> {
  // verified REST shape first: contexts are [{text}] objects; the binding
  // may instead want plain strings — try both, then the legacy names
  // the adapter's shape probing handles provider variants; two
  // attempts cover transient capacity errors
  for (let attempt = 0; attempt < 2; attempt++) {
    const scores = await ai.rerank(model, query, texts);
    if (scores && scores.some((s) => Number.isFinite(s))) return scores;
  }
  console.error("rerank failed, using vector order");
  return null;
}

export async function generateOnce(env: any, model: string, messages: any[], effort?: string): Promise<string | null> {
  // one immediate retry: Workers AI intermittently 8005s a call that
  // succeeds unchanged on the second attempt — a flake must not degrade
  // the answer (a multimodal primary falling to a text-only fallback
  // silently blindfolds figure answers)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res: any = await env.AI.run(model, {
        messages,
        max_tokens: effortBudget(effort ?? answerEffort(env)),
        reasoning_effort: effort ?? answerEffort(env),
        temperature: 0.6,
        top_p: 0.95,
      });
      // an EMPTY string is a failed generation, not an answer: the
      // platform intermittently returns empty bodies with a 200 (observed
      // live 2026-09-20 — answers went blank platform-wide while retrieval
      // and the deterministic paths kept working). Treating "" as success
      // shipped blank answers; treating it as a failure falls through to
      // the retry and then the fallback model, so the service rides out
      // the mode instead of serving nothing.
      if (typeof res?.response === "string" && res.response.trim()) return res.response;
      if (typeof res?.choices?.[0]?.message?.content === "string" && res.choices[0].message.content.trim()) return res.choices[0].message.content;
      if (attempt === 0) console.error("generate returned empty:", model);
    } catch (e) {
      console.error("generate failed:", model, String(e).slice(0, 120));
    }
  }
  return null;
}
