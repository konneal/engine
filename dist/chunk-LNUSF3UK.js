import {
  requestSalt,
  resolveRequestScope
} from "./chunk-LNSDBEKS.js";
import {
  NO_CONTEXT,
  appliedContext,
  buildMessages,
  checkQuota,
  citations,
  clientIp,
  contextNote,
  editionNote,
  embed,
  exchangeForLiveToken,
  generateOnce,
  graphExpand,
  identityNote,
  listwiseRerank,
  liveDataConfig,
  namedDocumentIn,
  parseContext,
  portModelRunner,
  rawSessionToken,
  resolveDocScope,
  resolveLiveAccount,
  retrievalQuery,
  retrieve,
  sessionFrom,
  splitHistory,
  syntheticUnderstanding,
  telemetry,
  understandQuery
} from "./chunk-6HCFW5PM.js";
import {
  corsHeaders,
  err,
  json,
  readJson,
  validateQuery
} from "./chunk-SN3ANQ3Y.js";
import {
  canonicalRefusal,
  refusalAnswer
} from "./chunk-WGXATDXY.js";
import {
  LIMITS,
  MODELS,
  answerEffort,
  effortBudget,
  num,
  requestEffort,
  roleModel,
  sha256Hex
} from "./chunk-Q6LI4T7M.js";
import {
  P
} from "./chunk-Q327B27J.js";

// workers/worker_public/src/internal_gateway.ts
async function retrieveInternal(service, auth, query) {
  try {
    const res = await service.fetch("https://internal/retrieve", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, authorization: auth.authorization },
      body: JSON.stringify({ query })
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data?.hits)) return [];
    return data.hits.map((h) => ({
      id: h.id,
      score: h.score,
      metadata: h.metadata ?? {},
      text: h.text ?? ""
    }));
  } catch {
    return [];
  }
}

// workers/worker_public/prompts/grader.md
var grader_default = 'You grade retrieval quality for a legal-metrology Q&A system.\nGiven the question and the retrieved passage summaries, reply with ONLY:\n{"grade": "good"}  \u2014 passages clearly contain the material to answer\n{"grade": "weak"}  \u2014 passages are on the right publication/topic but lack the specific material (a broader or differently-worded retrieval might find it)\n{"grade": "bad"}   \u2014 passages are unrelated to the question\n';

// workers/worker_public/src/grader.ts
async function gradeRetrieval(ai, model, query, passages) {
  if (!passages.length) return "bad";
  const summary = passages.slice(0, 8).map((p, i) => `[${i + 1}] ${p.replace(/\s+/g, " ").slice(0, 220)}`).join("\n");
  const timeout = new Promise((r) => setTimeout(() => r(null), 6e3));
  const call = (async () => {
    const res = await ai.run(model, {
      messages: [
        { role: "system", content: grader_default },
        { role: "user", content: `Question: ${query}

Passages:
${summary}` }
      ],
      // reasoning shares this budget — starved budgets silently disable
      // the CRAG corrective layer (default "good" fires). DeepSeek-V4's
      // non-think mode is severely degraded (model card: HLE 8.1 vs 34.8),
      // so the grader keeps reasoning on with real headroom plus the
      // card's recommended sampling.
      max_tokens: 6144,
      reasoning_effort: "low",
      temperature: 1,
      top_p: 1
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    const m = (text ?? "").match(/"grade"\s*:\s*"(good|weak|bad)"/);
    return m ? m[1] : null;
  })();
  try {
    const got = await Promise.race([call, timeout]);
    return got ?? "good";
  } catch {
    return "good";
  }
}
async function scoreJudge(ai, model, systemPrompt, userPrompt) {
  try {
    const timeout = new Promise((r) => setTimeout(() => r(null), 15e3));
    const call = (async () => {
      const res = await ai.run(model, {
        messages: [
          { role: "system", content: systemPrompt.trimEnd() },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 6144,
        reasoning_effort: "low"
      });
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
      let score = null;
      for (const m of (text ?? "").matchAll(/\{[^{}]*\}/g)) {
        try {
          const obj = JSON.parse(m[0]);
          if (typeof obj.score === "number") score = obj.score;
        } catch {
        }
      }
      return score === null ? null : Math.max(0, Math.min(1, score));
    })();
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  }
}

// workers/worker_public/prompts/summarize.md
var summarize_default = "Summarize this conversation so a Q&A assistant can continue it with full continuity. Capture: documents and editions discussed, questions asked, answers given (key values and definitions), terminology established, unresolved threads. Under 150 words, plain text, no preamble. The conversation may be any length and in any language \u2014 summarize it in English.\n";

// workers/worker_public/prompts/reflect.md
var reflect_default = 'You are a factuality critic. Given a question, an answer, and the passages the answer was based on, determine if every factual claim in the answer is directly supported by the passages. Reply with ONLY: {"grounded": true} or {"grounded": false, "missing_info": "what is missing"}\n';

// workers/worker_public/src/reflect.ts
async function reflect(ai, model, question, answer, passages) {
  if (!answer || !passages.length) return null;
  const ctx = passages.slice(0, 8).map((p, i) => `[${i + 1}] ${p.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const timeout = new Promise((r) => setTimeout(() => r(null), 6e3));
  const call = (async () => {
    const res = await ai.run(model, {
      messages: [
        {
          role: "system",
          content: reflect_default.trimEnd()
        },
        {
          role: "user",
          content: `Question: ${question}

Answer:
${answer.slice(0, 1500)}

Passages:
${ctx}`
        }
      ],
      // reasoning shares this budget — starved budgets silently disable
      // the reflection layer (null = no retry ever fires); DeepSeek-V4
      // card: keep reasoning on with headroom + temp 1.0 / top_p 1.0
      max_tokens: 3072,
      reasoning_effort: "low",
      temperature: 1,
      top_p: 1
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    const m = (text ?? "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const raw = JSON.parse(m[0]);
      return {
        grounded: raw.grounded === true,
        missing_info: typeof raw.missing_info === "string" ? raw.missing_info.slice(0, 200) : ""
      };
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  }
}

// workers/worker_public/src/anchors.ts
var normalize = (s) => s.replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"').replace(/[–—−]/g, "-").replace(/­/g, "").replace(/[     ]/g, " ").replace(/\s+/g, " ").toLowerCase();
var ANCHOR = /\[[^\[\]\n]*\]/g;
function checkQuoteAnchors(answer, passages) {
  const flat = answer.replace(/[“”‟«»]/g, '"');
  const hay = normalize(passages.join("\n\n"));
  const violations = [];
  let total = 0;
  for (const anchor of flat.matchAll(ANCHOR)) {
    for (const q of anchor[0].matchAll(/"([^"\n]+)"/g)) {
      total++;
      if (!hay.includes(normalize(q[1]))) violations.push(anchor[0]);
    }
  }
  return { total, violations };
}
var ANCHOR_CORRECTION_NOTE = "Correction notice: your draft quoted text that does not appear verbatim in the provided passages. Rewrite the answer \u2014 every quoted phrase must be an exact copy from a passage, or cite the clause without quoting.";

// workers/worker_public/src/refs.ts
var REF = /\[\[(u:[A-Za-z0-9_-]+)\]\]/g;
function availableUnitIds(hits) {
  const ids = /* @__PURE__ */ new Set();
  for (const h of hits) {
    const u = h.metadata?.unit_id;
    if (u) ids.add(u);
  }
  return ids;
}
function parseRefs(text) {
  return [...text.matchAll(REF)].map((m) => m[1]);
}
function sanitizeRefs(text, available) {
  const dropped = [];
  const out = text.replace(REF, (full, id) => {
    if (available.has(id)) return full;
    dropped.push(id);
    return "";
  });
  return { text: out, dropped };
}
async function resolveBlocks(db, refs) {
  if (!refs.length) return [];
  const uniq = [...new Set(refs)].slice(0, 12);
  const blocks = [];
  for (let i = 0; i < uniq.length; i += 20) {
    const batch = uniq.slice(i, i + 20);
    const placeholders = batch.map((_, n) => `?${n + 1}`).join(",");
    try {
      const res = await db.prepare(`SELECT unit_id, type, docidentifier, edition, payload FROM unit_payloads WHERE unit_id IN (${placeholders})`).bind(...batch).all();
      for (const r of res.results) {
        let payload = {};
        try {
          payload = JSON.parse(String(r.payload));
        } catch {
          continue;
        }
        blocks.push({
          unit_id: String(r.unit_id),
          type: String(r.type),
          docidentifier: String(r.docidentifier ?? ""),
          edition: r.edition ? String(r.edition) : void 0,
          payload
        });
      }
    } catch (e) {
      console.log("resolveBlocks failed:", String(e).slice(0, 150));
    }
  }
  return blocks;
}
async function contractV2(db, answer, usedHits) {
  const available = availableUnitIds(usedHits);
  const { text, dropped } = sanitizeRefs(answer, available);
  if (dropped.length) console.log("refs: dropped", dropped.length, "invalid (not in passages)");
  const refs = parseRefs(text);
  const blocks = await resolveBlocks(db, refs);
  return { text, blocks, dropped };
}
function tableRetyped(text, availableTable) {
  if (!availableTable) return false;
  return /(^|\n)\s*\|[^\n]+\|\s*(\n\s*\|[-: |]+\|\s*)?(\n|$)/.test(text) && (text.match(/\|/g) ?? []).length >= 6;
}

// workers/worker_public/src/completion.ts
async function completeTables(db, answer, used) {
  const blocks = [];
  try {
    const answerNums = new Set((answer.match(/\d[\d ,.]{1,8}\d/g) ?? []).map((x) => x.replace(/[ ,.]/g, "")));
    if (!answerNums.size) return blocks;
    const fams = [...new Set(used.map((h) => h.metadata.docidentifier).filter(Boolean))].slice(0, 3);
    for (const fam of fams) {
      const base = String(fam).replace(/\s*\([A-Z]\)\s*$/, "").split(":")[0].trim();
      const rows = await db.prepare("SELECT unit_id, payload FROM unit_payloads WHERE type = 'table' AND docidentifier LIKE ?1 LIMIT 8").bind(`%${base}%`).all();
      for (const r of rows.results ?? []) {
        const tableNums = new Set((String(r.payload).match(/\d[\d ,.]{1,8}\d/g) ?? []).map((x) => x.replace(/[ ,.]/g, "")));
        let hits = 0;
        for (const n of answerNums) if (tableNums.has(n)) hits++;
        if (hits >= 1) {
          const resolved = await resolveBlocks(db, [r.unit_id]);
          blocks.push(...resolved);
          console.log("contract D1 completion: table", r.unit_id, "in", base, "\u2014", hits, "matching values");
          break;
        }
      }
      if (blocks.length) break;
    }
  } catch {
  }
  return blocks;
}
async function completeFigures(db, answer, alreadyAttached, used = []) {
  const unitForm = (answer.match(/u:fig[\w.-]*/g) ?? []).map((x) => x.replace(/[.,;:)]+$/, ""));
  const bareForm = (answer.match(/\bfig-[\w.-]+\b/g) ?? []).map((x) => x.replace(/[.,;:)]+$/, ""));
  let mentioned = [.../* @__PURE__ */ new Set([...unitForm, ...bareForm.map((x) => x.startsWith("u:") ? x : "u:" + x)])].slice(0, 6);
  const proseNums = new Set(
    (answer.match(/\bFig(?:ure|\.)s?\s*([0-9]{1,2}[a-z]?)/g) ?? []).map((x) => x.replace(/\bFig(?:ure|\.)s?\s*/i, "").toLowerCase())
  );
  if (proseNums.size) {
    const fams = [...new Set(used.map((h) => h.metadata.docidentifier).filter(Boolean))].slice(0, 3);
    for (const fam of fams) {
      const base = String(fam).replace(/\s*\([A-Z]\)\s*$/, "").split(":")[0].trim();
      const rows = await db.prepare("SELECT unit_id FROM unit_payloads WHERE type = 'figure' AND docidentifier LIKE ?1 LIMIT 24").bind(`%${base}%`).all();
      for (const r of rows.results ?? []) {
        const m = r.unit_id.match(/fig-?([0-9]{1,2}[a-z]?)/i);
        if (m && proseNums.has(m[1].toLowerCase())) mentioned.push(r.unit_id);
      }
    }
    mentioned = [...new Set(mentioned)].slice(0, 6);
  }
  const have = new Set(alreadyAttached.map((b) => b.unit_id));
  const missing = mentioned.filter((id) => !have.has(id));
  if (!missing.length) return [];
  const figs = await resolveBlocks(db, missing);
  if (figs.length) console.log("figure completion:", figs.map((b) => b.unit_id).join(", "), "attached from D1");
  return figs;
}

// workers/worker_public/src/modelplane.ts
var NODE_RE = /(?:^|[\s("'`])\/(req|conf|term|constraint|characteristic|state-machine|dimension)\/([a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?)(?=[\s)"'`,;:.]|$)/i;
function modelNodeRefIn(text) {
  if (!text) return null;
  const m = text.match(NODE_RE);
  if (!m) return null;
  const id = `/${m[1].toLowerCase()}/${m[2]}`;
  return id.length <= 120 ? id : null;
}
function standardForDocNumber(docNumber) {
  if (!docNumber) return null;
  const models = P().sources?.models;
  if (!models?.standards?.length || !models?.standard_prefix) return null;
  return models.standards.includes(docNumber) ? `${models.standard_prefix}${docNumber}` : null;
}
async function fetchNode(env, standard, nodeId) {
  try {
    const row = await env.DB.prepare(
      "SELECT standard, node_id, kind, name, clause_doc, clause_ref, content FROM model_nodes WHERE standard = ?1 AND node_id = ?2"
    ).bind(standard, nodeId).first();
    if (!row) return null;
    const content = JSON.parse(String(row.content));
    const clause = row.clause_doc && row.clause_ref ? { doc: String(row.clause_doc), ref: String(row.clause_ref), urn: `${row.clause_doc}#clause-${row.clause_ref}` } : row.clause_doc ? { doc: String(row.clause_doc), ref: "", urn: String(row.clause_doc) } : null;
    return {
      standard: String(row.standard),
      node_id: String(row.node_id),
      kind: String(row.kind),
      name: String(row.name ?? row.node_id),
      clause,
      content
    };
  } catch {
    return null;
  }
}
async function bindModelNode(env, opts) {
  const nodeId = modelNodeRefIn(opts.label) ?? modelNodeRefIn(opts.query);
  if (!nodeId) return null;
  if (opts.standard) return fetchNode(env, opts.standard, nodeId);
  try {
    const rows = await env.DB.prepare("SELECT standard FROM model_nodes WHERE node_id = ?1 LIMIT 2").bind(nodeId).all();
    const standards = (rows?.results ?? []).map((r) => String(r.standard));
    if (standards.length === 1) return fetchNode(env, standards[0], nodeId);
    return null;
  } catch {
    return null;
  }
}
function clip(s, n = 500) {
  const t = String(s ?? "").trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + " \u2026";
}
function applicabilityText(app) {
  if (!app || typeof app !== "object") return "";
  const parts = [];
  for (const [dim, cond] of Object.entries(app)) {
    if (Array.isArray(cond)) parts.push(`${dim.replace(/_/g, " ")}: ${cond.join(", ")}`);
    else if (cond && typeof cond === "object" && Array.isArray(cond.values)) {
      parts.push(`${dim.replace(/_/g, " ")} (${cond.match ?? "any"}): ${cond.values.join(", ")}`);
    }
  }
  return parts.join("; ");
}
function modelGroundingBlock(node) {
  const c = node.content ?? {};
  const lines = [];
  lines.push(
    P().prompts.vars.model_grounding_intro ?? "Model grounding \u2014 the model plane's own statement:"
  );
  lines.push(`Node: ${node.node_id} (${node.kind.replace(/_/g, " ")}) \u2014 ${node.name} [${node.standard}]`);
  if (node.clause) lines.push(`Provenance: ${node.clause.urn}`);
  if (c.statement) lines.push(`Statement: ${clip(c.statement)}`);
  if (c.definition) lines.push(`Definition: ${clip(c.definition)}`);
  if (c.purpose) lines.push(`Purpose: ${clip(c.purpose)}`);
  const limit = c.limit ?? {};
  if (limit.expression) lines.push(`Machine limit (the constraint the platform's verdict engine evaluates \u2014 quote it verbatim): ${limit.expression}`);
  if (limit.accepts?.verdict) lines.push(`Machine limit: ${limit.accepts.verdict} ${limit.accepts.op} ${limit.accepts.limit} (the canonical acceptance chain)`);
  if (c.check) lines.push(`Machine check: ${c.check}`);
  if (c.derive) lines.push(`Derivation: ${c.derive}${Array.isArray(c.inputs) ? ` (inputs: ${c.inputs.join(", ")})` : ""}`);
  const app = applicabilityText(c.applicability);
  const scopeApp = applicabilityText(c.scope_applicability);
  if (app || scopeApp) lines.push(`Applicability: ${[scopeApp, app].filter(Boolean).join("; ")}`);
  if (Array.isArray(c.binds_to) && c.binds_to.length) lines.push(`Binds to: ${c.binds_to.join(", ")}`);
  if (Array.isArray(c.targets) && c.targets.length) lines.push(`Verifies requirements: ${c.targets.join(", ")}`);
  if (Array.isArray(c.preconditions) && c.preconditions.length) {
    const pcs = c.preconditions.map((p) => `${p.id}: ${clip(p.check ?? (p.state ? `state = ${p.state}` : ""), 120)}`).join("; ");
    lines.push(`Run-validity preconditions (a violation voids the run \u2014 invalid, never a fail): ${pcs}`);
  }
  if (c.acceptance_criteria?.description) lines.push(`Acceptance: ${clip(c.acceptance_criteria.description, 300)}`);
  if (c.violation_meaning) lines.push(`Violation meaning (verbatim): ${clip(c.violation_meaning, 300)} \u2014 on violation: ${c.on_violation ?? "invalid"}`);
  if (Array.isArray(c.values) && c.values.length) {
    lines.push(`Values: ${c.values.map((v) => `${v.id}${v.implies?.length ? ` (implies ${v.implies.join(", ")})` : ""}`).join("; ")}`);
  }
  if (c.source_discrepancy) {
    const sd = c.source_discrepancy;
    lines.push(
      `DECLARED SOURCE DISCREPANCY \u2014 the model and the text disagree; you MUST surface this and cite both: ${clip(sd.summary, 300)} Sources: ${(sd.sources ?? []).join(" and ")}. The model ${sd.resolution === "follows_clause_x" ? "follows one side" : "records the conflict without resolving it"}: ${clip(sd.rationale, 300)}`
    );
  }
  lines.push(
    "Rules for this answer: the machine facts (the constraint, the applicability, the acceptance, the provenance) come from THIS node \u2014 quote the machine limit verbatim, never invent one the node does not carry. If this model content and a prose passage disagree \u2014 including a passage from a different edition \u2014 say so explicitly and cite both (this node and the prose clause)."
  );
  return lines.join("\n");
}
function modelCitation(node) {
  return {
    doc_id: `model:${node.standard}`,
    docidentifier: `${P().publisher.name} SMART model (${(() => {
      const prefix = P().sources?.models?.standard_prefix ?? "";
      const letter = prefix.replace(/^.*-/, "").toUpperCase();
      return String(node.standard).replace(new RegExp(`^${prefix}`, "i"), `${letter} `);
    })()})`,
    edition: "",
    language: "en",
    clause_anchor: node.clause?.ref || "model",
    clause_title: `${node.kind.replace(/_/g, " ")} \u2014 ${node.name} (${node.node_id})`,
    status: "in-force",
    corpus: "smart-model",
    url: void 0,
    snippet: `${node.node_id}${node.clause ? ` \xB7 ${node.clause.urn}` : ""}${node.content?.statement ? ` \u2014 ${clip(node.content.statement, 240)}` : ""}`,
    score: 1
  };
}
function modelEcho(node) {
  return {
    node_id: node.node_id.slice(0, 120),
    kind: node.kind.slice(0, 40),
    standard: node.standard.slice(0, 40),
    ...node.clause?.urn ? { clause: node.clause.urn.slice(0, 120) } : {}
  };
}

// workers/worker_public/src/verdict.ts
function tokenize(src) {
  const toks = [];
  let i = 0;
  const s = src.replace(/\s+/g, " ");
  while (i < s.length) {
    const c = s[i];
    if (c === " ") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = s.slice(i).match(/^[0-9]*\.?[0-9]+/);
      toks.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/);
      toks.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if ([">=", "<=", "==", "!="].includes(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/()<>".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new Error(`bad char ${c}`);
  }
  return toks;
}
function parseAndEval(src, params) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => {
    const t = toks[p++];
    if (v && (!t || t.t !== "op" || t.v !== v)) throw new Error(`expected ${v}`);
    return t;
  };
  const isKw = (k) => {
    const t = peek();
    return t && t.t === "id" && t.v.toLowerCase() === k;
  };
  function or() {
    let l = and();
    while (isKw("or")) {
      p++;
      const r = and();
      l = truthy(l) || truthy(r);
    }
    return l;
  }
  function and() {
    let l = not();
    while (isKw("and")) {
      p++;
      const r = not();
      l = truthy(l) && truthy(r);
    }
    return l;
  }
  function not() {
    if (isKw("not")) {
      p++;
      return !truthy(not());
    }
    return cmp();
  }
  function cmp() {
    const l = add();
    const t = peek();
    if (t && t.t === "op" && [">=", "<=", ">", "<", "==", "!="].includes(t.v)) {
      p++;
      const r = add();
      switch (t.v) {
        case ">=":
          return num2(l) >= num2(r);
        case "<=":
          return num2(l) <= num2(r);
        case ">":
          return num2(l) > num2(r);
        case "<":
          return num2(l) < num2(r);
        case "==":
          return num2(l) === num2(r);
        default:
          return num2(l) !== num2(r);
      }
    }
    return l;
  }
  function add() {
    let l = mul();
    for (; ; ) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
        p++;
        const r = mul();
        l = t.v === "+" ? num2(l) + num2(r) : num2(l) - num2(r);
      } else return l;
    }
  }
  function mul() {
    let l = unary();
    for (; ; ) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/")) {
        p++;
        const r = unary();
        l = t.v === "*" ? num2(l) * num2(r) : num2(l) / num2(r);
      } else return l;
    }
  }
  function unary() {
    const t = peek();
    if (t && t.t === "op" && t.v === "-") {
      p++;
      return -num2(unary());
    }
    return atom();
  }
  function atom() {
    const t = eat();
    if (!t) throw new Error("unexpected end");
    if (t.t === "num") return t.v;
    if (t.t === "id") {
      if (params[t.v] !== void 0) return params[t.v];
      throw new Error(`missing ${t.v}`);
    }
    if (t.v === "(") {
      const v = or();
      eat(")");
      return v;
    }
    throw new Error(`unexpected ${t.v}`);
  }
  const truthy = (v) => typeof v === "boolean" ? v : v !== 0;
  const num2 = (v) => typeof v === "boolean" ? v ? 1 : 0 : v;
  const out = or();
  if (p !== toks.length) throw new Error("trailing tokens");
  return out;
}
function oclBody(s) {
  const m = String(s ?? "").match(/ocl\{([\s\S]*?)\}/);
  return m ? m[1].trim() : null;
}
function extractChecks(content) {
  if (!content || typeof content !== "object") return [];
  const c = content;
  const out = [];
  const push = (e) => {
    const b = e && oclBody(e);
    if (b) out.push(b);
  };
  push(c.check);
  push(c.limit?.expression);
  push(c.acceptance_criteria?.limit && !c.acceptance_criteria.limit.expression?.includes("ocl{") ? null : c.acceptance_criteria?.limit?.expression);
  const st = c.acceptance_criteria?.limit;
  if (st?.expression && st.operator && st.threshold_expression) {
    out.push(`${st.expression} ${st.operator} ${st.threshold_expression}`);
  }
  return [...new Set(out)];
}
function symbolsIn(checks) {
  const ids = /* @__PURE__ */ new Set();
  const KEYWORDS = /* @__PURE__ */ new Set(["and", "or", "not"]);
  for (const chk of checks) {
    try {
      for (const t of tokenize(chk)) if (t.t === "id" && !KEYWORDS.has(t.v.toLowerCase())) ids.add(t.v);
    } catch {
    }
  }
  return [...ids];
}
function parseNumber(raw) {
  let s = raw.replace(/[ ,]/g, "");
  s = s.replace(/\.(\d{3})$/, "$1");
  return Number(s.replace(/,(?=\d{3}\b)/g, ""));
}
function extractParams(query, symbols) {
  const params = {};
  for (const sym of symbols) {
    const leaf = sym.split(".").pop() ?? sym;
    const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${esc}\\b\\D{0,14}?([0-9][0-9 ,.]*[0-9])`, "iu");
    const m = query.match(re);
    if (m) {
      const v = parseNumber(m[1]);
      if (Number.isFinite(v)) params[sym] = v;
    }
  }
  return params;
}
function evaluate(content, query) {
  const c = content && typeof content === "object" ? content : {};
  const checks = extractChecks(content);
  if (!checks.length) return null;
  const symbols = symbolsIn(checks);
  const params = extractParams(query, symbols);
  const missing = symbols.filter((s) => params[s] === void 0);
  const machine = checks.map((expression) => {
    const values = {};
    try {
      for (const t of tokenize(expression)) if (t.t === "id" && params[t.v] !== void 0) values[t.v] = params[t.v];
    } catch {
    }
    let result = null;
    if (missing.length === 0) {
      try {
        result = !!parseAndEval(expression, params);
      } catch {
        result = null;
      }
    }
    return { expression, symbolic: expression, values, result };
  });
  if (missing.length) {
    return { verdict: "void", missing, checks: machine };
  }
  const failed = machine.some((m) => m.result === false);
  const evaluable = machine.some((m) => m.result !== null);
  if (!evaluable) return null;
  return {
    verdict: failed ? "fail" : "pass",
    on_violation: failed ? String(c.on_violation ?? "invalid") : void 0,
    violation_meaning: failed ? typeof c.violation_meaning === "string" ? c.violation_meaning : void 0 : void 0,
    missing: [],
    checks: machine
  };
}
function verdictNote(v, node) {
  const lines = [
    `Machine verdict (deterministic evaluation of node ${node.node_id}${node.clause?.urn ? `, ${node.clause.urn}` : ""}) \u2014 the service EXECUTED the node's machine check against the values stated in the question:`
  ];
  for (const c of v.checks) {
    const vals = Object.entries(c.values).map(([k, n]) => `${k}=${n}`).join(", ");
    lines.push(`- ${c.expression}${vals ? `  [${vals}]` : ""} \u2192 ${c.result === null ? "not evaluated" : c.result ? "holds" : "VIOLATED"}`);
  }
  if (v.verdict === "void") {
    lines.push(`VERDICT: VOID \u2014 the question does not state: ${v.missing.join(", ")}. Say exactly what is missing; never assume values.`);
  } else if (v.verdict === "pass") {
    lines.push(`VERDICT: PASS \u2014 every machine check holds at the stated values. Present this verdict, the arithmetic above, and cite the node's clause.`);
  } else {
    lines.push(`VERDICT: ${String(v.on_violation ?? "FAIL").toUpperCase()} \u2014 a machine check is violated. Present this verdict, the arithmetic, the violation meaning verbatim, and cite the node's clause.`);
  }
  lines.push("This verdict is computed data \u2014 quote it faithfully; do not recompute, soften, or contradict it.");
  return lines.join("\n");
}

// workers/worker_public/src/drafts.ts
var ACT_VERB = "(?:draft|prepare|pre-?fill|fill\\s+(?:in|out)|start|submit|file|lodge)";
var ACT_TARGET = "(?:new\\s+)?(?:certification\\s+|type[ -]evaluation\\s+|OIML[- ]CS\\s+)?application";
var INTENT_RES = [
  new RegExp(`\\b${ACT_VERB}\\b[\\s\\S]{0,60}?\\b${ACT_TARGET}\\b`, "i"),
  new RegExp(`\\b${ACT_TARGET}\\b[\\s\\S]{0,30}?\\b(?:draft|prepare|pre-?fill|for me)\\b`, "i")
];
function detectDraftIntent(query) {
  if (/\b(?:status|where|progress|state)\b/i.test(query) && /\bapplication\b/i.test(query) && !INTENT_RES[0].test(query)) return null;
  return INTENT_RES.some((re) => re.test(query)) ? "application_prefill" : null;
}
function decodeServiceRoles(token, platformClientId) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const roles = payload?.service_roles?.[platformClientId];
    return Array.isArray(roles) ? roles.filter((r) => typeof r === "string") : [];
  } catch {
    return [];
  }
}
function roleLabel(role) {
  if (role === "tl_operator") return "a test laboratory operator";
  if (["ia_officer", "case_officer", "certification_officer", "signatory"].includes(role)) return "an issuing authority officer";
  if (role === "viewer") return "a read-only viewer";
  if (["cs_admin", "admin"].includes(role)) return "a scheme administrator";
  return `the "${role}" role`;
}
var EXTRACTION_SYSTEM = `You extract the fields of a new OIML certification application from the user's own messages.

Rules:
- Output ONLY a JSON object \u2014 no prose, no code fence.
- Copy every value from the user's own words, and for each field give "source": the exact contiguous span of the user's message you copied it from.
- NEVER infer, complete, normalize away, or guess a value. If the user did not state it, omit the field entirely.
- "standard": the Recommendation the user named (e.g. "R 60" or "OIML R 60:2021") \u2014 a plain string, or omit when none was named.
- "scheme": only when the user named scheme A or scheme B explicitly.

Schema (every field optional):
{
  "standard": "R 60",
  "family_designation": { "value": "\u2026", "source": "\u2026" },
  "group_label": { "value": "\u2026", "source": "\u2026" },
  "model_designation": { "value": "\u2026", "source": "\u2026" },
  "description": { "value": "\u2026", "source": "\u2026" },
  "scheme": { "value": "A", "source": "\u2026" },
  "samples": [ { "serial": "\u2026", "condition": "\u2026", "source": "\u2026" } ]
}`;
async function extractDraftFields(ai, model, userTurns) {
  const transcript = userTurns.map((t, i) => `${i + 1}. ${t}`).join("\n").slice(0, 12e3);
  try {
    const res = await ai.run(model, {
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM },
        { role: "user", content: `The user's messages, oldest first:
${transcript}` }
      ],
      max_tokens: 1200,
      reasoning_effort: "low",
      temperature: 0.1
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
var norm = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, " ").replace(/\s+/g, " ").trim();
var docNorm = (s) => norm(s).replace(/\s+/g, "");
var DROP_REASON = "not stated in your own words";
function traceabilityGuard(extraction, userTurns) {
  const haystack = norm(userTurns.join("\n"));
  const docHaystack = docNorm(userTurns.join(" "));
  const kept = {};
  const dropped = [];
  const traced = (value, source) => {
    if (typeof value !== "string" || !value.trim()) return null;
    if (typeof source !== "string" || !source.trim()) return null;
    const v = norm(value);
    const s = norm(source);
    if (!v || !s) return null;
    return s.includes(v) && haystack.includes(s) ? value.trim() : null;
  };
  const scalar = (field) => {
    const entry = extraction[field];
    const ok = entry ? traced(entry.value, entry.source) : null;
    if (ok) kept[field] = ok.slice(0, 300);
    else if (entry && typeof entry.value === "string" && entry.value.trim()) {
      dropped.push({ field, value: entry.value.trim().slice(0, 120), reason: DROP_REASON });
    }
  };
  scalar("family_designation");
  scalar("group_label");
  scalar("model_designation");
  scalar("description");
  const scheme = extraction.scheme;
  const schemeOk = scheme ? traced(scheme.value, scheme.source) : null;
  if (schemeOk && /^[ab]$/i.test(schemeOk.trim())) kept.scheme = schemeOk.trim().toUpperCase();
  else if (scheme && typeof scheme.value === "string" && scheme.value.trim()) {
    dropped.push({ field: "scheme", value: scheme.value.trim().slice(0, 20), reason: DROP_REASON });
  }
  const samples = [];
  (Array.isArray(extraction.samples) ? extraction.samples : []).forEach((s, i) => {
    const ok = s ? traced(s.serial, s.source) : null;
    if (ok) {
      const sample = { serial: ok.slice(0, 80) };
      if (typeof s?.condition === "string" && s.condition.trim()) sample.condition = s.condition.trim().slice(0, 20).toUpperCase();
      samples.push(sample);
    } else if (s && typeof s.serial === "string" && s.serial.trim()) {
      dropped.push({ field: `samples[${i}].serial`, value: s.serial.trim().slice(0, 80), reason: DROP_REASON });
    }
  });
  if (samples.length) kept.samples = samples;
  if (typeof extraction.standard === "string" && extraction.standard.trim()) {
    if (docHaystack.includes(docNorm(extraction.standard))) kept.standard = extraction.standard.trim().slice(0, 80);
    else dropped.push({ field: "standard", value: extraction.standard.trim().slice(0, 80), reason: DROP_REASON });
  }
  return { kept, dropped };
}
async function resolveStandard(env, named) {
  const m = named.match(/^urn:oiml:pub:([rdbge]):(\d{1,3})(?:-[0-9A-Za-z]+)?(?::(\d{4}))?$/i) ?? named.match(/^(?:OIML\s+)?([RDBGE])\s*(\d{1,3})(?:-[0-9A-Za-z]+)?(?:\s*:\s*(\d{4}))?$/i);
  if (!m) return null;
  const type = m[1].toUpperCase();
  const num2 = String(Number(m[2]));
  try {
    const row = await env.DB.prepare(
      "SELECT docidentifier, edition, status, derived_status FROM documents WHERE family = ?1 AND active = 1 ORDER BY (part IS NULL) DESC, edition DESC LIMIT 1"
    ).bind(`${type}-${num2}`).first();
    if (!row) return null;
    const edition = typeof row.edition === "string" ? row.edition : void 0;
    return {
      urn: `urn:oiml:pub:${type.toLowerCase()}:${num2}${edition ? `:${edition}` : ""}`,
      label: typeof row.docidentifier === "string" ? row.docidentifier : `OIML ${type} ${num2}`,
      ...edition ? { edition } : {},
      status: typeof row.derived_status === "string" ? row.derived_status : typeof row.status === "string" ? row.status : void 0
    };
  } catch {
    return null;
  }
}
var FIELD_LABELS = [
  ["family_designation", "the instrument family"],
  ["group_label", "the instrument group"],
  ["model_designation", "the model designation"],
  ["description", "the description"]
];
function refusal(reason, answer) {
  return { status: "refused", reason, answer, citation: null };
}
async function prepareDraft(env, opts) {
  if (!opts.member || opts.delegation.status === "unsigned") {
    return refusal(
      "sign_in_required",
      "Preparing an act starts from your own account \u2014 sign in with your OIML SMART account and ask again. The draft would still be yours alone: it opens in the real form and only your own click commits it \u2014 I never hold a write credential."
    );
  }
  if (opts.delegation.status === "not_configured") {
    return refusal(
      "not_configured",
      "This deployment has not wired the live account link, so I cannot prepare acts here. I can still explain what the application asks for \u2014 just ask."
    );
  }
  if (opts.delegation.status === "window_expired") {
    return refusal(
      "window_expired",
      "Your live access window has lapsed \u2014 sign in again to refresh it, and I will prepare the draft. It stays a draft either way: only your own click in the real form commits it."
    );
  }
  if (opts.delegation.status !== "ok") {
    return refusal(
      "exchange_refused",
      "The live role check was refused, so I cannot prepare the draft honestly \u2014 the act needs your account's standing. Sign in afresh and ask again."
    );
  }
  const roles = opts.platformClientId ? decodeServiceRoles(opts.delegation.token, opts.platformClientId) : [];
  if (!roles.includes("applicant")) {
    const primary = roles[0] ?? "unknown";
    return refusal(
      "role_refused",
      `Your account's platform role \u2014 ${roleLabel(primary)} \u2014 can't prepare a new certification application: that act belongs to the applicant (the manufacturer's own account). Nothing was drafted. I can still walk you through what the application asks for \u2014 just ask.`
    );
  }
  const userTurns = [
    ...opts.history.filter((h) => h.role === "user").map((h) => h.content),
    opts.query
  ];
  const extraction = await extractDraftFields(env.AI, opts.model, userTurns);
  if (!extraction) {
    return refusal(
      "extraction_failed",
      "I could not read your requirements reliably just now \u2014 nothing was drafted. Ask again in a moment, or start the application directly in the portal: every field there is yours either way."
    );
  }
  const { kept, dropped } = traceabilityGuard(extraction, userTurns);
  if (!kept.standard) {
    const untraced = dropped.find((d) => d.field === "standard");
    return refusal(
      "standard_unresolved",
      untraced ? `I can't anchor the draft: you haven't named the Recommendation in your own words (the ${untraced.value} reading isn't yours). Name it plainly \u2014 for example OIML R 60 \u2014 and I'll prepare the draft.` : "I can't anchor the draft: you haven't named the Recommendation. Name it plainly \u2014 for example OIML R 60 \u2014 and I'll prepare it."
    );
  }
  const standard = await resolveStandard(env, kept.standard);
  if (!standard) {
    return refusal(
      "standard_unresolved",
      `I couldn't resolve ${kept.standard} as a publication in the corpus, so I can't anchor the draft. Name the Recommendation plainly \u2014 for example OIML R 60 \u2014 and I'll prepare it.`
    );
  }
  const fields = {
    standard_doc: standard.urn,
    standard_label: standard.label,
    ...kept.family_designation ? { family_designation: kept.family_designation } : {},
    ...kept.group_label ? { group_label: kept.group_label } : {},
    ...kept.model_designation ? { model_designation: kept.model_designation } : {},
    ...kept.description ? { description: kept.description } : {},
    ...kept.samples?.length ? { samples: kept.samples } : {},
    ...kept.scheme ? { scheme: kept.scheme } : {}
  };
  const carries = [`the Recommendation: ${standard.label}`];
  for (const [key, label] of FIELD_LABELS) {
    const v = kept[key];
    if (typeof v === "string") carries.push(`${label}: ${v}`);
  }
  if (kept.scheme) carries.push(`scheme ${kept.scheme}`);
  if (kept.samples?.length) carries.push(`${kept.samples.length} sample${kept.samples.length === 1 ? "" : "s"}: ${kept.samples.map((s) => s.serial).join(", ")}`);
  const notes = [
    `The technical parameters (capacities, dimensions, classes) stay with you: the form derives what ${standard.label}'s model declares, and you confirm each value.`,
    "Every field in the real form stays editable \u2014 the draft is a starting point, never a decision."
  ];
  const draft = {
    kind: "draft",
    act: "application_prefill",
    version: 1,
    title: `New ${standard.label} application`,
    prepared_at: (/* @__PURE__ */ new Date()).toISOString(),
    requires_confirmation: true,
    fields,
    ...dropped.length ? { dropped } : {},
    notes
  };
  const answer = `I've prepared a draft for a new ${standard.label} application from your own words.

What the draft carries:
${carries.map((c) => `- ${c}`).join("\n")}
` + (dropped.length ? `
I left ${dropped.length === 1 ? "this" : "these"} out because you never stated ${dropped.length === 1 ? "it" : "them"} in your own words: ${dropped.map((d) => `${d.field.replace(/\[(\d+)\]/, " $1")} ("${d.value}")`).join("; ")}. Say them plainly and I'll add them.
` : "") + `
${notes[0]}

The draft opens in the real application form with every field editable \u2014 review it carefully. Nothing is submitted until you confirm it there yourself: I never hold a write credential; your own click is the only commit.`;
  return {
    status: "draft",
    draft,
    answer,
    citation: { docidentifier: standard.label, ...standard.edition ? { edition: standard.edition } : {}, ...standard.status ? { status: standard.status } : {} }
  };
}

// workers/worker_public/src/memories.ts
var MAX_FILES = 10;
var MAX_CONTENT = 8e3;
var MAX_NAME = 64;
var ID_RE = /^m:[a-f0-9]{16}$/;
var newId = () => "m:" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function handleMemories(env, sub, req, route) {
  const { method, id } = route;
  if (method === "GET") {
    const rows = (await env.DB.prepare("SELECT id, name, content, enabled, updated_at FROM memories WHERE sub = ?1 ORDER BY updated_at DESC").bind(sub).all()).results ?? [];
    return json({ memories: rows });
  }
  if (method === "DELETE") {
    if (!id || !ID_RE.test(id)) return err(400, "invalid_input", "bad memory id");
    await env.DB.prepare("DELETE FROM memories WHERE id = ?1 AND sub = ?2").bind(id, sub).run();
    return json({ ok: true });
  }
  if (method === "POST") {
    const body = await req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
    const content = typeof body?.content === "string" ? body.content.slice(0, MAX_CONTENT) : "";
    if (!name || !content.trim()) return err(400, "invalid_input", "name and content are required");
    const now = Date.now();
    if (typeof body?.id === "string" && ID_RE.test(body.id)) {
      const r = await env.DB.prepare(
        "UPDATE memories SET name = ?1, content = ?2, updated_at = ?3 WHERE id = ?4 AND sub = ?5"
      ).bind(name, content, now, body.id, sub).run();
      if (!r.meta?.changes) return err(404, "not_found", "no such memory");
      return json({ ok: true, id: body.id });
    }
    const count = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE sub = ?1").bind(sub).first())?.n ?? 0);
    if (count >= MAX_FILES) return err(400, "quota_exceeded", `at most ${MAX_FILES} memory files`);
    const mid = newId();
    await env.DB.prepare(
      "INSERT INTO memories (id, sub, name, content, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)"
    ).bind(mid, sub, name, content, now).run();
    return json({ ok: true, id: mid });
  }
  return err(405, "method_not_allowed", "GET, POST or DELETE");
}
async function memoryNote(env, sub, ids) {
  const wanted = [...new Set(ids.filter((x) => typeof x === "string" && (ID_RE.test(x) || /^pf:[a-f0-9]{16}$/.test(x))))].slice(0, 4);
  if (!wanted.length) return [null, []];
  const ph = wanted.map((_, i) => `?${i + 2}`).join(",");
  const rows = [
    ...(await env.DB.prepare(`SELECT id, name, content FROM memories WHERE sub = ?1 AND id IN (${ph})`).bind(sub, ...wanted).all()).results ?? [],
    ...(await env.DB.prepare(
      `SELECT f.id, f.name, f.content FROM project_files f JOIN projects p ON p.id = f.project_id WHERE p.sub = ?1 AND f.id IN (${ph})`
    ).bind(sub, ...wanted).all()).results ?? []
  ];
  if (!rows.length) return [null, []];
  let budget = 4e3;
  const parts = [];
  const used = [];
  for (const r of rows) {
    if (budget <= 200) break;
    const body = String(r.content).slice(0, budget);
    budget -= body.length;
    parts.push(`### ${r.name}
${body}`);
    used.push(String(r.id));
  }
  return [
    "The user's own memory files \u2014 their stated context. Treat as trusted user facts (their lab, instruments, preferences); blend with the passages, never contradict them silently:\n" + parts.join("\n\n"),
    used
  ];
}

// workers/worker_public/src/answercache.ts
var CORPUS_GEN_KEY = "sys:corpus_gen";
async function corpusGen(cache) {
  try {
    return await cache.get(CORPUS_GEN_KEY) ?? "0";
  } catch {
    return "0";
  }
}
function freshRequested(body) {
  const f = body?.fresh;
  return f === true || f === "true" || f === 1 || f === "1";
}
function cacheKeyMaterial(query, lang, salt) {
  return `${query.toLowerCase().replace(/\s+/g, " ").trim()}|${lang ?? ""}${salt ? "|" + salt : ""}`;
}
function exactCacheKey(indexVersion, gen, ns, queryHash) {
  return `a:${indexVersion}:g${gen}:${ns}:${queryHash}`;
}
function semanticCacheKey(indexVersion, gen, signature) {
  return `sc:${indexVersion}:g${gen}:${signature}`;
}

// workers/worker_public/src/ask.ts
function userImageDataUrl(body) {
  const img = body?.image;
  if (img == null) return null;
  if (typeof img !== "string" || img.length > 6e6) return null;
  const m = img.match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !m[2]) return null;
  return img;
}
async function cacheGet(env, gen, ns, query, lang, salt) {
  const key = exactCacheKey(env.INDEX_VERSION, gen, ns, await sha256Hex(cacheKeyMaterial(query, lang, salt)));
  const hit = await env.CACHE.get(key, "json");
  return hit ? { key, value: hit } : null;
}
function embedWarm(env, text) {
  return embed(portModelRunner(env), MODELS.embed, text).catch(() => null);
}
async function attachFigureImages(env, messages, usedHits, query) {
  const figIntent = /\b(fig(ure)?s?|diagram|drawing|graph|chart)\b/i.test(query);
  const topProseAnchor = usedHits.find((h) => !h.metadata.unit_id)?.metadata.clause_anchor;
  const figures = usedHits.filter((h) => h.metadata.unit_id && h.metadata.block === "figure").filter((h) => figIntent || !!h.metadata.clause_anchor && h.metadata.clause_anchor === topProseAnchor).slice(0, 1);
  if (!figures.length) return;
  const fig = figures[0];
  const figAnchor = fig.metadata.clause_anchor ?? "";
  const figTitle = fig.metadata.clause_title ?? "";
  const referencing = usedHits.filter((h) => !h.metadata.unit_id && h.metadata.docidentifier === fig.metadata.docidentifier && /\bfig(ure)?s?\.?\s*\d/i.test(h.text ?? "")).slice(0, 2).map((h) => `clause ${h.metadata.clause_anchor ?? ""}${h.metadata.clause_title ? ` (${h.metadata.clause_title})` : ""}: ${(h.text ?? "").slice(0, 400)}`);
  const parts = [];
  const names = [];
  let figCaption = "";
  for (const h of figures) {
    try {
      const row = await env.DB.prepare("SELECT payload FROM unit_payloads WHERE unit_id = ?1").bind(h.metadata.unit_id).first();
      const payload = row ? JSON.parse(String(row.payload)) : {};
      const uri = typeof payload.uri === "string" ? payload.uri : "";
      if (typeof payload.caption === "string" && payload.caption.trim()) figCaption = payload.caption.trim();
      const m = typeof uri === "string" ? uri.match(/^\/assets\/(.+)/) : null;
      if (!m) continue;
      const obj = await env.UNIT_ASSETS.get(m[1]);
      if (!obj) continue;
      const buf = new Uint8Array(await obj.arrayBuffer());
      const ext = m[1].split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
      let binary = "";
      for (let i = 0; i < buf.length; i += 8192) binary += String.fromCharCode(...buf.subarray(i, i + 8192));
      parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${btoa(binary)}` } });
      names.push(h.metadata.unit_id);
    } catch {
    }
  }
  if (!parts.length) return;
  const context = [];
  if (figCaption) context.push(`Its caption reads: "${figCaption}".`);
  if (figAnchor) context.push(`It belongs to clause ${figAnchor}${figTitle ? ` (${figTitle})` : ""} of its publication.`);
  if (referencing.length) context.push(`The publication's prose references it from \u2014 ${referencing.join(" \u2014 and from \u2014 ")}.`);
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: `The original image of figure unit ${names.join(", ")} is attached; interpret the drawing directly when answering about this figure.` + (context.length ? ` To understand what the figure is doing: ${context.join(" ")}` : "")
      },
      ...parts
    ]
  });
  console.log("figure images attached:", names.join(", "));
}
async function generateStream(env, model, messages, effort) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await env.AI.run(model, {
        messages,
        stream: true,
        max_tokens: effortBudget(effort ?? answerEffort(env)),
        reasoning_effort: effort ?? answerEffort(env),
        temperature: 0.6,
        top_p: 0.95
      });
      if (res && typeof res.getReader === "function") return res;
      if (res && res.body && typeof res.body.getReader === "function") return res.body;
    } catch (e) {
      console.error("stream failed:", model, String(e).slice(0, 120));
    }
  }
  return null;
}
async function summarizeHistory(env, model, turns) {
  try {
    const convo = turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 1200)}`).join("\n").slice(0, 24e3);
    const res = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content: summarize_default.trimEnd()
        },
        { role: "user", content: convo }
      ],
      max_tokens: 2048,
      reasoning_effort: "low",
      // Qwen3 thinking-mode sampling (model card) — prevents the
      // repetition loops that eat the budget before the summary lands
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20
    });
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 1200) : null;
  } catch {
    return null;
  }
}
async function* sseTokens(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        const tok = typeof evt?.response === "string" ? evt.response : evt?.choices?.[0]?.delta?.content;
        if (tok) yield tok;
      } catch {
      }
    }
  }
}
async function handleAsk(env, ctx, req, tier, key) {
  const tStart = Date.now();
  const telemetryMeta = () => ({ durationMs: Date.now() - tStart, keyId: key?.id ?? null });
  const stageTiming = {};
  let generateRetries = 0;
  const readAs = () => understanding ? {
    intent: understanding.intent,
    doc: understanding.docidentifier,
    edition: understanding.edition ?? null,
    term: understanding.term,
    terms: (understanding.defined_terms ?? []).slice(0, 4),
    lang: q?.lang ?? null
  } : void 0;
  const serverTiming = () => Object.entries(stageTiming).map(([k, v]) => `${k};dur=${v}`).concat([`generate-retries;desc=count;dur=${generateRetries ?? 0}`, `total;dur=${Date.now() - tStart}`]).join(", ");
  const body = await readJson(req);
  const q = validateQuery(body);
  if (!q) return err(400, "invalid_input", `query is required (1-${LIMITS.maxInputChars} chars)`);
  const declaredCtx = parseContext(body);
  const draftAct = P().publisher.features?.drafts ? detectDraftIntent(q.query) : null;
  const member = tier === "member" ? await sessionFrom(req, env) : null;
  const effort = requestEffort(env, member, body?.effort);
  const limit = tier === "key" ? key.day_limit : tier === "member" || member ? num(env, "MEMBER_DAY_ASK", 300) : num(env, "ANON_DAY_ASK", 20);
  const bucketId = tier === "key" ? `key:${key.id}` : member ? `sub:${member.sub}` : clientIp(req);
  const quota = await checkQuota(env, "ask", bucketId, limit, effort === "low" ? 1 : 2);
  if (!quota.ok) {
    return err(429, "quota_exceeded", `Daily question limit reached (${quota.limit}). Try again tomorrow.`);
  }
  const hardCap = num(env, "ANON_DAY_HARD_CAP", 5e3);
  if (tier === "anon" && quota.used > hardCap) {
    return err(503, "generation_disabled", "Generation is temporarily paused; search remains available.");
  }
  if (await env.CACHE.get("sys:generation") === "off") {
    return err(503, "generation_disabled", "Generation is temporarily paused; search remains available.");
  }
  const service = env.INTERNAL_SERVICE;
  const fedAuth = {
    cookie: req.headers.get("cookie") ?? "",
    authorization: req.headers.get("authorization") ?? ""
  };
  const scope = resolveRequestScope(body, member);
  if ("error" in scope) return err(400, "invalid_input", "datasets: at least one dataset must stay enabled");
  const { corpora, narrowed, isoOn } = scope;
  const [memNote, memoryUsed] = member && scope.memoryIds.length ? await memoryNote(env, member.sub, scope.memoryIds) : [null, []];
  const requestSaltStr = requestSalt(scope, memoryUsed);
  const salt = requestSaltStr ? `${requestSaltStr}|effort:${effort}` : `effort:${effort}`;
  const federate = member && service && isoOn ? (q2) => retrieveInternal(service, fedAuth, q2) : void 0;
  const ns = tier === "key" ? `k:${key.id}` : member ? `m:${member.sub}` : "anon";
  const model = member ? MODELS.member : MODELS.anon;
  const prev = typeof body?.prev === "string" ? body.prev.slice(0, 800) : void 0;
  const rawHistory = Array.isArray(body?.history) ? body.history : [];
  const history = rawHistory.filter((h) => (h?.role === "user" || h?.role === "assistant") && typeof h?.content === "string" && h.content.trim()).slice(-24).map((h) => ({ role: h.role, content: h.content.slice(0, 4e3) }));
  const contextual = history.length > 0;
  const userImage = body?.image != null ? userImageDataUrl(body) : null;
  if (body?.image != null && !userImage) {
    return err(400, "invalid_image", "image must be a data URL (data:image/png|jpeg|webp|gif;base64,\u2026) up to 6 MB");
  }
  const budget = num(env, "INPUT_TOKEN_BUDGET", LIMITS.inputTokenBudget);
  const { kept: keptHistory, overflow } = splitHistory(history, budget);
  const summary = overflow.length >= 2 ? await summarizeHistory(env, MODELS.understand, overflow) ?? void 0 : void 0;
  let retrieved;
  const fresh = freshRequested(body);
  const gen = await corpusGen(env.CACHE);
  const cached = fresh || contextual || declaredCtx || draftAct || userImage ? null : await cacheGet(env, gen, ns, q.query, q.lang, salt);
  const wantsStream = body?.stream === true || tier === "anon" && body?.stream !== false;
  if (cached) {
    telemetry(env, ctx, tier, "ask", null, true, (cached.value.answer ?? "").length, cached.value.query_hash, q.lang, "exact", telemetryMeta());
    const cctx = cached.value.context_applied ?? NO_CONTEXT;
    if (wantsStream) {
      return sseResponse([{ type: "citations", citations: cached.value.citations ?? [], quota, context_applied: cctx }, { type: "token", v: cached.value.answer ?? "" }, { type: "done", model: cached.value.model ?? MODELS.member, query_hash: cached.value.query_hash, served_from: "cache", context_applied: cctx }], corsHeaders(req));
    }
    return json({ ...cached.value, cached: true, quota, context_applied: cctx });
  }
  const warmQuery = retrievalQuery(q.query, prev);
  const warmEmbed = embedWarm(env, warmQuery);
  const conversationId = typeof body?.conversation_id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.conversation_id) ? body.conversation_id : null;
  let convEntities = [];
  if (conversationId) {
    try {
      const rows = await env.DB.prepare("SELECT entity, kind FROM conversation_entities WHERE conversation_id = ?1 LIMIT 12").bind(conversationId).all();
      convEntities = rows.results ?? [];
      if (convEntities.length) console.log("entity map:", convEntities.length, "entries");
    } catch {
    }
  }
  let understanding = null;
  const nodeScoped = !!modelNodeRefIn(q.query) || !!modelNodeRefIn(declaredCtx?.label);
  if (!cached && !nodeScoped && !contextual && !declaredCtx && !draftAct && !q.lang && !userImage && !fresh) {
    const wv0 = await warmEmbed ?? null;
    if (wv0) {
      const sc0 = await semanticCacheGet(env, gen, wv0, salt);
      if (sc0) {
        console.log("semantic cache hit (pre-understanding)");
        telemetry(env, ctx, tier, "ask", null, true, sc0.answer.length, sc0.query_hash, q.lang, "semantic", telemetryMeta());
        const cctx0 = sc0.context_applied ?? NO_CONTEXT;
        if (wantsStream) {
          return sseResponse([{ type: "citations", citations: sc0.citations ?? [], context_applied: cctx0 }, { type: "token", v: sc0.answer }, { type: "done", model: sc0.model, query_hash: sc0.query_hash, similar: true, served_from: "similar", context_applied: cctx0 }], corsHeaders(req));
        }
        return json({ ...sc0, similar: true, context_applied: cctx0, quota });
      }
    }
  }
  let optimisticVec = null;
  let optimisticHits = [];
  const t0 = Date.now();
  if (!cached) {
    const understandingP = understandQuery(portModelRunner(env), roleModel(env, "understand"), q.query, history, convEntities);
    try {
      optimisticVec = await warmEmbed ?? null;
      if (optimisticVec) {
        const ores = await env.VECTORIZE.query(optimisticVec, { topK: LIMITS.retrieveK, returnMetadata: "all" });
        optimisticHits = (ores.matches ?? []).map((m) => ({
          id: m.id,
          score: m.score,
          metadata: m.metadata,
          text: m.metadata?.chunk_text ?? ""
        }));
      }
    } catch {
    }
    understanding = await understandingP;
    stageTiming.understand = Date.now() - t0;
    console.log("stage: understand+optimistic", Date.now() - t0, "ms");
  }
  const docScope = declaredCtx && declaredCtx.kind !== "account" ? await resolveDocScope(env, declaredCtx) : null;
  const named = declaredCtx && declaredCtx.kind !== "account" ? namedDocumentIn(q.query) : null;
  let ctxApplied;
  let declaredScoped = false;
  if (!declaredCtx) {
    ctxApplied = NO_CONTEXT;
    const bare = understanding?.process_intent ? null : namedDocumentIn(q.query);
    if (bare && understanding?.doc_number !== bare.doc_number) {
      understanding = {
        ...understanding ?? syntheticUnderstanding(bare),
        docidentifier: bare.label,
        doc_number: bare.doc_number,
        edition: bare.edition ?? understanding?.edition ?? null
      };
      console.log("question names", bare.label, "\u2014 scoping retrieval from the text");
    }
  } else if (declaredCtx.kind === "account") {
    ctxApplied = appliedContext(declaredCtx, null);
  } else if (docScope && (!named || named.doc_number === docScope.doc_number)) {
    if (understanding?.doc_number && understanding.doc_number !== docScope.doc_number) {
      console.log("context scope: understand's doc#" + understanding.doc_number, "is inferred, not named in the question \u2014 the declared", docScope.label, "scopes");
    }
    understanding = {
      ...understanding ?? syntheticUnderstanding(docScope),
      docidentifier: docScope.label,
      doc_number: docScope.doc_number,
      edition: docScope.edition ?? understanding?.edition ?? null
    };
    ctxApplied = appliedContext(declaredCtx, docScope);
    declaredScoped = true;
    console.log("context scope:", docScope.label, `(${declaredCtx.kind})`);
  } else if (docScope && named) {
    if (understanding?.doc_number !== named.doc_number) {
      understanding = {
        ...understanding ?? syntheticUnderstanding(named),
        docidentifier: named.label,
        doc_number: named.doc_number,
        edition: named.edition ?? null
      };
    }
    ctxApplied = appliedContext(declaredCtx, null, "question-document-wins");
    console.log("context scope: the question names", named.label, "\u2014 it wins over the declared", docScope.label);
  } else if (declaredCtx.doc) {
    ctxApplied = appliedContext(declaredCtx, null, "document-not-in-corpus");
    console.log("context scope:", declaredCtx.doc, "not in the corpus \u2014 the general corpus answers");
  } else {
    ctxApplied = appliedContext(declaredCtx, null);
  }
  if (conversationId && understanding) {
    const now = Date.now();
    const ents = [];
    if (understanding.docidentifier) ents.push([understanding.docidentifier, "document"]);
    for (const t of understanding.defined_terms) ents.push([t, "term"]);
    if (ents.length) {
      const upsert = (e, k) => env.DB.prepare("INSERT OR REPLACE INTO conversation_entities (conversation_id, entity, kind, ts) VALUES (?1, ?2, ?3, ?4)").bind(conversationId, e, k, now).run();
      ctx.waitUntil(Promise.allSettled(ents.map(([e, k]) => upsert(e, k))));
    }
  }
  console.log("understand:", understanding?.intent ?? "null", understanding?.doc_number ? `doc#${understanding.doc_number}${understanding.edition ? "@" + understanding.edition : ""}` : "nodoc", "|", q.query.slice(0, 50));
  const graphDocNumbers = await graphExpand(env, understanding);
  const eNote = await editionNote(env, understanding);
  if (understanding?.intent !== "conversational" && !nodeScoped && !contextual && !declaredCtx && !draftAct && !userImage && !fresh) {
    const warmVec = await warmEmbed ?? null;
    if (warmVec) {
      const sc = await semanticCacheGet(env, gen, warmVec, salt);
      if (sc) {
        console.log("semantic cache hit");
        telemetry(env, ctx, tier, "ask", null, true, sc.answer.length, sc.query_hash, q.lang, "semantic", telemetryMeta());
        const cctx = sc.context_applied ?? NO_CONTEXT;
        if (wantsStream) {
          return sseResponse([{ type: "citations", citations: sc.citations ?? [], context_applied: cctx }, { type: "token", v: sc.answer }, { type: "done", model: sc.model, query_hash: sc.query_hash, similar: true, served_from: "similar", context_applied: cctx }], corsHeaders(req));
        }
        return json({ ...sc, similar: true, context_applied: cctx, quota });
      }
    }
  }
  if (understanding?.intent === "conversational") {
    const queryHash2 = await sha256Hex(q.query);
    const messages2 = [
      { role: "system", content: identityNote(!!member) },
      ...summary ? [{ role: "system", content: `Earlier in this conversation (summarized for continuity):
${summary}` }] : [],
      ...keptHistory.slice(-6),
      { role: "user", content: q.query }
    ];
    if (wantsStream) {
      const stream = await generateStream(env, model, messages2, effort);
      if (stream) {
        const encoder = new TextEncoder();
        const sse = new ReadableStream({
          async start(controller) {
            const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}

`));
            send({ type: "citations", citations: [], context_applied: NO_CONTEXT, quota });
            let full = "";
            try {
              for await (const tok of sseTokens(stream)) {
                full += tok;
                send({ type: "token", v: tok });
              }
            } catch {
            }
            send({ type: "done", model, query_hash: queryHash2, context_applied: NO_CONTEXT });
            telemetry(env, ctx, tier, "ask", model, true, full.length, queryHash2, q.lang, void 0, telemetryMeta());
            controller.close();
          }
        });
        return new Response(sse, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...corsHeaders(req) }
        });
      }
    }
    let answer2 = await generateOnce(env, model, messages2, effort);
    if (answer2 === null) answer2 = await generateOnce(env, MODELS.fallback, messages2, effort);
    if (answer2 === null) {
      telemetry(env, ctx, tier, "ask", model, false, 0, queryHash2, q.lang, void 0, telemetryMeta());
      return err(502, "generation_failed", "The generation model is unavailable; please retry.");
    }
    telemetry(env, ctx, tier, "ask", model, true, answer2.length, queryHash2, q.lang, void 0, telemetryMeta());
    return json({ answer: answer2, citations: [], model, query_hash: queryHash2, follow_ups: [], context_applied: NO_CONTEXT, quota });
  }
  if (draftAct) {
    const draftCtxApplied = declaredCtx ? appliedContext(declaredCtx, null) : NO_CONTEXT;
    const queryHash2 = await sha256Hex(q.query);
    const liveCfg = liveDataConfig(env);
    const sessionRaw = rawSessionToken(req);
    let delegation;
    if (!member || !sessionRaw) delegation = { status: "unsigned" };
    else if (!liveCfg) delegation = { status: "not_configured" };
    else {
      const exchanged = await exchangeForLiveToken(env, sessionRaw);
      delegation = exchanged.ok ? { status: "ok", token: exchanged.token } : { status: exchanged.reason };
    }
    const verdict = await prepareDraft(env, {
      act: draftAct,
      query: q.query,
      history: keptHistory,
      member,
      delegation,
      platformClientId: liveCfg?.platformClientId,
      model: roleModel(env, "understand")
    });
    console.log("draft act:", draftAct, "\u2192", verdict.status === "draft" ? `draft (${Object.keys(verdict.draft.fields).length} fields)` : `refused (${verdict.reason})`);
    const citations2 = verdict.citation ? [{ ...verdict.citation, corpus: P().publisher.id }] : [];
    const draftPayload = verdict.status === "draft" ? verdict.draft : void 0;
    telemetry(env, ctx, tier, "ask", model, true, verdict.answer.length, queryHash2, q.lang, void 0, telemetryMeta());
    if (wantsStream) {
      return sseResponse(
        [
          { type: "citations", citations: citations2, context_applied: draftCtxApplied, ...draftPayload ? { draft: draftPayload } : {}, quota },
          { type: "token", v: verdict.answer },
          { type: "done", model, query_hash: queryHash2, context_applied: draftCtxApplied }
        ],
        corsHeaders(req)
      );
    }
    return json({ answer: verdict.answer, citations: citations2, model, query_hash: queryHash2, follow_ups: [], context_applied: draftCtxApplied, ...draftPayload ? { draft: draftPayload } : {}, quota });
  }
  let liveRecords;
  let accountNote;
  const modelDocHint = named ?? docScope ?? namedDocumentIn(q.query);
  const boundModel = P().publisher.features?.model_plane ? await bindModelNode(env, {
    label: declaredCtx?.label,
    query: q.query,
    standard: standardForDocNumber(modelDocHint?.doc_number)
  }) : null;
  if (boundModel) {
    ctxApplied = { ...ctxApplied, model: modelEcho(boundModel) };
    console.log("model plane: bound", boundModel.node_id, `[${boundModel.standard}]`, boundModel.clause?.urn ?? "no-clause");
  }
  const modelNote = boundModel ? modelGroundingBlock(boundModel) : void 0;
  const machineVerdict = boundModel ? evaluate(boundModel.content, q.query) : null;
  const machineNote = machineVerdict && boundModel ? verdictNote(machineVerdict, boundModel) : void 0;
  const verdictBlock = machineVerdict ? {
    unit_id: boundModel.node_id,
    type: "verdict",
    docidentifier: `${P().publisher.name} SMART model (${boundModel.standard})`,
    payload: {
      verdict: machineVerdict.verdict,
      on_violation: machineVerdict.on_violation,
      violation_meaning: machineVerdict.violation_meaning,
      missing: machineVerdict.missing,
      checks: machineVerdict.checks
    }
  } : null;
  if (machineVerdict) console.log("verdict engine:", boundModel.node_id, "\u2192", machineVerdict.verdict.toUpperCase(), machineVerdict.missing.length ? `(missing ${machineVerdict.missing.join(",")})` : "");
  try {
    const tR = Date.now();
    if (declaredCtx?.kind === "account") {
      const live = await resolveLiveAccount(env, rawSessionToken(req), member);
      if (live.status === "ok") {
        liveRecords = live.records;
        ctxApplied = appliedContext(declaredCtx, null, void 0, {
          read_at: live.readAt,
          stores: live.stores,
          records: live.records.length
        });
        const lines = live.records.map(
          (r) => `- ${r.label} [${[r.status, r.detail].filter(Boolean).join("; ")}] ${r.url}`
        );
        accountNote = `Live account data (read ${live.readAt} from ${P().prompts.vars.account_note_source ?? `the user's own ${P().publisher.product_name} account`} \u2014 exactly what they may see, never more):
` + (lines.length ? lines.join("\n") : "(the account surfaces answered empty)") + `
Answer account questions from these records ONLY: name the record when you use it, never invent one, and say honestly when they do not hold the answer. The corpus passages still ground the regulatory claims (the requirements, the procedures); the records are the user's own work.`;
        console.log("live data:", live.records.length, "records from", live.stores.join("+") || "none");
      } else {
        const note = live.reason === "sign_in_required" ? "sign-in-required" : live.reason === "window_expired" ? "live-window-expired" : "live-unavailable";
        ctxApplied = appliedContext(declaredCtx, null, note);
        accountNote = live.reason === "sign_in_required" ? "Context note: the user asked with the 'my account' context but is not signed in \u2014 the account data was NOT read; answer from the corpus and say so." : live.reason === "window_expired" ? "Context note: the user's live access window lapsed \u2014 the account data was NOT read; answer from the corpus, say the live read did not happen, and suggest signing in again to refresh it." : "Context note: the live account read was refused or unreachable \u2014 the account data was NOT read; answer from the corpus and say so honestly.";
        console.log("live data: not read \u2014", live.reason);
      }
    }
    retrieved = await retrieve(env, q.query, {
      prev,
      understanding,
      federate,
      warmEmbed,
      graphDocNumbers,
      sealScope: declaredScoped ? docScope : null,
      optimisticHits,
      optimisticVec,
      datasetScope: narrowed ? corpora : null
    });
    stageTiming["retrieve-core"] = Date.now() - tR;
    console.log("stage: retrieve", Date.now() - tR, "ms");
    const docScoped = !!understanding?.doc_number;
    const gradePromise = docScoped ? Promise.resolve("skipped-doc-scoped") : (() => {
      const tg = Date.now();
      return gradeRetrieval(env.AI, roleModel(env, "grader"), q.query, retrieved.hits.map((h) => h.text)).catch(() => null).finally(() => stageTiming["grade"] = Date.now() - tg);
    })();
    if (retrieved.hits.length >= 4 && (member || understanding?.complexity === "complex")) {
      const tl = Date.now();
      const reordered = await listwiseRerank(env, MODELS.listwise, understanding?.standalone_query || q.query, retrieved.hits);
      stageTiming.listwise = Date.now() - tl;
      if (reordered) {
        console.log("listwise: reordered", reordered[0]?.metadata?.docidentifier ?? "?", "to top");
        retrieved = { ...retrieved, hits: reordered };
      }
    }
    const grade = await gradePromise;
    stageTiming.retrieve = Date.now() - tR;
    console.log("stage: grade+listwise", Date.now() - tR, "ms since retrieve start | grade:", grade);
    if (grade === "weak" && understanding?.docidentifier) {
      const broaden = `${understanding.standalone_query || q.query} ${understanding.docidentifier}`.trim();
      const tc = Date.now();
      const second = await retrieve(env, q.query, { prev, understanding, queryOverride: broaden, federate, datasetScope: narrowed ? corpora : null });
      const grade2 = await gradeRetrieval(env.AI, roleModel(env, "grader"), q.query, second.hits.map((h) => h.text));
      stageTiming.corrective = Date.now() - tc;
      if (grade2 === "good") retrieved = second;
    }
  } catch (e) {
    console.log("ask: retrieval failed:", String(e).slice(0, 300));
    telemetry(env, ctx, tier, "ask", MODELS.embed, false, 0, await sha256Hex(q.query), q.lang, void 0, telemetryMeta());
    return err(503, "retrieval_unavailable", "Search is briefly busy \u2014 please retry in a moment.");
  }
  const { hits } = retrieved;
  if (hits.length === 0 && !liveRecords?.length && !boundModel) {
    const answer2 = refusalAnswer();
    const out2 = { answer: answer2, citations: [], model, query_hash: await sha256Hex(q.query), context_applied: ctxApplied };
    telemetry(env, ctx, tier, "ask", model, true, answer2.length, out2.query_hash, q.lang, void 0, telemetryMeta());
    return json({ ...out2, quota });
  }
  const processNote = understanding?.process_intent ? P().retrieval.process_note : void 0;
  const glossaryForNote = (() => {
    const g = retrieved.glossary ?? [];
    if (!g.length) return g;
    const dt = (understanding?.defined_terms ?? []).map((s) => s.toLowerCase());
    if (!dt.length) return g;
    const matched = g.filter((x) => dt.some((d) => x.term.toLowerCase().includes(d.split(" ")[0]) || d.includes(x.term.toLowerCase().split(" ")[0])));
    return matched.length ? matched : g;
  })();
  const vocabNote = glossaryForNote.length ? "Vocabulary binding \u2014 defined terms in the indexed corpus that may name this question's subject:\n" + glossaryForNote.map((g) => `- ${g.term} (${g.docidentifier}): ${g.definition}`).join("\n") + "\nIf the question describes a symptom or behavior in everyday words, OPEN the answer by naming the matching defined term, quote its definition, and cite its defining publication; keep using that term throughout. Match TIME SCALE carefully: change under a constant load over minutes/hours is creep; change over months/years of use is span stability or durability \u2014 do not call long-term drift creep." : void 0;
  const { messages, usedHits } = buildMessages(
    q.query,
    hits,
    q.lang,
    keptHistory,
    // stage-extracted graph facts (GraphRAG) ride the same note channel
    [processNote, eNote, contextNote(declaredCtx, docScope), accountNote, modelNote, vocabNote, memNote, machineNote, ...retrieved.notes ?? []].filter(Boolean).join("\n") || void 0,
    summary,
    budget
  );
  await attachFigureImages(env, messages, usedHits, q.query);
  if (userImage) {
    const last = messages[messages.length - 1];
    const note = "\n\n(The user attached an image with this question; interpret it directly when answering.)";
    if (Array.isArray(last.content)) {
      const textPart = last.content.find((p) => p.type === "text");
      if (textPart) textPart.text += note;
      last.content = [...last.content, { type: "image_url", image_url: { url: userImage } }];
    } else {
      last.content = [
        { type: "text", text: last.content + note },
        { type: "image_url", image_url: { url: userImage } }
      ];
    }
    console.log("user image attached to generation");
  }
  const queryHash = await sha256Hex(q.query);
  const cites = boundModel ? [modelCitation(boundModel), ...citations(usedHits)] : citations(usedHits);
  if (wantsStream) {
    const stream = await generateStream(env, model, messages, effort);
    if (stream) {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        async start(controller) {
          const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}

`));
          send({ type: "citations", citations: cites, context_applied: ctxApplied, ...liveRecords ? { records: liveRecords } : {}, quota });
          let full = "";
          try {
            for await (const tok of sseTokens(stream)) {
              full += tok;
              send({ type: "token", v: tok });
            }
          } catch {
          }
          const canonical0 = canonicalRefusal(full);
          const c2 = canonical0.includes(refusalAnswer()) ? { text: canonical0, blocks: [], dropped: [] } : await contractV2(env.DB, canonical0, usedHits);
          send({
            type: "done",
            model,
            query_hash: queryHash,
            follow_ups: understanding?.follow_ups ?? [],
            blocks: verdictBlock ? [...c2.blocks, verdictBlock] : c2.blocks,
            context_applied: ctxApplied,
            read: readAs(),
            // the evidence view's ground truth: the exact passages this
            // answer was built from, compact — cache hits carry none,
            // because the cache stores the answer and never the passages
            passages: usedHits.slice(0, 8).map((h) => ({ d: h.metadata.docidentifier ?? "", a: h.metadata.clause_anchor ?? "", t: (h.text ?? "").slice(0, 600), ...h.metadata.table_selection ? { s: h.metadata.table_selection } : {} }))
          });
          telemetry(env, ctx, tier, "ask", model, true, c2.text.length, queryHash, q.lang, void 0, telemetryMeta());
          const canonical = c2.text;
          const streamedAnchors = checkQuoteAnchors(canonical, usedHits.map((h) => h.text));
          const streamedRetyped = tableRetyped(canonical, usedHits.some((h) => h.metadata.unit_id && h.metadata.block === "table"));
          const streamed = { total: streamedAnchors.total, violations: streamedRetyped ? ["table-retyped"] : streamedAnchors.violations };
          if (streamed.violations.length > 0) {
            console.log("anchors:", streamed.violations.length, "of", streamed.total, "unverified \u2014 not caching");
          }
          if (streamed.violations.length === 0 && canonical.length > 0 && !contextual && !declaredCtx && !canonical.includes(refusalAnswer())) {
            const wv = await warmEmbed ?? null;
            if (wv) semanticCachePut(env, ctx, gen, wv, salt, { answer: canonical, citations: cites, model, query_hash: queryHash });
            ctx.waitUntil(
              env.CACHE.put(exactCacheKey(env.INDEX_VERSION, gen, ns, await sha256Hex(cacheKeyMaterial(q.query, q.lang, salt))), JSON.stringify({ answer: canonical, citations: cites, model, query_hash: queryHash }), { expirationTtl: LIMITS.cacheTtlSec })
            );
          }
          controller.close();
        }
      });
      return new Response(sse, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
          ...corsHeaders(req)
        }
      });
    }
  }
  const tGen = Date.now();
  let answer = await generateOnce(env, model, messages, effort);
  if (answer === null) {
    generateRetries += 1;
    const isFigureAttachMessage = (m) => Array.isArray(m.content) && m.content.some((part) => part?.type === "text" && /^The original image of figure unit /.test(part.text ?? ""));
    const flat = messages.filter((m) => !isFigureAttachMessage(m)).map(
      (m) => typeof m.content === "string" ? m : { ...m, content: m.content.filter((p) => p?.type === "text").map((p) => (p?.text ?? "").replace(/\n?\(The user attached an image with this question; interpret it directly when answering\.\)/, "")).join("\n") }
    );
    answer = await generateOnce(env, MODELS.fallback, flat, effort);
  }
  if (answer) answer = canonicalRefusal(answer);
  stageTiming.generate = Date.now() - tGen;
  let used = usedHits;
  if (answer && !answer.includes(refusalAnswer())) {
    const anchors = checkQuoteAnchors(answer, used.map((h) => h.text));
    const hasTableUnit = used.some((h) => h.metadata.unit_id && h.metadata.block === "table");
    const retyped = tableRetyped(answer, hasTableUnit);
    const unreferenced = (() => {
      if (!hasTableUnit || answer.includes("[[u:")) return false;
      const norm2 = (s) => (s.match(/\d[\d ,.]{1,8}\d/g) ?? []).map((x) => x.replace(/[ ,.]/g, ""));
      const nums = norm2(answer);
      if (nums.length < 2) return false;
      const tableNums = new Set(
        norm2(used.filter((h) => h.metadata.unit_id && h.metadata.block === "table").map((h) => h.text).join(" "))
      );
      return nums.filter((n) => tableNums.has(n)).length >= 2;
    })();
    if (anchors.violations.length > 0 || retyped || unreferenced) {
      console.log("contract check:", anchors.violations.length, "anchor violations; tableRetyped:", retyped, "; tableDataUnreferenced:", unreferenced, "\u2014 regenerating");
      const tableUnitId = unreferenced ? used.find((h) => h.metadata.unit_id && h.metadata.block === "table")?.metadata.unit_id : void 0;
      const note = retyped || unreferenced ? `Correction notice: your draft reproduced a table as markdown or presented a served table's data without its reference. Rewrite the answer: describe the table in prose, cite the clause, and write the reference token [[u:${tableUnitId ?? "<unit id>"}]] exactly where the table belongs. Do not render any table as markdown.` : ANCHOR_CORRECTION_NOTE;
      generateRetries += 1;
      const corrected = await generateOnce(env, model, [...messages, { role: "system", content: note }], effort);
      if (corrected) {
        const correctedAnswer = canonicalRefusal(corrected);
        const retryAnchors = checkQuoteAnchors(correctedAnswer, used.map((h) => h.text));
        const retryRetyped = tableRetyped(correctedAnswer, hasTableUnit);
        if (retryAnchors.violations.length < anchors.violations.length || !retryRetyped && retyped || unreferenced && correctedAnswer.includes("[[u:")) {
          answer = correctedAnswer;
        }
      }
    }
  }
  if (answer && !answer.includes(refusalAnswer())) {
    const reflection = await reflect(env.AI, MODELS.grader, q.query, answer, hits.map((h) => h.text));
    console.log("reflection:", reflection ? reflection.grounded ? "grounded" : "ungrounded" : "null");
    if (reflection && !reflection.grounded && reflection.missing_info) {
      const retryRetrieve = await retrieve(env, q.query, {
        prev,
        understanding: { ...understanding, standalone_query: `${understanding?.standalone_query || q.query} ${reflection.missing_info}` },
        sealScope: declaredScoped ? docScope : null,
        datasetScope: narrowed ? corpora : null
      });
      if (retryRetrieve.hits.length > 0) {
        const { messages: retryMessages, usedHits: retryUsed } = buildMessages(q.query, retryRetrieve.hits, q.lang, keptHistory, void 0, summary, budget);
        const retryAnswer = await generateOnce(env, model, retryMessages, effort);
        if (retryAnswer) {
          answer = canonicalRefusal(retryAnswer);
          used = retryUsed;
        }
      }
    }
  }
  if (answer === null) {
    telemetry(env, ctx, tier, "ask", model, false, 0, queryHash, q.lang, void 0, telemetryMeta());
    return err(502, "generation_failed", "The generation model is unavailable; please retry.");
  }
  const finalCites = boundModel ? [modelCitation(boundModel), ...citations(used)] : citations(used);
  const c2ns = answer.includes(refusalAnswer()) ? { text: answer, blocks: [], dropped: [] } : await contractV2(env.DB, answer, used);
  answer = c2ns.text;
  const finalAnchors = answer.includes(refusalAnswer()) ? { total: 0, violations: [] } : checkQuoteAnchors(answer, used.map((h) => h.text));
  if (finalAnchors.violations.length > 0) {
    console.log("anchors:", finalAnchors.violations.length, "of", finalAnchors.total, "unverified \u2014 not caching");
  }
  let completionBlocks = [];
  if (!answer.includes(refusalAnswer()) && !c2ns.blocks.some((b) => b.type === "table")) {
    completionBlocks = await completeTables(env.DB, answer, used);
    if (completionBlocks.length) console.log("contract completion:", completionBlocks.length, "table block(s) attached server-side");
  }
  completionBlocks.push(...await completeFigures(env.DB, answer, [...c2ns.blocks, ...completionBlocks], used));
  const out = { answer, citations: finalCites, model: MODELS.member, query_hash: queryHash, follow_ups: understanding?.follow_ups ?? [], blocks: [...c2ns.blocks, ...verdictBlock ? [verdictBlock] : [], ...completionBlocks], context_applied: ctxApplied, ...liveRecords ? { records: liveRecords } : {} };
  const cacheable = !contextual && !declaredCtx && !answer.includes(refusalAnswer()) && finalAnchors.violations.length === 0;
  if (cacheable) {
    const warmVec = await warmEmbed ?? null;
    if (warmVec) semanticCachePut(env, ctx, gen, warmVec, salt, out);
  }
  if (cacheable) {
    const ck = exactCacheKey(env.INDEX_VERSION, gen, ns, await sha256Hex(cacheKeyMaterial(q.query, q.lang, salt)));
    ctx.waitUntil(env.CACHE.put(ck, JSON.stringify(out), { expirationTtl: LIMITS.cacheTtlSec }));
  }
  telemetry(env, ctx, tier, "ask", model, true, answer.length, queryHash, q.lang, void 0, telemetryMeta());
  const contextOut = used.map((h) => ({
    doc_id: h.metadata.doc_id,
    clause_anchor: h.metadata.clause_anchor,
    text: h.text.slice(0, 1200),
    ...h.metadata.table_selection ? { sel: h.metadata.table_selection } : {}
  }));
  return json({ ...out, context: contextOut, read: readAs(), quota }, 200, { ...corsHeaders(req), "server-timing": serverTiming() });
}
function sseResponse(events, cors) {
  const encoder = new TextEncoder();
  const body = events.map((e) => `data: ${JSON.stringify(e)}

`).join("");
  return new Response(encoder.encode(body), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      ...cors
    }
  });
}
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function scSignature(v, salt) {
  return v.slice(0, 16).map((x) => x.toFixed(2)).join(",") + (salt ? `|s:${salt.length}:${salt.slice(0, 64)}` : "");
}
async function semanticCacheGet(env, gen, vec, salt) {
  try {
    const raw = await env.CACHE.get(semanticCacheKey(env.INDEX_VERSION, gen, scSignature(vec, salt)), "json");
    if (!raw?.v || !Array.isArray(raw.v) || raw.v.length !== vec.length) return null;
    if (cosine(raw.v, vec) < 0.97) return null;
    return raw;
  } catch {
    return null;
  }
}
function semanticCachePut(env, ctx, gen, vec, salt, payload) {
  const v = vec.map((x) => Number(x.toFixed(3)));
  ctx.waitUntil(
    env.CACHE.put(semanticCacheKey(env.INDEX_VERSION, gen, scSignature(vec, salt)), JSON.stringify({ v, ...payload }), { expirationTtl: LIMITS.cacheTtlSec })
  );
}

export {
  handleMemories,
  checkQuoteAnchors,
  standardForDocNumber,
  scoreJudge,
  handleAsk
};
