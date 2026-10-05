// The content-plane MCP tools (the owner's 2026-10-04 direction): a
// content plane earns a tool when its answer is MACHINE-SHAPED —
// structured data an agent computes with, not prose it re-reads. Every
// handler wraps the SAME query surface the API serves; entitlement
// scope rides the metadata the serving path already enforces. These are
// MCP-audience only: the agent path's declaration stays small because
// tool-selection quality degrades with menu size.
import type { ToolSpec } from "./tools.ts";
import { resolveBlocks } from "./refs.ts";
import { portIndex, portModelRunner, hasLane, portStore } from "./env.ts";
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
    { key: "standard", required: false, description: "the package id when the node id indexes under several standards, as the ambiguity message names it" },
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const node_id = String(args?.node_id ?? "").trim();
    const question = String(args?.question ?? "").trim();
    const standard = args?.standard ? String(args.standard).trim() : null;
    if (!node_id.startsWith("/") || question.length < 4) return null;
    try {
      // the same zero-or-ambiguous rule bindModelNode applies: a node
      // id that indexes under exactly one standard resolves; several
      // or none resolve to nothing — no silent pick (the standard
      // param is the caller's disambiguator)
      const rows = standard
        ? await env.DB.prepare("SELECT standard, kind, name, content FROM model_nodes WHERE node_id = ?1 AND standard = ?2 LIMIT 2").bind(node_id, standard).all()
        : await env.DB.prepare("SELECT standard, kind, name, content FROM model_nodes WHERE node_id = ?1 LIMIT 2").bind(node_id).all();
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


// The bibliography record (the owner's 2026-10-04 direction): the full
// registry entry for one citation label — what documents exist under
// it, their derived status, the successor/amends/variant edges, and
// what it cites and is cited by. graph.cites names the labels; this is
// the record behind the label, for agents that cite properly.
export const bibEntry: ToolSpec = {
  name: "bib.entry",
  description:
    "Fetch the bibliographic registry record for a citation label: every edition document under it with derived status (in-force/superseded, the ACTIVE flag), the relation edges (successor, amends, variant), and its outgoing citations. Use after graph.cites to resolve a cited label to its own record.",
  params: [
    { key: "label", required: true, description: "the citation label exactly as graph.cites returns it, e.g. ISO 8601" },
  ],
  audiences: ["mcp"],
  handler: async (env, args) => {
    const label = String(args?.label ?? "").trim();
    if (label.length < 2) return null;
    try {
      const rows = await env.DB.prepare(
        "SELECT id, kind, label FROM graph_nodes WHERE label = ?1 COLLATE NOCASE LIMIT 5",
      )
        .bind(label)
        .all();
      let nodes = ((rows.results ?? []) as { id: string; kind: string; label: string }[]);
      if (!nodes.length) {
        // the docidentifier form ("OIML R 60:2017") is a documents-
        // registry key, not a graph label (labels are titles) — resolve
        // it through the registry and synthesize the node rows
        const d = await env.DB.prepare(
          "SELECT canonical_id, docidentifier FROM documents WHERE docidentifier = ?1 COLLATE NOCASE LIMIT 5",
        )
          .bind(label)
          .all();
        nodes = ((d.results ?? []) as { canonical_id: string; docidentifier: string }[]).map((r) => ({
          id: r.canonical_id,
          kind: "doc",
          label: r.docidentifier,
        }));
      }
      if (!nodes.length) {
        return { name: "bib.entry", query: label, output: `No registry node carries the label "${label}". State this plainly.` };
      }
      const out: unknown[] = [];
      for (const n of nodes) {
        const entry: Record<string, unknown> = { label: n.label, kind: n.kind };
        if (n.kind === "doc") {
          const d = await env.DB.prepare(
            "SELECT docidentifier, family, part, edition, derived_status, active, superseded_by, title FROM documents WHERE canonical_id = ?1",
          )
            .bind(n.id)
            .all();
          const doc = (d.results ?? [])[0] as Record<string, unknown> | undefined;
          if (doc) {
            entry.document = {
              docidentifier: doc.docidentifier,
              family: doc.family,
              part: doc.part,
              edition: doc.edition,
              status: doc.derived_status,
              active: !!doc.active,
              superseded_by: doc.superseded_by,
              title: doc.title,
            };
          }
        }
        const rel = await env.DB.prepare(
          "SELECT e.kind, n.label AS target FROM graph_edges e JOIN graph_nodes n ON e.dst = n.id WHERE e.src = ?1 LIMIT 25",
        )
          .bind(n.id)
          .all();
        const relations = ((rel.results ?? []) as { kind: string; target: string }[]);
        if (relations.length) entry.relations = relations;
        const cites = await env.DB.prepare(
          "SELECT n.label AS cited FROM graph_edges e JOIN graph_nodes n ON e.dst = n.id WHERE e.src = ?1 AND e.kind = 'cites' LIMIT 40",
        )
          .bind(n.id)
          .all();
        const cited = ((cites.results ?? []) as { cited: string }[]).map((r) => r.cited).filter(Boolean);
        if (cited.length) entry.cites = cited;
        out.push(entry);
      }
      return { name: "bib.entry", query: label, output: JSON.stringify(out) };
    } catch {
      return null;
    }
  },
};


// The unitsdb plane (the owner's 2026-10-05 direction): measurement
// units as machine-shaped data — the dataset's typed projection in D1
// (units_db / unit_quantities / unit_prefixes), served as tools agents
// compute with. Conversion is honest about its scope: SI-coherent
// units convert through prefix powers; the dataset defines no numeric
// factors for non-SI units (foot, pound) — a ratio scale is not a
// factor — and the tool says so instead of inventing one.

interface UnitRow {
  code: string;
  short: string | null;
  name_en: string | null;
  name_fr: string | null;
  root: number;
  symbols: string | null;
  root_units: string | null;
  dimension_id: string | null;
  dimension_ascii: string | null;
  quantity_ids: string | null;
  unit_system: string | null;
  scale: string | null;
}

async function unitByTerm(store: any, term: string): Promise<UnitRow | null> {
  const t = term.trim();
  if (!t) return null;
  const q = (where: string, bind: unknown[]) =>
    store.prepare(`SELECT * FROM units_db WHERE ${where} LIMIT 1`).bind(...bind).all().catch(() => ({ results: [] }));
  const exact = await q("code = ?1 OR short = ?1 OR LOWER(name_en) = LOWER(?1)", [t]);
  let rows = (exact.results ?? []) as UnitRow[];
  if (rows.length) return rows[0]!;
  const sym = await q("LOWER(json_extract(symbols, '$.ascii')) = LOWER(?1)", [t]);
  rows = (sym.results ?? []) as UnitRow[];
  if (rows.length) return rows[0]!;
  const like = await q("LOWER(short) LIKE LOWER(?1) OR LOWER(name_en) LIKE LOWER(?1)", [`%${t}%`]);
  rows = (like.results ?? []) as UnitRow[];
  return rows[0] ?? null;
}

/** A prefixed input ("kPa", "km"): the first symbols name a prefix,
 *  the remainder a unit — the dataset does not enumerate prefixed
 *  variants, they are derived. Returns the factor the prefix carries. */
async function resolveWithPrefix(store: any, term: string): Promise<{ unit: UnitRow; prefixFactor: number; prefixName: string | null } | null> {
  const direct = await unitByTerm(store, term);
  if (direct) return { unit: direct, prefixFactor: 1, prefixName: null };
  const t = term.trim();
  for (let cut = 1; cut < Math.min(t.length, 3); cut++) {
    const pSym = t.slice(0, cut);
    const rest = t.slice(cut);
    if (!rest) continue;
    const pres = await store
      .prepare("SELECT id, name_en, symbol, base, power FROM unit_prefixes WHERE symbol = ?1 AND base IS NOT NULL AND power IS NOT NULL")
      .bind(pSym)
      .all()
      .catch(() => ({ results: [] }));
    const prefix = (pres.results ?? [])[0] as { id: string; name_en: string | null; symbol: string; base: number; power: number } | undefined;
    if (!prefix) continue;
    const unit = await unitByTerm(store, rest);
    if (unit) return { unit, prefixFactor: Math.pow(prefix.base, prefix.power), prefixName: prefix.name_en };
  }
  return null;
}

export const unitsLookup: ToolSpec = {
  name: "units.lookup",
  description:
    "Look up a measurement unit in the unitsdb plane: its names and symbols, its dimension, its quantity kinds, and its SI decomposition. Bind a symbol or an everyday unit name to the dataset's canonical unit before computing with it.",
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
      const qtyNames: string[] = [];
      for (const qid of JSON.parse(unit.quantity_ids || "[]") as string[]) {
        const r = await store.prepare("SELECT name_en FROM unit_quantities WHERE id = ?1").bind(qid).all().catch(() => ({ results: [] }));
        const n = ((r.results ?? [])[0] as any)?.name_en;
        if (n) qtyNames.push(n);
      }
      const roots: { code: string; power: number }[] = JSON.parse(unit.root_units || "[]");
      const rootNames = await Promise.all(
        roots.map(async (r) => {
          const row = await unitByTerm(store, r.code);
          return `${row?.short ?? r.code}^${r.power}`;
        }),
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
          scale: unit.scale,
        }),
      };
    } catch {
      return null;
    }
  },
};

export const unitsConvert: ToolSpec = {
  name: "units.convert",
  description:
    "Convert a value between two measurement units through the unitsdb plane. SI-coherent units convert exactly (prefix powers over the same dimension); a non-SI unit is stated honestly — the dataset defines a ratio scale for it, not a factor, and none is invented.",
  params: [
    { key: "value", required: true, description: "the numeric value to convert" },
    { key: "from_unit", required: true, description: "the source unit, e.g. kPa, km, m" },
    { key: "to_unit", required: true, description: "the target unit, e.g. Pa, m" },
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
        return { name: "units.convert", query: `${value} ${fromTerm} → ${toTerm}`, output: `No unit matches "${missing}" in the unitsdb plane. State this plainly.` };
      }
      if ((from.unit.dimension_ascii ?? "") !== (to.unit.dimension_ascii ?? "")) {
        return {
          name: "units.convert",
          query: `${value} ${fromTerm} → ${toTerm}`,
          output: `Not convertible: ${fromTerm} carries dimension ${from.unit.dimension_ascii ?? "unknown"} and ${toTerm} carries ${to.unit.dimension_ascii ?? "unknown"}. State this plainly.`,
        };
      }
      const coherent = (u: UnitRow) => !!u.unit_system && u.unit_system.toLowerCase().startsWith("si");
      if (!coherent(from.unit) || !coherent(to.unit)) {
        const nonSi = !coherent(from.unit) ? fromTerm : toTerm;
        return {
          name: "units.convert",
          query: `${value} ${fromTerm} → ${toTerm}`,
          output: `The dataset defines no numeric factor for ${nonSi} (a non-SI unit carried on a ${from.unit.scale ?? to.unit.scale ?? "ratio"} scale) — no factor is invented. State this plainly; the caller may supply the factor itself.`,
        };
      }
      const result = (value * from.prefixFactor) / to.prefixFactor;
      return {
        name: "units.convert",
        query: `${value} ${fromTerm} → ${toTerm}`,
        output: JSON.stringify({
          value,
          from: `${from.prefixName ? from.prefixName + " " : ""}${from.unit.name_en}`,
          to: `${to.prefixName ? to.prefixName + " " : ""}${to.unit.name_en}`,
          dimension: from.unit.dimension_ascii,
          result,
        }),
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
