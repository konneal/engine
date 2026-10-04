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
import { standardKeysFrom } from "./requestScope.ts";
import { licenseBoundaryRefusal, licensedEntryForDocNumber, licensedEntryForPackage } from "./modelplane.ts";
import { evaluate as evaluateVerdict } from "./verdict.ts";
import { evaluateConditionSets } from "./conditions.ts";

const slug = (docidentifier: string) =>
  docidentifier
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const unitsGet: ToolSpec = {
  name: "units.get",
  description:
    "Fetch typed Recommendation content — a table, formula or figure as structured data (columns, rows, MathML, caption), by its unit id. The machine-consumable form of a Recommendation's content, for computing with rather than reading.",
  params: [{ key: "unit_id", required: true, description: "the unit id exactly as an answer's [[u:…]] reference spells it" }],
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

export const documentsFamily: ToolSpec = {
  name: "documents.family",
  description:
    "Look up the publication registry for a family: every edition with its derived status (in-force/superseded), which edition is ACTIVE (terminal of the successor chain), and supersession links. Use for current/latest-edition and edition-history questions.",
  params: [{ key: "family", required: true, description: "the family key, e.g. R-60 (series letter and number)" }],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const family = String(args?.family ?? "").trim().toUpperCase();
    if (!/^[A-Z]-\d{1,3}$/.test(family)) return null;
    try {
      const rows = await env.DB.prepare(
        "SELECT d.docidentifier, d.derived_status, d.active, s.docidentifier AS succ FROM documents d LEFT JOIN documents s ON d.superseded_by = s.canonical_id WHERE d.family = ?1 ORDER BY d.part, d.edition",
      )
        .bind(family)
        .all();
      const lines = ((rows.results ?? []) as { docidentifier: string; derived_status: string; active: number; succ: string | null }[]).map(
        (r) => `${r.docidentifier} — ${r.derived_status}${r.active ? " [ACTIVE]" : ""}${r.succ ? ` → superseded by ${r.succ}` : ""}`,
      );
      if (!lines.length) {
        return { name: "documents.family", query: family, output: `No editions are registered for the family ${family}. State this plainly.` };
      }
      return { name: "documents.family", query: family, output: lines.join("\n") };
    } catch {
      return null;
    }
  },
};


// The licensed library (the owner's 2026-10-04 direction): "return
// clause X of document Y" for licensed standards, behind the SAME
// entitlement predicate the ask path applies — the caller declares
// keys, the deployment's declared whitelist validates them (a forged
// key can never widen scope), and the unentitled caller receives the
// boundary refusal: the standard's title and edition, the declare
// pointer, never a word of the text. The entitled caller gets the
// model plane's typed nodes for the clause — the computing form.
export const licensedSection: ToolSpec = {
  name: "licensed.section",
  description:
    "Fetch one clause of a licensed standard's typed model content — requirements, condition sets and parameters as structured data — behind the caller's license entitlement keys. An unentitled caller receives the license boundary: the standard's title and edition and the declare flow, never its text.",
  params: [
    { key: "doc", required: true, description: "the standard's document number, e.g. 60068-2-30 or 61000-4-2" },
    { key: "clause", required: true, description: "the clause number inside the standard, e.g. 5 or 9" },
    { key: "licensed_standards", required: true, description: 'the caller\'s license entitlement keys, e.g. ["std:iec-60068-2-30"] — validated against the licenses this deployment declares; keys it does not know drop' },
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const doc = String(args?.doc ?? "").trim();
    const clause = String(args?.clause ?? "").trim();
    if (doc.length < 3 || !clause) return null;
    // "IEC 60068-2-30" / "ISO/IEC 17025" → the bare doc number the
    // licensed registry keys on
    const docNumber = doc.replace(/^(?:ISO\/IEC|ISO|IEC)\s+/i, "").trim();
    const entry = licensedEntryForDocNumber(docNumber);
    if (!entry) {
      return {
        name: "licensed.section",
        query: `${doc} §${clause}`,
        output: `"${doc}" is not among the licensed standards this deployment keys. For clauses of the public corpus use the docs.section tool instead. State this plainly.`,
      };
    }
    const keys = standardKeysFrom({ licensed_standards: args?.licensed_standards });
    if (!keys.has(entry.key)) {
      const refusal = licenseBoundaryRefusal(docNumber, keys);
      return {
        name: "licensed.section",
        query: `${doc} §${clause}`,
        output: refusal ?? "License boundary — the caller's entitlement set does not cover this standard's text.",
      };
    }
    try {
      const rows = await env.DB.prepare(
        "SELECT node_id, kind, name, clause_ref, content FROM model_nodes WHERE standard = ?1 AND clause_ref = ?2 ORDER BY node_id LIMIT 20",
      )
        .bind(entry.package, clause)
        .all();
      const nodes = ((rows.results ?? []) as { node_id: string; kind: string; name: string | null; clause_ref: string; content: string }[]);
      if (!nodes.length) {
        const c = await env.DB.prepare(
          "SELECT DISTINCT clause_ref FROM model_nodes WHERE standard = ?1 ORDER BY clause_ref",
        )
          .bind(entry.package)
          .all();
        const clauses = ((c.results ?? []) as { clause_ref: string }[]).map((r) => r.clause_ref).filter(Boolean).join(", ");
        return {
          name: "licensed.section",
          query: `${doc} §${clause}`,
          output: `No typed nodes are indexed for ${doc} §${clause}.${clauses ? ` The clauses with typed nodes: ${clauses}.` : ""} State this plainly.`,
        };
      }
      return {
        name: "licensed.section",
        query: `${doc} §${clause}`,
        output: JSON.stringify(
          nodes.map((n) => {
            let content: unknown = n.content;
            try { content = JSON.parse(n.content); } catch { /* verbatim when not JSON */ }
            return { node_id: n.node_id, kind: n.kind, name: n.name, clause: n.clause_ref, content };
          }),
        ),
      };
    } catch {
      return null;
    }
  },
};


// The deterministic engines as tools (the owner's 2026-10-04
// direction): computing with the standard, not reading it. Both wrap
// the engines the ask path already runs — no new evaluation logic
// lives here; the tool is the door, the engine is the authority.
// Void-when-parameters-miss is the honest contract: the tool states
// WHICH parameters the question did not state, never guesses.

export const verdictEvaluate: ToolSpec = {
  name: "verdict.evaluate",
  description:
    "Deterministically evaluate a model-plane node's machine checks (OCL boolean expressions, threshold limits) against the quantities a question states. Returns pass/fail with every check's expression and values, or void with the missing parameter names when the question does not state enough. The machine computes; cite the node's clause.",
  params: [
    { key: "node_id", required: true, description: "the model-plane node id, e.g. /req/metrological/repeatability (node ids appear in answers' verdict blocks)" },
    { key: "question", required: true, description: "the statement carrying the quantities, e.g. 'is mpe 0.02 with n_lc 3000 within the limit?'" },
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const node_id = String(args?.node_id ?? "").trim();
    const question = String(args?.question ?? "").trim();
    if (!node_id.startsWith("/") || question.length < 4) return null;
    try {
      // the same zero-or-ambiguous rule bindModelNode applies: a node
      // id that indexes under exactly one standard resolves; several
      // or none resolve to nothing — no silent pick
      const rows = await env.DB.prepare(
        "SELECT standard, kind, name, content FROM model_nodes WHERE node_id = ?1 LIMIT 2",
      )
        .bind(node_id)
        .all();
      const found = (rows.results ?? []) as { standard: string; kind: string; name: string | null; content: string }[];
      if (found.length !== 1) {
        return {
          name: "verdict.evaluate",
          query: node_id,
          output: found.length
            ? `The node id ${node_id} is indexed under several standards — name the standard to disambiguate. State this plainly.`
            : `No model-plane node ${node_id} is indexed. State this plainly.`,
        };
      }
      const node = found[0]!;
      const entry = licensedEntryForPackage(node.standard);
      if (entry) {
        return {
          name: "verdict.evaluate",
          query: node_id,
          output: licenseBoundaryRefusal(entry.doc_number, null) ?? "License boundary — the node belongs to a licensed standard the caller's entitlement set does not cover.",
        };
      }
      let content: unknown;
      try { content = JSON.parse(node.content); } catch { content = null; }
      const v = evaluateVerdict(content, question);
      if (!v) {
        return {
          name: "verdict.evaluate",
          query: node_id,
          output: `The node ${node_id} (${node.kind}) carries no machine-checkable expressions — it is not evaluatable by the verdict engine. State this plainly.`,
        };
      }
      return {
        name: "verdict.evaluate",
        query: node_id,
        output: JSON.stringify({ standard: node.standard, node_id, kind: node.kind, name: node.name, verdict: v.verdict, on_violation: v.on_violation, missing: v.missing, checks: v.checks }),
      };
    } catch {
      return null;
    }
  },
};

export const conditionsCheck: ToolSpec = {
  name: "conditions.check",
  description:
    "Check a stated combination of environmental quantities (temperature, humidity, duration, cycles) against the indexed severity/condition sets — the pass answer names the matched set and every band, the fail names the nearest set and its distance. Machine evaluation over the condition-set nodes; cite the matched set's clause.",
  params: [
    { key: "question", required: true, description: "the stated combination, e.g. 'damp heat cyclic test at 55 °C for 2 cycles of 24 h'" },
    { key: "standard", required: false, description: "optional scope, the package id, e.g. iec-60068-2-30 (defaults to every indexed condition set the caller may see)" },
    { key: "licensed_standards", required: false, description: 'license entitlement keys for licensed condition sets, validated against the deployment\'s declared licenses' },
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const question = String(args?.question ?? "").trim();
    if (question.length < 4) return null;
    const standard = args?.standard ? String(args.standard).trim() : null;
    const keys = standardKeysFrom({ licensed_standards: args?.licensed_standards });
    try {
      const rows = standard
        ? await env.DB.prepare("SELECT node_id, standard, content FROM model_nodes WHERE kind = 'condition_set' AND standard = ?1").bind(standard).all()
        : await env.DB.prepare("SELECT node_id, standard, content FROM model_nodes WHERE kind = 'condition_set'").all();
      const all = ((rows.results ?? []) as { node_id: string; standard: string; content: string }[]).map((r) => {
        let content: unknown = r.content;
        try { content = JSON.parse(r.content); } catch { /* verbatim */ }
        return { node_id: r.node_id, standard: r.standard, content };
      });
      // the ask path's own gate: licensed condition sets compete only
      // for entitled callers — the same licensedEntryForPackage filter
      const visible = all.filter((n) => {
        const entry = licensedEntryForPackage(n.standard);
        return !entry || keys.has(entry.key);
      });
      if (!visible.length) {
        return { name: "conditions.check", query: question, output: "No condition sets are indexed (or visible to this caller's entitlements). State this plainly." };
      }
      const v = evaluateConditionSets(visible, question);
      if (!v) {
        return { name: "conditions.check", query: question, output: "No quantities were recognized in the statement — state the values (temperature, humidity, duration, cycles). The engine checks stated numbers, never guesses." };
      }
      return {
        name: "conditions.check",
        query: question,
        output: JSON.stringify({ verdict: v.verdict, matched: v.matched, checks: v.checks }),
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
