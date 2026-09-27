export type { Verdict } from "./verdict-parse";
export interface FaithfulnessResult {
    score: number;
    ungrounded_claims: string[];
}
/** The serving gate's verdict from a faithfulness score (0-1): what the
 *  confidence line says when the claims themselves were measured against
 *  the passages they cite. */
export declare function entailmentVerdict(score: number, supportedFloor: number, partialFloor: number): {
    support: "supported" | "partial" | "unsupported";
    note: string;
};
export declare function scoreFaithfulness(ai: any, model: string, answer: string, passages: (string | {
    text: string;
    table?: boolean;
})[], machine?: string[]): Promise<FaithfulnessResult | null>;
