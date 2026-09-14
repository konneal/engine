export interface DocScope {
    doc_number: string;
    edition?: string;
    label: string;
}
export interface RefCodec {
    /** The explicit form: "R 60-1:2021", "urn:…" — null when unparseable. */
    parse(doc: string, edition?: string): DocScope | null;
    /** The gap-tolerant scan over question text — null when nothing names a document. */
    scanQuestion(query: string): DocScope | null;
    /** The graph's node id → document number — null for other shapes. */
    graphDocNumber(nodeId: string): string | null;
    /** A docidentifier's family key ("R-60") for edition steering — null when not of the grammar. */
    familyOf(docidentifier: string): string | null;
}
/** OIML's grammar: type letter (R/D/B/G/E) + 1–3 digits, optional part,
 *  optional edition year; the URN provenance form; part numbers are
 *  significant (R 60-1), the edition is never part of the number. */
export declare const oimlPubid: RefCodec;
/** The generic floor: the identifier is whatever string it is. */
export declare const plainSlug: RefCodec;
export declare function refCodec(): RefCodec;
