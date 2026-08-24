// CRAG-style retrieval grader (audit finding; the corrective layer of
// 2025 SOTA RAG architectures): grade the retrieved passages against the
// question BEFORE generating. "weak" triggers one corrective re-retrieval;
// "bad" flows through to the strict generation prompt, which refuses
// honestly — the grader never invents a refusal of its own.

export type RetrievalGrade = "good" | "weak" | "bad";

const SYSTEM = [
  "You grade retrieval quality for a legal-metrology Q&A system.",
  "Given the question and the retrieved passage summaries, reply with ONLY:",
  '{"grade": "good"}  — passages clearly contain the material to answer',
  '{"grade": "weak"}  — passages are on the right publication/topic but lack the specific material (a broader or differently-worded retrieval might find it)',
  '{"grade": "bad"}   — passages are unrelated to the question',
].join("\n");

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
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 2500));
  const call = (async () => {
    const res: any = await ai.run(model, {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Question: ${query}\n\nPassages:\n${summary}` },
      ],
      max_tokens: 200,
      reasoning_effort: "low",
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
