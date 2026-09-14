// The model plane (TODO.ai-platform/05) — the ask path's model-native
// grounding. The packages' machine content (the requirements' constraints,
// the applicability rules, the acceptance criteria, the term definitions)
// indexes alongside the prose corpus; this module is the deterministic
// half at ask time:
//
//   1. BIND — "this requirement" on a model surface (the platform's
//      entity chip) names the model node by its canonical id (the label
//      leads with it, e.g. "this requirement /req/metrological/mpe — …");
//      a question may name one too. The grammar is strict — a node id is
//      a machine shape, never fuzzy-matched.
//   2. GROUND — the bound node's own content (from the model_nodes D1
//      store, loaded from the smart repo's derived bundles) joins the
//      prompt as a structured grounding block: the constraint (quoted
//      verbatim), the applicability, the acceptance, the provenance, the
//      tests. A DECLARED source discrepancy (the model and the text
//      disagree) rides verbatim — the clause-drift doctrine's posture is
//      structural: the answer must surface it and cite both.
//   3. ECHO — context_applied.model names the bound node so the panel's
//      honest context line never invents the grounding.
//
// The verdict-explanation discipline is the smart repo's (its engine's
// trace seam — never reimplemented here): this module grounds in the
// model NODE (the static constraint + clause + acceptance); a live
// verdict's explanation is the platform's computation, quoted when the
// platform serves it — this service never recomputes one.

/** The strict model-node id grammar: the kind prefix + one or two
 *  slug segments (the packages' identifier shapes — /req/<class>/<id>,
 *  /conf/<class>/<id>, /term/<id>, /constraint/<id>, /characteristic/<id>,
 *  /state-machine/<id>, /dimension/<id>). */
import { P } from "./profile.ts";
const NODE_RE = /(?:^|[\s("'`])\/(req|conf|term|constraint|characteristic|state-machine|dimension)\/([a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?)(?=[\s)"'`,;:.]|$)/i;

/** The first model-node id a text names (the declared chip label first,
 *  the question second — the caller orders). */
export function modelNodeRefIn(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = text.match(NODE_RE);
  if (!m) return null;
  const id = `/${m[1]!.toLowerCase()}/${m[2]}`;
  return id.length <= 120 ? id : null;
}

/** The doc scope's publication family → the model plane's standard
 *  (doc_number "60" → oiml-r60). Only the four modeled Recommendations
 *  carry a plane; anything else resolves null (honest: no model to bind). */
export function standardForDocNumber(docNumber: string | undefined): string | null {
  if (!docNumber) return null;
  const models = P().sources?.models;
  if (!models?.standards?.length || !models?.standard_prefix) return null;
  return (models.standards as string[]).includes(docNumber) ? `${models.standard_prefix}${docNumber}` : null;
}

export interface BoundModelNode {
  standard: string;
  node_id: string;
  kind: string;
  name: string;
  clause: { doc: string; ref: string; urn: string } | null;
  /** The node's bundle projection (verbatim JSON). */
  content: any;
}

async function fetchNode(env: any, standard: string, nodeId: string): Promise<BoundModelNode | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT standard, node_id, kind, name, clause_doc, clause_ref, content FROM model_nodes WHERE standard = ?1 AND node_id = ?2",
    )
      .bind(standard, nodeId)
      .first();
    if (!row) return null;
    const content = JSON.parse(String(row.content));
    const clause =
      row.clause_doc && row.clause_ref
        ? { doc: String(row.clause_doc), ref: String(row.clause_ref), urn: `${row.clause_doc}#clause-${row.clause_ref}` }
        : row.clause_doc
          ? { doc: String(row.clause_doc), ref: "", urn: String(row.clause_doc) }
          : null;
    return {
      standard: String(row.standard),
      node_id: String(row.node_id),
      kind: String(row.kind),
      name: String(row.name ?? row.node_id),
      clause,
      content,
    };
  } catch {
    // the table predates the migration on this deployment, or D1 hiccuped:
    // the model plane degrades honestly (retrieval still carries the model
    // chunks) — never a hard failure of the ask.
    return null;
  }
}

/** Bind the ask's model node: the declared entity label's id wins (the
 *  model-aware chip), then a node id the question names. The standard
 *  comes from the declared doc scope when it carries one; without a scope
 *  the node binds only when it exists in EXACTLY ONE indexed standard —
 *  ambiguity is refused honestly (retrieval still surfaces the chunks). */
export async function bindModelNode(
  env: any,
  opts: { label?: string; query: string; standard?: string | null },
): Promise<BoundModelNode | null> {
  const nodeId = modelNodeRefIn(opts.label) ?? modelNodeRefIn(opts.query);
  if (!nodeId) return null;
  if (opts.standard) return fetchNode(env, opts.standard, nodeId);
  try {
    const rows = await env.DB.prepare("SELECT standard FROM model_nodes WHERE node_id = ?1 LIMIT 2").bind(nodeId).all();
    const standards = (rows?.results ?? []).map((r: any) => String(r.standard));
    if (standards.length === 1) return fetchNode(env, standards[0]!, nodeId);
    return null; // zero (not indexed) or ambiguous (several standards) — no silent pick
  } catch {
    return null;
  }
}

// ── the grounding block (the node's own content, composed) ───────────

function clip(s: unknown, n = 500): string {
  const t = String(s ?? "").trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + " …";
}

function applicabilityText(app: any): string {
  if (!app || typeof app !== "object") return "";
  const parts: string[] = [];
  for (const [dim, cond] of Object.entries(app)) {
    if (Array.isArray(cond)) parts.push(`${dim.replace(/_/g, " ")}: ${cond.join(", ")}`);
    else if (cond && typeof cond === "object" && Array.isArray((cond as any).values)) {
      parts.push(`${dim.replace(/_/g, " ")} (${(cond as any).match ?? "any"}): ${(cond as any).values.join(", ")}`);
    }
  }
  return parts.join("; ");
}

/** The structured grounding block for the prompt — every line is the
 *  node's own declared content (the bundle projection), never a model
 *  paraphrase. The discrepancy block, when the model declares one, is the
 *  model/prose disagreement posture made structural. */
export function modelGroundingBlock(node: BoundModelNode): string {
  const c = node.content ?? {};
  const lines: string[] = [];
  lines.push(
    P().prompts.vars.model_grounding_intro ?? "Model grounding — the model plane's own statement:",
  );
  lines.push(`Node: ${node.node_id} (${node.kind.replace(/_/g, " ")}) — ${node.name} [${node.standard}]`);
  if (node.clause) lines.push(`Provenance: ${node.clause.urn}`);
  if (c.statement) lines.push(`Statement: ${clip(c.statement)}`);
  if (c.definition) lines.push(`Definition: ${clip(c.definition)}`);
  if (c.purpose) lines.push(`Purpose: ${clip(c.purpose)}`);
  const limit = c.limit ?? {};
  if (limit.expression) lines.push(`Machine limit (the constraint the platform's verdict engine evaluates — quote it verbatim): ${limit.expression}`);
  if (limit.accepts?.verdict) lines.push(`Machine limit: ${limit.accepts.verdict} ${limit.accepts.op} ${limit.accepts.limit} (the canonical acceptance chain)`);
  if (c.check) lines.push(`Machine check: ${c.check}`);
  if (c.derive) lines.push(`Derivation: ${c.derive}${Array.isArray(c.inputs) ? ` (inputs: ${c.inputs.join(", ")})` : ""}`);
  const app = applicabilityText(c.applicability);
  const scopeApp = applicabilityText(c.scope_applicability);
  if (app || scopeApp) lines.push(`Applicability: ${[scopeApp, app].filter(Boolean).join("; ")}`);
  if (Array.isArray(c.binds_to) && c.binds_to.length) lines.push(`Binds to: ${c.binds_to.join(", ")}`);
  if (Array.isArray(c.targets) && c.targets.length) lines.push(`Verifies requirements: ${c.targets.join(", ")}`);
  if (Array.isArray(c.preconditions) && c.preconditions.length) {
    const pcs = c.preconditions.map((p: any) => `${p.id}: ${clip(p.check ?? (p.state ? `state = ${p.state}` : ""), 120)}`).join("; ");
    lines.push(`Run-validity preconditions (a violation voids the run — invalid, never a fail): ${pcs}`);
  }
  if (c.acceptance_criteria?.description) lines.push(`Acceptance: ${clip(c.acceptance_criteria.description, 300)}`);
  if (c.violation_meaning) lines.push(`Violation meaning (verbatim): ${clip(c.violation_meaning, 300)} — on violation: ${c.on_violation ?? "invalid"}`);
  if (Array.isArray(c.values) && c.values.length) {
    lines.push(`Values: ${c.values.map((v: any) => `${v.id}${v.implies?.length ? ` (implies ${v.implies.join(", ")})` : ""}`).join("; ")}`);
  }
  if (c.source_discrepancy) {
    const sd = c.source_discrepancy;
    lines.push(
      `DECLARED SOURCE DISCREPANCY — the model and the text disagree; you MUST surface this and cite both: ${clip(sd.summary, 300)} ` +
        `Sources: ${(sd.sources ?? []).join(" and ")}. The model ${sd.resolution === "follows_clause_x" ? "follows one side" : "records the conflict without resolving it"}: ${clip(sd.rationale, 300)}`,
    );
  }
  lines.push(
    "Rules for this answer: the machine facts (the constraint, the applicability, the acceptance, the provenance) come from THIS node — quote the machine limit verbatim, never invent one the node does not carry. If this model content and a prose passage disagree — including a passage from a different edition — say so explicitly and cite both (this node and the prose clause).",
  );
  return lines.join("\n");
}

/** The citation the panel renders for the bound node (the model plane is
 *  a first-class corpus: the citation names the node + its clause). */
export function modelCitation(node: BoundModelNode) {
  return {
    doc_id: `model:${node.standard}`,
    docidentifier: `OIML SMART model (${node.standard.replace(/^oiml-r/, "R ")})`,
    edition: "",
    language: "en",
    clause_anchor: node.clause?.ref || "model",
    clause_title: `${node.kind.replace(/_/g, " ")} — ${node.name} (${node.node_id})`,
    status: "in-force",
    corpus: "smart-model",
    url: undefined,
    snippet: `${node.node_id}${node.clause ? ` · ${node.clause.urn}` : ""}${node.content?.statement ? ` — ${clip(node.content.statement, 240)}` : ""}`,
    score: 1,
  };
}

/** The context_applied echo's model block — the honest context line's
 *  grounding record. */
export function modelEcho(node: BoundModelNode) {
  return {
    node_id: node.node_id.slice(0, 120),
    kind: node.kind.slice(0, 40),
    standard: node.standard.slice(0, 40),
    ...(node.clause?.urn ? { clause: node.clause.urn.slice(0, 120) } : {}),
  };
}

/** The per-corpus guidance note (config.ts's DATASETS pattern — every
 *  retrieved model-plane chunk carries it, chip or no chip). */
export function modelCorpusNote(): string {
  return P().prompts.vars.model_passage_note ?? "";
}
