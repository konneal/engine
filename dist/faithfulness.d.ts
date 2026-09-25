export type { Verdict } from "./verdict-parse";
export interface FaithfulnessResult {
    score: number;
    ungrounded_claims: string[];
}
export declare function scoreFaithfulness(ai: any, model: string, answer: string, passages: (string | {
    text: string;
    table?: boolean;
})[], machine?: string[]): Promise<FaithfulnessResult | null>;
