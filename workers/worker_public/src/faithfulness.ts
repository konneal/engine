// RAGAS-style faithfulness scorer: LLM-as-judge verifies that every claim
// in the answer is supported by the retrieved passages. This catches
// hallucinations the golden-set pattern matcher cannot.
// Ref: docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness

// The prompt is data (prompts/faithfulness.md), bundled as text.
import faithfulnessPrompt from "../prompts/faithfulness.md";

export interface FaithfulnessResult {
  score: number; // 0-1 (1 = every claim grounded)
  ungrounded_claims: string[];
}

export async function scoreFaithfulness(
  ai: any,
  model: string,
  answer: string,
  passages: string[],
): Promise<FaithfulnessResult | null> {
  if (!answer || !passages.length) return null;
  const context = passages
    .slice(0, 8)
    .map((p, i) => `[${i + 1}] ${p.replace(/\s+/g, " ").slice(0, 900)}`)
    .join("\n");

  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 15000));
  const call = (async () => {
    const res: any = await ai.run(model, {
      messages: [
        {
          role: "system",
          content: faithfulnessPrompt.trimEnd(),
        },
        { role: "user", content: `Answer:\n${answer.slice(0, 2000)}\n\nPassages:\n${context}` },
      ],
      max_tokens: 1200,
      reasoning_effort: "low",
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    // reasoning models can emit several {...} fragments before the final
    // verdict — take the LAST flat object that parses with a numeric score
    let parsed: { score?: unknown; ungrounded_claims?: unknown } | null = null;
    for (const m of (text ?? "").matchAll(/\{[^{}]*\}/g)) {
      try {
        const obj = JSON.parse(m[0]);
        if (typeof obj.score === "number") parsed = obj;
      } catch {
        // not JSON — keep scanning
      }
    }
    if (!parsed) return null;
    return {
      score: Math.max(0, Math.min(1, parsed.score as number)),
      ungrounded_claims: Array.isArray(parsed.ungrounded_claims) ? parsed.ungrounded_claims.map(String).slice(0, 5) : [],
    };
  })();

  try {
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  }
}
