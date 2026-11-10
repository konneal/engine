import type { StoreQuery } from "./ports/store.ts";
export interface AssembledDocument {
    docidentifier: string;
    text: string;
    clauses: Set<string>;
    truncated: boolean;
}
/** Assemble the WHOLE document from the chunks table in reading order
 *  (rowid preserves the parse's order — TODO.impl/02's invariant),
 *  capped. The clause set is every clause anchor the document carries,
 *  plus their dotted prefixes (a citation of 5.3.2 verifies when the
 *  document carries 5.3.2 itself or a longer clause beneath it). */
export declare function assembleDocument(store: StoreQuery, docidentifier: string, capChars: number, lang?: string): Promise<AssembledDocument | null>;
/** The clause-like tokens the ANSWER references (d.d and d.d.d shapes,
 *  including ranges "5.3–5.5"). Every token must resolve in the
 *  document's clause set — a cited clause the document does not carry
 *  makes the whole answer unverifiable. */
export declare function verifyAnchors(answer: string, clauses: Set<string>): {
    ok: boolean;
    missing: string[];
};
export declare const ESCALATION_SYSTEM: string;
/** The escalation's daily budget: a per-bucket KV counter. */
export declare function escalationAllowed(kv: any, bucketId: string, dailyCap: number, day: string): Promise<boolean>;
export declare function chargeEscalation(kv: any, bucketId: string, day: string): Promise<void>;
