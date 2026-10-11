// The data-plane grammar (the owner's 2026-10-12 direction, "the model
// decides what and how to look for data"): instead of pre-enumerated
// operation menus, the agent gets the PUBLISHED SCHEMA and composes
// typed predicates over it. db.schema answers "what is queryable";
// db.find answers the question. The engine compiles predicates to
// parameterized SQL — the model never writes SQL, identifiers never
// interpolate from model input, values always bind. BIRD-INTERACT
// (2026) grounding: interactive data questions collapse without schema
// linkage, so every validation error NAMES the valid columns.

export interface CatalogColumn {
  name: string;
  type: "text" | "number";
  description: string;
  /** ordering/comparison compiles CAST(col AS INTEGER) — textual columns
   *  carrying numeric content (certificates.year is TEXT in D1) */
  numeric_cast?: boolean;
  /** excluded from the default select (heavy bodies); still selectable by name */
  wide?: boolean;
}

export interface CatalogTable {
  name: string;
  description: string;
  columns: CatalogColumn[];
  default_select: string[];
}

// PUBLISHED tables only — public corpus data. Everything holding user
// or operational state (api_keys, queries, spend, feedback, memories,
// projects, project_files, conversations, messages, shared_conversations,
// conversation_entities, attachments, model_plane_meta, ask retries and
// usage caches) is deliberately absent: db.find cannot reach it.
export const DB_CATALOG: CatalogTable[] = [
  {
    name: "certificates",
    description:
      "The certificate register (a snapshot, not live certification status): one row per issued certificate across the recommendation families.",
    columns: [
      { name: "num", type: "text", description: "the printed certificate number, e.g. R60/2021-A-NL1-26.12 (family/prefix per recommendation)" },
      { name: "family", type: "text", description: "the recommendation family number, e.g. '60' for R 60" },
      { name: "holder", type: "text", description: "the certificate holder (manufacturer)" },
      { name: "model", type: "text", description: "the instrument model designation" },
      { name: "year", type: "number", description: "the issue year", numeric_cast: true },
      { name: "status", type: "text", description: "Valid | Suspended | Withdrawn" },
      { name: "pdf_key", type: "text", description: "the /cert-pdf path suffix when the PDF is on file, else empty" },
    ],
    default_select: ["num", "family", "holder", "model", "year", "status", "pdf_key"],
  },
  {
    name: "documents",
    description:
      "The document identity registry: every publication edition with its family, part, and derived edition status (an edition with a successor is superseded regardless of any copied status field).",
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
      { name: "title", type: "text", description: "the publication title" },
    ],
    default_select: ["canonical_id", "docidentifier", "family", "part", "edition", "derived_status", "active", "superseded_by", "title"],
  },
  {
    name: "graph_nodes",
    description: "The public citation-graph nodes: documents, families, and vocabulary concepts.",
    columns: [
      { name: "id", type: "text", description: "doc:<identifier-slug> | family:<number> | concept:<id>" },
      { name: "kind", type: "text", description: "doc | family | concept" },
      { name: "label", type: "text", description: "the display label" },
    ],
    default_select: ["id", "kind", "label"],
  },
  {
    name: "graph_edges",
    description: "The public citation-graph edges between nodes.",
    columns: [
      { name: "src", type: "text", description: "the source node id" },
      { name: "dst", type: "text", description: "the destination node id" },
      { name: "kind", type: "text", description: "part_of | variant_of | successor | amends | defines" },
    ],
    default_select: ["src", "kind", "dst"],
  },
  {
    name: "model_nodes",
    description:
      "The Recommendation model plane (per-standard requirement/conformance graphs): the machine-readable nodes behind the verdict engine.",
    columns: [
      { name: "standard", type: "text", description: "the standard key, e.g. r60" },
      { name: "node_id", type: "text", description: "/req/metrological/mpe" },
      { name: "kind", type: "text", description: "requirement | conformance_test | term | constraint | characteristic | state_machine | dimension" },
      { name: "name", type: "text", description: "the node's display name" },
      { name: "clause_doc", type: "text", description: "the provenance document urn" },
      { name: "clause_ref", type: "text", description: "the clause inside it, e.g. 5.3.2" },
      { name: "content", type: "text", description: "the node's JSON projection (the checks, thresholds, parameters)", wide: true },
      { name: "content_hash", type: "text", description: "sha256 of content" },
    ],
    default_select: ["standard", "node_id", "kind", "name", "clause_doc", "clause_ref"],
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
      { name: "payload", type: "text", description: "the producer payload JSON (the table's rows, the formula's math)", wide: true },
    ],
    default_select: ["unit_id", "doc_id", "docidentifier", "edition", "clause_anchor", "type"],
  },
  {
    name: "chunks",
    description:
      "The indexed corpus chunks (one row per clause-level passage) — use for exact metadata questions; semantic search is NOT this tool's job.",
    columns: [
      { name: "id", type: "text", description: "the chunk id" },
      { name: "doc_id", type: "text", description: "the source document slug" },
      { name: "docidentifier", type: "text", description: "the publication identifier with part" },
      { name: "doctype", type: "text", description: "R | D | B | G | E" },
      { name: "doc_number", type: "text", description: "60" },
      { name: "edition", type: "text", description: "the edition year" },
      { name: "language", type: "text", description: "en | fr | …" },
      { name: "clause_anchor", type: "text", description: "the clause anchor" },
      { name: "clause_title", type: "text", description: "the clause title" },
      { name: "status", type: "text", description: "in-force | superseded" },
      { name: "superseded_by", type: "text", description: "the superseding docidentifier, else empty" },
      { name: "corpus", type: "text", description: "clean | dirty" },
      { name: "tier", type: "text", description: "the quality tier" },
      { name: "text", type: "text", description: "the passage body (wide — select only when needed)", wide: true },
      { name: "fts_text", type: "text", description: "context preamble + body (wide)", wide: true },
    ],
    default_select: ["id", "doc_id", "docidentifier", "doctype", "doc_number", "edition", "language", "clause_anchor", "clause_title", "status", "corpus"],
  },
];

export function publishedTable(name: string): CatalogTable | undefined {
  return DB_CATALOG.find((t) => t.name === name);
}

// ── the predicate compiler (pure; unit-tested) ────────────────────────

export const FIND_OPS = ["eq", "ne", "lt", "le", "gt", "ge", "in", "like", "between"] as const;
export type FindOp = (typeof FIND_OPS)[number];

export interface FindPredicate {
  col: string;
  op: FindOp;
  value: unknown;
}

export interface FindArgs {
  table: string;
  where?: FindPredicate[];
  select?: string[];
  order_by?: { col: string; dir?: "asc" | "desc" };
  limit?: number;
  group_by?: string[];
  agg?: { fn: "count" | "sum" | "avg" | "min" | "max"; col?: string };
}

export type Compiled =
  | { ok: true; sql: string; params: unknown[]; echo: string }
  | { ok: false; error: string };

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

const NUMERIC_OPS: FindOp[] = ["lt", "le", "gt", "ge", "between"];

/** Compile validated identifiers + bound parameters. Returns a
 *  schema-linked error (naming the valid columns) on any mismatch —
 *  the model corrects from the error, the loop continues. */
export function compileFind(args: FindArgs): Compiled {
  const table = publishedTable(String(args?.table ?? ""));
  if (!table) {
    return {
      ok: false,
      error: `unknown table "${String(args?.table ?? "")}". Published tables: ${DB_CATALOG.map((t) => t.name).join(", ")}.`,
    };
  }
  const colNames = table.columns.map((c) => c.name);
  const colByName = new Map(table.columns.map((c) => [c.name, c]));
  const params: unknown[] = [];
  const phrases: string[] = [];
  const p = (n: number) => `?${n}`;

  const colRef = (col: string): string => {
    const c = colByName.get(col)!;
    return c.numeric_cast ? `CAST(${col} AS INTEGER)` : col;
  };

  for (const w of Array.isArray(args?.where) ? args.where : []) {
    const col = String(w?.col ?? "");
    const colDef = colByName.get(col);
    if (!colDef) {
      return {
        ok: false,
        error: `table "${table.name}" has no column "${col}". Valid columns: ${colNames.join(", ")}.`,
      };
    }
    const op = String(w?.op ?? "") as FindOp;
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
      const pair = Array.isArray(v) ? v : [undefined, undefined];
      if (pair.length !== 2) return { ok: false, error: `op "between" needs a two-element value [lo, hi].` };
      phrases.push(`${ref} BETWEEN ${p(params.push(pair[0]))} AND ${p(params.push(pair[1]))}`);
    } else if (op === "like") {
      phrases.push(`${ref} LIKE ${p(params.push(String(v)))}`);
    } else {
      const sqlOp = { eq: "=", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" }[op as "eq" | "ne" | "lt" | "le" | "gt" | "ge"];
      phrases.push(`${ref} ${sqlOp} ${p(params.push(v))}`);
    }
  }

  const select = (Array.isArray(args?.select) && args.select.length ? args.select : table.default_select).map(String);
  for (const s of select) {
    if (!colNames.includes(s)) {
      return { ok: false, error: `table "${table.name}" has no column "${s}". Valid columns: ${colNames.join(", ")}.` };
    }
  }

  let head: string;
  if (args?.agg?.fn) {
    const fn = String(args.agg.fn) as "count" | "sum" | "avg" | "min" | "max";
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
    head = `SELECT ${args?.group_by?.length ? `${(args.group_by as string[]).map(String).join(", ")}, ` : ""}${aggExpr} AS agg FROM ${table.name}`;
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
  if (args?.group_by?.length) tail += ` GROUP BY ${(args.group_by as string[]).map(String).join(", ")}`;
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
    args?.agg?.fn ? `${args.agg.fn}${args.agg.col ? ` ${args.agg.col}` : ""}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    ok: true,
    sql: `${head}${where}${tail}`,
    params,
    echo,
  };
}

/** The db.find handler: compile, run on D1, format deterministically.
 *  Every output carries the predicate echo — the answer attributes the
 *  rows to the query that produced them. */
export async function runFind(env: any, args: FindArgs): Promise<{ name: string; query: string; output: string } | null> {
  const compiled = compileFind(args);
  if (!compiled.ok) {
    return {
      name: "db.find",
      query: String(args?.table ?? ""),
      output: `The query was rejected: ${compiled.error} Correct the predicates and call again.`,
    };
  }
  try {
    const { portStore } = await import("./env.ts");
    const res = await portStore(env).prepare(compiled.sql).bind(...compiled.params).all();
    const rows = (res?.results ?? []) as Record<string, unknown>[];
    const body = rows.length
      ? rows.map((r) => JSON.stringify(r)).join("\n")
      : "No rows matched. Either the predicates are too narrow or the data is absent — state which, and consider widening.";
    const aggNote = args?.agg?.fn ? " (aggregate)" : "";
    return { name: "db.find", query: compiled.echo, output: `${compiled.echo}${aggNote} → ${rows.length} row(s):\n${body}` };
  } catch (e: any) {
    return { name: "db.find", query: compiled.echo, output: `The query failed to run: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

/** The db.schema handler: the published map, one table or the catalog. */
export function runSchema(table?: string): { name: string; query: string; output: string } {
  const tables = table ? [publishedTable(String(table))].filter(Boolean) : DB_CATALOG;
  if (!tables.length) {
    return {
      name: "db.schema",
      query: String(table),
      output: `Unknown table "${table}". Published tables: ${DB_CATALOG.map((t) => t.name).join(", ")}.`,
    };
  }
  const output = (tables as CatalogTable[])
    .map((t) => {
      const cols = t.columns
        .map((c) => `  ${c.name} (${c.type}${c.numeric_cast ? ", numeric-cast" : ""}${c.wide ? ", wide" : ""}) — ${c.description}`)
        .join("\n");
      return `${t.name} — ${t.description}\n${cols}\n  default select: ${t.default_select.join(", ")}`;
    })
    .join("\n\n");
  return {
    name: "db.schema",
    query: table ? String(table) : "catalog",
    output: `Published tables (compose TOOL db.find with where: [{col, op, value}]; ops: ${FIND_OPS.join(" ")}; values bind safely; like accepts % and _ wildcards):\n\n${output}`,
  };
}
