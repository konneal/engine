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
  /** Extra terms appended to the LEXICAL lane's query only (never the
   *  dense vector): the licensed-boundary boost — chunks whose prose
   *  references the licensed document surface for a question the
   *  document's own vocabulary would otherwise miss. */
  lexicalBoost?: string;
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
  /** Verify's grounding steer (demote-not-exclude): hits of the named
   *  document whose edition differs from the active one move to the END
   *  of the candidate pool — superseded passages stay servable but stop
   *  competing for the window against the current edition. */
  editionSteer?: { doc_number: string; edition: string } | null;
  /** Option C: dense-lane results computed concurrently with
   *  understanding (same folded-query vector, retrieve's exact query
   *  parameters). With no filter they REPLACE the primary dense query;
   *  with a filter they union in as discounted filter-miss cover. */
  optimisticHits?: Hit[];
  optimisticVec?: number[] | null;
  /** Dataset scope (the sidebar toggles): the set of CORPUS values the
   *  request allows. Present only when NARROWER than the default (all
   *  permitted datasets) — a null scope means no filtering. The ask path
   *  intersects the requested ids with session permissions before
   *  building this set. */
  datasetScope?: Set<string> | null;
  /** The license entitlement set (TODO.external-refs/08): the standard
   *  keys the caller's organization is entitled to, resolved
   *  request-scoped by the deployment (never a client-tunable filter —
   *  it arrives through the same trusted request context as the session,
   *  and the profile's declared licensed list is the validation
   *  whitelist). NON-NULL activates the hard scope: chunks carrying a
   *  `standard_key` outside the set never reach ranking (an EMPTY set is
   *  the unentitled caller — licensed content hidden, citation-level
   *  metadata stays). Null = the deployment declares no licensed
   *  content, the scope is inert. */
  standardKeys?: Set<string> | null;
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
  /** structured facts stages contribute to the answer prompt (the
   *  GraphRAG seam: graph-derived notes ride the same channel the
   *  vocabulary link does — ask.ts merges them into the retrieval note) */
  notes: string[];
  opts: RetrieveOptions;
  /** prefetch bag: stage-name → that stage's in-flight I/O promise (the
   *  stage owns its key; see Stage.prefetch) */
  lane: Record<string, Promise<unknown>>;
}

export interface Stage {
  name: string;
  /** Absent = always runs. Guards are pure reads of the context. */
  when?: (c: PipelineContext) => boolean;
  /** "additive": a throw is logged and the pipeline continues with the
   *  context as the previous stage left it (the lane's results were not
   *  written). "blocking" (default): the throw propagates to the caller. */
  failure?: "additive" | "blocking";
  /** Kick this stage's INDEPENDENT I/O off early (the runner invokes
   *  every stage's prefetch before running any stage). Only for stages
   *  whose I/O depends on pre-pipeline state (u, vector, opts) — never
   *  on prior stages' output. The promise lands in c.lane[name]; run()
   *  awaits it and merges. Merges stay in registry order — concurrency
   *  changes when I/O completes, never the merge order (determinism). */
  prefetch?: (c: PipelineContext) => void;
  run: (c: PipelineContext) => Promise<void> | void;
}

/** Run the registry in order. Additive stages swallow their own throws —
 *  replicating the per-lane try/catch the monolith carried inline. */
export async function runStages(stages: Stage[], c: PipelineContext): Promise<void> {
  for (const stage of stages) {
    if (stage.prefetch && (!stage.when || stage.when(c))) stage.prefetch(c);
  }
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
