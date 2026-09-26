export interface RegisterRow {
    num: string;
    family: string;
    holder: string;
    model: string;
    year: string;
    status: string;
}
/** A question is register-shaped when it asks about certification
 *  standing of an identifiable model or holder — the deterministic
 *  trigger the citation-graph notes already use (query-shaped notes,
 *  never a router). */
export declare function isRegisterShaped(query: string): boolean;
/** Search tokens: words that can identify a holder or a model — words of
 *  2+ characters that are not register question words, plus bare model
 *  numbers ("190", "HM14H1"). Upper-cased tokens match case-insensitively
 *  in SQL LIKE. */
export declare function registerTokens(query: string): string[];
export declare function searchRegister(db: any, query: string): Promise<{
    rows: RegisterRow[];
    tokens: string[];
} | null>;
export declare function registerNote(rows: RegisterRow[]): string;
