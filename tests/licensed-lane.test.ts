// The licensed lane: an entitled, topically-matched question merges the
// licensed package's own units into the pool at the graph lane's
// discount; the lane never fires without the option; duplicates never
// double-merge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { licensedLane } from "../workers/worker_public/src/stages/licensedLane.ts";
import { runStages, type PipelineContext } from "../workers/worker_public/src/stages/types.ts";

const VEC = [1, 0.5];

function envWith(matches: any[]) {
  return {
    VECTORIZE: {
      queries: [] as any[],
      query(_vector: number[], o: { topK: number; filter?: Record<string, unknown> }) {
        this.queries.push(o);
        return Promise.resolve({ matches });
      },
    },
  };
}

function ctx(env: any, over: Partial<PipelineContext> = {}): PipelineContext {
  return {
    env, query: "damp heat", rq: "damp heat", folded: "damp heat",
    u: null, filters: null, filter: null, vector: VEC,
    lexicalHits: [], matches: [], hits: [], finalHits: [], glossary: [], notes: [],
    opts: {}, lane: {}, ...over,
  } as PipelineContext;
}

test("the lane fires only when the option carries the standard", async () => {
  const env = envWith([]);
  const silent = ctx(env);
  assert.equal(licensedLane.when!(silent), false, "no option, no fire");
  assert.equal(env.VECTORIZE.queries.length, 0);

  const armed = ctx(envWith([]), { opts: { licensedDocNumbers: ["iec-60068-2-30"] } });
  assert.equal(licensedLane.when!(armed), true, "the option arms the lane");
  await licensedLane.prefetch!(armed);
  assert.ok(armed.lane["licensed-lane"], "the option arms the lane");
});

test("the filter targets the named standard's metadata", async () => {
  const env = envWith([]);
  const c = ctx(env, { opts: { licensedDocNumbers: ["iec-60068-2-30"] } });
  await licensedLane.prefetch!(c);
  assert.deepEqual(env.VECTORIZE.queries[0].filter, { standard: { $in: ["iec-60068-2-30"] } });
});

test("lane results merge at the graph discount, deduplicated", async () => {
  const env = envWith([
    { id: "lic-unit-1", score: 0.8, metadata: { standard: "iec-60068-2-30", standard_key: "std:iec-60068-2-30" } },
    { id: "already-present", score: 0.9, metadata: {} },
  ]);
  const c = ctx(env, {
    opts: { licensedDocNumbers: ["iec-60068-2-30"] },
    matches: [{ id: "already-present", score: 0.7, metadata: {} }] as any,
  });
  await licensedLane.prefetch!(c);
  await licensedLane.run!(c);
  const ids = c.matches.map((m: any) => m.id);
  assert.ok(ids.includes("lic-unit-1"));
  assert.equal(ids.filter((i: string) => i === "already-present").length, 1, "no double merge");
  const added = c.matches.find((m: any) => m.id === "lic-unit-1");
  assert.equal(added.score, 0.8 * 0.75, "the graph lane's discount applies");
});
