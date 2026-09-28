export interface Nameplate {
    manufacturer: string | null;
    model: string | null;
}
export declare function parseNameplate(text: string): Nameplate | null;
/** The register query the extraction feeds: the nameplate's tokens lead,
 *  the question's family (if named) scopes. */
export declare function nameplateRegisterQuery(np: Nameplate, question: string): string;
