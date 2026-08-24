// Query understanding (TODO.impl/15 audit finding #1): a small, fast LLM
// call replaces the regex heuristics as the decision-maker for what
// retrieval should see. The regex path (selfquery.ts) remains as a
// fallback when this call fails, errors, or times out — degraded mode,
// never a hard failure.

export interface QueryUnderstanding {
  /** normalized document reference, e.g. "OIML R 60-3" — null when none */
  docidentifier: string | null;
  /** base document number for the Vectorize filter, e.g. "60" */
  doc_number: string | null;
  edition?: string | null;
  language?: string | null;
  /** the question is about a process around publications (certify, apply…) */
  process_intent: boolean;
  /** definition-style question whose subject is `term` */
  term: string | null;
  /** self-contained retrieval query: follow-ups folded with context */
  standalone_query: string;
}

const SYSTEM = [
  "You normalize a user question for a retrieval system over OIML legal-metrology publications (English corpus).",
  "Reply with ONLY a JSON object, no prose, no markdown fence:",
  '{"docidentifier": "OIML R 60-3" | null, "docnumber": "60" | null, "edition": "2021" | null, "language": "en" | null, "process_intent": true | false, "term": "load cell" | null, "standalone_query": "..."}',
  "Rules:",
  '- docidentifier: the publication the user names, in any spelling ("r60", "R 60-3", "OIML R60", "the load cell recommendation" → resolve to the OIML identifier you can infer; include the part ("-1", "-3") only when clearly meant). docnumber is the base number without part.',
  "- edition: only when the user pins a year.",
  "- language: only when the user asks for a specific answer language; otherwise null (the corpus is English; answering in the user's language is handled elsewhere).",
  "- process_intent: true when the question is about HOW to do something around publications (get certified, apply, contact an issuing authority, comply) rather than the technical content of a publication.",
  "- term: the defined term when the question asks what something is (\"what is a load cell\" → \"load cell\"); otherwise null.",
  "- standalone_query: the question rewritten to stand alone — fold in the conversation context so \"give me more details\" becomes the concrete question. Keep the user's own words where they already stand alone.",
].join("\n");

function extractJson(text: string): QueryUnderstanding | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[0]);
    const u: QueryUnderstanding = {
      docidentifier: typeof raw.docidentifier === "string" && raw.docidentifier.trim() ? raw.docidentifier.trim().slice(0, 60) : null,
      doc_number: typeof raw.docnumber === "string" && /^\d{1,3}$/.test(raw.docnumber) ? raw.docnumber : null,
      edition: typeof raw.edition === "string" && /^\d{4}$/.test(raw.edition) ? raw.edition : null,
      language: typeof raw.language === "string" && /^[a-z]{2}$/.test(raw.language) ? raw.language : null,
      process_intent: raw.process_intent === true,
      term: typeof raw.term === "string" && raw.term.trim() ? raw.term.trim().slice(0, 60) : null,
      standalone_query: typeof raw.standalone_query === "string" && raw.standalone_query.trim() ? raw.standalone_query.trim().slice(0, 400) : "",
    };
    return u;
  } catch {
    return null;
  }
}

const TIMEOUT_MS = 3500;

/** Understand the query with the cheap model. Null = use the regex fallback. */
export async function understandQuery(
  ai: any,
  model: string,
  query: string,
  history: Array<{ role: string; content: string }>,
): Promise<QueryUnderstanding | null> {
  const convo = history
    .slice(-4)
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content.slice(0, 300)}`)
    .join("\n");
  const user = `${convo ? "Conversation so far:\n" + convo + "\n\n" : ""}Question: ${query}`;
  const body = {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    max_tokens: 400,
    reasoning_effort: "low",
  };
  const call = (async () => {
    const res: any = await ai.run(model, body);
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    return typeof text === "string" ? extractJson(text) : null;
  })();
  // one retry on failure/timeout — a single transient miss should not
  // cost the query its understanding; after the retry it degrades to
  // vanilla retrieval (no filters, no heuristics), never to regexes
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), TIMEOUT_MS));
    try {
      const got = await Promise.race([call, timeout]);
      if (got) return got;
    } catch {
      /* retry */
    }
  }
  console.warn("query understanding unavailable — vanilla retrieval");
  return null;
}
