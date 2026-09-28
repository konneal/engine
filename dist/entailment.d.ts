export interface EntailmentVerdict {
    support: "supported" | "partial" | "unsupported";
    note: string;
}
export declare function entailmentVerdict(score: number, supportedFloor: number, partialFloor: number): EntailmentVerdict;
