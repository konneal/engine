// The understanding contract (TODO.impl/29): QueryUnderstanding and the
// pure JSON extractor — no imports (the prompt file and the model call
// stay in understand.ts; this module is the testable contract).

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


/** Model output text
 *  → QueryUnderstanding (or null). Every silent coercion is pinned by
 *  tests/understand.test.ts — change the prompt's JSON shape and the
 *  test names what moved. */
export function extractJson(text: string): QueryUnderstanding | null {
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
