// Licensed cover (the seat): an entitled, topically-matched caller
// asked about the licensed standard, so the licensed package's own
// machinery must be ABLE to reach the answer — the public restatements
// crowd the window and the citation the golden legs assert rides this
// passage. When the rerank cut drops every licensed unit, the lane's
// best unit takes one seat at the end of the window (appended after
// ranking, like the section-descent children — the window floor keeps
// appended passages by construction). Narrow by law: one unit, only
// when none is present, only for an armed licensed lane.
import { portIndex } from "../env.ts";
import { toHits } from "./types.ts";
import type { Stage } from "./types.ts";

export const licensedCover: Stage = {
  name: "licensed-cover",
  failure: "additive",
  when: (c) => !!c.opts.licensedDocNumbers?.length && c.finalHits.length > 0,
  run: async (c) => {
    const keys = new Set(c.opts.licensedDocNumbers!);
    const present = c.finalHits.some((h) => keys.has(String((h.metadata as any).standard ?? "")));
    if (present) return;
    const ids = ((await (c.lane["licensed-ids"] as Promise<string[]> | undefined)) ?? []).slice(0, 8);
    if (!ids.length) return;
    const matches = await portIndex(c.env, "public").getByIds(ids);
    const unit = matches.find((m) => m.metadata && keys.has(String((m.metadata as any).standard ?? "")));
    if (!unit) return;
    const hit = toHits([unit as any])[0]!;
    c.finalHits = [...c.finalHits, hit];
    console.log("licensed cover: seated", unit.id, "—", (unit.metadata as any).docidentifier);
  },
};
