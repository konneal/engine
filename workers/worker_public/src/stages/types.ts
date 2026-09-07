// The pipeline stage contract (TODO.impl/02): every retrieval mechanism
// is a self-contained stage implementing this interface, composed by the
// registry in stages/index.ts. Adding a mechanism = adding a stage file
// and one registry entry — no edits to existing stages, the runner, or
// retrieve() (OCP). Contracts per stage: docs/spec-pipeline.md.

import type { Hit } from "../../../shared/chunk";
import type { QueryFilters } from "../selfquery.ts";
import type { QueryUnderstanding } from "../understand";

export interface RetrieveOptions {
  prev?: string;
  understanding?: QueryUnderstanding | null;
  queryOverride?: string;
  federate?: (query: string) => Promise<Hit[]>;
  warmEmbed?: Promise<number[] | null>;
  graphDocNumbers?: string[];
  /** The declared context's HARD seal (TODO.ai-platform/02): when the
   *  panel's chip declares a document scope, the CANDIDATE POOL is cut
   *  to the publication family before rerank + the top-N cut — the
   *  soft-steer widenings below (the full-corpus lexical union, the
   *  sparse-filter widen, the sub-query lanes) can otherwise outscore
   *  the filtered dense lane under the cross-encoder and push every
   *  in-family passage out of the final hits, sealing the answer to
   *  zero despite a healthy in-family pool. */
  sealScope?: { doc_number: string; edition?: string } | null;
  /** Option C: dense-lane results computed concurrently with
   *  understanding (same folded-query vector, retrieve's exact query
   *  parameters). With no filter they REPLACE the primary dense query;
   *  with a filter they union in as discounted filter-miss cover. */
  optimisticHits?: Hit[];
  optimisticVec?: number[] | null;
}

export interface GlossaryEntry {
  term: string;
  definition: string;
  docidentifier: string;
  doc_number: string;
  score: number;
}

/** The mutable state every stage reads and writes. Field ownership per
 *  stage is specified in docs/spec-pipeline.md; in general: candidate
 *  lanes append to `matches`, refinement stages rewrite `hits`, and only
 *  the window-assembly stages touch `finalHits`. */
export interface PipelineContext {
  env: any;
  query: string; // the user's original wording (rerank + pin score on it)
  rq: string; // the retrieval query (folded / standalone / expanded)
  folded: string; // the pre-understanding fold (optimistic-lane identity)
  u: QueryUnderstanding | null;
  filters: QueryFilters | null; // dense-stage may drop a guessed edition pin
  filter: Record<string, string> | null | undefined; // toVectorizeFilter's output
  vector: number[]; // embedding of rq
  lexicalHits: Hit[]; // full-corpus BM25 ranking (already seal-filtered)
  matches: any[]; // the candidate pool (Vectorize match shape, pre-Hit)
  hits: Hit[]; // the ranked pool from poolOpen onward
  finalHits: Hit[]; // the answer window
  glossary: GlossaryEntry[]; // the vocabulary link (glossary stage owns)
  opts: RetrieveOptions;
}

export interface Stage {
  name: string;
  /** Absent = always runs. Guards are pure reads of the context. */
  when?: (c: PipelineContext) => boolean;
  /** "additive": a throw is logged and the pipeline continues with the
   *  context as the previous stage left it (the lane's results were not
   *  written). "blocking" (default): the throw propagates to the caller. */
  failure?: "additive" | "blocking";
  run: (c: PipelineContext) => Promise<void> | void;
}

/** Run the registry in order. Additive stages swallow their own throws —
 *  replicating the per-lane try/catch the monolith carried inline. */
export async function runStages(stages: Stage[], c: PipelineContext): Promise<void> {
  for (const stage of stages) {
    if (stage.when && !stage.when(c)) continue;
    if (stage.failure === "additive") {
      try {
        await stage.run(c);
      } catch (e) {
        console.log(`stage ${stage.name}: additive lane failed — primary results stand (${String(e).slice(0, 120)})`);
      }
    } else {
      await stage.run(c);
    }
  }
}

// the shared match→Hit conversion (lib/hit.ts owns it)
export { toHits } from "../lib/hit.ts";
