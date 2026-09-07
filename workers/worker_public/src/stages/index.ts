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
import { hyde } from "./hyde.ts";
import { glossary } from "./glossary.ts";
import { conceptGraph } from "./conceptGraph.ts";
import { graphLane } from "./graphLane.ts";
import { multiQuery } from "./multiQuery.ts";
import { subQuery } from "./subQuery.ts";
import { poolOpen } from "./poolOpen.ts";
import { lexicalUnion } from "./lexicalUnion.ts";
import { federate } from "./federate.ts";
import { seal } from "./seal.ts";
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
  multiQuery,
  subQuery,
  poolOpen,
  lexicalUnion,
  federate,
  seal,
  overviewDemote,
  familyBoost,
  rerankStage,
  lexicalRrf,
  termNudge,
  conceptSteer,
  editionSteer,
  propagate,
  diversity,
  typedPin,
  sectionDescent,
  dedup,
  windowFloor,
];
