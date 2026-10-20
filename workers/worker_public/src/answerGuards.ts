// The answer-contract's text guards, dependency-free so plain node can
// load them for unit tests (ask.ts imports .md prompts that only the
// bundler resolves — the guards were module-local there and rode e2e
// alone). Both lanes share them: the JSON lane's contract retry and the
// streamed lane's 80-char head ruling.

// The tool-narration leak (2026-10-14, the R 134-1 probe): the answer
// model sometimes NARRATES the agent loop's call in prose — 'The
// db.find tool returned, for the query "…": {…json…}' — instead of
// answering. The TOOL-line scrub cannot catch prose. The JSON lane
// regenerates through the contract retry; the streamed lane buffers
// the head and sends the retry sentinel (the blind-answer guard's
// client contract) before streaming the fresh answer. One bounded
// restart per lane.
export function toolNarration(t: string): boolean {
  return /^(?:the\s+)?[a-z][a-z_.]*\.[a-z_]+ tool returned\b/i.test(t.slice(0, 200)) ||
    /tool returned,? for the query\b/i.test(t.slice(0, 300));
}
export const TOOL_NARRATION_NOTICE =
  "Correction notice: your draft narrated an internal tool call ('the … tool returned …') instead of answering. Rewrite: answer the question directly from the retrieved passages, cite the clauses, and never mention tools, queries, wire formats, or JSON.";

// The intent preamble (2026-10-19, the ~200-word technical-file
// question): the draft is a PLAN, not an answer — "I'll look up the R
// 76-1 MPE clause and classification details in the corpus." — shipped
// while ten citations rode the same response. Narrow by construction:
// it must OPEN with a first-person intent verb AND carry no substance —
// short, no clause citation, no normative numbers (a real answer's
// opening names values or clauses).
export function intentPreamble(t: string): boolean {
  const s = (t ?? "").trim();
  if (s.length > 240) return false;
  if (!/^(?:i'll|i will|let me|let's|i'm going to|i am going to)\b/i.test(s)) return false;
  return !/\[\[u:|\[\^?\d+\]|\b\d+\.\d+\b/.test(s);
}
export const INTENT_PREAMBLE_NOTICE =
  "Correction notice: your draft announced a plan ('I'll look up …') instead of answering. Do not narrate intent — answer the question NOW from the retrieved passages: give the values, clause references and citations the question asks for.";
