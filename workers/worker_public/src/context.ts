// The declared context (TODO.ai-platform/02): the estate assistant
// panel's opt-in context chips declare what the answer grounds in —
// the page the user is on, the entity the page carries, a corpus
// document, or nothing (the default; an ABSENT context field IS
// "none"). Opt-in means opt-in: no context the caller didn't declare
// is ever applied, and every ask response echoes what was APPLIED
// (context_applied) so the panel's honest context line never invents
// a grounding. A declared context bypasses both answer caches (the
// answer depends on the declaration, not just the query) and is never
// written into them — the caches stay context-clean by construction.

export interface DeclaredContext {
  kind: "page" | "entity" | "document";
  /** display label ("this certificate R60/2021-A-EX1-26.01") — echoed
   *  into context_applied for the panel's context line */
  label: string;
  /** the publishing page's route (page/entity contexts) */
  route?: string;
  /** the corpus reference to scope retrieval to (entity/document
   *  contexts): the URN the SMART models carry as clause provenance
   *  (urn:oiml:pub:r:60-1:2021) or the plain docidentifier */
  doc?: string;
  edition?: string;
}

export interface AppliedContext {
  kind: "page" | "entity" | "document" | "none";
  label?: string;
  /** the publication the DECLARED context actually scoped retrieval to
   *  ("OIML R 60:2021"); null when the declaration did not scope this
   *  answer (see `note` for the honest why) */
  scoped_to?: string | null;
  /** why a doc-carrying declaration did not scope the answer:
   *  the corpus does not carry it, or the question named its own
   *  publication (the user's explicit words always win over the chip) */
  note?: "document-not-in-corpus" | "question-document-wins";
}

export const NO_CONTEXT: AppliedContext = { kind: "none", scoped_to: null };

/** Parse + bound the ask body's optional `context` field. Anything
 *  malformed degrades to null (no context), never to a 400 — a context
 *  the service can't parse is a context it must not apply. */
export function parseContext(body: any): DeclaredContext | null {
  const c = body?.context;
  if (!c || typeof c !== "object") return null;
  if (c.kind !== "page" && c.kind !== "entity" && c.kind !== "document") return null;
  const label = typeof c.label === "string" ? c.label.trim().slice(0, 120) : "";
  const route = typeof c.route === "string" && c.route.trim() ? c.route.trim().slice(0, 200) : undefined;
  const doc = typeof c.doc === "string" && c.doc.trim() ? c.doc.trim().slice(0, 80) : undefined;
  const edition = typeof c.edition === "string" && /^\d{4}$/.test(c.edition.trim()) ? c.edition.trim() : undefined;
  return { kind: c.kind, label, ...(route ? { route } : {}), ...(doc ? { doc } : {}), ...(edition ? { edition } : {}) };
}

export interface DocScope {
  /** the Vectorize doc_number filter value (the publication FAMILY —
   *  an entity's clause provenance spans parts: R 60-1 requirements,
   *  R 60-2 tests) */
  doc_number: string;
  edition?: string;
  /** the canonical label form for the echo + the prompt note */
  label: string;
}

/** Parse the two reference forms the estate speaks: the URN the SMART
 *  models carry as clause provenance (urn:oiml:pub:r:60-1:2021) and the
 *  plain docidentifier (OIML R 60-1:2021 / R 60). Part designations
 *  parse but do not narrow the scope (the family IS the scope). */
export function parseDocRef(doc: string, edition?: string): DocScope | null {
  const m =
    doc.match(/^urn:oiml:pub:([rdbge]):(\d{1,3})(?:-[0-9A-Za-z]+)?(?::(\d{4}))?$/i) ??
    doc.match(/^(?:OIML\s+)?([RDBGE])\s*(\d{1,3})(?:-[0-9A-Za-z]+)?(?::(\d{4}))?$/i);
  if (!m) return null;
  const type = m[1].toUpperCase();
  const ed = edition ?? m[3] ?? undefined;
  return { doc_number: m[2], ...(ed ? { edition: ed } : {}), label: `OIML ${type} ${m[2]}${ed ? `:${ed}` : ""}` };
}

/** Resolve the declared document against the publications registry: the
 *  family must exist in the corpus, else the scope honestly does not
 *  apply (the answer runs on the general corpus and context_applied's
 *  scoped_to stays null). A registry READ failure proceeds with the
 *  parsed scope — a scoped refusal is more honest than silently
 *  widening to the whole corpus. */
export async function resolveDocScope(env: any, ctx: DeclaredContext): Promise<DocScope | null> {
  if (!ctx.doc) return null;
  const parsed = parseDocRef(ctx.doc, ctx.edition);
  if (!parsed) return null;
  try {
    const type = parsed.label.split(" ")[1];
    const row = await env.DB.prepare("SELECT 1 FROM documents WHERE family = ?1 LIMIT 1").bind(`${type}-${parsed.doc_number}`).first();
    if (!row) return null;
  } catch {
    // registry unreadable — proceed with the parsed scope
  }
  return parsed;
}

export function appliedContext(declared: DeclaredContext | null, scope: DocScope | null, note?: AppliedContext["note"]): AppliedContext {
  if (!declared) return NO_CONTEXT;
  return { kind: declared.kind, label: declared.label, scoped_to: scope ? scope.label : null, ...(note ? { note } : {}) };
}

/** The prompt note the declared context contributes (rides the
 *  retrieval-note slot buildMessages already carries). The entity note
 *  is explicit about the wave-02 boundary: the entity's OWN DATA is not
 *  in scope (that is wave 03's live-data exchange) — the grounding is
 *  the governing publication's clauses. */
export function contextNote(declared: DeclaredContext | null, scope: DocScope | null): string | undefined {
  if (!declared) return undefined;
  if (declared.kind === "page") {
    return `Context note: the user is viewing ${declared.label || "a page"}${declared.route ? ` (${declared.route})` : ""} in the OIML SMART platform. The passages come from the general corpus; frame procedural guidance for that page when relevant.`;
  }
  if (declared.kind === "entity") {
    return scope
      ? `Context note: the user is asking about ${declared.label || "an entity"} — the passages are scoped to ${scope.label}, the publication that governs it. You do NOT have the entity's own data; answer what the publication requires and say when the question needs the record itself.`
      : `Context note: the user is asking about ${declared.label || "an entity"}. You do NOT have the entity's own data; answer from the corpus passages and say when the question needs the record itself.`;
  }
  return scope
    ? `Context note: the user scoped this question to ${scope.label} — the passages come from that publication. If they cannot answer the question, say so instead of drawing on other documents.`
    : `Context note: the user named ${declared.label || declared.doc || "a document"} as context, but it is not in the indexed corpus — answer from the general corpus and say the document was not found.`;
}

/** A minimal knowledge-intent understanding for when the understand
 *  call failed but a declared document still scopes retrieval: the
 *  whole doc-scoped machinery (the family boost, the typed pin, the
 *  grade skip) keys off understanding.doc_number. */
export function syntheticUnderstanding(scope: DocScope) {
  return {
    intent: "knowledge" as const,
    docidentifier: scope.label,
    doc_number: scope.doc_number,
    edition: scope.edition ?? null,
    language: null,
    process_intent: false,
    term: null,
    defined_terms: [],
    standalone_query: "",
    complexity: "simple" as const,
    query_variants: [],
    sub_queries: [],
    hypothetical_answer: "",
    follow_ups: [],
  };
}
