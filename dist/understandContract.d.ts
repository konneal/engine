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
export declare function extractJson(text: string): QueryUnderstanding | null;
