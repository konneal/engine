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

// workers/worker_public/src/tools-content.ts
var slug = (docidentifier) => docidentifier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
var unitsGet = {
  name: "units.get",
  description: "Fetch typed Recommendation content \u2014 a table, formula or figure as structured data (columns, rows, MathML, caption), by its unit id. The machine-consumable form of a Recommendation's content, for computing with rather than reading.",
  params: [{ key: "unit_id", required: true, description: "the unit id, e.g. u:table-1 or u:form-3 (ids appear in answers' [[u:\u2026]] references)" }],
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
var glossaryLookup = {
  name: "glossary.lookup",
  description: "Look up a defined term in the terminology datasets \u2014 the concept's definition and its defining publication. Bind everyday words to the defined term before interpreting a question.",
  params: [{ key: "term", required: true, description: "the term or everyday phrase to bind, e.g. creep or load cell" }],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const term = String(args?.term ?? "").trim();
    if (term.length < 2) return null;
    try {
      const rows = await env.DB.prepare(
        "SELECT clause_title AS term, chunk_text AS text, docidentifier FROM chunks WHERE corpus = 'glossary' AND (clause_title = ?1 OR clause_title LIKE ?2) LIMIT 3"
      ).bind(term, `%${term}%`).all();
      const hits = (rows.results ?? []).filter((r) => r.term);
      if (!hits.length) {
        return { name: "glossary.lookup", query: term, output: `No defined term matches "${term}" in the terminology datasets. State this plainly.` };
      }
      return {
        name: "glossary.lookup",
        query: term,
        output: hits.map((r) => `- ${r.term} (${r.docidentifier}): ${String(r.text ?? "").split(" \u2014 ").slice(1).join(" \u2014 ").slice(0, 400)}`).join("\n")
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
var TOOLS_REGISTRY = [certificatesSearch, unitsGet, graphCites, docsSection, glossaryLookup];
var TOOL_DECLARATION = [
  "You may use one tool before answering, by writing a single line:",
  ...TOOLS_REGISTRY.filter((t) => t.audiences.includes("agent")).map((t) => {
    const shape = `{${t.params.map((p) => `"${p.key}": "<${p.description}>"`).join(", ")}}`;
    return `TOOL ${t.name} ${shape}`;
  }),
  "The worker runs it and returns the result attributed \u2014 phrase the tool's result as what it returned, with the searched string visible in your answer. Use a tool when the question turns on what it answers (including from a photograph). If you do not need it, answer directly without the line."
].join("\n");
async function runTool(env, call) {
  const spec = TOOLS_REGISTRY.find((t) => t.name === call.name && t.audiences.includes("agent"));
  if (!spec) return null;
  return spec.handler(env, call.args ?? {});
}
function toolNote(r) {
  return `The ${r.name} tool returned, for the query "${r.query}":
${r.output}`;
}

export {
  resolveBlocks,
  contractV2,
  tableRetyped,
  parseToolCall,
  TOOLS_REGISTRY,
  TOOL_DECLARATION,
  runTool,
  toolNote
};
