// Licensed lane (additive): an entitled caller whose question is
// topically about a licensed standard gets that standard's typed units
// merged into the pool before rerank — the public restatements stop
// out-ranking the licensed package's own machinery (the rank-order gap
// the quality ledger has documented on every damp-heat run since the
// eleven-standard wave).
//
// Identity, not similarity: the units are resolved from the model
// plane's own registry (D1 model_nodes by standard) and turned into
// index ids with the exporter's hash — `m` + sha1(standard|node_id)
// truncated to 16 — then fetched by id. Vectorize metadata filtering
// plays no part (measured: REST and binding filters on this index
// return empty even for values proven present), and no similarity
// search is needed — the package's units are the package's units, and
// the pool's cross-encoder ranks them against the question like every
// other candidate.
import { THRESHOLDS } from "../config.ts";
import { portIndex, portStore } from "../env.ts";
import type { Stage } from "./types.ts";

const sha1Hex = async (s: string) => {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const licensedLane: Stage = {
  name: "licensed-lane",
  failure: "additive",
  when: (c) => !!c.opts.licensedDocNumbers?.length,
  run: async (c) => {
    const standards = c.opts.licensedDocNumbers!;
    const placeholders = standards.map((_, i) => `?${i + 1}`).join(",");
    const rows = await portStore(c.env)
      .prepare(`SELECT standard, node_id FROM model_nodes WHERE standard IN (${placeholders}) LIMIT 40`)
      .bind(...standards)
      .all()
      .catch(() => ({ results: [] }));
    const ids = await Promise.all(
      ((rows.results ?? []) as { standard: string; node_id: string }[]).map(async (r) =>
        "m" + (await sha1Hex(`${r.standard}|${r.node_id}`)).slice(0, 16),
      ),
    );
    if (!ids.length) return;
    const matches = await portIndex(c.env, "public").getByIds(ids);
    const seenIds = new Set(c.matches.map((m: any) => m.id));
    let merged = 0;
    const mergedIds: string[] = [];
    for (const m of matches) {
      if (m.metadata && !seenIds.has(m.id)) {
        c.matches.push({ id: m.id, score: THRESHOLDS.licensedLaneScore, metadata: m.metadata });
        seenIds.add(m.id);
        merged++;
        mergedIds.push(m.id);
      }
    }
    // the cover stage's stash: the licensed units' ids, so the seat can
    // recover a unit the rerank cut dropped
    c.lane["licensed-ids"] = Promise.resolve(mergedIds);
    console.log("licensed lane:", ids.length, "units,", matches.length, "vectors,", merged, "merged");
  },
};
