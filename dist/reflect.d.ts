export interface ReflectionResult {
    grounded: boolean;
    missing_info: string;
}
export declare function reflect(ai: any, model: string, question: string, answer: string, passages: string[]): Promise<ReflectionResult | null>;
