// The stage registry (TODO.impl/02): the pipeline is this ordered list.
// Adding a mechanism = writing a stage module and appending one entry —
// no edits to existing stages, the runner, or retrieve() (OCP). Ordering
// invariants and per-stage contracts: docs/spec-pipeline.md.
//
// Phase structure:
//   candidate lanes (dense → glossary-graph lanes → fusion lanes)
//   → pool open → pool-level merges (lexical/federate/seal)
//   → refinement (demotion, rerank, steering, propagation, diversity)
//   → window assembly (typed pin, section descent, dedup, floor)
import type { Stage } from "./types.ts";
export { runStages } from "./types.ts";
export type { PipelineContext, RetrieveOptions, GlossaryEntry, Stage } from "./types.ts";
import { dense } from "./dense.ts";
import { citationProbe } from "./citationProbe.ts";
import { hyde } from "./hyde.ts";
import { glossary } from "./glossary.ts";
import { conceptGraph } from "./conceptGraph.ts";
import { graphLane } from "./graphLane.ts";
import { licensedLane } from "./licensedLane.ts";
import { licensedCover } from "./licensedCover.ts";
import { multiQuery } from "./multiQuery.ts";
import { subQuery } from "./subQuery.ts";
import { poolOpen } from "./poolOpen.ts";
import { lexicalUnion } from "./lexicalUnion.ts";
import { federate } from "./federate.ts";
import { seal } from "./seal.ts";
import { licenseScope } from "./licenseScope.ts";
import { corpusScope } from "./corpusScope.ts";
import { editionCover } from "./editionCover.ts";
import { stdRefNudge } from "./stdRefNudge.ts";
import { overviewDemote } from "./overviewDemote.ts";
import { familyBoost } from "./familyBoost.ts";
import { rerankStage, lexicalRrf } from "./rerank.ts";
import { termNudge } from "./termNudge.ts";
import { conceptSteer } from "./conceptSteer.ts";
import { editionSteer } from "./editionSteer.ts";
import { propagate } from "./propagate.ts";
import { diversity } from "./diversity.ts";
import { typedPin } from "./typedPin.ts";
import { sectionDescent } from "./sectionDescent.ts";
import { dedup } from "./dedup.ts";
import { windowFloor } from "./windowFloor.ts";

export const STAGES: Stage[] = [
  dense,
  hyde,
  glossary,
  conceptGraph,
  graphLane,
  licensedLane,
  multiQuery,
  subQuery,
  poolOpen,
  lexicalUnion,
  federate,
  seal,
  licenseScope,
  overviewDemote,
  familyBoost,
  rerankStage,
  lexicalRrf,
  citationProbe,
  corpusScope,
  editionCover,
  stdRefNudge,
  termNudge,
  conceptSteer,
  editionSteer,
  propagate,
  diversity,
  licensedCover,
  typedPin,
  sectionDescent,
  dedup,
  windowFloor,
];

export const STAGE_NAMES: string[] = STAGES.map((s) => s.name);

/** The ablation switch (TODO.sota/09): a configuration is a stage list.
 *  The projection keeps REGISTRY order — a subset can narrow the
 *  pipeline, never reorder it (the ordering invariants are
 *  load-bearing). Unknown names throw so a typo'd configuration can
 *  never measure the wrong pipeline silently. */
export function projectStages(names: readonly string[]): Stage[] {
  const wanted = new Set(names);
  const projected = STAGES.filter((s) => wanted.has(s.name));
  if (projected.length !== wanted.size) {
    const known = new Set(STAGE_NAMES);
    for (const n of wanted) if (!known.has(n)) throw new Error(`unknown stage: ${n}`);
  }
  return projected;
}
