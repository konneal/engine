// Overview demotion: overview chunks repeat the title/doctype boilerplate
// and embed strongly for name-like queries, crowding clause chunks out of
// the rerank window.
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const overviewDemote: Stage = {
  name: "overview-demote",
  run: (c) => {
    for (const h of c.hits) {
      if (h.metadata.clause_anchor === "overview") h.score *= THRESHOLDS.overviewDemotion;
    }
  },
};
