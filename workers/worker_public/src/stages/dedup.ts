// Same-chain near-duplicate collapse (FABLE ancestor-descendant dedup).
import { ancestorDescendantDedup } from "../structural.ts";
import type { Stage } from "./types.ts";

export const dedup: Stage = {
  name: "dedup",
  run: (c) => {
    c.finalHits = ancestorDescendantDedup(c.finalHits);
  },
};
