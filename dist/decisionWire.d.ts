import { type DecisionItem, type DecisionMode } from "./decisions.ts";
import type { Env } from "./env";
export interface DecisionPassResult {
    mode: DecisionMode;
    gate: number;
    items: DecisionItem[];
    section: string;
}
export declare function decisionsEnabled(env: Env): boolean;
/** The gate: one clef-flash noul over the question — "is this a
 *  requirement-shaped question?" Cheap; prefetched in parallel with
 *  retrieval by the caller. Returns the probability, or null on any
 *  failure (fail-open: the pass just doesn't fire). */
export declare function gateQuestion(env: Env, question: string): Promise<number | null>;
/** The full pass: derive the checklist candidates from the used
 *  passages, decide them in one batched Clef call, assemble the
 *  deterministic section. Returns null when the pass stands down. */
export declare function runDecisionPass(env: Env, opts: {
    question: string;
    gate: number;
    passages: string[];
    docidentifier: string | null;
    statedValues?: string;
    userDocs?: boolean;
}): Promise<DecisionPassResult | null>;
/** The decisions telemetry (TODO.decisions/03): the nightly's
 *  calibration signal, riding the queries table's route key with a
 *  defined encoding — no schema migration.
 *  - one PASS row, route "ask-decisions": ok = fired, lang = mode,
 *    model = the gate probability (2dp), duration_ms = the pass's.
 *  - one ITEM row per requirement, route "ask-decision": ok = band is
 *    "met", lang = band, model = the probability (2dp); query_hash
 *    joins the rows to their pass. */
export declare function telemetryDecisions(env: Env, ctx: {
    waitUntil(p: Promise<unknown>): void;
}, tier: string, queryHash: string, result: {
    mode: string;
    gate: number;
    items: DecisionItem[];
} | null, durationMs: number): void;
