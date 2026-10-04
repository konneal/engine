import {
  embed,
  hasLane,
  portIndex,
  portModelRunner
} from "./chunk-LOBYXEVD.js";
import {
  standardKeysFrom
} from "./chunk-LVZTWUVJ.js";
import {
  THRESHOLDS
} from "./chunk-2PCUAJJO.js";
import {
  P
} from "./chunk-3FYJM7LH.js";

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
function licensedEntryForPackage(packageId) {
  if (!packageId) return null;
  return (P().sources?.licensed ?? []).find((l) => l.package === packageId) ?? null;
}
function licensedEntryForDocNumber(docNumber) {
  if (!docNumber) return null;
  return (P().sources?.licensed ?? []).find((l) => String(l.doc_number ?? "") === docNumber) ?? null;
}
function licenseBoundaryNote(docNumber, standardKeys) {
  const entry = licensedEntryForDocNumber(docNumber);
  if (!entry || standardKeys && standardKeys.has(entry.key)) return void 0;
  const pointer = P().prompts?.vars?.license_declare_pointer;
  return `License boundary \u2014 the question is about ${licenseBoundaryName(entry)}, a licensed publication (entitlement key ${entry.key}). The caller's organization license does not cover its text, so no passage of it was retrieved and NONE of its procedural content (steps, parameters, severities, limits) may be stated, paraphrased or recalled from memory. You MAY answer at the citation level: name the standard and edition, and cite the invoking clause from the PUBLIC passages in context (the Recommendation's own applicability and normative references are public and stay answerable). Then say the organization's license does not cover the standard's text` + (pointer ? ` and point to the declare flow: ${pointer}.` : ".");
}
function licenseBoundaryName(entry) {
  const id = entry.doc_number ? ` ${entry.doc_number}` : ` ${entry.package}`;
  return `${entry.title ?? "standard"}${entry.edition ? ` (${entry.edition})` : ""} \u2014${id}`;
}
function licenseBoundaryRefusal(docNumber, standardKeys) {
  const entry = licensedEntryForDocNumber(docNumber);
  if (!entry || standardKeys && standardKeys.has(entry.key)) return void 0;
  const pointer = P().prompts?.vars?.license_declare_pointer;
  return `${licenseBoundaryName(entry)} is a licensed publication and your organization's license does not cover its text, so I can't quote or summarize its procedure. I can answer at the citation level \u2014 the standard's title and edition, and the clause your Recommendation invokes \u2014 and the public ${P().publisher.name} content in full.` + (pointer ? ` To unlock the full text, an org admin can declare the license under ${pointer}.` : "");
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
  const gate = (node) => {
    if (!node) return null;
    const entry = licensedEntryForPackage(node.standard);
    return entry && !(opts.standardKeys?.has(entry.key) ?? false) ? { ...node, gated: true, content: {} } : node;
  };
  if (opts.standard) return gate(await fetchNode(env, opts.standard, nodeId));
  try {
    const rows = await env.DB.prepare("SELECT standard FROM model_nodes WHERE node_id = ?1 LIMIT 2").bind(nodeId).all();
    const standards = (rows?.results ?? []).map((r) => String(r.standard));
    if (standards.length === 1) return gate(await fetchNode(env, standards[0], nodeId));
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
    quality: "verified",
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
          return num(l) >= num(r);
        case "<=":
          return num(l) <= num(r);
        case ">":
          return num(l) > num(r);
        case "<":
          return num(l) < num(r);
        case "==":
          return num(l) === num(r);
        default:
          return num(l) !== num(r);
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
        l = t.v === "+" ? num(l) + num(r) : num(l) - num(r);
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
        l = t.v === "*" ? num(l) * num(r) : num(l) / num(r);
      } else return l;
    }
  }
  function unary() {
    const t = peek();
    if (t && t.t === "op" && t.v === "-") {
      p++;
      return -num(unary());
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
  const num = (v) => typeof v === "boolean" ? v ? 1 : 0 : v;
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

// workers/worker_public/src/conditions.ts
var NUM = String.raw`-?\d+(?:[.,]\d+)?`;
function quantitiesIn(query) {
  const out = {};
  const num = (s) => Number(s.replace(",", "."));
  const put = (kind, stated, stated_unit, si) => {
    if (Number.isFinite(si)) out[kind] = { stated, stated_unit, si };
  };
  const tempC = query.match(new RegExp(`(${NUM})\\s*(?:\xB0\\s*)?C\\b`));
  if (tempC) put("temperature", num(tempC[1]), "degC", num(tempC[1]) + 273.15);
  const tempK = query.match(new RegExp(`(${NUM})\\s*K\\b`));
  if (tempK && out.temperature === void 0) put("temperature", num(tempK[1]), "K", num(tempK[1]));
  const rh = query.match(new RegExp(`(${NUM})\\s*%\\s*(?:RH\\b|relative\\s+humidity)?`, "i"));
  if (rh) put("relative_humidity", num(rh[1]), "%", num(rh[1]) / 100);
  const hours = query.match(new RegExp(`(${NUM})\\s*h\\b`, "i"));
  if (hours) put("duration", num(hours[1]), "h", num(hours[1]) * 3600);
  const days = query.match(new RegExp(`(${NUM})\\s*days?\\b`, "i"));
  if (days && out.duration === void 0) put("duration", num(days[1]), "d", num(days[1]) * 86400);
  return out;
}
function scoreSet(entries, q) {
  const checks = [];
  let distance = 0;
  let stated = 0;
  for (const e of entries) {
    const siEntry = e;
    const statedQ = q[e.quantity_kind];
    if (!statedQ || !siEntry?.si) continue;
    const tol = Number(String(siEntry.tolerance ?? "0").replace(",", "."));
    const tolSi = (Number.isFinite(tol) ? tol : 0) * (siEntry.si.unit === "K" ? 1 : siEntry.si.unit === "1" ? 0.01 : 1);
    const in_band = statedQ.si >= siEntry.si.value - tolSi && statedQ.si <= siEntry.si.value + tolSi;
    const gap = Math.max(0, statedQ.si - (siEntry.si.value + tolSi), siEntry.si.value - tolSi - statedQ.si);
    distance += gap / Math.max(tolSi, 1);
    stated += 1;
    checks.push({
      quantity_kind: e.quantity_kind,
      band: `${siEntry.si.value} ${siEntry.si.unit} \xB1${tolSi}`,
      stated: statedQ.stated,
      stated_unit: statedQ.stated_unit,
      in_band
    });
  }
  return stated ? { checks, distance, stated } : null;
}
function evaluateConditionSets(nodes, query) {
  const q = quantitiesIn(query);
  const kinds = Object.keys(q);
  if (!kinds.length) return null;
  const scored = [];
  for (const n of nodes) {
    const c = n.content && typeof n.content === "object" ? n.content : {};
    const payload = c.payload ?? {};
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (!entries.length) continue;
    const s = scoreSet(entries, q);
    if (s) scored.push({ node_id: n.node_id, checks: s.checks, distance: s.distance });
  }
  if (!scored.length) return null;
  const matched = scored.filter((s) => s.checks.every((c) => c.in_band));
  scored.sort((a, b) => a.distance - b.distance);
  if (matched.length) {
    return {
      verdict: "pass",
      matched: matched.map((m) => m.node_id),
      checks: matched[0].checks,
      note: `VERDICT: PASS \u2014 the stated combination (${kinds.join(", ")}) matches a severity set (${matched[0].checks.map((c) => c.band).join("; ")}). Present this verdict and cite the set's clause. The machine set identifier rides the verdict block as data \u2014 never write it in your prose.`
    };
  }
  const nearest = scored[0];
  return {
    verdict: "fail",
    matched: [],
    nearest: { node_id: nearest.node_id, distance: Number(nearest.distance.toFixed(2)), bands: nearest.checks.map((c) => c.band) },
    checks: nearest.checks,
    note: `VERDICT: FAIL \u2014 no severity set admits the stated combination. The nearest set (bands: ${nearest.checks.map((c) => c.band).join("; ")}) is the closest match. Say the combination is outside the menu and describe the nearest set's bands; never soften it. The machine set identifier rides the verdict block as data \u2014 never write it in your prose.`
  };
}

// workers/worker_public/src/tools-content.ts
var slug = (docidentifier) => docidentifier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
var unitsGet = {
  name: "units.get",
  description: "Fetch typed Recommendation content \u2014 a table, formula or figure as structured data (columns, rows, MathML, caption), by its unit id. The machine-consumable form of a Recommendation's content, for computing with rather than reading.",
  params: [{ key: "unit_id", required: true, description: "the unit id exactly as an answer's [[u:\u2026]] reference spells it" }],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const unit_id = String(args?.unit_id ?? "").trim().replace(/^\[?\[?u:/, "u:").replace(/]?\]?$/, "");
    if (!/^u:[\w.-]+$/.test(unit_id)) return null;
    const blocks = await resolveBlocks(env.DB, [unit_id]);
    if (!blocks.length) {
      return { name: "units.get", query: unit_id, output: `No typed unit "${unit_id}" exists in the indexed payloads. State this plainly.` };
    }
    return {
      name: "units.get",
      query: unit_id,
      output: JSON.stringify(
        blocks.map((b) => ({ unit_id: b.unit_id, type: b.type, docidentifier: b.docidentifier, payload: b.payload }))
      )
    };
  }
};
var graphCites = {
  name: "graph.cites",
  description: "The bibliography edges: what a publication's own bibliography actually cites, extracted from its indexed bibliography sections. Returns the cited works' labels for a document (optionally scoped to an edition).",
  params: [
    { key: "doc", required: true, description: "the publication identifier, e.g. R 60-1:2021" },
    { key: "edition", required: false, description: "an edition year to scope, e.g. 2021" }
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const doc = String(args?.doc ?? "").trim();
    if (doc.length < 3) return null;
    const edition = args?.edition ? String(args.edition).trim() : null;
    const pat = `%${doc.replace(/[:\s]+/g, "%")}%${edition ? edition : ""}%`;
    try {
      const rows = await env.DB.prepare(
        "SELECT DISTINCT n.label AS label FROM graph_edges e JOIN documents d ON e.src = d.canonical_id JOIN graph_nodes n ON e.dst = n.id WHERE d.docidentifier LIKE ?1 AND e.kind = 'cites' ORDER BY label LIMIT 60"
      ).bind(pat).all();
      const labels = (rows.results ?? []).map((r) => r.label).filter(Boolean);
      return {
        name: "graph.cites",
        query: `${doc}${edition ? ` (${edition})` : ""}`,
        output: labels.length ? `The publication's bibliography cites:
${labels.map((l) => `- ${l}`).join("\n")}` : `No bibliography citations are indexed for "${doc}"${edition ? ` (${edition})` : ""}. State this plainly.`
      };
    } catch {
      return null;
    }
  }
};
var docsSection = {
  name: "docs.section",
  description: "Fetch one clause of a publication's rendered document \u2014 its text and its permanent deep-link URL \u2014 for agents that need the human-formatted passage with its anchor.",
  params: [
    { key: "doc", required: true, description: "the publication identifier, e.g. R 60-1:2021" },
    { key: "clause", required: true, description: "the clause anchor, e.g. 5.1.1 or annex-b" }
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const doc = String(args?.doc ?? "").trim();
    const clause = String(args?.clause ?? "").trim();
    if (doc.length < 3 || !clause) return null;
    try {
      const rows = await env.DB.prepare(
        "SELECT docidentifier, clause_anchor, clause_title, text FROM chunks WHERE docidentifier LIKE ?1 AND REPLACE(clause_anchor, ' ', '') = ?2 LIMIT 1"
      ).bind(`%${doc.replace(/[:\s]+/g, "%")}%`, clause).all();
      const r = (rows.results ?? [])[0];
      if (!r) {
        return { name: "docs.section", query: `${doc} \xA7${clause}`, output: `No clause "${clause}" is indexed for "${doc}". State this plainly.` };
      }
      const url = `https://www.ommisa.org/docs/${slug(r.docidentifier)}.html#${r.clause_anchor}`;
      return {
        name: "docs.section",
        query: `${r.docidentifier} \xA7${r.clause_anchor}`,
        output: JSON.stringify({ docidentifier: r.docidentifier, clause: r.clause_anchor, title: r.clause_title, url, text: (r.text ?? "").slice(0, 4e3) })
      };
    } catch {
      return null;
    }
  }
};
var documentsFamily = {
  name: "documents.family",
  description: "Look up the publication registry for a family: every edition with its derived status (in-force/superseded), which edition is ACTIVE (terminal of the successor chain), and supersession links. Use for current/latest-edition and edition-history questions.",
  params: [{ key: "family", required: true, description: "the family key, e.g. R-60 (series letter and number)" }],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const family = String(args?.family ?? "").trim().toUpperCase();
    if (!/^[A-Z]-\d{1,3}$/.test(family)) return null;
    try {
      const rows = await env.DB.prepare(
        "SELECT d.docidentifier, d.derived_status, d.active, s.docidentifier AS succ FROM documents d LEFT JOIN documents s ON d.superseded_by = s.canonical_id WHERE d.family = ?1 ORDER BY d.part, d.edition"
      ).bind(family).all();
      const lines = (rows.results ?? []).map(
        (r) => `${r.docidentifier} \u2014 ${r.derived_status}${r.active ? " [ACTIVE]" : ""}${r.succ ? ` \u2192 superseded by ${r.succ}` : ""}`
      );
      if (!lines.length) {
        return { name: "documents.family", query: family, output: `No editions are registered for the family ${family}. State this plainly.` };
      }
      return { name: "documents.family", query: family, output: lines.join("\n") };
    } catch {
      return null;
    }
  }
};
var licensedSection = {
  name: "licensed.section",
  description: "Fetch one clause of a licensed standard's typed model content \u2014 requirements, condition sets and parameters as structured data \u2014 behind the caller's license entitlement keys. An unentitled caller receives the license boundary: the standard's title and edition and the declare flow, never its text.",
  params: [
    { key: "doc", required: true, description: "the standard's document number, e.g. 60068-2-30 or 61000-4-2" },
    { key: "clause", required: true, description: "the clause number inside the standard, e.g. 5 or 9" },
    { key: "licensed_standards", required: true, description: `the caller's license entitlement keys, e.g. ["std:iec-60068-2-30"] \u2014 validated against the licenses this deployment declares; keys it does not know drop` }
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const doc = String(args?.doc ?? "").trim();
    const clause = String(args?.clause ?? "").trim();
    if (doc.length < 3 || !clause) return null;
    const docNumber = doc.replace(/^(?:ISO\/IEC|ISO|IEC)\s+/i, "").trim();
    const entry = licensedEntryForDocNumber(docNumber);
    if (!entry) {
      return {
        name: "licensed.section",
        query: `${doc} \xA7${clause}`,
        output: `"${doc}" is not among the licensed standards this deployment keys. For clauses of the public corpus use the docs.section tool instead. State this plainly.`
      };
    }
    const keys = standardKeysFrom({ licensed_standards: args?.licensed_standards });
    if (!keys.has(entry.key)) {
      const refusal = licenseBoundaryRefusal(docNumber, keys);
      return {
        name: "licensed.section",
        query: `${doc} \xA7${clause}`,
        output: refusal ?? "License boundary \u2014 the caller's entitlement set does not cover this standard's text."
      };
    }
    try {
      const rows = await env.DB.prepare(
        "SELECT node_id, kind, name, clause_ref, content FROM model_nodes WHERE standard = ?1 AND clause_ref = ?2 ORDER BY node_id LIMIT 20"
      ).bind(entry.package, clause).all();
      const nodes = rows.results ?? [];
      if (!nodes.length) {
        const c = await env.DB.prepare(
          "SELECT DISTINCT clause_ref FROM model_nodes WHERE standard = ?1 ORDER BY clause_ref"
        ).bind(entry.package).all();
        const clauses = (c.results ?? []).map((r) => r.clause_ref).filter(Boolean).join(", ");
        return {
          name: "licensed.section",
          query: `${doc} \xA7${clause}`,
          output: `No typed nodes are indexed for ${doc} \xA7${clause}.${clauses ? ` The clauses with typed nodes: ${clauses}.` : ""} State this plainly.`
        };
      }
      return {
        name: "licensed.section",
        query: `${doc} \xA7${clause}`,
        output: JSON.stringify(
          nodes.map((n) => {
            let content = n.content;
            try {
              content = JSON.parse(n.content);
            } catch {
            }
            return { node_id: n.node_id, kind: n.kind, name: n.name, clause: n.clause_ref, content };
          })
        )
      };
    } catch {
      return null;
    }
  }
};
var verdictEvaluate = {
  name: "verdict.evaluate",
  description: "Deterministically evaluate a model-plane node's machine checks (OCL boolean expressions, threshold limits) against the quantities a question states. Returns pass/fail with every check's expression and values, or void with the missing parameter names when the question does not state enough. The machine computes; cite the node's clause.",
  params: [
    { key: "node_id", required: true, description: "the model-plane node id, e.g. /req/metrological/repeatability (node ids appear in answers' verdict blocks)" },
    { key: "question", required: true, description: "the statement carrying the quantities, e.g. 'is mpe 0.02 with n_lc 3000 within the limit?'" }
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const node_id = String(args?.node_id ?? "").trim();
    const question = String(args?.question ?? "").trim();
    if (!node_id.startsWith("/") || question.length < 4) return null;
    try {
      const rows = await env.DB.prepare(
        "SELECT standard, kind, name, content FROM model_nodes WHERE node_id = ?1 LIMIT 2"
      ).bind(node_id).all();
      const found = rows.results ?? [];
      if (found.length !== 1) {
        return {
          name: "verdict.evaluate",
          query: node_id,
          output: found.length ? `The node id ${node_id} is indexed under several standards \u2014 name the standard to disambiguate. State this plainly.` : `No model-plane node ${node_id} is indexed. State this plainly.`
        };
      }
      const node = found[0];
      const entry = licensedEntryForPackage(node.standard);
      if (entry) {
        return {
          name: "verdict.evaluate",
          query: node_id,
          output: licenseBoundaryRefusal(entry.doc_number, null) ?? "License boundary \u2014 the node belongs to a licensed standard the caller's entitlement set does not cover."
        };
      }
      let content;
      try {
        content = JSON.parse(node.content);
      } catch {
        content = null;
      }
      const v = evaluate(content, question);
      if (!v) {
        return {
          name: "verdict.evaluate",
          query: node_id,
          output: `The node ${node_id} (${node.kind}) carries no machine-checkable expressions \u2014 it is not evaluatable by the verdict engine. State this plainly.`
        };
      }
      return {
        name: "verdict.evaluate",
        query: node_id,
        output: JSON.stringify({ standard: node.standard, node_id, kind: node.kind, name: node.name, verdict: v.verdict, on_violation: v.on_violation, missing: v.missing, checks: v.checks })
      };
    } catch {
      return null;
    }
  }
};
var conditionsCheck = {
  name: "conditions.check",
  description: "Check a stated combination of environmental quantities (temperature, humidity, duration, cycles) against the indexed severity/condition sets \u2014 the pass answer names the matched set and every band, the fail names the nearest set and its distance. Machine evaluation over the condition-set nodes; cite the matched set's clause.",
  params: [
    { key: "question", required: true, description: "the stated combination, e.g. 'damp heat cyclic test at 55 \xB0C for 2 cycles of 24 h'" },
    { key: "standard", required: false, description: "optional scope, the package id, e.g. iec-60068-2-30 (defaults to every indexed condition set the caller may see)" },
    { key: "licensed_standards", required: false, description: "license entitlement keys for licensed condition sets, validated against the deployment's declared licenses" }
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const question = String(args?.question ?? "").trim();
    if (question.length < 4) return null;
    const standard = args?.standard ? String(args.standard).trim() : null;
    const keys = standardKeysFrom({ licensed_standards: args?.licensed_standards });
    try {
      const rows = standard ? await env.DB.prepare("SELECT node_id, standard, content FROM model_nodes WHERE kind = 'condition_set' AND standard = ?1").bind(standard).all() : await env.DB.prepare("SELECT node_id, standard, content FROM model_nodes WHERE kind = 'condition_set'").all();
      const all = (rows.results ?? []).map((r) => {
        let content = r.content;
        try {
          content = JSON.parse(r.content);
        } catch {
        }
        return { node_id: r.node_id, standard: r.standard, content };
      });
      const visible = all.filter((n) => {
        const entry = licensedEntryForPackage(n.standard);
        return !entry || keys.has(entry.key);
      });
      if (!visible.length) {
        return { name: "conditions.check", query: question, output: "No condition sets are indexed (or visible to this caller's entitlements). State this plainly." };
      }
      const v = evaluateConditionSets(visible, question);
      if (!v) {
        return { name: "conditions.check", query: question, output: "No quantities were recognized in the statement \u2014 state the values (temperature, humidity, duration, cycles). The engine checks stated numbers, never guesses." };
      }
      return {
        name: "conditions.check",
        query: question,
        output: JSON.stringify({ verdict: v.verdict, matched: v.matched, checks: v.checks })
      };
    } catch {
      return null;
    }
  }
};
var bibEntry = {
  name: "bib.entry",
  description: "Fetch the bibliographic registry record for a citation label: every edition document under it with derived status (in-force/superseded, the ACTIVE flag), the relation edges (successor, amends, variant), and its outgoing citations. Use after graph.cites to resolve a cited label to its own record.",
  params: [
    { key: "label", required: true, description: "the citation label exactly as graph.cites returns it, e.g. ISO 8601" }
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const label = String(args?.label ?? "").trim();
    if (label.length < 2) return null;
    try {
      const rows = await env.DB.prepare(
        "SELECT id, kind, label FROM graph_nodes WHERE label = ?1 COLLATE NOCASE LIMIT 5"
      ).bind(label).all();
      const nodes = rows.results ?? [];
      if (!nodes.length) {
        return { name: "bib.entry", query: label, output: `No registry node carries the label "${label}". State this plainly.` };
      }
      const out = [];
      for (const n of nodes) {
        const entry = { label: n.label, kind: n.kind };
        if (n.kind === "doc") {
          const d = await env.DB.prepare(
            "SELECT docidentifier, family, part, edition, derived_status, active, superseded_by, title FROM documents WHERE canonical_id = ?1"
          ).bind(n.id).all();
          const doc = (d.results ?? [])[0];
          if (doc) {
            entry.document = {
              docidentifier: doc.docidentifier,
              family: doc.family,
              part: doc.part,
              edition: doc.edition,
              status: doc.derived_status,
              active: !!doc.active,
              superseded_by: doc.superseded_by,
              title: doc.title
            };
          }
        }
        const rel = await env.DB.prepare(
          "SELECT e.kind, n.label AS target FROM graph_edges e JOIN graph_nodes n ON e.dst = n.id WHERE e.src = ?1 LIMIT 25"
        ).bind(n.id).all();
        const relations = rel.results ?? [];
        if (relations.length) entry.relations = relations;
        const cites = await env.DB.prepare(
          "SELECT n.label AS cited FROM graph_edges e JOIN graph_nodes n ON e.dst = n.id WHERE e.src = ?1 AND e.kind = 'cites' LIMIT 40"
        ).bind(n.id).all();
        const cited = (cites.results ?? []).map((r) => r.cited).filter(Boolean);
        if (cited.length) entry.cites = cited;
        out.push(entry);
      }
      return { name: "bib.entry", query: label, output: JSON.stringify(out) };
    } catch {
      return null;
    }
  }
};
var glossaryLookup = {
  name: "glossary.lookup",
  description: "Look up a defined term in the terminology datasets \u2014 the concept's definition and its defining publication. Bind everyday words to the defined term before interpreting a question.",
  params: [{ key: "term", required: true, description: "the term or everyday phrase to bind, e.g. creep or load cell" }],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const term = String(args?.term ?? "").trim();
    if (term.length < 2) return null;
    if (!hasLane(env, "glossary")) return null;
    try {
      const vec = await embed(portModelRunner(env), "", term);
      const cands = await portIndex(env, "glossary").query({ vector: vec, topK: 5 });
      const hits = cands.filter((m) => m.score >= THRESHOLDS.glossaryCosineFloor).map((m) => ({
        term: String(m.metadata?.clause_title ?? "").trim(),
        definition: String(m.metadata?.chunk_text ?? "").split(" \u2014 ").slice(1).join(" \u2014 ").slice(0, 400),
        docidentifier: String(m.metadata?.docidentifier ?? "")
      })).filter((x) => x.term && x.definition);
      if (!hits.length) {
        return { name: "glossary.lookup", query: term, output: `No defined term matches "${term}" in the terminology datasets. State this plainly.` };
      }
      const seen = /* @__PURE__ */ new Set();
      const uniq = hits.filter((h) => {
        const k = h.term.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/labeler\b/g, "labeller").replace(/\s+/g, " ").trim();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 3);
      return {
        name: "glossary.lookup",
        query: term,
        output: uniq.map((h) => `- ${h.term} (${h.docidentifier}): ${h.definition}`).join("\n")
      };
    } catch {
      return null;
    }
  }
};

// workers/worker_public/src/tools.ts
function parseToolCall(text) {
  const m = /^TOOL\s+([a-z_.]+)\s*(\{[^\n}]*\})?/m.exec(String(text ?? ""));
  if (!m) return null;
  let args = {};
  if (m[2]) {
    try {
      args = JSON.parse(m[2]);
    } catch {
      return null;
    }
  } else if (/^TOOL\s+[a-z_.]+\s*\{/m.test(String(text ?? ""))) {
    return null;
  }
  return { name: m[1].toLowerCase(), args };
}
var certificatesSearch = {
  name: "certificates.search",
  description: "Search the certificate register (a snapshot) by holder name, model designation, or a printed certificate number. Returns the matching rows \u2014 number, holder, model, issue year, status, and document links where on file \u2014 or the exact no-match statement for the string asked.",
  params: [{ key: "query", required: true, description: "the holder, model, or printed certificate number to look up" }],
  audiences: ["agent", "mcp"],
  handler: async (env, args) => {
    const query = String(args?.query ?? "").trim().slice(0, 160);
    if (!query) return null;
    const { searchRegister, registerNote, certificateLinks } = await import("./certificates-CO7KX2S2.js");
    const reg = await searchRegister(env.DB, query, true);
    const output = reg?.rows?.length ? [registerNote(reg.rows), certificateLinks(reg.rows)].filter(Boolean).join("\n") : `No certificate was found for "${query}" in the certificates database (the register snapshot). State this as the search's result, with the searched string visible.`;
    return { name: "certificates.search", query, output };
  }
};
var TOOLS_REGISTRY = [certificatesSearch, unitsGet, graphCites, docsSection, glossaryLookup, documentsFamily, licensedSection, verdictEvaluate, conditionsCheck, bibEntry];
var TOOL_DECLARATION = [
  "You may use one tool before answering, by writing a single line:",
  ...TOOLS_REGISTRY.filter((t) => t.audiences.includes("agent")).map((t) => {
    const shape = `{${t.params.map((p) => `"${p.key}": "<${p.description}>"`).join(", ")}}`;
    return `TOOL ${t.name} ${shape}`;
  }),
  "The worker runs it and returns the result attributed \u2014 phrase the tool's result as what it returned, with the searched string visible in your answer. Use a tool when the question turns on what it answers (including from a photograph). If you do not need it, answer directly without the line."
].join("\n");
async function runTool(env, call, audience = "agent") {
  const spec = TOOLS_REGISTRY.find((t) => t.name === call.name && t.audiences.includes(audience));
  if (!spec) return null;
  return spec.handler(env, call.args ?? {});
}
function toolNote(r) {
  return `The ${r.name} tool returned, for the query "${r.query}":
${r.output}`;
}

export {
  standardForDocNumber,
  licensedEntryForPackage,
  licenseBoundaryNote,
  licenseBoundaryRefusal,
  bindModelNode,
  modelGroundingBlock,
  modelCitation,
  modelEcho,
  resolveBlocks,
  contractV2,
  tableRetyped,
  evaluate,
  verdictNote,
  quantitiesIn,
  evaluateConditionSets,
  parseToolCall,
  TOOLS_REGISTRY,
  TOOL_DECLARATION,
  runTool,
  toolNote
};
