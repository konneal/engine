// The decision pass orchestrator (TODO.decisions/01): gate → derive →
// decide → hand back the items + the deterministic section. All I/O
// through the ports; the pure math lives in decisions.ts. Fired only
// when DECISIONS_ENABLED, not ablated, not a refusal, no verdict block
// bound, and the gate's noul clears decisionsGateMin.
import { portModelRunner } from "./env.ts";
import { telemetry } from "./quota";
import { MODELS, THRESHOLDS } from "./config.ts";
import {
  buildDecisionQuestions, matchAnswers, parseDerivation,
  assembleSection, type DecisionItem, type DecisionMode,
} from "./decisions.ts";
import type { Env } from "./env";

export interface DecisionPassResult {
  mode: DecisionMode;
  gate: number;
  items: DecisionItem[];
  section: string;
}

export function decisionsEnabled(env: Env): boolean {
  return String((env as any).DECISIONS_ENABLED ?? "true") !== "false";
}

/** The gate: one clef-flash noul over the question — "is this a
 *  requirement-shaped question?" Cheap; prefetched in parallel with
 *  retrieval by the caller. Returns the probability, or null on any
 *  failure (fail-open: the pass just doesn't fire). */
export async function gateQuestion(env: Env, question: string): Promise<number | null> {
  try {
    const res = await portModelRunner(env).run({
      model: (env as any).DECISIONS_GATE_MODEL || MODELS.decisionsGate,
      input: {
        state: question.slice(0, 500),
        questions: {
          requirements: {
            type: "noul",
            instructions: "Is this question asking whether requirements are met, or asking what requirements apply to something?",
            criteria: {
              true: "the asker wants requirements listed or their own values/products checked against requirements",
              false: "a definitional, lookup, how-to, or conversational question",
            },
          },
        },
      },
      maxTokens: 512,
    });
    const parsed = JSON.parse(res.text ?? "{}") as Record<string, any>;
    const p = parsed?.requirements?.noul;
    return typeof p === "number" ? p : null;
  } catch {
    return null;
  }
}

/** The full pass: derive the checklist candidates from the used
 *  passages, decide them in one batched Clef call, assemble the
 *  deterministic section. Returns null when the pass stands down. */
export async function runDecisionPass(
  env: Env,
  opts: {
    question: string;
    gate: number;
    passages: string[];
    docidentifier: string | null;
    statedValues?: string;
    userDocs?: boolean;
  },
): Promise<DecisionPassResult | null> {
  const gateMin = THRESHOLDS.decisionsGateMin;
  if (opts.gate == null || opts.gate < gateMin) return null;
  const passages = opts.passages.filter(Boolean).slice(0, 8).map((p) => p.slice(0, 1600));
  if (!passages.length) return null;
  try {
    // 1. derive the checklist candidates from the used passages
    const deriveModel = (env as any).DECISIONS_EXTRACT_MODEL || MODELS.member;
    const derived = await portModelRunner(env).run({
      model: deriveModel,
      messages: [
        { role: "system", content: "You extract requirement checklists from legal-metrology text. Reply with ONLY JSON, no prose." },
        {
          role: "user",
          content:
            `User question: ${opts.question}\n\n` +
            (opts.statedValues ? `The user's stated values: ${opts.statedValues}\n\n` : "") +
            `Passages:\n${passages.map((p, i) => `[${i + 1}] ${p}`).join("\n")}\n\n` +
            `List the DISTINCT requirements relevant to the question as JSON: ` +
            `{"mode":"check"|"list","requirements":[{"text":"...","clause":"..."}]} — ` +
            `"check" when the user's question or values ask whether requirements are MET; ` +
            `"list" when the user asks what the requirements ARE. Max ${THRESHOLDS.decisionsRequirementsMax}. ` +
            `Each requirement's clause = the clause anchor it comes from. If nothing qualifies, return {"mode":"list","requirements":[]}.`,
        },
      ],
      maxTokens: 3072,
      // the GLM law: the effort defaults to MAX when absent — an omitted
      // effort starved the derivation to empty (observed live: the pass
      // stood down silently on every fired question)
      effort: "low",
      temperature: 0,
    });
    const { mode, requirements } = parseDerivation(derived.text, THRESHOLDS.decisionsRequirementsMax);
    if (!requirements.length) return null;

    // 2. decide: one batched Clef call over the derived requirements
    const decideModel = (env as any).DECISIONS_MODEL || MODELS.decisionsModel;
    const decided = await portModelRunner(env).run({
      model: decideModel,
      input: {
        state:
          `User question: ${opts.question}\n` +
          (opts.statedValues ? `Stated values: ${opts.statedValues}\n` : "") +
          `Corpus passages:\n${passages.join("\n")}`.slice(0, 12000),
        questions: buildDecisionQuestions(mode, requirements, opts.question, opts.statedValues ?? ""),
      },
      maxTokens: 4096,
    });
    const answers = JSON.parse(decided.text ?? "{}") as Record<string, any>;

    // 3. band and assemble
    const items = matchAnswers(mode, requirements, answers, THRESHOLDS.decisionsMetBand, THRESHOLDS.decisionsRefuteBand);
    if (!items.length) return null;
    const section = assembleSection(mode, items);
    if (!section) return null;
    return { mode, gate: opts.gate, items, section };
  } catch {
    return null; // additive — the essay answer ships
  }
}

/** The decisions telemetry (TODO.decisions/03): the nightly's
 *  calibration signal, riding the queries table's route key with a
 *  defined encoding — no schema migration.
 *  - one PASS row, route "ask-decisions": ok = fired, lang = mode,
 *    model = the gate probability (2dp), duration_ms = the pass's.
 *  - one ITEM row per requirement, route "ask-decision": ok = band is
 *    "met", lang = band, model = the probability (2dp); query_hash
 *    joins the rows to their pass. */
export function telemetryDecisions(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  tier: string,
  queryHash: string,
  result: { mode: string; gate: number; items: DecisionItem[] } | null,
  durationMs: number,
): void {
  try {
    telemetry(env, ctx, tier, "ask-decisions", result ? result.gate.toFixed(2) : "0", !!result, result?.items.length ?? 0, queryHash, result?.mode ?? undefined, undefined, { durationMs });
    for (const it of result?.items ?? []) {
      telemetry(env, ctx, tier, "ask-decision", it.probability.toFixed(2), it.band === "met", 1, queryHash, it.band, undefined, {});
    }
  } catch { /* telemetry never answers for the answer */ }
}
