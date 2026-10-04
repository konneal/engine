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
var TOOLS_REGISTRY = [certificatesSearch, unitsGet, graphCites, docsSection, glossaryLookup, documentsFamily, licensedSection];
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
  parseToolCall,
  TOOLS_REGISTRY,
  TOOL_DECLARATION,
  runTool,
  toolNote
};
