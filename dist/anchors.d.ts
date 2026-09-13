export interface AnchorCheck {
    total: number;
    violations: string[];
}
export declare function checkQuoteAnchors(answer: string, passages: string[]): AnchorCheck;
export declare const ANCHOR_CORRECTION_NOTE: string;
