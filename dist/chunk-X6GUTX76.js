import {
  embed
} from "./chunk-POW7OTLB.js";
import {
  standardKeysFrom
} from "./chunk-C67BN6G3.js";
import {
  THRESHOLDS
} from "./chunk-DNKWDI4G.js";
import {
  P
} from "./chunk-3FYJM7LH.js";
import {
  hasLane,
  portIndex,
  portModelRunner,
  portStore
} from "./chunk-LSZTJI7V.js";

// workers/worker_public/src/refs.ts
var REF = /\[\[(u:(?:u:)?[A-Za-z0-9_-]+)\]\]/g;
function normalizeRef(id) {
  return id.startsWith("u:u:") ? id.slice(2) : id;
}
function availableUnitIds(hits) {
  const ids = /* @__PURE__ */ new Set();
  for (const h of hits) {
    const u = h.metadata?.unit_id;
    if (u) ids.add(u);
  }
  return ids;
}
function parseRefs(text) {
  return [...text.matchAll(REF)].map((m) => normalizeRef(m[1]));
}
function sanitizeRefs(text, available) {
  const dropped = [];
  const out = text.replace(REF, (_full, id) => {
    const normalized = normalizeRef(id);
    if (available.has(normalized)) return `[[${normalized}]]`;
    dropped.push(normalized);
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
  push(c.expression);
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
var TOL_SEP_SRC = "\\u00b1|\\bpm\\b|\\+/-";
var NUM_SRC = "[0-9]+(?:[0-9 ,.]*[0-9])?";
var UNIT_SRC = "%|\\u00b0?[A-Za-z\\u00b5\\u03a9]{0,6}";
function statedUncertainty(value, tolRaw, tolUnitRaw, valueUnit) {
  const tolNum = parseNumber(tolRaw);
  const tolUnit = (tolUnitRaw ?? "").trim();
  const relative = tolUnit === "%";
  return {
    tol: relative ? Math.abs(value) * tolNum / 100 : tolNum,
    stated: relative ? `\xB1 ${tolRaw} %` : `\xB1 ${tolRaw}${tolUnit ? ` ${tolUnit}` : ""}`,
    relative,
    unit: relative ? valueUnit : tolUnit || valueUnit
  };
}
function extractParamsWithUnits(query, symbols) {
  const values = {};
  const units = {};
  const uncertainties = {};
  for (const sym of symbols) {
    const leaf = sym.split(".").pop() ?? sym;
    const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reTolFirst = new RegExp(
      `\\b${esc}\\b\\D{0,14}?(${NUM_SRC})\\s*(?:${TOL_SEP_SRC})\\s*(${NUM_SRC})\\s*(${UNIT_SRC})?`,
      "iu"
    );
    const reTolAfter = new RegExp(
      `\\b${esc}\\b\\D{0,14}?(${NUM_SRC})\\s*(${UNIT_SRC})\\s*(?:${TOL_SEP_SRC})\\s*(${NUM_SRC})\\s*(${UNIT_SRC})?`,
      "iu"
    );
    const rePlain = new RegExp(
      `\\b${esc}\\b\\D{0,14}?(${NUM_SRC})\\s*(${UNIT_SRC})?`,
      "iu"
    );
    const mFirst = query.match(reTolFirst);
    const mAfter = mFirst ? null : query.match(reTolAfter);
    const mTol = mFirst ?? mAfter;
    if (mTol) {
      const value = parseNumber(mTol[1]);
      if (!Number.isFinite(value)) continue;
      values[sym] = value;
      let unit;
      let u;
      if (mFirst) {
        unit = (mFirst[3] ?? "").trim() || void 0;
        u = statedUncertainty(value, mFirst[2], mFirst[3], unit);
      } else {
        unit = (mAfter[2] ?? "").trim() || void 0;
        u = statedUncertainty(value, mAfter[3], mAfter[4], unit || void 0);
      }
      if (unit) units[sym] = unit;
      uncertainties[sym] = u;
      continue;
    }
    const m = query.match(rePlain);
    if (m) {
      const v = parseNumber(m[1]);
      if (Number.isFinite(v)) {
        values[sym] = v;
        const u = (m[2] ?? "").trim();
        if (u) units[sym] = u;
      }
    }
  }
  return { values, units, uncertainties };
}
function dimensionMismatch(check, units, dimensions) {
  const dims = /* @__PURE__ */ new Map();
  for (const [sym, unit] of Object.entries(units)) {
    const leaf = sym.split(".").pop();
    if (!leaf || !new RegExp(`\\b${leaf}\\b`, "i").test(check)) continue;
    const dim = dimensions[unit.toLowerCase()];
    if (dim) dims.set(sym, dim);
  }
  const distinct = [...new Set(dims.values())];
  if (distinct.length <= 1) return null;
  const parts = [...dims.entries()].map(([sym, dim]) => `${sym} is in ${dim}`);
  return `the stated quantities mix dimensions: ${parts.join(" while ")}`;
}
function evaluate(content, query, opts) {
  const c = content && typeof content === "object" ? content : {};
  const checks = extractChecks(content);
  if (!checks.length) return null;
  const symbols = symbolsIn(checks);
  const bound = extractParamsWithUnits(query, symbols);
  const params = bound.values;
  const missing = symbols.filter((s) => params[s] === void 0);
  let voidReason = null;
  const machine = checks.map((expression) => {
    const values = {};
    const ids = [];
    try {
      for (const t of tokenize(expression)) if (t.t === "id") ids.push(t.v);
    } catch {
    }
    for (const t of new Set(ids)) if (params[t] !== void 0) values[t] = params[t];
    let result = null;
    let uncertainty;
    if (missing.length === 0) {
      const mismatch = opts?.dimensions ? dimensionMismatch(expression, bound.units, opts.dimensions) : null;
      if (mismatch) {
        voidReason = voidReason ?? mismatch;
      } else {
        try {
          result = !!parseAndEval(expression, params);
        } catch {
          result = null;
        }
        const bandSyms = [...new Set(ids)].filter((s) => bound.uncertainties[s] !== void 0).slice(0, 3);
        if (bandSyms.length && result !== null) {
          const corners = [];
          for (let mask = 0; mask < 1 << bandSyms.length; mask++) {
            const corner = { ...params };
            bandSyms.forEach((s, i) => {
              corner[s] = corner[s] + (mask >> i & 1 ? 1 : -1) * bound.uncertainties[s].tol;
            });
            try {
              corners.push(!!parseAndEval(expression, corner));
            } catch {
              corners.push(null);
            }
          }
          const first = bandSyms[0];
          const un = bound.uncertainties[first];
          uncertainty = {
            symbol: first,
            stated: un.stated,
            tol: un.tol,
            unit: un.unit,
            nominal: result,
            corners
          };
          const decided = corners.filter((c2) => c2 !== null);
          if (decided.length && decided.some((c2) => c2 !== result)) {
            voidReason = voidReason ?? `the stated uncertainty (${un.stated}) on ${first.split(".").pop()} crosses the decision boundary \u2014 the check evaluates ${result ? "true" : "false"} at the stated value but ${decided.find((c2) => c2 !== result) ? "true" : "false"} at the band edge; the question cannot be decided as stated`;
          } else if (decided.length === corners.length && un.tol > 0) {
            const flipsAt = (scale) => {
              for (const dir of [1, -1]) {
                const corner = { ...params, [first]: params[first] + dir * scale * un.tol };
                try {
                  if (!!parseAndEval(expression, corner) !== result) return true;
                } catch {
                  return true;
                }
              }
              return false;
            };
            if (flipsAt(20)) {
              let lo = 1, hi = 20;
              for (let i = 0; i < 12; i++) {
                const mid = (lo + hi) / 2;
                if (flipsAt(mid)) hi = mid;
                else lo = mid;
              }
              const marginTol = hi * un.tol;
              uncertainty = {
                ...uncertainty,
                margin_tol: marginTol,
                margin_bounded: true,
                coverage: "k=2",
                safety_factor: marginTol / (2 * un.tol)
              };
            } else {
              uncertainty = {
                ...uncertainty,
                margin_tol: 20 * un.tol,
                margin_bounded: false,
                coverage: "k=2",
                safety_factor: 20 * un.tol / (2 * un.tol)
              };
            }
          }
        }
      }
    }
    return { expression, symbolic: expression, values, result, uncertainty };
  });
  if (missing.length) {
    return { verdict: "void", missing, checks: machine };
  }
  const failed = machine.some((m) => m.result === false);
  const evaluable = machine.some((m) => m.result !== null);
  if (!evaluable) {
    if (voidReason) return { verdict: "void", missing: [], void_reason: voidReason, checks: machine };
    return null;
  }
  if (voidReason) return { verdict: "void", missing: [], void_reason: voidReason, checks: machine };
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
    if (c.uncertainty) {
      const u = c.uncertainty;
      const edges = u.corners.map((r) => r === null ? "not evaluated" : r ? "holds" : "VIOLATED").join("; ");
      lines.push(`  band ${u.stated}${u.unit && !u.stated.includes(u.unit) ? ` ${u.unit}` : ""} on ${u.symbol}: ${edges} across the band`);
    }
  }
  if (v.verdict === "void") {
    lines.push(v.void_reason ? `VERDICT: VOID \u2014 ${v.void_reason}. State the mismatch plainly; the question cannot be decided as stated.` : `VERDICT: VOID \u2014 the question does not state: ${v.missing.join(", ")}. Say exactly what is missing; never assume values.`);
  } else if (v.verdict === "pass") {
    lines.push(`VERDICT: PASS \u2014 every machine check holds at the stated values. Present this verdict, the arithmetic above, and cite the node's clause.`);
  } else {
    lines.push(`VERDICT: ${String(v.on_violation ?? "FAIL").toUpperCase()} \u2014 a machine check is violated. Present this verdict, the arithmetic, the violation meaning verbatim, and cite the node's clause.`);
  }
  lines.push("This verdict is computed data \u2014 quote it faithfully; do not recompute, soften, or contradict it.");
  return lines.join("\n");
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
    const rows = await env.DB.prepare(
      "SELECT n.standard AS standard FROM model_nodes n LEFT JOIN model_plane_meta m ON m.standard = n.standard WHERE n.node_id = ?1 ORDER BY m.indexed_at DESC, n.standard DESC LIMIT 1"
    ).bind(nodeId).all();
    const standard = (rows?.results ?? []).map((r) => String(r.standard))[0];
    if (standard) return gate(await fetchNode(env, standard, nodeId));
    return null;
  } catch {
    return null;
  }
}
async function bindConstraintByQuantities(env, query, standardKeys) {
  const verdictish = /\b(acceptable|valid|violate|violation|within|comply|proposal|severity|conform)\b/i.test(query);
  if (!verdictish) return null;
  try {
    const rows = await env.DB.prepare(
      "SELECT standard, node_id, kind, name, clause_doc, clause_ref, content FROM model_nodes WHERE kind = 'constraint' LIMIT 120"
    ).all();
    const q = query.toLowerCase();
    let best = null;
    for (const r of rows.results ?? []) {
      const checks = extractChecks(JSON.parse(String(r.content ?? "{}")));
      if (!checks.length) continue;
      const leaves = new Set(
        symbolsIn(checks).map((sym) => sym.split(".").pop() ?? sym).filter((leaf) => leaf.length >= 2)
      );
      let matched = 0;
      for (const leaf of leaves) {
        const re = new RegExp(`(?<![a-z_])${leaf.replace(/[^a-z0-9_]/g, "")}(?![a-z_])`, "i");
        if (re.test(q)) matched++;
      }
      if (matched >= 2 && (!best || matched > best.score)) {
        best = { score: matched, standard: String(r.standard), node_id: String(r.node_id) };
      }
    }
    if (!best) return null;
    const gate = (node) => {
      if (!node) return null;
      const entry = licensedEntryForPackage(node.standard);
      return entry && !(standardKeys?.has(entry.key) ?? false) ? { ...node, gated: true, content: {} } : node;
    };
    return gate(await fetchNode(env, best.standard, best.node_id));
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
    { key: "question", required: true, description: "the statement carrying the quantities, e.g. 'is mpe 0.02 with n_lc 3000 within the limit?'" },
    { key: "standard", required: false, description: "the package id when the node id indexes under several standards, as the ambiguity message names it" }
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const node_id = String(args?.node_id ?? "").trim();
    const question = String(args?.question ?? "").trim();
    const standard = args?.standard ? String(args.standard).trim() : null;
    if (!node_id.startsWith("/") || question.length < 4) return null;
    try {
      const rows = standard ? await env.DB.prepare("SELECT standard, kind, name, content FROM model_nodes WHERE node_id = ?1 AND standard = ?2 LIMIT 2").bind(node_id, standard).all() : await env.DB.prepare("SELECT standard, kind, name, content FROM model_nodes WHERE node_id = ?1 LIMIT 2").bind(node_id).all();
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
      let nodes = rows.results ?? [];
      if (!nodes.length) {
        const d = await env.DB.prepare(
          "SELECT canonical_id, docidentifier FROM documents WHERE docidentifier = ?1 COLLATE NOCASE LIMIT 5"
        ).bind(label).all();
        nodes = (d.results ?? []).map((r) => ({
          id: r.canonical_id,
          kind: "doc",
          label: r.docidentifier
        }));
      }
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
async function unitByTerm(store, term) {
  const t = term.trim();
  if (!t) return null;
  const q = (where, bind) => store.prepare(`SELECT * FROM units_db WHERE ${where} LIMIT 1`).bind(...bind).all().catch(() => ({ results: [] }));
  const exact = await q("code = ?1 OR short = ?1 OR LOWER(name_en) = LOWER(?1)", [t]);
  let rows = exact.results ?? [];
  if (rows.length) return rows[0];
  const sym = await q("LOWER(json_extract(symbols, '$.ascii')) = LOWER(?1)", [t]);
  rows = sym.results ?? [];
  if (rows.length) return rows[0];
  const like = await q("LOWER(short) LIKE LOWER(?1) OR LOWER(name_en) LIKE LOWER(?1)", [`%${t}%`]);
  rows = like.results ?? [];
  return rows[0] ?? null;
}
async function resolveWithPrefix(store, term) {
  const direct = await unitByTerm(store, term);
  if (direct) return { unit: direct, prefixFactor: 1, prefixName: null };
  const t = term.trim();
  for (let cut = 1; cut < Math.min(t.length, 3); cut++) {
    const pSym = t.slice(0, cut);
    const rest = t.slice(cut);
    if (!rest) continue;
    const pres = await store.prepare("SELECT id, name_en, symbol, base, power FROM unit_prefixes WHERE symbol = ?1 AND base IS NOT NULL AND power IS NOT NULL").bind(pSym).all().catch(() => ({ results: [] }));
    const prefix = (pres.results ?? [])[0];
    if (!prefix) continue;
    const unit = await unitByTerm(store, rest);
    if (unit) return { unit, prefixFactor: Math.pow(prefix.base, prefix.power), prefixName: prefix.name_en };
  }
  return null;
}
var unitsLookup = {
  name: "units.lookup",
  description: "Look up a measurement unit in the unitsdb plane: its names and symbols, its dimension, its quantity kinds, and its SI decomposition. Bind a symbol or an everyday unit name to the dataset's canonical unit before computing with it.",
  params: [{ key: "term", required: true, description: "a unit's code, short name, symbol or plain name, e.g. m, Pa, pascal, meter per second" }],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const term = String(args?.term ?? "").trim();
    if (term.length < 1) return null;
    try {
      const store = portStore(env);
      const unit = await unitByTerm(store, term);
      if (!unit) {
        return { name: "units.lookup", query: term, output: `No unit matches "${term}" in the unitsdb plane. State this plainly.` };
      }
      const qtyNames = [];
      for (const qid of JSON.parse(unit.quantity_ids || "[]")) {
        const r = await store.prepare("SELECT name_en FROM unit_quantities WHERE id = ?1").bind(qid).all().catch(() => ({ results: [] }));
        const n = (r.results ?? [])[0]?.name_en;
        if (n) qtyNames.push(n);
      }
      const roots = JSON.parse(unit.root_units || "[]");
      const rootNames = await Promise.all(
        roots.map(async (r) => {
          const row = await unitByTerm(store, r.code);
          return `${row?.short ?? r.code}^${r.power}`;
        })
      );
      const symbols = JSON.parse(unit.symbols || "null");
      return {
        name: "units.lookup",
        query: term,
        output: JSON.stringify({
          code: unit.code,
          name_en: unit.name_en,
          name_fr: unit.name_fr,
          symbol: symbols?.ascii ?? null,
          si_root: !!unit.root,
          unit_system: unit.unit_system,
          dimension: unit.dimension_ascii,
          quantities: qtyNames.slice(0, 4),
          si_decomposition: rootNames,
          scale: unit.scale
        })
      };
    } catch {
      return null;
    }
  }
};
var unitsConvert = {
  name: "units.convert",
  description: "Convert a value between two measurement units through the unitsdb plane. SI-coherent units convert exactly (prefix powers over the same dimension); a non-SI unit is stated honestly \u2014 the dataset defines a ratio scale for it, not a factor, and none is invented.",
  params: [
    { key: "value", required: true, description: "the numeric value to convert" },
    { key: "from_unit", required: true, description: "the source unit, e.g. kPa, km, m" },
    { key: "to_unit", required: true, description: "the target unit, e.g. Pa, m" }
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const value = Number(args?.value);
    const fromTerm = String(args?.from_unit ?? "").trim();
    const toTerm = String(args?.to_unit ?? "").trim();
    if (!Number.isFinite(value) || !fromTerm || !toTerm) return null;
    try {
      const store = portStore(env);
      const from = await resolveWithPrefix(store, fromTerm);
      const to = await resolveWithPrefix(store, toTerm);
      if (!from || !to) {
        const missing = !from ? fromTerm : toTerm;
        return { name: "units.convert", query: `${value} ${fromTerm} \u2192 ${toTerm}`, output: `No unit matches "${missing}" in the unitsdb plane. State this plainly.` };
      }
      if ((from.unit.dimension_ascii ?? "") !== (to.unit.dimension_ascii ?? "")) {
        return {
          name: "units.convert",
          query: `${value} ${fromTerm} \u2192 ${toTerm}`,
          output: `Not convertible: ${fromTerm} carries dimension ${from.unit.dimension_ascii ?? "unknown"} and ${toTerm} carries ${to.unit.dimension_ascii ?? "unknown"}. State this plainly.`
        };
      }
      const coherent = (u) => !!u.unit_system && u.unit_system.toLowerCase().startsWith("si");
      if (!coherent(from.unit) || !coherent(to.unit)) {
        const nonSi = !coherent(from.unit) ? fromTerm : toTerm;
        return {
          name: "units.convert",
          query: `${value} ${fromTerm} \u2192 ${toTerm}`,
          output: `The dataset defines no numeric factor for ${nonSi} (a non-SI unit carried on a ${from.unit.scale ?? to.unit.scale ?? "ratio"} scale) \u2014 no factor is invented. State this plainly; the caller may supply the factor itself.`
        };
      }
      const result = value * from.prefixFactor / to.prefixFactor;
      return {
        name: "units.convert",
        query: `${value} ${fromTerm} \u2192 ${toTerm}`,
        output: JSON.stringify({
          value,
          from: `${from.prefixName ? from.prefixName + " " : ""}${from.unit.name_en}`,
          to: `${to.prefixName ? to.prefixName + " " : ""}${to.unit.name_en}`,
          dimension: from.unit.dimension_ascii,
          result
        })
      };
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

// workers/worker_public/src/dbtools.ts
var DB_CATALOG = [
  {
    name: "certificates",
    description: "The certificate register (a snapshot, not live certification status): one row per issued certificate across the recommendation families.",
    columns: [
      { name: "num", type: "text", description: "the printed certificate number, e.g. R60/2021-A-NL1-26.12 (family/prefix per recommendation)" },
      { name: "family", type: "text", description: "the recommendation family number, e.g. '60' for R 60" },
      { name: "holder", type: "text", description: "the certificate holder (manufacturer)" },
      { name: "model", type: "text", description: "the instrument model designation" },
      { name: "year", type: "number", description: "the issue year", numeric_cast: true },
      { name: "status", type: "text", description: "Valid | Suspended | Withdrawn" },
      { name: "pdf_key", type: "text", description: "the /cert-pdf path suffix when the PDF is on file, else empty" }
    ],
    default_select: ["num", "family", "holder", "model", "year", "status", "pdf_key"]
  },
  {
    name: "documents",
    description: "The document identity registry: every publication edition with its family, part, and derived edition status (an edition with a successor is superseded regardless of any copied status field).",
    columns: [
      { name: "canonical_id", type: "text", description: "doc:<family>-<edition> slug" },
      { name: "docidentifier", type: "text", description: "the full identifier with edition" },
      { name: "family", type: "text", description: "the family key, e.g. R-60" },
      { name: "part", type: "text", description: "1 | 2 | 3 | A | annexes | sup | empty" },
      { name: "edition", type: "number", description: "the edition year", numeric_cast: true },
      { name: "status", type: "text", description: "in-force | superseded | withdrawn (as recorded)" },
      { name: "derived_status", type: "text", description: "the successor-edge derivation result" },
      { name: "active", type: "number", description: "1 = the active edition of its family+part" },
      { name: "superseded_by", type: "text", description: "the successor's canonical_id, else empty" },
      { name: "title", type: "text", description: "the publication title" }
    ],
    default_select: ["canonical_id", "docidentifier", "family", "part", "edition", "derived_status", "active", "superseded_by", "title"]
  },
  {
    name: "graph_nodes",
    description: "The public citation-graph nodes: documents, families, and vocabulary concepts.",
    columns: [
      { name: "id", type: "text", description: "doc:<identifier-slug> | family:<number> | concept:<id>" },
      { name: "kind", type: "text", description: "doc | family | concept" },
      { name: "label", type: "text", description: "the display label" }
    ],
    default_select: ["id", "kind", "label"]
  },
  {
    name: "graph_edges",
    description: "The public citation-graph edges between nodes.",
    columns: [
      { name: "src", type: "text", description: "the source node id" },
      { name: "dst", type: "text", description: "the destination node id" },
      { name: "kind", type: "text", description: "part_of | variant_of | successor | amends | defines" }
    ],
    default_select: ["src", "kind", "dst"]
  },
  {
    name: "model_nodes",
    description: "The Recommendation model plane (per-standard requirement/conformance graphs): the machine-readable nodes behind the verdict engine.",
    columns: [
      { name: "standard", type: "text", description: "the standard key, e.g. r60" },
      { name: "node_id", type: "text", description: "/req/metrological/mpe" },
      { name: "kind", type: "text", description: "requirement | conformance_test | term | constraint | characteristic | state_machine | dimension" },
      { name: "name", type: "text", description: "the node's display name" },
      { name: "clause_doc", type: "text", description: "the provenance document urn" },
      { name: "clause_ref", type: "text", description: "the clause inside it, e.g. 5.3.2" },
      { name: "content", type: "text", description: "the node's JSON projection (the checks, thresholds, parameters)", wide: true },
      { name: "content_hash", type: "text", description: "sha256 of content" }
    ],
    default_select: ["standard", "node_id", "kind", "name", "clause_doc", "clause_ref"]
  },
  {
    name: "unit_payloads",
    description: "Typed retrievable units (tables, formulas, figures, terms) with their producer payloads.",
    columns: [
      { name: "unit_id", type: "text", description: "u:table-1" },
      { name: "doc_id", type: "text", description: "the owning document id" },
      { name: "docidentifier", type: "text", description: "the publication identifier with part" },
      { name: "edition", type: "text", description: "the edition year" },
      { name: "clause_anchor", type: "text", description: "the clause the unit lives in" },
      { name: "type", type: "text", description: "table | formula | figure | term | requirement" },
      { name: "payload", type: "text", description: "the producer payload JSON (the table's rows, the formula's math)", wide: true }
    ],
    default_select: ["unit_id", "doc_id", "docidentifier", "edition", "clause_anchor", "type"]
  },
  {
    name: "chunks",
    description: "The indexed corpus chunks (one row per clause-level passage) \u2014 use for exact metadata questions; semantic search is NOT this tool's job.",
    columns: [
      { name: "id", type: "text", description: "the chunk id" },
      { name: "doc_id", type: "text", description: "the source document slug" },
      { name: "docidentifier", type: "text", description: "the publication identifier with part" },
      { name: "doctype", type: "text", description: "R | D | B | G | E" },
      { name: "doc_number", type: "text", description: "60" },
      { name: "edition", type: "text", description: "the edition year" },
      { name: "language", type: "text", description: "en | fr | \u2026" },
      { name: "clause_anchor", type: "text", description: "the clause anchor" },
      { name: "clause_title", type: "text", description: "the clause title" },
      { name: "status", type: "text", description: "in-force | superseded" },
      { name: "superseded_by", type: "text", description: "the superseding docidentifier, else empty" },
      { name: "corpus", type: "text", description: "clean | dirty" },
      { name: "tier", type: "text", description: "the quality tier" },
      { name: "text", type: "text", description: "the passage body (wide \u2014 select only when needed)", wide: true },
      { name: "fts_text", type: "text", description: "context preamble + body (wide)", wide: true }
    ],
    default_select: ["id", "doc_id", "docidentifier", "doctype", "doc_number", "edition", "language", "clause_anchor", "clause_title", "status", "corpus"]
  }
];
function publishedTable(name) {
  return DB_CATALOG.find((t) => t.name === name);
}
var FIND_OPS = ["eq", "ne", "lt", "le", "gt", "ge", "in", "like", "between"];
var MAX_LIMIT = 25;
var DEFAULT_LIMIT = 10;
var NUMERIC_OPS = ["lt", "le", "gt", "ge", "between"];
function compileFind(args) {
  const table = publishedTable(String(args?.table ?? ""));
  if (!table) {
    return {
      ok: false,
      error: `unknown table "${String(args?.table ?? "")}". Published tables: ${DB_CATALOG.map((t) => t.name).join(", ")}.`
    };
  }
  const colNames = table.columns.map((c) => c.name);
  const colByName = new Map(table.columns.map((c) => [c.name, c]));
  const params = [];
  const phrases = [];
  const p = (n) => `?${n}`;
  const colRef = (col) => {
    const c = colByName.get(col);
    return c.numeric_cast ? `CAST(${col} AS INTEGER)` : col;
  };
  for (const w of Array.isArray(args?.where) ? args.where : []) {
    const col = String(w?.col ?? "");
    const colDef = colByName.get(col);
    if (!colDef) {
      return {
        ok: false,
        error: `table "${table.name}" has no column "${col}". Valid columns: ${colNames.join(", ")}.`
      };
    }
    const op = String(w?.op ?? "");
    if (!FIND_OPS.includes(op)) {
      return { ok: false, error: `unknown op "${op}". Valid ops: ${FIND_OPS.join(", ")}.` };
    }
    const v = w?.value;
    if (NUMERIC_OPS.includes(op) && !colDef.numeric_cast && colDef.type !== "number") {
      return { ok: false, error: `op "${op}" needs a numeric column; "${col}" is ${colDef.type}.` };
    }
    const ref = colRef(col);
    if (op === "in") {
      const list = Array.isArray(v) ? v.map((x) => String(x)) : [String(v)];
      if (!list.length) return { ok: false, error: `op "in" needs a non-empty value list.` };
      const holders = list.map((x) => p(params.push(x))).join(", ");
      phrases.push(`${ref} IN (${holders})`);
    } else if (op === "between") {
      const pair = Array.isArray(v) ? v : [void 0, void 0];
      if (pair.length !== 2) return { ok: false, error: `op "between" needs a two-element value [lo, hi].` };
      phrases.push(`${ref} BETWEEN ${p(params.push(pair[0]))} AND ${p(params.push(pair[1]))}`);
    } else if (op === "like") {
      phrases.push(`${ref} LIKE ${p(params.push(String(v)))}`);
    } else {
      const sqlOp = { eq: "=", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" }[op];
      phrases.push(`${ref} ${sqlOp} ${p(params.push(v))}`);
    }
  }
  const select = (Array.isArray(args?.select) && args.select.length ? args.select : table.default_select).map(String);
  for (const s of select) {
    if (!colNames.includes(s)) {
      return { ok: false, error: `table "${table.name}" has no column "${s}". Valid columns: ${colNames.join(", ")}.` };
    }
  }
  let head;
  if (args?.agg?.fn) {
    const fn = String(args.agg.fn);
    if (!["count", "sum", "avg", "min", "max"].includes(fn)) {
      return { ok: false, error: `unknown agg fn "${fn}". Valid: count, sum, avg, min, max.` };
    }
    let aggExpr = "COUNT(*)";
    if (fn !== "count") {
      const acol = String(args.agg.col ?? "");
      const adef = colByName.get(acol);
      if (!adef) return { ok: false, error: `agg column "${acol}" is not a column of "${table.name}". Valid columns: ${colNames.join(", ")}.` };
      aggExpr = `${fn.toUpperCase()}(${colRef(acol)})`;
    }
    head = `SELECT ${args?.group_by?.length ? `${args.group_by.map(String).join(", ")}, ` : ""}${aggExpr} AS agg FROM ${table.name}`;
    for (const g of args?.group_by ?? []) {
      if (!colNames.includes(String(g))) {
        return { ok: false, error: `table "${table.name}" has no column "${String(g)}". Valid columns: ${colNames.join(", ")}.` };
      }
    }
  } else {
    head = `SELECT ${select.join(", ")} FROM ${table.name}`;
  }
  const where = phrases.length ? ` WHERE ${phrases.join(" AND ")}` : "";
  let tail = "";
  if (args?.group_by?.length) tail += ` GROUP BY ${args.group_by.map(String).join(", ")}`;
  if (args?.order_by?.col) {
    const ocol = String(args.order_by.col);
    if (!colNames.includes(ocol)) {
      return { ok: false, error: `table "${table.name}" has no column "${ocol}". Valid columns: ${colNames.join(", ")}.` };
    }
    const dir = String(args.order_by.dir ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    tail += ` ORDER BY ${colRef(ocol)} ${dir}`;
  }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(args?.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  tail += ` LIMIT ${limit}`;
  const echo = [
    `db.find ${table.name}`,
    args?.where?.length ? `where ${args.where.map((w) => `${w.col} ${w.op} ${JSON.stringify(w.value ?? null)}`).join(" AND ")}` : "all rows",
    args?.agg?.fn ? `${args.agg.fn}${args.agg.col ? ` ${args.agg.col}` : ""}` : ""
  ].filter(Boolean).join(" \xB7 ");
  return {
    ok: true,
    sql: `${head}${where}${tail}`,
    params,
    echo
  };
}
async function runFind(env, args) {
  const compiled = compileFind(args);
  if (!compiled.ok) {
    return {
      name: "db.find",
      query: String(args?.table ?? ""),
      output: `The query was rejected: ${compiled.error} Correct the predicates and call again.`
    };
  }
  try {
    const { portStore: portStore2 } = await import("./env-LMHGNJTN.js");
    const res = await portStore2(env).prepare(compiled.sql).bind(...compiled.params).all();
    const rows = res?.results ?? [];
    const body = rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") : "No rows matched. Either the predicates are too narrow or the data is absent \u2014 state which, and consider widening.";
    const aggNote = args?.agg?.fn ? " (aggregate)" : "";
    return { name: "db.find", query: compiled.echo, output: `${compiled.echo}${aggNote} \u2192 ${rows.length} row(s):
${body}` };
  } catch (e) {
    return { name: "db.find", query: compiled.echo, output: `The query failed to run: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}
function runSchema(table) {
  const tables = table ? [publishedTable(String(table))].filter(Boolean) : DB_CATALOG;
  if (!tables.length) {
    return {
      name: "db.schema",
      query: String(table),
      output: `Unknown table "${table}". Published tables: ${DB_CATALOG.map((t) => t.name).join(", ")}.`
    };
  }
  const output = tables.map((t) => {
    const cols = t.columns.map((c) => `  ${c.name} (${c.type}${c.numeric_cast ? ", numeric-cast" : ""}${c.wide ? ", wide" : ""}) \u2014 ${c.description}`).join("\n");
    return `${t.name} \u2014 ${t.description}
${cols}
  default select: ${t.default_select.join(", ")}`;
  }).join("\n\n");
  return {
    name: "db.schema",
    query: table ? String(table) : "catalog",
    output: `Published tables (compose TOOL db.find with where: [{col, op, value}]; ops: ${FIND_OPS.join(" ")}; values bind safely; like accepts % and _ wildcards):

${output}`
  };
}

// workers/worker_public/src/tools.ts
function parseToolCall(text) {
  const m = /^TOOL\s+([a-z_.]+)[ \t]*(\{.*)?$/m.exec(String(text ?? ""));
  if (!m) return null;
  const rest = (m[2] ?? "").trim();
  if (!rest) return { name: m[1].toLowerCase(), args: {} };
  if (!rest.startsWith("{")) return null;
  try {
    return { name: m[1].toLowerCase(), args: JSON.parse(rest) };
  } catch {
    return null;
  }
}
var certificatesSearch = {
  name: "certificates.search",
  description: "Search the certificate register (a snapshot) by holder name, model designation, or a printed certificate number. Returns the matching rows \u2014 number, holder, model, issue year, status, and document links where on file \u2014 or the exact no-match statement for the string asked.",
  params: [{ key: "query", required: true, description: "the holder, model, or printed certificate number to look up" }],
  audiences: ["agent", "mcp"],
  handler: async (env, args) => {
    const query = String(args?.query ?? "").trim().slice(0, 160);
    if (!query) return null;
    const { searchRegister, registerNote, certificateLinks } = await import("./certificates-F5G7GRWK.js");
    const reg = await searchRegister(env.DB, query, true);
    const output = reg?.rows?.length ? [registerNote(reg.rows), certificateLinks(reg.rows)].filter(Boolean).join("\n") : `No certificate was found for "${query}" in the certificates database (the register snapshot). State this as the search's result, with the searched string visible.`;
    return { name: "certificates.search", query, output };
  }
};
var dbSchema = {
  name: "db.schema",
  description: "The published data map: every queryable table (the certificate register, the document registry, the citation graph, the model plane, typed units, the corpus chunks) with its columns, types, and meanings. Call this first whenever a question turns on structured data; then compose db.find.",
  params: [{ key: "table", required: false, description: "one table's detail; omit for the whole catalog" }],
  audiences: ["agent", "mcp"],
  handler: async (_env, args) => {
    const t = args?.table ? String(args.table) : void 0;
    return runSchema(t);
  }
};
var dbFind = {
  name: "db.find",
  description: "Query a published table with typed predicates you compose: where: [{col, op, value}] with ops eq|ne|lt|le|gt|ge|in|like|between, optional select, order_by {col, dir}, limit (\u226425), group_by + agg {fn: count|sum|avg|min|max, col}. Values bind safely; identifiers validate against the schema (errors name the valid columns). Returns the matching rows or aggregate with the query echoed.",
  params: [
    { key: "table", required: true, description: "a published table (db.schema lists them)" },
    { key: "where", required: false, description: "[{col, op, value}] predicates, ANDed" },
    { key: "select", required: false, description: "columns to return; default per table" },
    { key: "order_by", required: false, description: "{col, dir: asc|desc}" },
    { key: "limit", required: false, description: "row cap, \u226425" },
    { key: "agg", required: false, description: "{fn, col?} aggregate instead of rows; with group_by: [cols]" }
  ],
  audiences: ["agent", "mcp"],
  handler: async (env, args) => {
    const findArgs = {
      table: String(args?.table ?? ""),
      where: Array.isArray(args?.where) ? args.where : [],
      select: Array.isArray(args?.select) ? args.select : void 0,
      order_by: args?.order_by && typeof args.order_by === "object" ? args.order_by : void 0,
      limit: args?.limit != null ? Number(args.limit) : void 0,
      group_by: Array.isArray(args?.group_by) ? args.group_by : void 0,
      agg: args?.agg && typeof args.agg === "object" ? args.agg : void 0
    };
    if (!findArgs.table) return null;
    return runFind(env, findArgs);
  }
};
var TOOLS_REGISTRY = [dbSchema, dbFind, certificatesSearch, unitsGet, graphCites, docsSection, glossaryLookup, documentsFamily, licensedSection, verdictEvaluate, conditionsCheck, bibEntry, unitsLookup, unitsConvert];
var TOOL_DECLARATION = [
  "You may query data before answering, by writing ONE line per call:",
  ...TOOLS_REGISTRY.filter((t) => t.audiences.includes("agent")).map((t) => {
    const shape = `{${t.params.map((p) => `"${p.key}": <${p.description}>`).join(", ")}}`;
    return `TOOL ${t.name} ${shape}`;
  }),
  "The worker runs each call and returns the result attributed; you may issue up to three calls across the turns, one per turn, each on its own single line (compact JSON, no line breaks). Structured questions \u2014 counts, latest, filters, per-holder or per-year breakdowns over the register, document editions, model-plane requirements \u2014 start from TOOL db.schema (it lists the queryable tables and their columns), then compose TOOL db.find predicates. Each result arrives attributed: phrase it as what the tool returned, with your query visible in the answer. When you have enough, answer WITHOUT a TOOL line; if no tool helps, answer directly."
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
  extractChecks,
  symbolsIn,
  extractParamsWithUnits,
  evaluate,
  verdictNote,
  standardForDocNumber,
  licensedEntryForPackage,
  licenseBoundaryNote,
  licenseBoundaryRefusal,
  bindModelNode,
  bindConstraintByQuantities,
  modelGroundingBlock,
  modelCitation,
  modelEcho,
  resolveBlocks,
  contractV2,
  tableRetyped,
  quantitiesIn,
  evaluateConditionSets,
  parseToolCall,
  TOOLS_REGISTRY,
  TOOL_DECLARATION,
  runTool,
  toolNote
};
