export interface LicensedEntry {
    key: string;
    package?: string;
    doc_number?: string;
    title?: string;
}
export interface LicensedMatch {
    entry: LicensedEntry;
    matched: string[];
}
export declare function distinctiveTokens(title: string): string[];
/** The licensed entry whose distinctive title tokens best match the
 *  question. Needs TWO token hits (or one hyphenated-compound hit) —
 *  a single shared word is not a topic match. */
export declare function matchLicensedTopic(query: string, licensed: LicensedEntry[]): LicensedMatch | null;
/** The note text: the posture instruction for an unentitled match. */
export declare function boundaryNoteText(match: LicensedMatch, citing: string[]): string;
