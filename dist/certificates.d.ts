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
/** An AGGREGATE register question — "how many certificates are issued
 *  for R 60:2021?", "what is the latest certificate issued for R 60" —
 *  is served by DETERMINISTIC computation (COUNT, ORDER BY), never by
 *  the model counting the rows a note happens to carry. The register
 *  lane's own philosophy: the note answers the structure, the model
 *  narrates it (TODO.sota/04's machine-checkable ground truth, applied
 *  to the register plane 2026-10-11). */
export declare function registerAggregateIntent(query: string): "count" | "latest" | null;
export interface RegisterAggregate {
    family: string;
    count: number;
    valid: number;
    suspended: number;
    latest: RegisterRow | null;
}
/** The family's aggregate, computed in SQL (the register is the ground
 *  truth; editions do not appear in it — certificates are issued per
 *  family). The latest row ranks by year then the sequence number's
 *  tail (the -YY.NN suffix carries the actual issue ordering). */
export declare function registerAggregate(db: any, family: string): Promise<RegisterAggregate | null>;
/** The aggregate's authoritative note: the numbers are DATA — the
 *  model narrates, never recomputes. The edition disclaimer rides every
 *  family-scoped answer (the register has no edition dimension). */
export declare function aggregateNote(agg: RegisterAggregate): string;
/** A typed block for aggregate answers — the UI renders the count and
 *  the latest row's link as data, never from prose. */
export declare function aggregateBlock(agg: RegisterAggregate): {
    type: string;
    payload: {
        latest?: {
            url?: string | undefined;
            num: string;
            holder: string;
            model: string;
            year: string;
            status: string;
        } | undefined;
        suspended?: number | undefined;
        family: string;
        count: number;
        valid: number;
    };
};
/** Search tokens: words that can identify a holder or a model — words of
 *  2+ characters that are not register question words, plus bare model
 *  numbers ("190", "HM14H1"). Upper-cased tokens match case-insensitively
 *  in SQL LIKE. */
/** The family the question names ("R 60", "R60", "D 31") — the register
 *  search filters to it, so a question about R 60 never presents R 76
 *  rows. */
export declare function queryFamily(query: string): string | null;
/** A PRINTED certificate number on a nameplate ("R76/2006-A-GB1-18.08")
 *  names the exact register row — it must not be shredded into word
 *  tokens that compete with it. */
export declare function printedCertificateNumber(query: string): string | null;
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
export declare function searchRegister(db: any, query: string, force?: boolean): Promise<{
    rows: RegisterRow[];
    tokens: string[];
} | null>;
export declare function registerNote(rows: RegisterRow[]): string;
/** Each certificate's location rides the note as a link when its PDF
 *  is in the R2 plane (TODO 7) — the user gets the document, not just
 *  the fact. */
export declare function certificateLinks(rows: RegisterRow[]): string;
