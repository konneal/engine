export interface MachineCheck {
    expression: string;
    symbolic: string;
    values: Record<string, number>;
    result: boolean | null;
}
export interface Verdict {
    verdict: "pass" | "fail" | "void";
    on_violation?: string;
    violation_meaning?: string;
    missing: string[];
    /** why a fully-stated question still cannot evaluate (TODO.sota/04):
     *  the stated quantities' units carry conflicting dimensions */
    void_reason?: string;
    checks: MachineCheck[];
}
export declare function extractChecks(content: unknown): string[];
export declare function symbolsIn(checks: string[]): string[];
export declare function extractParams(query: string, symbols: string[]): Record<string, number>;
/** The stated values WITH their unit tokens (TODO.sota/04's unit
 *  semantics): "E_max 30000 v" binds e_max=30000 and the unit "v" —
 *  the dimension check needs both. */
export declare function extractParamsWithUnits(query: string, symbols: string[]): {
    values: Record<string, number>;
    units: Record<string, string>;
};
/** Dimension coherence (TODO.sota/04 item 2): the units plane gives
 *  each unit token a dimension; a parameter set whose bound symbols
 *  carry CONFLICTING known dimensions is incoherent — the check
 *  compares quantities that are not comparable. Pure: the dimensions
 *  map arrives from the caller (the units register at load). */
export declare function dimensionMismatch(check: string, units: Record<string, string>, dimensions: Record<string, string>): string | null;
export declare function evaluate(content: unknown, query: string, opts?: {
    dimensions?: Record<string, string>;
}): Verdict | null;
/** The deterministic note the answer model narrates — never recomputes. */
export declare function verdictNote(v: Verdict, node: {
    node_id: string;
    clause?: {
        urn?: string;
    } | null;
}): string;
