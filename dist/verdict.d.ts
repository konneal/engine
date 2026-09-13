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
    checks: MachineCheck[];
}
export declare function extractChecks(content: unknown): string[];
export declare function symbolsIn(checks: string[]): string[];
export declare function extractParams(query: string, symbols: string[]): Record<string, number>;
export declare function evaluate(content: unknown, query: string): Verdict | null;
/** The deterministic note the answer model narrates — never recomputes. */
export declare function verdictNote(v: Verdict, node: {
    node_id: string;
    clause?: {
        urn?: string;
    } | null;
}): string;
