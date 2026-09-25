// RAGAS-style faithfulness scorer: LLM-as-judge verifies that every claim
// in the answer is supported by the retrieved passages. This catches
// hallucinations the golden-set pattern matcher cannot.
// Ref: docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness

// The prompt is data (prompts/faithfulness.md), bundled as text.
import faithfulnessPrompt from "../prompts/faithfulness.md";
import { parseVerdict } from "./verdict-parse";
import { buildJudgeContext } from "./faithfulness-context";

export type { Verdict } from "./verdict-parse";

export interface FaithfulnessResult {
  score: number; // 0-1 (1 = every claim grounded)
  ungrounded_claims: string[];
}

export async function scoreFaithfulness(
  ai: any,
  model: string,
  answer: string,
  passages: string[],
  machine: string[] = [],
): Promise<FaithfulnessResult | null> {
  if (!answer || !passages.length) return null;
  const context = buildJudgeContext(passages, machine);

  const t0 = Date.now();
  const timeout = new Promise<null>((r) => setTimeout(() => { console.log(`faithfulness: timeout (${Date.now() - t0}ms)`); r(null); }, 240000));
  const call = (async () => {
    const res: any = await ai.run(model, {
      messages: [
        {
          role: "system",
          content: faithfulnessPrompt.trimEnd(),
        },
        { role: "user", content: `Answer:\n${answer.slice(0, 2000)}\n\nPassages:\n${context}${machine.length ? buildJudgeContext([], machine) : ""}` },
      ],
      max_tokens: 6144,
      reasoning_effort: "low",
      // DeepSeek-V4 card: temp 1.0 / top_p 1.0
      temperature: 1.0,
      top_p: 1.0,
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    const verdict = parseVerdict(text ?? "");
    if (!verdict) {
      console.log(`faithfulness: no parse (${Date.now() - t0}ms, text ${((text ?? "").length)} chars) raw=${JSON.stringify((text ?? "").replace(/\s+/g, " ").slice(0, 500))}`);
      return null;
    }
    return verdict;
  })();

  return await Promise.race([call, timeout]);
}
