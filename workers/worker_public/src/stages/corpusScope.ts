// Dataset scope (the sidebar toggles): hits whose corpus lies outside
// the request's enabled datasets drop from the pool before ranking —
// disabling a database must actually disable it, not just hide its UI
// row. Runs after the pool is fully assembled (all lanes + federation)
// and before every ranking stage. Corpora the toggle model doesn't name
// (serving lanes, unknown values) pass untouched: the toggles name
// DATASETS, not lanes.
import type { Stage } from "./types.ts";

const DATASET_CORPORA = new Set(["oiml", "dirty", "clean", "synthetic", "smart-model", "iso-internal"]);

export const corpusScope: Stage = {
  name: "corpus-scope",
  when: (c) => !!c.opts.datasetScope && c.opts.datasetScope.size > 0,
  run: (c) => {
    const before = c.hits.length;
    c.hits = c.hits.filter((h) => {
      const corpus = h.metadata.corpus;
      if (!corpus || !DATASET_CORPORA.has(corpus)) return true;
      return c.opts.datasetScope!.has(corpus);
    });
    if (c.hits.length !== before) console.log("corpus scope:", before, "→", c.hits.length, "candidates");
  },
};
