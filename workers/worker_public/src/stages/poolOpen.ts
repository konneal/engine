// Pool open: the candidate pool closes its lane-merge phase and becomes
// the ranked Hit list every refinement stage operates on.
import { toHits, type Stage } from "./types.ts";

export const poolOpen: Stage = {
  name: "pool-open",
  run: (c) => {
    c.hits = toHits(c.matches);
  },
};
