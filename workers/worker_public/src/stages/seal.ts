// The declared context's hard seal (TODO.ai-platform/02) — pool-level,
// after every lane has merged, before rerank + the top-N cut. Nothing
// outside the declared family competes for the window; everything
// inside it does.
import type { Stage } from "./types.ts";

export const seal: Stage = {
  name: "seal",
  when: (c) => !!c.opts.sealScope || !!c.opts.editionSteer || !!c.opts.editionExclude,
  run: (c) => {
    const before = c.hits.length;
    const scope = c.opts.sealScope!;
    if (scope) {
        c.hits = c.hits.filter((h) => h.metadata.doc_number === scope.doc_number && (!scope.edition || h.metadata.edition === scope.edition));
      console.log("context seal:", before, "→", c.hits.length, "candidates within", `doc#${scope.doc_number}${scope.edition ? "@" + scope.edition : ""}`);
      return;
    }
    const exclude = c.opts.editionExclude!;
    if (exclude) {
      const before = c.hits.length;
      c.hits = c.hits.filter((h) => !(h.metadata.doc_number === exclude.doc_number && h.metadata.edition !== exclude.edition));
      console.log("edition exclude:", before, "→", c.hits.length, "after dropping superseded candidates of", `doc#${exclude.doc_number}@${exclude.edition}`);
      return;
    }
    const steer = c.opts.editionSteer!;
    const current: typeof c.hits = [];
    const superseded: typeof c.hits = [];
    for (const h of c.hits) {
      const same = h.metadata.doc_number === steer.doc_number;
      (same && h.metadata.edition !== steer.edition ? superseded : current).push(h);
    }
    c.hits = [...current, ...superseded];
    console.log("edition steer:", superseded.length, "superseded candidates demoted behind", current.length, "current-edition candidates of", `doc#${steer.doc_number}@${steer.edition}`);
  },
};
