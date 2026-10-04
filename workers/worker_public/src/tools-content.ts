// The content-plane MCP tools (the owner's 2026-10-04 direction): a
// content plane earns a tool when its answer is MACHINE-SHAPED —
// structured data an agent computes with, not prose it re-reads. Every
// handler wraps the SAME query surface the API serves; entitlement
// scope rides the metadata the serving path already enforces. These are
// MCP-audience only: the agent path's declaration stays small because
// tool-selection quality degrades with menu size.
import type { ToolSpec } from "./tools.ts";
import { resolveBlocks } from "./refs.ts";
import { portIndex, portModelRunner, hasLane } from "./env.ts";
import { embed } from "./ai.ts";
import { THRESHOLDS } from "./config.ts";

const slug = (docidentifier: string) =>
  docidentifier
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const unitsGet: ToolSpec = {
  name: "units.get",
  description:
    "Fetch typed Recommendation content — a table, formula or figure as structured data (columns, rows, MathML, caption), by its unit id. The machine-consumable form of a Recommendation's content, for computing with rather than reading.",
  params: [{ key: "unit_id", required: true, description: "the unit id, e.g. u:table-1 or u:form-3 (ids appear in answers' [[u:…]] references)" }],
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
        blocks.map((b: any) => ({ unit_id: b.unit_id, type: b.type, docidentifier: b.docidentifier, payload: b.payload })),
      ),
    };
  },
};

export const graphCites: ToolSpec = {
  name: "graph.cites",
  description:
    "The bibliography edges: what a publication's own bibliography actually cites, extracted from its indexed bibliography sections. Returns the cited works' labels for a document (optionally scoped to an edition).",
  params: [
    { key: "doc", required: true, description: "the publication identifier, e.g. R 60-1:2021" },
    { key: "edition", required: false, description: "an edition year to scope, e.g. 2021" },
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const doc = String(args?.doc ?? "").trim();
    if (doc.length < 3) return null;
    const edition = args?.edition ? String(args.edition).trim() : null;
    const pat = `%${doc.replace(/[:\s]+/g, "%")}%${edition ? edition : ""}%`;
    try {
      const rows = await env.DB.prepare(
        "SELECT DISTINCT n.label AS label FROM graph_edges e JOIN documents d ON e.src = d.canonical_id JOIN graph_nodes n ON e.dst = n.id WHERE d.docidentifier LIKE ?1 AND e.kind = 'cites' ORDER BY label LIMIT 60",
      )
        .bind(pat)
        .all();
      const labels = ((rows.results ?? []) as { label: string }[]).map((r) => r.label).filter(Boolean);
      return {
        name: "graph.cites",
        query: `${doc}${edition ? ` (${edition})` : ""}`,
        output: labels.length
          ? `The publication's bibliography cites:\n${labels.map((l) => `- ${l}`).join("\n")}`
          : `No bibliography citations are indexed for "${doc}"${edition ? ` (${edition})` : ""}. State this plainly.`,
      };
    } catch {
      return null;
    }
  },
};

export const docsSection: ToolSpec = {
  name: "docs.section",
  description:
    "Fetch one clause of a publication's rendered document — its text and its permanent deep-link URL — for agents that need the human-formatted passage with its anchor.",
  params: [
    { key: "doc", required: true, description: "the publication identifier, e.g. R 60-1:2021" },
    { key: "clause", required: true, description: "the clause anchor, e.g. 5.1.1 or annex-b" },
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const doc = String(args?.doc ?? "").trim();
    const clause = String(args?.clause ?? "").trim();
    if (doc.length < 3 || !clause) return null;
    try {
      const rows = await env.DB.prepare(
        "SELECT docidentifier, clause_anchor, clause_title, text FROM chunks WHERE docidentifier LIKE ?1 AND REPLACE(clause_anchor, ' ', '') = ?2 LIMIT 1",
      )
        .bind(`%${doc.replace(/[:\s]+/g, "%")}%`, clause)
        .all();
      const r = (rows.results ?? [])[0] as { docidentifier: string; clause_anchor: string; clause_title: string; text: string } | undefined;
      if (!r) {
        return { name: "docs.section", query: `${doc} §${clause}`, output: `No clause "${clause}" is indexed for "${doc}". State this plainly.` };
      }
      const url = `https://www.ommisa.org/docs/${slug(r.docidentifier)}.html#${r.clause_anchor}`;
      return {
        name: "docs.section",
        query: `${r.docidentifier} §${r.clause_anchor}`,
        output: JSON.stringify({ docidentifier: r.docidentifier, clause: r.clause_anchor, title: r.clause_title, url, text: (r.text ?? "").slice(0, 4000) }),
      };
    } catch {
      return null;
    }
  },
};

export const glossaryLookup: ToolSpec = {
  name: "glossary.lookup",
  description:
    "Look up a defined term in the terminology datasets — the concept's definition and its defining publication. Bind everyday words to the defined term before interpreting a question.",
  params: [{ key: "term", required: true, description: "the term or everyday phrase to bind, e.g. creep or load cell" }],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const term = String(args?.term ?? "").trim();
    if (term.length < 2) return null;
    if (!hasLane(env, "glossary")) return null;
    try {
      // the same lane the ask path's glossary stage queries: dense
      // candidates over the concept index, the cosine floor the stage
      // applies — retrieval proposes; the caller's model adjudicates
      const vec = await embed(portModelRunner(env), "", term);
      const cands = await portIndex(env, "glossary").query({ vector: vec, topK: 5 });
      const hits = cands
        .filter((m: any) => m.score >= THRESHOLDS.glossaryCosineFloor)
        .map((m: any) => ({
          term: String(m.metadata?.clause_title ?? "").trim(),
          definition: String(m.metadata?.chunk_text ?? "").split(" — ").slice(1).join(" — ").slice(0, 400),
          docidentifier: String(m.metadata?.docidentifier ?? ""),
        }))
        .filter((x) => x.term && x.definition);
      if (!hits.length) {
        return { name: "glossary.lookup", query: term, output: `No defined term matches "${term}" in the terminology datasets. State this plainly.` };
      }
      const seen = new Set<string>();
      const uniq = hits.filter((h) => {
        const k = h.term.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/labeler\b/g, "labeller").replace(/\s+/g, " ").trim();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 3);
      return {
        name: "glossary.lookup",
        query: term,
        output: uniq.map((h) => `- ${h.term} (${h.docidentifier}): ${h.definition}`).join("\n"),
      };
    } catch {
      return null;
    }
  },
};
