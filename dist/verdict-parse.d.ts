export interface Verdict {
    score: number;
    ungrounded_claims: string[];
}
export declare function parseVerdict(text: string): Verdict | null;
