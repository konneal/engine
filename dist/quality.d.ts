import type { ChunkMeta } from "../../shared/chunk.ts";
export type SourceQuality = "verified" | "curated" | "ocr";
export declare function hitQuality(m: ChunkMeta): SourceQuality;
export declare function answerQuality(qualities: (SourceQuality | undefined)[]): SourceQuality | null;
/** The one-line posture the interface renders under the answer. The
 *  OCR rung is the owner's 2026-09-26 wording, verbatim. */
export declare function qualityNote(q: SourceQuality): string;
/** The citations standing on the OCR rung, named for the reader — the
 *  confidence line says WHICH sources are experimental, not just that
 *  some are. Producer-UUID anchors say nothing and are dropped; a cap
 *  keeps the line readable on citation-heavy answers. */
export declare function experimentalSourceLabels(cites: {
    quality?: string;
    docidentifier?: string;
    doc_id?: string;
    clause_anchor?: string;
}[], cap?: number): string[];
