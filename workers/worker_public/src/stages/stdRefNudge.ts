// Standard-reference nudge (L5): when the question asks which ISO/IEC
// standard a document invokes, the answer IS the clause carrying the
// citation — but generic family prose (definitions, certification
// passages) otherwise fills the window and the citing clause never
// reaches the answer (measured: l5a-iso-humidity flips ~1/6 runs).
// Lexical ranking signal, same design as term-nudge: query mentions the
// standard family, chunks whose text carries an ISO/IEC identifier get
// a spread-scaled boost. Typed table units (serialized payloads) compete
// on the same signal.
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

const ASKS_ABOUT_STD = /\b(iso|iec|astm|en\s?\d{2,5})\b/i;
const CITES_STD = /\b(?:ISO|IEC|ASTM|EN)[ /]?\d{3,6}(?:[-–]\d+)?\b/;

export const stdRefNudge: Stage = {
  name: "std-ref-nudge",
  when: (c) => ASKS_ABOUT_STD.test(c.query) && c.hits.length > 1,
  run: (c) => {
    const scored = c.hits.map((h) => h.rerank_score ?? h.score);
    const spread = Math.max(...scored) - Math.min(...scored);
    if (spread <= 0) return;
    let nudged = 0;
    for (const h of c.hits) {
      if (CITES_STD.test(h.text) || CITES_STD.test(h.metadata.clause_title ?? "")) {
        h.rerank_score = (h.rerank_score ?? h.score) + spread * THRESHOLDS.stdRefNudgeSpread;
        nudged++;
      }
    }
    if (nudged) {
      c.hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
      console.log("std-ref nudge:", nudged, "chunks carrying standard citations");
    }
  },
};
