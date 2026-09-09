// Edition steering, family-relative: when the query does not pin an
// edition, chunks from an OLDER edition of a publication are demoted
// whenever a NEWER edition of the SAME publication is in the pool.
// Superseded editions match archaic phrasing strongly (their wording is
// what the question echoes) and the per-doc diversity cap then fills
// the publication's slots with them — observed: R 76-1:1992/1988
// passages displacing the current R 76-1:2006 on complex unfiltered
// queries. Cross-publication recency is deliberately NOT touched: a
// 1992 publication that is still current must not be demoted because
// some unrelated 2024 document exists. Scaled to the live rerank spread
// — the scores cluster within ~0.001.
import { THRESHOLDS } from "../config.ts";
import type { Stage } from "./types.ts";

export const editionSteer: Stage = {
  name: "edition-steer",
  when: (c) => !c.filters?.edition && c.hits.length > 1,
  run: (c) => {
    const year = (s?: string) => (/^(19|20)\d{2}$/.test(s ?? "") ? Number(s) : null);
    // the FAMILY key (doctype + base number): "R 60", "R 60 (Annexes)"
    // and "R 60-1/-2/-3" are one publication whose current shape is the
    // 2021 PARTS — the 2017 monolith lives under other identifiers, so
    // docidentifier-level steering never sees it against 2021
    const family = (m: any) => `${m.doctype}|${String(m.doc_number ?? "").split("-")[0]}|${m.language}`;
    const scored = c.hits.map((h) => h.rerank_score ?? h.score);
    const spread = Math.max(...scored) - Math.min(...scored);
    if (spread > 0) {
      const newest = new Map<string, number>();
      const famNewest = new Map<string, number>();
      let anyYear = 0;
      for (const h of c.hits) {
        const y = year(h.metadata.edition);
        if (!y || y < 1990) continue;
        const k = `${h.metadata.docidentifier}|${h.metadata.language}`;
        newest.set(k, Math.max(newest.get(k) ?? 0, y));
        const fk = family(h.metadata);
        famNewest.set(fk, Math.max(famNewest.get(fk) ?? 0, y));
        anyYear = Math.max(anyYear, y);
      }
      // cross-publication tie-break: a current-edition publication ranks
      // over stale ones (load-bearing — par-prepackaged: R 87:2004 must
      // outrank 1990s texts); composed WITH the family-relative demotion
      // below, which dominates for same-publication duplicates
      if (anyYear > 1990) {
        for (const h of c.hits) {
          const y = year(h.metadata.edition);
          if (y && y >= 1990) {
            h.rerank_score = (h.rerank_score ?? h.score) + spread * THRESHOLDS.crossPubRecencySpread * ((y - 1990) / (anyYear - 1990));
          }
        }
      }
      let demoted = 0;
      for (const h of c.hits) {
        const y = year(h.metadata.edition);
        // (a) same-identifier: the successor of THIS document is in the
        // pool — FULL strength, because ordering is load-bearing here:
        // the diversity cap keeps ONE overview per publication and
        // near-tied editions otherwise hand the slot to the older one
        // (observed: R 60's 2017 parts displacing the current 2021
        // parts). A lone older edition (successor not in the pool)
        // passes undemoted — superseded content stays citable when it
        // alone carries the clause
        const max = newest.get(`${h.metadata.docidentifier}|${h.metadata.language}`);
        if (y && max && y < max) {
          h.rerank_score = (h.rerank_score ?? h.score) - spread * THRESHOLDS.familyDemoteSpread;
          demoted++;
          continue;
        }
        // (b) family-wide, status-gated: a superseded/unknown-status
        // edition demotes against the FAMILY's newest even under a
        // different identifier — the corpus's own status carries the
        // supersession the registry link missed. in-force documents are
        // exempt: a newer part-2 must never demote a current part-1
        const fmax = famNewest.get(family(h.metadata));
        if (y && fmax && y < fmax && (h.metadata.status === "superseded" || h.metadata.status === "unknown")) {
          h.rerank_score = (h.rerank_score ?? h.score) - spread * THRESHOLDS.familyDemoteSpread;
          demoted++;
        }
      }
      if (demoted) {
        console.log("edition steering: demoted", demoted, "superseded-edition chunks (family-relative)");
        c.hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
      } else if (anyYear > 1990) {
        c.hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
      }
    }
  },
};
