// The operations catalog lane (TODO.new-era/6's platform surface): the
// smart-ops corpus is SMALL (169 operations) and name-addressable. An
// operation-intent question gets (1) the operations whose description
// matches the question's action stems — with their full lines, and (2)
// the complete name index. The note is AUTHORITATIVE: the model must
// name the operation from it, never answer from the passages' silence.
// Pure composition lives here; the D1 call is a thin wrapper.

export function isOperationIntent(query: string): boolean {
  return /\b(operations?|endpoints?)\b/i.test(query);
}

/** The action stems the register's descriptions use, mapped from the
 *  words a question actually asks ("updates" → updat; "upserts" shares
 *  the stem). */
const ACTION_STEMS = [
  "updat", "upsert", "writ", "put", "delet", "remov", "read", "fetch", "get", "creat", "declar",
  "confirm", "approv", "declin", "decide", "revok", "grant", "notify", "advanc", "announc", "download",
];

export function matchOperations(query: string, rows: { anchor: string; text: string }[]): { anchor: string; text: string }[] {
  const q = query.toLowerCase();
  const stems = ACTION_STEMS.filter((s) => q.includes(s));
  if (!stems.length) return [];
  const scored: { anchor: string; text: string; score: number }[] = [];
  for (const r of rows) {
    const hay = `${r.anchor} ${r.text}`.toLowerCase();
    const score = stems.filter((s) => hay.includes(s)).length;
    if (score > 0) scored.push({ ...r, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 4);
}

export function catalogNote(anchors: string[]): string {
  if (!anchors.length) return "";
  return `The COMPLETE name index of the platform's operations:\n${anchors.map((a) => `- ${a}`).join("\n")}`;
}

export async function operationsCatalogNote(db: any, query: string): Promise<string | undefined> {
  if (!isOperationIntent(query)) return undefined;
  try {
    const rows = (await db.prepare("SELECT clause_anchor AS anchor, substr(text, 1, 220) AS text FROM chunks WHERE corpus = 'smart-ops' AND clause_anchor IS NOT NULL ORDER BY clause_anchor").all()).results ?? [];
    const opRows = (rows as any[]).map((r) => ({ anchor: String(r.anchor ?? ""), text: String(r.text ?? "") })).filter((r) => r.anchor);
    const matched = matchOperations(query, opRows);
    const parts: string[] = [];
    if (matched.length) {
      parts.push(`Operations whose description matches the question's action (AUTHORITATIVE — if one matches, the answer MUST name it and cite its line; never answer that the information is missing):\n${matched.map((m) => `- ${m.text}`).join("\n")}`);
    }
    parts.push(catalogNote(opRows.map((r) => r.anchor)));
    return parts.filter(Boolean).join("\n\n") || undefined;
  } catch {
    return undefined; // the lane is optional
  }
}
