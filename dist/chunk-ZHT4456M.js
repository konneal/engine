import {
  answerEffort,
  effortBudget
} from "./chunk-HWWJAJWM.js";

// workers/worker_public/src/ai.ts
var delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function embed(ai, _model, text) {
  let lastError = null;
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
  throw new Error(`embed failed after retries: ${String(lastError)}`);
}
async function rerank(ai, model, query, texts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const scores = await ai.rerank(model, query, texts);
    if (scores && scores.some((s) => Number.isFinite(s))) return scores;
  }
  console.error("rerank failed, using vector order");
  return null;
}
async function generateOnce(env, model, messages, effort) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await Promise.race([
        env.AI.run(model, {
          messages,
          max_tokens: effortBudget(effort ?? answerEffort(env)),
          reasoning_effort: effort ?? answerEffort(env),
          temperature: 0.6,
          top_p: 0.95
        }),
        new Promise((r) => setTimeout(() => r(null), 12e4))
      ]);
      if (typeof res?.response === "string" && res.response.trim()) return res.response;
      if (typeof res?.choices?.[0]?.message?.content === "string" && res.choices[0].message.content.trim()) return res.choices[0].message.content;
      if (attempt === 0) console.error("generate returned empty:", model);
    } catch (e) {
      console.error("generate failed:", model, String(e).slice(0, 120));
    }
  }
  return null;
}

export {
  embed,
  rerank,
  generateOnce
};
