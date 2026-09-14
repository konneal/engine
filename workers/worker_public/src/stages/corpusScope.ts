// Dataset scope (the sidebar toggles): hits whose corpus lies outside
// the request's enabled datasets drop from the pool before the window
// is cut — disabling a database must actually disable it, not just hide
// its UI row. Runs LAST of the pool-assembly stages: after lexicalRrf,
// which unions the lexical lane's separate hit list into the pool AFTER
// rerank (filtering earlier let lexical hits back in — measured). Corpora
// the toggle model doesn't name (serving lanes, unknown values) pass
// untouched: the toggles name DATASETS, not lanes.
import type { Stage } from "./types.ts";
import { P } from "../profile.ts";

/** The corpora a dataset toggle can name: the union of the datasets'
 *  declared corpora. Corpora outside it (serving lanes, unknown values)
 *  pass untouched — the toggles name datasets, not lanes. */
function datasetCorpora(): Set<string> {
  return new Set(P().datasets.flatMap((d: { corpora?: string[] }) => d.corpora ?? []));
}

export const corpusScope: Stage = {
  name: "corpus-scope",
  when: (c) => !!c.opts.datasetScope && c.opts.datasetScope.size > 0,
  run: (c) => {
    const before = c.hits.length;
    c.hits = c.hits.filter((h) => {
      const corpus = h.metadata.corpus;
      if (!corpus || !datasetCorpora().has(corpus)) return true;
      return c.opts.datasetScope!.has(corpus);
    });
    if (c.hits.length !== before) console.log("corpus scope:", before, "→", c.hits.length, "candidates");
  },
};
