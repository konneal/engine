// The member's OWN documents, federated additively into the candidate
// pool (TODO.sota/20 v1, slice 4): the caller's lane (their imported
// certificates and reports) beside the public corpus — no discount,
// their content answers their question. The callback carries the
// mandatory sub filter (queryUserLane has no unfiltered path); the
// stage adds nothing when the caller has no documents.
import type { Stage } from "./types.ts";

export const userLane: Stage = {
  name: "user-lane",
  when: (c) => !!c.opts.userDocs,
  run: async (c) => {
    const fed = await c.opts.userDocs!(c.rq).catch(() => []);
    const seen = new Set(c.hits.map((h) => h.id));
    for (const h of fed) {
      if (!seen.has(h.id)) {
        c.hits.push({ ...h });
        seen.add(h.id);
      }
    }
  },
};
