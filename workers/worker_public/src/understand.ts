// Query understanding (TODO.impl/15 audit finding #1): a small, fast LLM
// call replaces the regex heuristics as the decision-maker for what
// retrieval should see. The regex path (selfquery.ts) remains as a
// fallback when this call fails, errors, or times out — degraded mode,
// never a hard failure.

// The prompt is data (prompts/understanding.md), bundled as text.
import SYSTEM from "../prompts/understanding.md";

export interface QueryUnderstanding {
  /** conversational turn (greeting, identity, small talk) vs knowledge seek */
  intent: "conversational" | "knowledge";
  /** normalized document reference, e.g. "OIML R 76-2" — null when none */
  docidentifier: string | null;
  /** base document number for the Vectorize filter, e.g. "60" */
  doc_number: string | null;
  edition?: string | null;
  language?: string | null;
  /** the question is about a process around publications (certify, apply…) */
  process_intent: boolean;
  /** definition-style question whose subject is `term` */
  term: string | null;
  /** corpus-terminology mapping of everyday wording (drift→creep) */
  defined_terms: string[];
  /** self-contained retrieval query: follow-ups folded with context */
  standalone_query: string;
  complexity: "simple" | "complex";
  query_variants: string[];
  sub_queries: string[];
  hypothetical_answer: string;
  /** plausible next questions (conversational UX), in the user's language */
  follow_ups: string[];
}


function extractJson(text: string): QueryUnderstanding | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[0]);
    const u: QueryUnderstanding = {
      intent: raw.intent === "conversational" ? ("conversational" as const) : ("knowledge" as const),
      docidentifier: typeof raw.docidentifier === "string" && raw.docidentifier.trim() ? raw.docidentifier.trim().slice(0, 60) : null,
      doc_number: typeof raw.docnumber === "string" && /^\d{1,3}$/.test(raw.docnumber) ? raw.docnumber : null,
      edition: typeof raw.edition === "string" && /^\d{4}$/.test(raw.edition) ? raw.edition : null,
      language: typeof raw.language === "string" && /^[a-z]{2}$/.test(raw.language) ? raw.language : null,
      process_intent: raw.process_intent === true,
      term: typeof raw.term === "string" && raw.term.trim() ? raw.term.trim().slice(0, 60) : null,
      defined_terms: Array.isArray(raw.defined_terms)
        ? raw.defined_terms.filter((t: unknown) => typeof t === "string" && (t as string).trim()).map((t: string) => t.trim().slice(0, 60)).slice(0, 4)
        : [],
      standalone_query: typeof raw.standalone_query === "string" && raw.standalone_query.trim() ? raw.standalone_query.trim().slice(0, 400) : "",
      complexity: raw.complexity === 'complex' ? ('complex' as const) : ('simple' as const),
      query_variants: Array.isArray(raw.query_variants)
        ? raw.query_variants.filter((q: unknown) => typeof q === 'string' && (q as string).trim()).map((q: string) => q.trim().slice(0, 300)).slice(0, 4)
        : [],
      hypothetical_answer: typeof raw.hypothetical_answer === "string" ? raw.hypothetical_answer.trim().slice(0, 300) : "",
      sub_queries: Array.isArray(raw.sub_queries)
        ? raw.sub_queries.filter((q: unknown) => typeof q === 'string' && (q as string).trim()).map((q: string) => q.trim().slice(0, 300)).slice(0, 5)
        : [],
      follow_ups: Array.isArray(raw.follow_ups)
        ? raw.follow_ups.filter((q: unknown) => typeof q === 'string' && (q as string).trim()).map((q: string) => q.trim().slice(0, 200)).slice(0, 2)
        : [],    };
    return u;
  } catch {
    return null;
  }
}


/** Understand the query with the cheap model. Null = use the regex fallback. */
export async function understandQuery(
  ai: any,
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
      const res: any = await ai.run(model, body);
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
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
