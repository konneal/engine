// The declared context (TODO.ai-platform/02): the estate assistant
// panel's opt-in context chips declare what the answer grounds in —
// the page the user is on, the entity the page carries, a corpus
// document, or nothing (the default; an ABSENT context field IS
// "none"). TODO.ai-platform/03 adds the member-only "account" kind:
// the user's OWN live platform data, read through the RFC 8693
// delegation (livedata.ts) — never ambient, member-signed-in only.
// Opt-in means opt-in: no context the caller didn't declare
// is ever applied, and every ask response echoes what was APPLIED
// (context_applied) so the panel's honest context line never invents
// a grounding. A declared context bypasses both answer caches (the
// answer depends on the declaration, not just the query) and is never
// written into them — the caches stay context-clean by construction.

export interface DeclaredContext {
  kind: "page" | "entity" | "document" | "account";
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

/** The account context's live-read echo (TODO.ai-platform/03): WHEN the
 *  live data was read, WHICH stores answered, and how many records the
 *  answer could ground in. Present only on a successful read — a failed
 *  or refused read reports through `note` instead, never silently. */
export interface LiveEcho {
  read_at: string;
  stores: string[];
  records: number;
}

export interface AppliedContext {
  kind: "page" | "entity" | "document" | "account" | "none";
  label?: string;
  /** the publication the DECLARED context actually scoped retrieval to
   *  ("OIML R 60:2021"); null when the declaration did not scope this
   *  answer (see `note` for the honest why) */
  scoped_to?: string | null;
  /** why a doc-carrying declaration did not scope the answer:
   *  the corpus does not carry it, or the question named its own
   *  publication (the user's explicit words always win over the chip);
   *  for the account kind: why the live data was NOT read (the honest
   *  degradation — sign in, the window lapsed, the cone refused) */
  note?: "document-not-in-corpus" | "question-document-wins" | "sign-in-required" | "live-window-expired" | "live-unavailable";
  /** the account kind's live-read echo (TODO.ai-platform/03) */
  live?: LiveEcho;
  /** the model plane's bound node (TODO.ai-platform/05): the model-aware
   *  chip grounded this answer in the model node itself — its constraint,
   *  its provenance, its tests */
  model?: { node_id: string; kind: string; standard: string; clause?: string };
}

export const NO_CONTEXT: AppliedContext = { kind: "none", scoped_to: null };

/** Parse + bound the ask body's optional `context` field. Anything
 *  malformed degrades to null (no context), never to a 400 — a context
 *  the service can't parse is a context it must not apply. */
export function parseContext(body: any): DeclaredContext | null {
  const c = body?.context;
  if (!c || typeof c !== "object") return null;
  if (c.kind !== "page" && c.kind !== "entity" && c.kind !== "document" && c.kind !== "account") return null;
  const label = typeof c.label === "string" ? c.label.trim().slice(0, 120) : "";
  const route = typeof c.route === "string" && c.route.trim() ? c.route.trim().slice(0, 200) : undefined;
  const doc = typeof c.doc === "string" && c.doc.trim() ? c.doc.trim().slice(0, 80) : undefined;
  const edition = typeof c.edition === "string" && /^\d{4}$/.test(c.edition.trim()) ? c.edition.trim() : undefined;
  return { kind: c.kind, label, ...(route ? { route } : {}), ...(doc ? { doc } : {}), ...(edition ? { edition } : {}) };
}

import { refCodec, type DocScope } from "./codecs.ts";
import { P } from "./profile.ts";
export type { DocScope };

/** Parse the two reference forms the estate speaks: the URN the SMART
 *  models carry as clause provenance (urn:oiml:pub:r:60-1:2021) and the
 *  plain docidentifier (OIML R 60-1:2021 / R 60). Part designations
 *  parse but do not narrow the scope (the family IS the scope). */
export function parseDocRef(doc: string, edition?: string): DocScope | null {
  return refCodec().parse(doc, edition);
}

/** Read the FIRST publication the question's own text names, in the
 *  letter+number forms the corpus speaks ("R 76", "r76-1", "OIML B 18",
 *  "R 60:2021"). "A document named in the question wins over the declared
 *  chip" is only honest when it is the user's own words that win — the
 *  understand stage's doc_number is an LLM extraction that also fires on
 *  domain priors ("maximum permissible errors" → R 76, no document named
 *  — the merged tree's ctx-document-r111 flake) and can miss a naming the
 *  text plainly carries; both directions are decided from the TEXT here.
 *  A glued single digit is a class/designation ("E2 weights"), never a
 *  naming; part designations parse but do not narrow the family. */
export function namedDocumentIn(query: string): DocScope | null {
  return refCodec().scanQuestion(query);
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

export function appliedContext(
  declared: DeclaredContext | null,
  scope: DocScope | null,
  note?: AppliedContext["note"],
  live?: LiveEcho,
): AppliedContext {
  if (!declared) return NO_CONTEXT;
  return {
    kind: declared.kind,
    label: declared.label,
    scoped_to: scope ? scope.label : null,
    ...(note ? { note } : {}),
    ...(live ? { live } : {}),
  };
}

/** Validate a context_applied object arriving from a client (the
 *  conversations API stores the echo with the message). Bounded and
 *  shape-checked; garbage degrades to null (nothing stored). */
export function parseAppliedContext(v: any): AppliedContext | null {
  if (!v || typeof v !== "object") return null;
  if (v.kind !== "page" && v.kind !== "entity" && v.kind !== "document" && v.kind !== "account" && v.kind !== "none") return null;
  const label = typeof v.label === "string" && v.label.trim() ? v.label.trim().slice(0, 120) : undefined;
  const scoped = typeof v.scoped_to === "string" && v.scoped_to.trim() ? v.scoped_to.trim().slice(0, 80) : null;
  const note =
    v.note === "document-not-in-corpus" || v.note === "question-document-wins" ||
    v.note === "sign-in-required" || v.note === "live-window-expired" || v.note === "live-unavailable"
      ? v.note
      : undefined;
  // The live echo round-trips bounded (the panel's context line reads
  // it on a resumed session — the "when live data was read" honesty).
  const live =
    v.live && typeof v.live === "object" && typeof v.live.read_at === "string" && Array.isArray(v.live.stores) && typeof v.live.records === "number"
      ? { read_at: v.live.read_at.slice(0, 40), stores: v.live.stores.filter((s: any) => typeof s === "string").slice(0, 8), records: Math.min(Math.max(0, v.live.records), 999) }
      : undefined;
  // The model-plane echo round-trips bounded too (TODO.ai-platform/05):
  // a resumed session keeps the "grounded in this model node" honesty.
  const model =
    v.model && typeof v.model === "object" && typeof v.model.node_id === "string" && typeof v.model.kind === "string" && typeof v.model.standard === "string"
      ? {
          node_id: v.model.node_id.slice(0, 120),
          kind: v.model.kind.slice(0, 40),
          standard: v.model.standard.slice(0, 40),
          ...(typeof v.model.clause === "string" && v.model.clause.trim() ? { clause: v.model.clause.slice(0, 120) } : {}),
        }
      : undefined;
  return { kind: v.kind, ...(label ? { label } : {}), scoped_to: scoped, ...(note ? { note } : {}), ...(live ? { live } : {}), ...(model ? { model } : {}) };
}

/** The prompt note the declared context contributes (rides the
 *  retrieval-note slot buildMessages already carries). The entity note
 *  is explicit about the wave-02 boundary: the entity's OWN DATA is not
 *  in scope (that is wave 03's live-data exchange) — the grounding is
 *  the governing publication's clauses. */
export function contextNote(declared: DeclaredContext | null, scope: DocScope | null): string | undefined {
  if (!declared) return undefined;
  if (declared.kind === "account") {
    // The account note depends on the live read's OUTCOME (the records
    // block on success, the honest degradation on a refusal) — the ask
    // handler composes it (TODO.ai-platform/03); never a static claim.
    return undefined;
  }
  if (declared.kind === "page") {
    return `Context note: the user is viewing ${declared.label || "a page"}${declared.route ? ` (${declared.route})` : ""} in the ${P().publisher.product_name} platform. The passages come from the general corpus; frame procedural guidance for that page when relevant.`;
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
