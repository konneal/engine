// The CRAG per-passage evaluator core (TODO.sota/14.6 v2): grade EACH used
// passage's relevance on the CRAG vocabulary. Dependency-free on purpose —
// the system prompt arrives as a parameter (the md-importing binding lives
// in grader.ts), the ai binding is injected, every failure mode is
// fail-open: a lost race or an unparseable reply grades null, because
// absence is honest and a guess is not. Opt-in — only the reproducibility
// manifest requests these grades, so the k calls never sit on the default
// serving path.

export type PassageGrade = "correct" | "incorrect" | "ambiguous";

export async function gradePassage(
  ai: any,
  model: string,
  systemPrompt: string,
  query: string,
  passage: string,
  timeoutMs = 6000,
): Promise<PassageGrade | null> {
  try {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
    const call = (async () => {
      const res: any = await ai.run(model, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Question: ${query}\n\nPassage:\n${passage.replace(/\s+/g, " ").slice(0, 1200)}` },
        ],
        max_tokens: 6144,
        reasoning_effort: "low",
        // a measurement: greedy decoding, no sampling
        temperature: 0,
        top_p: 1,
      });
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
      const m = (text ?? "").match(/"grade"\s*:\s*"(correct|incorrect|ambiguous)"/);
      return m ? (m[1] as PassageGrade) : null;
    })();
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  }
}

export function gradePassages(
  ai: any,
  model: string,
  systemPrompt: string,
  query: string,
  passages: string[],
): Promise<(PassageGrade | null)[]> {
  return Promise.all(passages.map((p) => gradePassage(ai, model, systemPrompt, query, p)));
}
