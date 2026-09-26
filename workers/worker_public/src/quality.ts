// The answer-quality ladder (TODO.rag/13): every citation states what
// kind of text grounds it, so the answer states how far to trust it.
// Three rungs, derived from provenance the chunk wire already carries —
// no new ingest state:
//
//   verified — the model plane: the chunk rides a primmel data model
//     (model_node/model_version), the Recommendation's semantics are
//     machine-checkable and the golden set measures them (R 60 is the
//     gauge). The answer can be WRONG, but it is wrong against a
//     contract we can see.
//   curated  — the edited corpus: Metanorma-authored documents
//     (mn-samples-oiml and the editors' own), clause-boundary chunks,
//     enrichment applied.
//   ocr      — the experimental OCR corpus: the broad coverage lane,
//     text recovered from scans; quote anchors may wobble, tables can
//     be mangled. Useful, and marked as experimental on purpose.
//
// The answer's tier is the WORST rung its citations stand on: one OCR
// citation makes the whole answer experimental, because the reader
// cannot tell which sentence leaned on which chunk.

import type { ChunkMeta } from "../../shared/chunk.ts";

export type SourceQuality = "verified" | "curated" | "ocr";

const ORDER: Record<SourceQuality, number> = { verified: 0, curated: 1, ocr: 2 };

export function hitQuality(m: ChunkMeta): SourceQuality {
  if (m.model_node || m.model_version || m.producer === "primmel") return "verified";
  if (m.tier === "curated") return "curated";
  return "ocr";
}

export function answerQuality(qualities: (SourceQuality | undefined)[]): SourceQuality | null {
  let worst: SourceQuality | null = null;
  for (const q of qualities) {
    if (!q) continue;
    if (!worst || ORDER[q] > ORDER[worst]) worst = q;
  }
  return worst;
}

/** The one-line posture the interface renders under the answer. */
export function qualityNote(q: SourceQuality): string {
  if (q === "verified") return "Grounded in verified sources: this publication's requirements ride a machine-checkable data model.";
  if (q === "curated") return "Grounded in the edited corpus: Metanorma-authored documents, chunked at clause boundaries.";
  return "Partly grounded in experimental OCR text: verify quotations and table values against the official publication.";
}
