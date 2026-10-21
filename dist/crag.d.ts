export type PassageGrade = "correct" | "incorrect" | "ambiguous";
export declare function gradePassage(ai: any, model: string, systemPrompt: string, query: string, passage: string, timeoutMs?: number): Promise<PassageGrade | null>;
export declare function gradePassages(ai: any, model: string, systemPrompt: string, query: string, passages: string[]): Promise<(PassageGrade | null)[]>;
