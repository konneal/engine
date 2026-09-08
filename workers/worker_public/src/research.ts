// Deep-research dossier loop (G10): bounded agentic iterations,
// members-only — the workflow-shaped research spend (TODO.impl/23).
import { err, json, corsHeaders, readJson, validateQuery } from "./lib/http";
import { telemetry } from "./quota";
import { LIMITS, MODELS, sha256Hex } from "./config";
import { retrieve, buildMessages, citations } from "./pipeline";
import { understandQuery } from "./understand";
import { generateOnce } from "./ai";
import { canonicalRefusal } from "./refusal";
import { checkQuoteAnchors } from "./anchors";
import { graphExpand, editionNote } from "./graph";
import researchPromptText from "../prompts/research.md";
import type { Env } from "./env";
import type { Hit } from "../../shared/chunk.ts";

/** Deep-research mode (G10 v1): bounded agentic loop for members —
 *  retrieve → sufficiency judge → re-retrieve targeting the gap → answer
 *  from the ACCUMULATED evidence. ≤ max_iterations rounds; every
 *  iteration's retrieval goes through the same gated pipeline as a
 *  normal ask. Workflows (durable, resumable) is the documented upgrade
 *  path when runs outgrow a single request. */
export async function handleResearch(env: Env, ctx: ExecutionContext, req: Request, session: any): Promise<Response> {
  if (!session) {
    return err(403, "forbidden", "Deep research is a member feature — sign in with your OIML SMART account.");
  }
  const body = await readJson(req);
  const q = validateQuery(body);
  if (!q) return err(400, "invalid_input", `query is required (1-${LIMITS.maxInputChars} chars)`);
  const maxIters = Math.min(Math.max(Number(body?.max_iterations) || 3, 1), 3);

  const started = Date.now();
  const queryHash = await sha256Hex(q.query);
  const understanding = await understandQuery(env.AI, MODELS.understand, q.query, [], []);
  const graphDocNumbers = await graphExpand(env, understanding);
  const eNote = await editionNote(env, understanding);

  const accumulated = new Map<string, Hit>();
  let iterations = 0;
  let focus = understanding?.standalone_query?.trim() || q.query;
  let judge: { sufficient: boolean; missing: string } | null = null;

  for (let i = 0; i < maxIters; i++) {
    iterations = i + 1;
    let retrieved: { hits: Hit[] };
    try {
      retrieved = await retrieve(env, q.query, {
        understanding: i === 0 ? understanding : ({ ...understanding, standalone_query: focus, query_variants: [], hypothetical_answer: undefined } as any),
        graphDocNumbers,
      });
    } catch {
      break;
    }
    for (const h of retrieved.hits.slice(0, LIMITS.rerankKeep)) {
      if (!accumulated.has(h.id)) accumulated.set(h.id, h);
    }
    const passages = [...accumulated.values()];
    // Hierarchical context management (GLM-5 report, their search agents):
    // the judge re-reads the full evidence every round and its context
    // grows without bound. Keep-recent-k: the k most recent findings at
    // full length, everything older as one-line digests. The final ANSWER
    // generation below still sees the full set within the token budget —
    // folding is judge-context only.
    const KEEP_RECENT = 10;
    const older = passages.slice(0, Math.max(0, passages.length - KEEP_RECENT));
    const recent = passages.slice(-KEEP_RECENT);
    const digest = older.length
      ? `Earlier evidence (digest, ${older.length} passages):\n${older.map((h) => `- ${h.metadata.docidentifier ?? ""} §${h.metadata.clause_anchor ?? ""}: ${h.text.replace(/\s+/g, " ").slice(0, 160)}`).join("\n")}\n\n`
      : "";
    judge = await (async () => {
      try {
        const res: any = await env.AI.run(MODELS.grader, {
          messages: [
            { role: "system", content: researchPromptText.trimEnd() },
            { role: "user", content: `Research question: ${q.query}\n\n${digest}Collected passages (${recent.length}):\n${recent.map((h, n) => `[${n + 1}] ${h.metadata.docidentifier ?? ""} §${h.metadata.clause_anchor ?? ""}: ${h.text.slice(0, 700)}`).join("\n")}` },
          ],
          max_tokens: 3072,
          reasoning_effort: "low",
          temperature: 1.0,
          top_p: 1.0,
        });
        const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
        let parsed: any = null;
        for (const m of (text ?? "").matchAll(/\{[^{}]*\}/g)) {
          try {
            const obj = JSON.parse(m[0]);
            if (typeof obj.sufficient === "boolean") parsed = obj;
          } catch { /* keep scanning */ }
        }
        return parsed ? { sufficient: parsed.sufficient, missing: String(parsed.missing ?? "") } : null;
      } catch {
        return null;
      }
    })();
    console.log("research iter", iterations, "passages", passages.length, "sufficient:", judge?.sufficient);
    if (!judge || judge.sufficient || !judge.missing) break;
    // fold, don't accumulate: appending every round's `missing` compounds
    // stale wants; the next retrieval focuses on the ORIGINAL question plus
    // what is still missing now
    focus = `${understanding?.standalone_query?.trim() || q.query} ${judge.missing}`.slice(0, LIMITS.maxInputChars);
  }

  const used = [...accumulated.values()];
  if (!used.length) {
    return err(503, "retrieval_unavailable", "Search is briefly busy — please retry in a moment.");
  }
  const { messages, usedHits } = buildMessages(q.query, used, q.lang, [], eNote || undefined, undefined, LIMITS.inputTokenBudget);
  let answer = await generateOnce(env, MODELS.research, messages);
  if (answer === null) answer = await generateOnce(env, MODELS.fallback, messages);
  if (answer === null) {
    telemetry(env, ctx, "member", "research", MODELS.research, false, 0, queryHash, q.lang);
    return err(502, "generation_failed", "The generation model is unavailable; please retry.");
  }
  answer = canonicalRefusal(answer);
  const anchors = checkQuoteAnchors(answer, used.map((h: Hit) => h.text));
  if (anchors.violations.length) console.log("research anchors:", anchors.violations.length, "unverified");
  const out = {
    answer,
    citations: citations(usedHits),
    model: MODELS.research,
    query_hash: queryHash,
    research: { iterations, passages: used.length, elapsed_ms: Date.now() - started, sufficient: judge?.sufficient ?? null },
  };
  telemetry(env, ctx, "member", "research", MODELS.research, true, answer.length, queryHash, q.lang);
  return json({ ...out, ...corsHeaders(req) });
}
