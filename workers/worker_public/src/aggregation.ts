// Table-payload aggregation (konneal/engine#91): count / min / max /
// interval lookup executed over the typed table nodes' payloads —
// deterministic arithmetic where the answer IS the table's content.
// The model narrates the computed value; it never computes. Interval
// rows follow the standards' own convention: a lower `*_gt` bound is
// exclusive, `*_min` inclusive, `*_max` inclusive, `null` the open top.

export interface AggregationVerdict {
  operation: "count" | "min" | "max" | "lookup";
  table: string;
  table_title?: string;
  column?: string;
  value: number | string | null;
  unit?: string;
  row?: Record<string, string>;
  note: string;
}

interface Column {
  name: string;
  type?: string;
  unit?: string;
}

const NUM = String.raw`-?\d+(?:[,\s]?\d{3})*(?:[.,]\d+)?`;

const UNIT_WORDS: Record<string, string[]> = {
  kg: ["mass", "load", "weight"],
  s: ["time", "duration", "second"],
  "km/h": ["speed", "velocity"],
  v: ["load"],
  degC: ["temperature"],
  ppm: ["range", "fraction"],
};

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/\s/g, "");
  if (!s || /^null$/i.test(s)) return null;
  // "1,000" is grouping, "0,5" is a decimal comma
  if (/^\d{1,3}(,\d{3})+([.,]\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function tokens(name: string): string[] {
  return name.toLowerCase().split("_").filter(Boolean);
}

function hasWord(queryLower: string, w: string): boolean {
  return new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`, "i").test(queryLower);
}

function columnScore(col: Column, queryLower: string): number {
  let score = 0;
  for (const t of tokens(col.name)) {
    if (["min", "max", "gt", "of"].includes(t)) continue;
    if (t.length >= 3 && queryLower.includes(t)) score += 1;
  }
  const hints = col.unit ? UNIT_WORDS[col.unit] : undefined;
  if (hints?.some((h) => hasWord(queryLower, h))) score += 1;
  return score;
}

function classColumn(cols: Column[]): Column | undefined {
  return cols.find((c) => c.name === "accuracy_class" || c.name === "metrological_class" || c.name.endsWith("_class"));
}

/** "class C", "class cd" → the class id the question names. */
function classToken(query: string): string | null {
  const m = query.match(/\bclass\s+([a-z0-9.]+)\b/i);
  return m ? m[1]!.toLowerCase() : null;
}

/** The class columns shaped `class_<id>` — classes as COLUMNS rather
 *  than as row values. Exact id first; a column whose suffix STARTS WITH
 *  the token serves compound class ids sharing one column (c → cd). */
function classAsColumn(cols: Column[], token: string): Column | undefined {
  const classCols = cols.filter((c) => /^class_[a-z0-9.]+$/.test(c.name));
  const exact = classCols.find((c) => c.name.slice(6) === token);
  if (exact) return exact;
  return classCols.find((c) => c.name.slice(6).startsWith(token));
}

function numericColumns(cols: Column[]): Column[] {
  return cols.filter((c) => c.type === "number" || c.type === "integer" || /^class_[a-z0-9.]+$/.test(c.name));
}

/** Interval pairs sharing a prefix: (a_min, a_max) inclusive-low,
 *  (a_gt, a_max) exclusive-low, `null` the open end. */
function intervalPairs(cols: Column[]): { low: Column; high: Column; exclusiveLow: boolean }[] {
  const byName = new Map(cols.map((c) => [c.name, c]));
  const pairs: { low: Column; high: Column; exclusiveLow: boolean }[] = [];
  for (const c of cols) {
    for (const [suffix, exclusive] of [["min", false], ["gt", true]] as const) {
      if (!c.name.endsWith(`_${suffix}`)) continue;
      const high = byName.get(`${c.name.slice(0, -suffix.length)}max`);
      if (high && high.unit === c.unit) pairs.push({ low: c, high, exclusiveLow: exclusive });
    }
  }
  return pairs;
}

function statedInInterval(query: string, unit: string | undefined): number | null {
  if (!unit) return null;
  const re = new RegExp(`(${NUM})\\s*${unit.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`, "i");
  const m = query.match(re);
  return m ? num(m[1]) : null;
}

function selectRow(
  rows: string[][],
  cols: Column[],
  pair: { low: Column; high: Column; exclusiveLow: boolean },
  stated: number,
  filterColumn: Column | undefined,
  filterValue: string | null,
): { row: string[]; index: number } | null {
  const lowIdx = cols.indexOf(pair.low);
  const highIdx = cols.indexOf(pair.high);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (filterColumn && filterValue !== null) {
      const fIdx = cols.indexOf(filterColumn);
      if (fIdx < 0 || String(row[fIdx] ?? "").trim().toLowerCase() !== filterValue) continue;
    }
    const low = num(row[lowIdx]);
    const high = num(row[highIdx]);
    const aboveLow = low === null || (pair.exclusiveLow ? stated > low : stated >= low);
    const belowHigh = high === null || stated <= high;
    if (aboveLow && belowHigh) return { row, index: i };
  }
  return null;
}

function cellValue(row: string[], cols: Column[], col: Column): number | string | null {
  const idx = cols.indexOf(col);
  if (idx < 0) return null;
  const raw = row[idx] ?? "";
  return num(raw) ?? String(raw).trim();
}

/** The named class exists as a row VALUE of the table's class column
 *  (mpe_tiers' accuracy_class A/B/C/D rows). */
function classValueExists(rows: string[][], cols: Column[], token: string): boolean {
  const cc = classColumn(cols);
  if (!cc) return false;
  const idx = cols.indexOf(cc);
  return rows.some((r) => String(r[idx] ?? "").trim().toLowerCase() === token);
}

function statedUnits(query: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`(${NUM})\\s*([%°a-zA-Z][a-zA-Z/.%°]*\\b)`,"g");
  for (const m of query.matchAll(re)) {
    if (m[2]) out.add(m[2].replace("\u2062", "").trim());
  }
  return out;
}

function pickTable(nodes: { node_id: string; content: any }[], query: string): { node_id: string; content: any } | null {
  const queryLower = query.toLowerCase();
  const stated = statedUnits(query);
  const cToken = classToken(query);
  let best: { node: { node_id: string; content: any }; score: number } | null = null;
  for (const n of nodes) {
    const c = n.content ?? {};
    const payload = (c.payload ?? {}) as { columns?: Column[]; rows?: unknown[] };
    if (!Array.isArray(payload.rows) || !payload.rows.length) continue;
    const cols = (Array.isArray(payload.columns) ? payload.columns : []) as Column[];
    const rows = (Array.isArray(payload.rows) ? payload.rows : []).filter((r) => Array.isArray(r)) as string[][];
    let score = 0;
    for (const t of tokens(n.node_id.replace("/table/", ""))) {
      if (t.length >= 3 && queryLower.includes(t)) score += 2;
    }
    // the D1 projection keeps the title under `definition`
    for (const w of String(c.name ?? c.definition ?? "").toLowerCase().split(/[^a-z0-9.]+/)) {
      if (w.length >= 4 && queryLower.includes(w)) score += 1;
    }
    // the question's stated unit existing as this table's interval unit,
    // and the named class resolving here, are the strongest signals —
    // a table without either cannot hold the lookup
    if (intervalPairs(cols).some((p) => p.low.unit && stated.has(p.low.unit))) score += 3;
    if (cToken && (classAsColumn(cols, cToken) || classValueExists(rows, cols, cToken))) score += 2;
    if (!best || score > best.score) best = { node: n, score };
  }
  // an un-scored pick across several tables would be a guess: refuse
  // unless exactly one candidate survives the doc join
  if (best && best.score > 0) return best.node;
  return nodes.length === 1 ? nodes[0]! : null;
}

/** Evaluate the candidate table nodes against the question's
 *  aggregation intent. One verdict: the operation the question names,
 *  computed over the best-matching table's typed payload. */
export function evaluateAggregation(
  nodes: { node_id: string; content: unknown }[],
  query: string,
): AggregationVerdict | null {
  const qLower = query.toLowerCase();
  const operation: AggregationVerdict["operation"] | null = /\bhow many\b|\bnumber of\b/.test(qLower)
    ? "count"
    : /\b(minimum|smallest|shortest|lowest|least)\b/.test(qLower)
      ? "min"
      : /\b(maximum|largest|longest|highest|greatest)\b/.test(qLower)
        ? "max"
        : "lookup";
  if (!nodes.length) return null;
  const node = pickTable(nodes, query);

  if (!node) return null;
  const content = (node.content && typeof node.content === "object" ? node.content : {}) as Record<string, any>;
  const payload = (content.payload ?? {}) as { columns?: Column[]; rows?: unknown[] };
  const cols = Array.isArray(payload.columns) ? payload.columns : [];
  const rows = (Array.isArray(payload.rows) ? payload.rows : []).filter((r) => Array.isArray(r)) as string[][];
  if (!cols.length || !rows.length) return null;
  const rawTitle = String(content.name ?? content.definition ?? node.node_id.replace("/table/", ""));
  // display titles are cut before the normative parenthetical and at a
  // word boundary — the full definition stays in the payload
  const cut = rawTitle.indexOf(" (");
  const tableTitle = cut > 0 ? rawTitle.slice(0, cut) : rawTitle.slice(0, 120);

  const cite = (what: string) =>
    `COMPUTED (${operation}) — ${what}, read from the typed table "${tableTitle}". Present this result and cite the table's clause; the value is machine-computed from the table payload, do not recompute or round it differently. The machine table identifier rides the verdict block as data — never write it in your prose.`;

  if (operation === "count") {
    const cc = classColumn(cols);
    if (cc && /\bclasses?\b/.test(qLower) && tokens(cc.name).some((t) => t.length >= 3 && qLower.includes(t))) {
      const idx = cols.indexOf(cc);
      const distinct = new Set(rows.map((r) => String(r[idx] ?? "").trim().toLowerCase()));
      return {
        operation,
        table: node.node_id,
        table_title: tableTitle,
        column: cc.name,
        value: distinct.size,
        note: cite(`the table defines ${distinct.size} distinct ${cc.name.replace("_", " ")} values`),
      };
    }
    return {
      operation,
      table: node.node_id,
      table_title: tableTitle,
      value: rows.length,
      note: cite(`the table has ${rows.length} rows`),
    };
  }

  const cToken = classToken(query);

  if (operation === "min" || operation === "max") {
    let col: Column | undefined = cToken ? classAsColumn(cols, cToken) : undefined;
    if (!col) {
      let best: { col: Column; score: number } | null = null;
      for (const c of numericColumns(cols)) {
        const s = columnScore(c, qLower);
        if (s > 0 && (!best || s > best.score)) best = { col: c, score: s };
      }
      col = best?.col;
    }
    if (!col) return null;
    const values = rows.map((r) => num(r[cols.indexOf(col!)])).filter((v): v is number => v !== null);
    if (!values.length) return null;
    const value = operation === "min" ? Math.min(...values) : Math.max(...values);
    return {
      operation,
      table: node.node_id,
      table_title: tableTitle,
      column: col.name,
      value,
      unit: col.unit,
      note: cite(`${operation} of ${col.name.replace(/_/g, " ")} across ${values.length} rows is ${value}${col.unit ? ` ${col.unit}` : ""}`),
    };
  }

  // lookup: a stated quantity selects the interval row; a class token
  // (as row value or as column) names the cell.
  const pairs = intervalPairs(cols);
  const cc = classColumn(cols);
  const filterColumn = cc && cToken ? cc : undefined;
  let matched: { row: string[] } | null = null;
  let pairUsed: { low: Column; high: Column; exclusiveLow: boolean } | null = null;
  let stated: number | null = null;
  for (const pair of pairs) {
    const v = statedInInterval(query, pair.low.unit);
    if (v === null) continue;
    const r = selectRow(rows, cols, pair, v, filterColumn, cToken);
    if (r) {
      matched = r;
      pairUsed = pair;
      stated = v;
      break;
    }
  }
  if (matched && pairUsed && stated !== null) {
    const returnCol = cToken ? classAsColumn(cols, cToken) : undefined;
    const valueCols = cols.filter(
      (c) =>
        c !== pairUsed!.low &&
        c !== pairUsed!.high &&
        c !== filterColumn &&
        numericColumns(cols).includes(c),
    );
    const col = returnCol ?? (valueCols.length === 1 ? valueCols[0] : undefined);
    const value = col ? cellValue(matched.row, cols, col) : null;
    const rowObj: Record<string, string> = {};
    cols.forEach((c, i) => (rowObj[c.name] = String(matched!.row[i] ?? "").trim()));
    return {
      operation: "lookup",
      table: node.node_id,
      table_title: tableTitle,
      column: col?.name,
      value,
      unit: col?.unit,
      row: rowObj,
      note: cite(
        `the stated ${stated} ${pairUsed.low.unit ?? ""} falls in the row ${pairUsed.low.name} ${matched.row[cols.indexOf(pairUsed.low)]} / ${pairUsed.high.name} ${matched.row[cols.indexOf(pairUsed.high)]}${cToken ? `, ${filterColumn ? filterColumn.name.replace("_", " ") : "class"} ${cToken}` : ""}`,
      ),
    };
  }
  return null;
}
