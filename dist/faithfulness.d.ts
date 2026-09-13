export interface FaithfulnessResult {
    score: number;
    ungrounded_claims: string[];
}
export declare function scoreFaithfulness(ai: any, model: string, answer: string, passages: string[]): Promise<FaithfulnessResult | null>;
