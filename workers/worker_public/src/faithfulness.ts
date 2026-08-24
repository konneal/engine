// RAGAS-style faithfulness scorer: LLM-as-judge verifies that every claim
// in the answer is supported by the retrieved passages. This catches
// hallucinations the golden-set pattern matcher cannot.
// Ref: docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness

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
    .map((p, i) => `[${i + 1}] ${p.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");

  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 5000));
  const call = (async () => {
    const res: any = await ai.run(model, {
      messages: [
        {
          role: "system",
          content: [
            "You are a factuality judge. Given an answer and the retrieved passages it was based on,",
            "identify any claims in the answer that are NOT directly supported by the passages.",
            "Reply with ONLY a JSON object:",
            '{"score": 0.0-1.0, "ungrounded_claims": ["claim text", ...]}',
            "score = fraction of claims that ARE grounded in the passages.",
            "If every claim is supported, score is 1.0 and ungrounded_claims is [].",
          ].join(" "),
        },
        { role: "user", content: `Answer:\n${answer.slice(0, 2000)}\n\nPassages:\n${context}` },
      ],
      max_tokens: 400,
      reasoning_effort: "low",
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    const m = (text ?? "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const raw = JSON.parse(m[0]);
      return {
        score: typeof raw.score === "number" ? Math.max(0, Math.min(1, raw.score)) : 0.5,
        ungrounded_claims: Array.isArray(raw.ungrounded_claims) ? raw.ungrounded_claims.map(String).slice(0, 5) : [],
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
