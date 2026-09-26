import { embed } from "./ai";
import { P } from "./profile.ts";
import { LIMITS, MODELS, DATASETS, THRESHOLDS, processExpansion } from "./config";
import systemPromptText from "../prompts/system.md";
import conversationalPromptText from "../prompts/conversational.md";
import listwisePromptText from "../prompts/listwise.md";
import { tableSelection } from "./tablecontext";

// the pinned refusal sentence lives with the canonicalizer in ./refusal
// (refusals are never cached: a refusal says "retrieval found nothing",
// which is a property of the moment, not of the question); re-exported
// here so the existing import surface keeps working
export { refusalAnswer } from "./refusal";

/** The interpolation source for every prompt: the profile's declared
 *  vars plus the derived publisher tokens. Call sites never build
 *  their own var map. */
export function promptVars(extra: Record<string, string> = {}): Record<string, string> {
  // profile vars are snake_case keys; template tokens are UPPER_SNAKE —
  // the map is built here, once, so no call site can spread the raw
  // keys again (the pre-varianlization bug: the identity token sat
  // unmatched and rendered empty in the system prompt)
  const out: Record<string, string> = { PUBLISHER_NAME: P().publisher.name };
  for (const [k, v] of Object.entries(P().prompts?.vars ?? {})) {
    if (typeof v === "string") out[k.toUpperCase()] = v;
  }
  return { ...out, ...extra };
}

/** Fill {{TOKEN}} placeholders in a prompt data file. Unknown/empty tokens
 *  resolve to "" so optional lines vanish cleanly. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => (k in vars ? vars[k] : ""));
}
import { QueryFilters, toVectorizeFilter, standardKeyAllowed } from "./selfquery";
import { hitQuality } from "./quality";
import { lexicalPrefilter } from "./lexical";
import { positionOrder } from "./structural";
import { STAGES, runStages } from "./stages";
import type { PipelineContext, RetrieveOptions, GlossaryEntry } from "./stages/types";
// the chunk wire contract lives with its pydantic twin (workers/shared/
// chunk.ts ↔ ingest/vector_adapter.py); re-exported here so the existing
// import surface keeps working
export type { ChunkMeta, Hit } from "../../shared/chunk";
import type { ChunkMeta, Hit } from "../../shared/chunk";
import { portModelRunner } from "./env.ts";

export interface Retrieved {
  hits: Hit[];
  filters: QueryFilters;
  /** vocabulary link (the L2 nomenclature bridge): top defined-term
   *  candidates for the question's subject — the answer model adjudicates
   *  among them (dense retrieval alone binds everyday words to the wrong
   *  term: measured "keeps drifting" → creep 0.69 vs durability 0.54) */
  glossary?: GlossaryEntry[];
  /** structured facts stages extracted from the graph (GraphRAG) —
   *  merged into the answer prompt's retrieval note */
  notes?: string[];
}

// Short follow-ups are usually elliptical ("and the limits?") — fold the
// previous question into the RETRIEVAL query (generation still sees the
// original wording). Purely structural (word count): whether a question
// is elliptical is a semantic judgment, and semantics belong to the
// understanding model, whose standalone_query takes precedence anyway.
export function retrievalQuery(query: string, prev?: string): string {
  if (!prev || !prev.trim()) return query;
  const words = query.trim().split(/\s+/).length;
  if (words <= 8) return `${prev.trim()} — ${query.trim()}`;
  return query;
}

// colloquial process questions ("how do I get a device certified to R 60")
// share almost no vocabulary with the B-series prose that answers them —
// THRESHOLDS.processExpansion is appended to the retrieval query so the
// window contains the certification-system documents at all

// ── the retrieval pipeline (TODO.impl/02) ────────────────────────────────
// retrieve() is COMPOSITION ONLY: build the context (the parallel
// embed/lexical prelude — Option C's latency structure is load-bearing),
// run the stage registry, project the result. Every mechanism lives in
// its own stage module under src/stages/; the registry order and the
// per-stage contracts are specified in docs/spec-pipeline.md.
export async function retrieve(
  env: any,
  query: string,
  opts: RetrieveOptions = {},
): Promise<Retrieved> {
  const u = opts.understanding ?? null;
  // Filters and process-intent come ONLY from query understanding — no
  // regex floor, no union. When understanding is unavailable the query
  // runs unfiltered and unexpanded (vanilla retrieval); meaning is never
  // decided by string matching.
  // The declared context's HARD scope outranks the understanding's routing
  // opinion: a certificate chip that says R 60:2021 keeps its dense filter
  // even when the question's vocabulary makes the classifier emit
  // process_intent (certification wording is the chip's subject, not the
  // question's). Without this, dense runs unfiltered, the certification
  // corpus floods the pool, and the pool-level seal — which must stay hard —
  // cuts it to zero (the ctx-entity refusal, diagnosed 2026-09-08).
  const scope: QueryFilters | null =
    u && !u.process_intent && u.doc_number
      ? { doc_number: u.doc_number, ...(u.edition ? { edition: u.edition } : {}) }
      : opts.sealScope
        ? { doc_number: opts.sealScope.doc_number, ...(opts.sealScope.edition ? { edition: opts.sealScope.edition } : {}) }
        : null;
  const filters: QueryFilters | null = scope;
  const filter = filters ? toVectorizeFilter(filters) : null;
  const folded = retrievalQuery(query, opts.prev);
  let rq = opts.queryOverride?.trim() || u?.standalone_query?.trim() || folded;
  if (u?.process_intent) rq += processExpansion();
  // Dense embed + full-corpus BM25 prefilter in parallel (G-ETSI-1 /
  // arXiv:2604.09868 §II-B5). Lexical must scan the whole corpus — the
  // old keywordRank only re-ordered dense hits and could not recover
  // exact-jargon misses. Fail-open: empty lexical list leaves dense alone.
  // Option C: when the query is unchanged (rq === folded) the optimistic
  // vector is already resolved — never await a fresh embed for it.
  const vectorP =
    rq === folded && opts.optimisticVec
      ? Promise.resolve(opts.optimisticVec)
      : rq === folded && opts.warmEmbed
        ? opts.warmEmbed.then((w) => w ?? embed(portModelRunner(env), MODELS.embed, rq))
        : embed(portModelRunner(env), MODELS.embed, rq);
  const lexicalP = lexicalPrefilter(env, opts.lexicalBoost ? `${rq} ${opts.lexicalBoost}` : rq).catch(() => [] as Hit[]);
  const [vector, lexicalHits0] = await Promise.all([vectorP, lexicalP]);
  // The declared context's seal binds the lexical lane at the SOURCE: the
  // RRF fusion mixes the full-corpus lexical ranking straight into the
  // final hits — past the pool-level seal — so under a seal the lexical
  // lane is the FAMILY's lexical hits only. The license entitlement scope
  // binds the same lane the same way (it re-enters twice: lexical-union
  // pre-rerank and lexical-rrf post-rerank — both consume this list).
  const lexicalHits = (opts.sealScope || opts.standardKeys
    ? lexicalHits0.filter(
        (h) =>
          (!opts.sealScope ||
            (h.metadata.doc_number === opts.sealScope!.doc_number &&
              (!opts.sealScope!.edition || h.metadata.edition === opts.sealScope!.edition))) &&
          standardKeyAllowed(h.metadata, opts.standardKeys),
      )
    : lexicalHits0);
  if (lexicalHits.length) console.log("lexical prefilter:", lexicalHits.length, "hits");

  const ctx: PipelineContext = {
    env, query, rq, folded, u, filters, filter, vector, lexicalHits,
    matches: [], hits: [], finalHits: [], glossary: [], notes: [], opts, lane: {},
  };
  await runStages(STAGES, ctx);
  return {
    hits: ctx.finalHits,
    filters: ctx.filters ?? {},
    ...(ctx.glossary?.length ? { glossary: ctx.glossary } : {}),
    ...(ctx.notes?.length ? { notes: ctx.notes } : {}),
  };
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

// ── context budget ─────────────────────────────────────────────────────
// The model window is finite; without a cap, a long conversation plus 8
// clause chunks (tables can be huge) overflows and the request FAILS
// outright. Everything is estimated (never exact) and stays well under
// the smallest context our models accept. Priority when the budget is
// tight: system + query always fit → newest history gets a bounded slice
// → passages fill the rest, best-ranked first, worst-ranked dropped.

function estTokens(s: string): number {
  // CJK/Arabic/Indic scripts ≈ 1 token per char; Latin ≈ 1 per 4 chars
  const wide = (s.match(/[؀-ۿݐ-ݿऀ-ॿ぀-ヿ㐀-䶿一-鿿가-힯]/g) || []).length;
  return wide + Math.ceil((s.length - wide) / 4);
}

function clipToTokens(s: string, maxTok: number): string {
  if (maxTok < 40 || estTokens(s) <= maxTok) return s;
  const wide = (s.match(/[؀-ۿݐ-ݿऀ-ॿ぀-ヿ㐀-䶿一-鿿가-힯]/g) || []).length;
  const latinChars = Math.max(0, maxTok - wide) * 4;
  return s.slice(0, Math.min(s.length, wide + latinChars)).trimEnd() + " …";
}

export interface BuiltMessages {
  messages: { role: string; content: string }[];
  usedHits: Hit[]; // passages actually included (citations must match these)
}

/** System instruction for a conversational (non-knowledge) turn: the
 *  service facts the model speaks from, composed from the DATASETS
 *  catalog — the same SSOT /api/datasets serves. Routing is decided by
 *  query UNDERSTANDING (understanding.ts), never by string matching. */
export function identityNote(member: boolean): string {
  const corpora = DATASETS().filter((d) => !d.session || member)
    .map((d) => `- ${d.label}: ${d.description}`)
    .join("\n");
  const locked = DATASETS().filter((d) => d.session && !member);
  const upsell = locked.length
    ? `Signed-in members additionally search: ${locked.map((d) => `${d.label} (${d.description})`).join("; ")}.`
    : "";
  return fill(conversationalPromptText, promptVars({ CORPORA: corpora, UPSELL: upsell }))
    .split("\n")
    .filter((l) => l.trim())
    .join("\n");
}

/** Split history into the turns that fit the budget slice (kept, newest)
 *  and the older ones that must be compacted into a summary (overflow). */
export function splitHistory(
  history: HistoryTurn[],
  budgetTokens: number,
): { kept: HistoryTurn[]; overflow: HistoryTurn[] } {
  const historyBudget = Math.floor(budgetTokens * THRESHOLDS.historyBudgetShare);
  let used = 0;
  let cut = 0; // everything before `cut` overflows
  for (let i = history.length - 1; i >= 0; i--) {
    const t = Math.min(estTokens(history[i].content), 600);
    if (used + t > historyBudget) {
      cut = i + 1;
      break;
    }
    used += t;
  }
  return { kept: history.slice(cut), overflow: history.slice(0, cut) };
}


/** Final-tier LLM listwise rerank: jointly reorders the top passages for
 *  hard queries (cascade stage after the cross-encoder). Null = keep the
 *  incoming order (timeout/parse failure never blocks serving). */
export async function listwiseRerank(
  env: any,
  model: string,
  query: string,
  hits: Hit[],
): Promise<Hit[] | null> {
  if (hits.length < 4) return null;
  try {
    const listing = hits
      .map((h, i) => {
        const label = `${h.metadata.docidentifier || h.metadata.doc_id}:${h.metadata.edition || ""} §${h.metadata.clause_anchor || ""}`;
        return `[${i + 1}] ${label.replace(/(:|§)+$/g, "")} — ${h.text.replace(/\s+/g, " ").slice(0, 220)}`;
      })
      .join("\n");
    // bounded to 2.5s: this call sits serially before generation starts —
    // a slow reorder must never hold the first token hostage; the
    // cross-encoder order is the fallback and is already good
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 2500));
    const call = (async () => {
      const res: any = await env.AI.run(model, {
        messages: [
          { role: "system", content: listwisePromptText.trimEnd() },
          { role: "user", content: `Question: ${query}\n\nPassages:\n${listing}` },
        ],
        max_tokens: 700,
        reasoning_effort: "low",
      });
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
      const m = (text ?? "").match(/\[[\s\S]*?\]/);
      if (!m) return null;
      const order = JSON.parse(m[0]);
      if (!Array.isArray(order) || order.length !== hits.length) return null;
      const idx = order.map((n: unknown) => Number(n) - 1);
      if (idx.some((n: number) => !Number.isInteger(n) || n < 0 || n >= hits.length) || new Set(idx).size !== hits.length) return null;
      return idx.map((n: number) => hits[n]);
    })();
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  }
}

export function buildMessages(
  query: string,
  hits: Hit[],
  lang?: string,
  history: HistoryTurn[] = [],
  retrievalNote?: string,
  conversationSummary?: string,
  budgetTokens: number = LIMITS.inputTokenBudget,
): BuiltMessages {
  // per-corpus guidance travels WITH the dataset (config.ts): every
  // dataset whose corpus appears in the passages contributes its note —
  // new corpora need a catalog entry, never pipeline changes
  const corpusNotes = DATASETS().filter(
    (d) => d.note && hits.some((h) => (h.metadata as any).corpus === d.id),
  )
    .map((d) => d.note!)
    .join("\n");

  // the prompt itself is data (prompts/system.md); one rule per line,
  // joined with spaces exactly as the original array form
  const system = fill(systemPromptText, promptVars({
    HISTORY_CONTEXT: history.length
      ? " Earlier turns of this conversation are provided for context — answer the LATEST question, treating the passages below as the source of truth for facts and citations."
      : "",
    CORPUS_NOTES: corpusNotes,
    LANG_CLAUSE: lang ? ` (explicitly requested: ${lang})` : "",
  }))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");

  // history: newest-first into a bounded slice (oldest dropped first);
  // each turn is clipped so accounting and content agree
  const historyBudget = Math.floor(budgetTokens * THRESHOLDS.historyBudgetShare);
  const keptHistory: { role: "user" | "assistant"; content: string }[] = [];
  let historyUsed = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const content = clipToTokens(history[i].content, 600);
    const t = estTokens(content);
    if (historyUsed + t > historyBudget) break;
    keptHistory.unshift({ role: history[i].role, content });
    historyUsed += t;
  }

  // passages: best-ranked first into whatever remains
  const summaryBlock = conversationSummary
    ? `Earlier in this conversation (summarized for continuity):\n${conversationSummary}`
    : "";
  let remain =
    budgetTokens - estTokens(system) - estTokens(retrievalNote ?? "") - estTokens(summaryBlock) - estTokens(`Question: ${query}\n\nContext passages:\n`) - historyUsed - 120; // slack for estimator error + output framing
  const passageParts: string[] = [];
  const usedHits: Hit[] = [];
  // Passage label as the MODEL should cite it (it copies these into
  // answers): drop OIML language markers, append the edition only when
  // the identifier doesn't already carry it ("B 18:2025 (E)" + "2025" →
  // no ":2025"; "PD-06 Edition 4" + "4" → no ":4"), and never show a
  // producer UUID as a clause anchor — cite the clause title instead.
  const passageLabel = (m: ChunkMeta): string => {
    const id = (m.docidentifier || m.doc_id || "source").replace(/\s*\(([A-Z])\)\s*$/, "").trim();
    const edition = m.edition && !id.includes(m.edition) ? ":" + m.edition : "";
    const raw = String(m.clause_anchor ?? "");
    const garbage = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw) || (raw.startsWith("_") && raw.length > 12);
    const anchor = garbage || !raw ? "" : ` §${raw}`;
    return `${id}${edition}${anchor}`;
  };
  // passages in document reading order (FABLE NodeFusion): same-doc
  // clauses read top-to-bottom, docs by best rank — synthesis quality
  // depends on arrangement, not just the selected set
  for (const h of positionOrder(hits)) {
    const st = h.metadata.status === "withdrawn" || h.metadata.status === "superseded" ? ` [${h.metadata.status}]` : "";
    const label = `${passageLabel(h.metadata)}${st}`;
    // answer contract v2: typed passages declare their unit id so the
    // model can reference [[u:<id>]] instead of retyping the object
    const unitTag = (h.metadata as any).unit_id ? ` unit ${(h.metadata as any).unit_id}${(h.metadata as any).block ? ` (${(h.metadata as any).block})` : ""}` : "";
    const head = `[${usedHits.length + 1}] ${label}${unitTag} ${h.metadata.clause_title ? "— " + h.metadata.clause_title : ""}\n`;
    // tables: schema-aware pruning from the producer payload; the
    // stored text is the fallback (pruning never goes below baseline)
    const tableSel = (h.metadata as any).block === "table" ? tableSelection(h.metadata, query) : null;
    const pruned = tableSel?.text ?? null;
    if (tableSel) (h.metadata as any).table_selection = { cols: tableSel.cols, rowsShown: tableSel.rowsShown, rowsTotal: tableSel.rowsTotal };
    const body = clipToTokens(pruned ?? h.text, LIMITS.maxPassageTokens);
    const t = estTokens(head) + estTokens(body);
    if (t <= remain) {
      passageParts.push(head + body);
      usedHits.push(h);
      remain -= t;
    } else if (usedHits.length < 2) {
      // always keep at least the two best passages, truncated to fit
      passageParts.push(head + clipToTokens(h.text, Math.max(150, remain - estTokens(head))));
      usedHits.push(h);
      remain = 0;
      break;
    } else break;
  }
  const context = passageParts.join("\n\n") || "(no passages)";

  return {
    messages: [
      { role: "system", content: system },
      ...(retrievalNote ? [{ role: "system", content: retrievalNote }] : []),
      ...(summaryBlock ? [{ role: "system", content: summaryBlock }] : []),
      ...keptHistory.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: `Question: ${query}\n\nContext passages:\n${context}` },
    ],
    usedHits,
  };
}

/** The publisher's catalog page for a publication, from the profile's
 *  URL template ({type} = lowercase doctype, then the number); no
 *  template, no catalog link. */
function publicationUrl(meta: ChunkMeta): string | undefined {
  // the catalog template names THIS publisher's store - an internal or
  // foreign-corpus chunk has no entry in it, and a fabricated url is
  // worse than none (the door for internal renderings is the internal
  // origin, wired by the site's doc-base configuration)
  const ownCorpora = P().publisher.catalog_corpora;
  if (meta.corpus && ownCorpora && !ownCorpora.includes(meta.corpus)) return undefined;
  const tpl = P().publisher.catalog_url_template;
  if (!tpl || !meta.doctype || !meta.doc_number) return undefined;
  return tpl.replace("{type}", meta.doctype.toLowerCase()) + meta.doc_number;
}

export function citations(hits: Hit[]) {
  const rank = (s?: string) => (s === "in-force" || s === "joint" ? 0 : s === "unknown" || !s ? 1 : 2);
  return [...hits]
    .map((h) => ({
      doc_id: h.metadata.doc_id,
      docidentifier: h.metadata.docidentifier,
      edition: h.metadata.edition,
      language: h.metadata.language,
      clause_anchor: h.metadata.clause_anchor,
      clause_title: h.metadata.clause_title,
      status: h.metadata.status ?? "unknown",
      superseded_by: h.metadata.superseded_by || undefined,
      corpus: h.metadata.corpus || P().publisher.id,
      quality: hitQuality(h.metadata),
      url: publicationUrl(h.metadata),
      snippet: h.text.slice(0, 400),
      score: h.rerank_score ?? h.score,
    }))
    .sort((a, b) => rank(a.status) - rank(b.status)); // in-force first, withdrawn last
}
