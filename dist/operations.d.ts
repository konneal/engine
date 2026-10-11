export declare function isOperationIntent(query: string): boolean;
/** camelCase/snake anchors meet the question's words: "updates an
 *  entity record" must reach putEntityRecord even when its description
 *  words the action differently ("replaces the stored…"). */
export declare function anchorWords(anchor: string): string[];
export declare function matchOperations(query: string, rows: {
    anchor: string;
    text: string;
    docidentifier?: string;
}[]): {
    anchor: string;
    text: string;
    docidentifier?: string;
}[];
export declare function catalogNote(anchors: string[]): string;
/** The lane's whole result: the authoritative note (matched lines +
 *  name index) AND the matched rows themselves — the ask path rides the
 *  matched operations as CITABLE PASSAGES, because the refusal logic
 *  keys on passages and a side-note cannot outrank the passages'
 *  silence (observed live 2026-09-29: the note was present and the
 *  model still refused "the only API operation in the current context
 *  is the blob download"). */
export interface OperationsLane {
    note?: string;
    matched: {
        anchor: string;
        text: string;
        docidentifier?: string;
    }[];
}
export declare function operationsLane(db: any, query: string): Promise<OperationsLane>;
