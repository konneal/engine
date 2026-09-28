export type RetrievalGrade = "good" | "weak" | "bad";
export declare function gradeRetrieval(ai: any, model: string, query: string, passages: string[]): Promise<RetrievalGrade>;
export declare function scoreJudge(ai: any, model: string, systemPrompt: string, userPrompt: string): Promise<number | null>;
