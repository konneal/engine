// The license entitlement hard scope (TODO.external-refs/08) — pool-level,
// after every candidate lane has merged, BEFORE rerank + the top-N cut
// (the `seal` posture, never the post-rerank corpus-scope drop). A chunk
// whose `standard_key` lies outside the caller's entitlement set never
// competes for the window: the model never sees licensed text the caller
// cannot be shown, so no prompt-level leakage either. The predicate is
// selfquery.standardKeyAllowed; the lane audit that binds every query
// shape lives in its doc comment.
import { standardKeyAllowed } from "../selfquery.ts";
import type { Stage } from "./types.ts";

export const licenseScope: Stage = {
  name: "license-scope",
  when: (c) => !!c.opts.standardKeys,
  run: (c) => {
    const keys = c.opts.standardKeys!;
    const before = c.hits.length;
    c.hits = c.hits.filter((h) => standardKeyAllowed(h.metadata, keys));
    if (c.hits.length !== before) {
      console.log("license scope:", before, "→", c.hits.length, "candidates within the caller's entitlement set");
    }
  },
};
