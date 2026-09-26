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

/** The one-line posture the interface renders under the answer. The
 *  OCR rung is the owner's 2026-09-26 wording, verbatim. */
export function qualityNote(q: SourceQuality): string {
  if (q === "verified") return "High confidence: this publication's requirements ride a machine-checkable data model.";
  if (q === "curated") return "Established sources: Metanorma-edited documents, chunked at clause boundaries.";
  return "WARNING: Partly grounded in experimental data source that was derived from OCR content. Please verify content against official publications.";
}

/** The citations standing on the OCR rung, named for the reader — the
 *  confidence line says WHICH sources are experimental, not just that
 *  some are. Producer-UUID anchors say nothing and are dropped; a cap
 *  keeps the line readable on citation-heavy answers. */
export function experimentalSourceLabels(
  cites: { quality?: string; docidentifier?: string; doc_id?: string; clause_anchor?: string }[],
  cap = 6,
): string[] {
  const labels: string[] = [];
  for (const c of cites) {
    if (c.quality !== "ocr") continue;
    const id = String(c.docidentifier || c.doc_id || "source");
    const anchor = String(c.clause_anchor ?? "");
    const garbage = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(anchor) || (anchor.startsWith("_") && anchor.length > 12);
    labels.push(garbage || !anchor || anchor === "overview" ? id : `${id} §${anchor}`);
    if (labels.length >= cap) break;
  }
  return labels;
}
