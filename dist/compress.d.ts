export declare function tokens(text: string): string[];
export declare function splitSentences(text: string): string[];
/** Query-term density, with a numeric sentence boosted: a sentence that
 *  states values, tolerances or clause numbers is evidence even when it
 *  repeats few query words. */
export declare function scoreSentence(sentence: string, qTerms: Set<string>): number;
/** Compress to at most `budgetChars` characters: the lead sentence is
 *  always kept (it carries the subject), the rest by score, emitted in
 *  reading order. No sentence scores above zero → plain truncation of
 *  the lead at a word boundary (never empty when input is non-empty). */
export declare function compressText(text: string, query: string, budgetChars: number): string;
