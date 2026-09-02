// Self-RAG style reflection loop: after generating the answer, the model
// critiques whether every claim is grounded in the passages. If NOT, it
// identifies what's missing and the system retries retrieval.
// Ref: selfrag.github.io; Meilisearch self-RAG guide

// The prompt is data (prompts/reflect.md), bundled as text.
import reflectPrompt from "../prompts/reflect.md";

export interface ReflectionResult {
  grounded: boolean;
  missing_info: string;
}

export async function reflect(
  ai: any,
  model: string,
  question: string,
  answer: string,
  passages: string[],
): Promise<ReflectionResult | null> {
  if (!answer || !passages.length) return null;
  const ctx = passages
    .slice(0, 8)
    .map((p, i) => `[${i + 1}] ${p.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");

  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 6000));
  const call = (async () => {
    const res: any = await ai.run(model, {
      messages: [
        {
          role: "system",
          content: reflectPrompt.trimEnd(),
        },
        {
          role: "user",
          content: `Question: ${question}\n\nAnswer:\n${answer.slice(0, 1500)}\n\nPassages:\n${ctx}`,
        },
      ],
      // reasoning shares this budget — starved budgets silently disable
      // the reflection layer (null = no retry ever fires); DeepSeek-V4
      // card: keep reasoning on with headroom + temp 1.0 / top_p 1.0
      max_tokens: 3072,
      reasoning_effort: "low",
      temperature: 1.0,
      top_p: 1.0,
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    const m = (text ?? "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const raw = JSON.parse(m[0]);
      return {
        grounded: raw.grounded === true,
        missing_info: typeof raw.missing_info === "string" ? raw.missing_info.slice(0, 200) : "",
      };
    } catch {
      return null;
    }
  })();

  try {
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  }
}
