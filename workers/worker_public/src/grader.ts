// CRAG-style retrieval grader (audit finding; the corrective layer of
// 2025 SOTA RAG architectures): grade the retrieved passages against the
// question BEFORE generating. "weak" triggers one corrective re-retrieval;
// "bad" flows through to the strict generation prompt, which refuses
// honestly — the grader never invents a refusal of its own.

// The prompt is data (prompts/grader.md), bundled as text.
import SYSTEM from "../prompts/grader.md";

export type RetrievalGrade = "good" | "weak" | "bad";



export async function gradeRetrieval(
  ai: any,
  model: string,
  query: string,
  passages: string[],
): Promise<RetrievalGrade> {
  if (!passages.length) return "bad";
  const summary = passages
    .slice(0, 8)
    .map((p, i) => `[${i + 1}] ${p.replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 6000));
  const call = (async () => {
    const res: any = await ai.run(model, {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Question: ${query}\n\nPassages:\n${summary}` },
      ],
      // reasoning shares this budget — starved budgets silently disable
      // the CRAG corrective layer (default "good" fires). DeepSeek-V4's
      // non-think mode is severely degraded (model card: HLE 8.1 vs 34.8),
      // so the grader keeps reasoning on with real headroom plus the
      // card's recommended sampling.
      max_tokens: 3072,
      reasoning_effort: "low",
      temperature: 1.0,
      top_p: 1.0,
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    const m = (text ?? "").match(/"grade"\s*:\s*"(good|weak|bad)"/);
    return m ? (m[1] as RetrievalGrade) : null;
  })();
  try {
    const got = await Promise.race([call, timeout]);
    return got ?? "good"; // grader unavailable → do not block the pipeline
  } catch {
    return "good";
  }
}
