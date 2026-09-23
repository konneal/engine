export interface ConditionCheck {
    quantity_kind: string;
    band: string;
    stated: number;
    stated_unit: string;
    in_band: boolean;
}
export interface ConditionVerdict {
    verdict: "pass" | "fail";
    matched: string[];
    nearest?: {
        node_id: string;
        distance: number;
        bands: string[];
    };
    checks: ConditionCheck[];
    note: string;
}
/** The question's stated quantities with their SI normalization
 *  (temperature → K, relative_humidity → the ratio unit, duration → s).
 *  Units, never words: "12 months" is not a 12 h duration. */
export declare function quantitiesIn(query: string): Record<string, {
    stated: number;
    stated_unit: string;
    si: number;
}>;
/** Evaluate the candidate condition_set nodes against the question's
 *  stated quantities. PASS when at least one set admits every stated
 *  quantity within its band (the set is named); FAIL names the nearest
 *  set and the violated bands. */
export declare function evaluateConditionSets(nodes: {
    node_id: string;
    content: unknown;
}[], query: string): ConditionVerdict | null;
