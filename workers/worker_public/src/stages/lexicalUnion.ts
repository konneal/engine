// Lexical union: union full-corpus lexical hits that dense missed
// (G-ETSI-1). Prefer dense metadata/text when both sources return the
// same id.
import type { Stage } from "./types.ts";

export const lexicalUnion: Stage = {
  name: "lexical-union",
  when: (c) => c.lexicalHits.length > 0,
  run: (c) => {
    const seen = new Set(c.hits.map((h) => h.id));
    let added = 0;
    for (const h of c.lexicalHits) {
      if (!seen.has(h.id)) {
        c.hits.push(h);
        seen.add(h.id);
        added++;
      }
    }
    if (added) console.log("lexical union:", added, "new candidates");
  },
};
