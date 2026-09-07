// Relevance-floored window (the evidence-budget principle): a full
// window of near-miss passages costs tokens and attention while good
// answers cite only what they need (measured: median 10 served, 1–2
// cited). Serve what can matter: passages within a fraction of the top
// score, plus every structurally-guaranteed unit — typed pins and the
// passages appended after ranking (their scores are not cross-encoder
// comparable). Never fewer than two.
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const windowFloor: Stage = {
  name: "window-floor",
  run: (c) => {
    const top = Math.max(...c.finalHits.map((h) => h.rerank_score ?? h.score));
    const floored = c.finalHits.filter(
      (h) => h.rerank_score === undefined || (h.rerank_score ?? h.score) >= THRESHOLDS.windowFloorFraction * top || !!h.metadata.unit_id || h.metadata.clause_anchor === "family",
    );
    if (floored.length >= 2) {
      if (floored.length < c.finalHits.length) console.log("window floor:", c.finalHits.length, "→", floored.length, "passages");
      c.finalHits = floored;
    }
  },
};
