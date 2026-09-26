import type { ChunkMeta } from "../../shared/chunk.ts";
export type SourceQuality = "verified" | "curated" | "ocr";
export declare function hitQuality(m: ChunkMeta): SourceQuality;
export declare function answerQuality(qualities: (SourceQuality | undefined)[]): SourceQuality | null;
/** The one-line posture the interface renders under the answer. */
export declare function qualityNote(q: SourceQuality): string;
