export type RetrievalGrade = "good" | "weak" | "bad";
export declare function gradeRetrieval(ai: any, model: string, query: string, passages: string[]): Promise<RetrievalGrade>;
export declare function scoreJudge(ai: any, model: string, systemPrompt: string, userPrompt: string): Promise<number | null>;
import { type PassageGrade } from "./crag";
export type { PassageGrade };
export declare function gradePassage(ai: any, model: string, query: string, passage: string): Promise<PassageGrade | null>;
export declare function gradePassages(ai: any, model: string, query: string, passages: string[]): Promise<(PassageGrade | null)[]>;
