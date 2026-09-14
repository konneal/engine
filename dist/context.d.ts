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
    model?: {
        node_id: string;
        kind: string;
        standard: string;
        clause?: string;
    };
}
export declare const NO_CONTEXT: AppliedContext;
/** Parse + bound the ask body's optional `context` field. Anything
 *  malformed degrades to null (no context), never to a 400 — a context
 *  the service can't parse is a context it must not apply. */
export declare function parseContext(body: any): DeclaredContext | null;
import { type DocScope } from "./codecs.ts";
export type { DocScope };
/** Parse the two reference forms the estate speaks: the URN the SMART
 *  models carry as clause provenance (urn:oiml:pub:r:60-1:2021) and the
 *  plain docidentifier (OIML R 60-1:2021 / R 60). Part designations
 *  parse but do not narrow the scope (the family IS the scope). */
export declare function parseDocRef(doc: string, edition?: string): DocScope | null;
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
export declare function namedDocumentIn(query: string): DocScope | null;
/** Resolve the declared document against the publications registry: the
 *  family must exist in the corpus, else the scope honestly does not
 *  apply (the answer runs on the general corpus and context_applied's
 *  scoped_to stays null). A registry READ failure proceeds with the
 *  parsed scope — a scoped refusal is more honest than silently
 *  widening to the whole corpus. */
export declare function resolveDocScope(env: any, ctx: DeclaredContext): Promise<DocScope | null>;
export declare function appliedContext(declared: DeclaredContext | null, scope: DocScope | null, note?: AppliedContext["note"], live?: LiveEcho): AppliedContext;
/** Validate a context_applied object arriving from a client (the
 *  conversations API stores the echo with the message). Bounded and
 *  shape-checked; garbage degrades to null (nothing stored). */
export declare function parseAppliedContext(v: any): AppliedContext | null;
/** The prompt note the declared context contributes (rides the
 *  retrieval-note slot buildMessages already carries). The entity note
 *  is explicit about the wave-02 boundary: the entity's OWN DATA is not
 *  in scope (that is wave 03's live-data exchange) — the grounding is
 *  the governing publication's clauses. */
export declare function contextNote(declared: DeclaredContext | null, scope: DocScope | null): string | undefined;
/** A minimal knowledge-intent understanding for when the understand
 *  call failed but a declared document still scopes retrieval: the
 *  whole doc-scoped machinery (the family boost, the typed pin, the
 *  grade skip) keys off understanding.doc_number. */
export declare function syntheticUnderstanding(scope: DocScope): {
    intent: "knowledge";
    docidentifier: string;
    doc_number: string;
    edition: string | null;
    language: null;
    process_intent: boolean;
    term: null;
    defined_terms: never[];
    standalone_query: string;
    complexity: "simple";
    query_variants: never[];
    sub_queries: never[];
    hypothetical_answer: string;
    follow_ups: never[];
};
