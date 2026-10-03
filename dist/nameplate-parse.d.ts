export interface Nameplate {
    manufacturer: string | null;
    model: string | null;
    certificate_number?: string | null;
}
export declare function parseNameplate(text: string): Nameplate | null;
/** The register query the extraction feeds: a PRINTED CERTIFICATE NUMBER
 *  leads (it names the exact row), then the nameplate's tokens, then the
 *  question's family (if named) scopes. */
export declare function nameplateRegisterQuery(np: Nameplate, question: string): string;
