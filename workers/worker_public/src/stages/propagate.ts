// Structural propagation (FABLE TreeExpansion, arXiv:2601.18116): the
// corpus IS a tree — clause anchors chain parent→child, so a hit's
// score blends with its ancestors' (topic continuity) and descendants'
// (subtopic heat) — a section whose clauses are collectively hot rises,
// and a hot section lifts its clauses. Pure post-retrieval re-scoring
// over metadata the chunks already carry; no new index lane required.
import { structuralPropagation } from "../structural.ts";
import type { Stage } from "./types.ts";

export const propagate: Stage = {
  name: "structural-propagate",
  run: (c) => {
    c.hits = structuralPropagation(c.hits);
  },
};
