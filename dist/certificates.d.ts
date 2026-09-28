export interface RegisterRow {
    num: string;
    family: string;
    holder: string;
    model: string;
    year: string;
    status: string;
    pdf_key?: string | null;
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
/** The family the question names ("R 60", "R60", "D 31") — the register
 *  search filters to it, so a question about R 60 never presents R 76
 *  rows. */
export declare function queryFamily(query: string): string | null;
export declare function registerTokens(query: string): string[];
/** The register query for a token set. Numeric tokens (a model number
 *  like "190") must match as a STANDALONE value — `LIKE '%190%'` also
 *  catches "XK3190", which the live Utilcell probe demonstrated — so a
 *  number matches the exact model, or as a delimiter-separated word
 *  (hyphens and punctuation normalize to spaces). Word tokens keep the
 *  substring LIKE (names and model words do not overmatch the way
 *  numbers do). Each token takes its own numbered placeholder,
 *  referenced three times (holder, model, number). */
export declare function buildRegisterQuery(tokens: string[]): {
    sql: string;
    params: string[];
};
export declare function searchRegister(db: any, query: string): Promise<{
    rows: RegisterRow[];
    tokens: string[];
} | null>;
export declare function registerNote(rows: RegisterRow[]): string;
/** Each certificate's location rides the note as a link when its PDF
 *  is in the R2 plane (TODO 7) — the user gets the document, not just
 *  the fact. */
export declare function certificateLinks(rows: RegisterRow[]): string;
