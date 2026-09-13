import type { ModelRunner } from "./ports/model.ts";
import { extractJson, type QueryUnderstanding } from "./understandContract.ts";
export type { QueryUnderstanding };

// Query understanding (TODO.impl/15 audit finding #1): a small, fast LLM
// call replaces the regex heuristics as the decision-maker for what
// retrieval should see. The regex path (selfquery.ts) remains as a
// fallback when this call fails, errors, or times out — degraded mode,
// never a hard failure.

// The prompt is data (prompts/understanding.md), bundled as text.
import SYSTEM from "../prompts/understanding.md";

/** Understand the query with the cheap model. Null = use the regex fallback. */
export async function understandQuery(
  ai: ModelRunner,
  model: string,
  query: string,
  history: Array<{ role: string; content: string }>,
  entities: Array<{ entity: string; kind: string }> = [],
): Promise<QueryUnderstanding | null> {
  const convo = history
    .slice(-6)
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content.slice(0, 600)}`)
    .join("\n");
  const entityLine = entities.length
    ? `Entities already established in this conversation: ${entities.map((e) => e.entity).join("; ")}. Resolve pronouns and shorthand against these.\n\n`
    : "";
  const user = `${convo ? "Conversation so far:\n" + convo + "\n\n" : ""}${entityLine}Question: ${query}`;
  const body = {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    // the model always reasons; reasoning tokens share this budget — too
    // small and the JSON is never reached (understanding silently degrades).
    // GLM-5 family defaults to reasoning_effort "max" when the parameter is
    // not honored, so GLM needs headroom or reasoning starves the JSON.
    max_tokens: model.includes("glm") ? 3072 : 1500,
    reasoning_effort: "low",
    // Qwen3 thinking-mode sampling (model card): greedy/1.0 sampling
    // degrades into repetition loops — the 10s/5s timeout nulls were the
    // budget being eaten by loops, not by reasoning
    temperature: 0.6,
    top_p: 0.95,
    top_k: 20,
  };
  // each attempt issues a FRESH call — re-racing a timed-out promise would
  // retry nothing. Generous first attempt: reasoning + the full JSON must
  // fit inside the timeout or understanding silently degrades to vanilla
  // retrieval (which refuses conversational turns).
  const ATTEMPT_TIMEOUTS = [10000, 5000];
  for (let attempt = 0; attempt < ATTEMPT_TIMEOUTS.length; attempt++) {
    const call = (async () => {
      const res = await ai.run({ model, messages: (body as any).messages, effort: (body as any).reasoning_effort, maxTokens: (body as any).max_tokens, temperature: (body as any).temperature, topP: (body as any).top_p, topK: (body as any).top_k });
      const text = res?.text ?? null;
      return typeof text === "string" ? extractJson(text) : null;
    })();
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), ATTEMPT_TIMEOUTS[attempt]));
    try {
      const got = await Promise.race([call, timeout]);
      if (got) return got;
    } catch (e) {
      // account rate-limited: a retry in the same minute will also fail —
      // degrade to vanilla retrieval immediately instead of burning the
      // second attempt (TTFT surgery)
      if (String(e).includes("3021") || String(e).includes("rate")) return null;
    }
  }
  console.warn("query understanding unavailable — vanilla retrieval");
  return null;
}
