// The declared context's hard seal (TODO.ai-platform/02) — pool-level,
// after every lane has merged, before rerank + the top-N cut. Nothing
// outside the declared family competes for the window; everything
// inside it does.
import type { Stage } from "./types.ts";

export const seal: Stage = {
  name: "seal",
  when: (c) => !!c.opts.sealScope,
  run: (c) => {
    const before = c.hits.length;
    const scope = c.opts.sealScope!;
    c.hits = c.hits.filter((h) => h.metadata.doc_number === scope.doc_number && (!scope.edition || h.metadata.edition === scope.edition));
    console.log("context seal:", before, "→", c.hits.length, "candidates within", `doc#${scope.doc_number}${scope.edition ? "@" + scope.edition : ""}`);
  },
};
