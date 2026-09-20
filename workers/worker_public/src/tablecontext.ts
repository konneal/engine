/** Schema-aware table context composition (TableRAG-class cell
 *  selection) over the producer's typed table payload. Pure — the
 *  interface is the test surface. */
/** Schema-aware table context (TableRAG-class cell selection): the
 *  producer payload (metadata.table) carries caption/columns/rows; the
 *  consumer composes the model-facing serialization — columns whose
 *  labels overlap the query, rows whose cells overlap the query or the
 *  selected column labels. Full table stays available for rendering;
 *  this only shapes the prompt context, and falls back to the stored
 *  text when pruning matches nothing (never worse than baseline). */
export interface TableSelection {
  text: string;
  cols: string[];
  rowsShown: number;
  rowsTotal: number;
}

export function tableSelection(meta: any, query: string): TableSelection | null {
  const t: any = meta?.table;
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows) || !t.rows.length) return null;
  const terms = new Set(
    query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w: string) => w.length > 2),
  );
  const termList = [...terms];
  const label = (c: any): string => `${c?.label ?? ""} ${c?.unit ?? ""}`.toLowerCase();
  const keepCols: number[] = [];
  t.columns.forEach((c: any, i: number) => {
    if (termList.some((term) => label(c).includes(term))) keepCols.push(i);
  });
  const colKeep: number[] = keepCols.length ? keepCols : t.columns.map((_: any, i: number) => i);
  const rowHits: string[] = [];
  for (const row of t.rows as string[]) {
    const cells = String(row).split("|").map((c: string) => c.trim().toLowerCase());
    const cellHit = cells.some((c: string) => c && termList.some((term) => c.includes(term)));
    const colHit = keepCols.length > 0 && colKeep.some((i: number) => cells[i] && termList.some((term) => label(t.columns[i]).includes(term) && cells[i].length > 0));
    if (cellHit || colHit) rowHits.push(row);
  }
  if (!rowHits.length) return null;
  const CAP = 10;
  const shown = rowHits.slice(0, CAP);
  const header = `Table: ${t.caption ?? ""}\ncolumns: ${colKeep.map((i: number) => `${t.columns[i]?.label ?? ""}${t.columns[i]?.unit ? ` [${t.columns[i].unit}]` : ""}`).join(" | ")}`;
  const lines = shown.map((r: string) => `row: ${r}`);
  const elided =
    rowHits.length > CAP || rowHits.length < t.rows.length
      ? `\n(${shown.length} of ${t.rows.length} rows shown; ${t.rows.length - rowHits.length} rows did not match the question terms)`
      : "";
  return { text: `${header}\n${lines.join("\n")}${elided}`, cols: colKeep.map((i: number) => `${t.columns[i]?.label ?? ""}${t.columns[i]?.unit ? ` [${t.columns[i].unit}]` : ""}`), rowsShown: shown.length, rowsTotal: t.rows.length };
}

export function tableContext(meta: any, query: string): string | null {
  return tableSelection(meta, query)?.text ?? null;
}
