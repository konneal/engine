// The operations catalog lane (TODO.new-era/6's platform surface): the
// smart-ops corpus is SMALL (169 operations) and name-addressable. An
// operation-intent question gets (1) the operations whose NAME carries
// the question's object words and whose description carries its action
// stems — with their full lines, and (2) the complete name index. The
// note is AUTHORITATIVE: the model must name the operation from it,
// never answer from the passages' silence. Pure composition lives
// here; the D1 call is a thin wrapper.

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

const STOP_WORDS = new Set([
  "which", "what", "where", "when", "how", "why", "who", "does", "did", "can", "the", "and", "for",
  "with", "that", "this", "are", "was", "were", "has", "have", "had", "not", "but", "all", "any",
  "platform", "operation", "operations", "endpoint", "endpoints", "api",
]);

/** camelCase/snake anchors meet the question's words: "updates an
 *  entity record" must reach putEntityRecord even when its description
 *  words the action differently ("replaces the stored…"). */
export function anchorWords(anchor: string): string[] {
  return anchor
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const singular = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

export function matchOperations(query: string, rows: { anchor: string; text: string }[]): { anchor: string; text: string }[] {
  const q = query.toLowerCase();
  const stems = ACTION_STEMS.filter((s) => q.includes(s));
  const objects = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map(singular);
  const scored: { anchor: string; text: string; score: number; objectScore: number }[] = [];
  for (const r of rows) {
    const hay = `${r.anchor} ${r.text}`.toLowerCase();
    const verbScore = stems.filter((s) => hay.includes(s)).length * 3;
    const words = anchorWords(r.anchor).map(singular);
    const objectScore = objects.filter((o) => words.includes(o)).length * 10;
    if (objectScore + verbScore > 0) scored.push({ ...r, score: objectScore + verbScore, objectScore });
  }
  // A question that names its object ("entity record") has found its
  // target by name — verb-only mentions are the noise that displaced
  // the answer with an unrelated sibling (the 2026-09-29 "blob upload"
  // answers).
  const named = scored.filter((s) => s.objectScore > 0);
  const pool = named.length ? named : scored;
  return pool.sort((a, b) => b.score - a.score).slice(0, 4);
}

export function catalogNote(anchors: string[]): string {
  if (!anchors.length) return "";
  return `The COMPLETE name index of the platform's operations:\n${anchors.map((a) => `- ${a}`).join("\n")}`;
}

export async function operationsCatalogNote(db: any, query: string): Promise<string | undefined> {
  if (!isOperationIntent(query)) return undefined;
  try {
    const rows = (await db.prepare("SELECT clause_anchor AS anchor, substr(text, 1, 300) AS text FROM chunks WHERE corpus = 'smart-ops' AND clause_anchor IS NOT NULL ORDER BY clause_anchor").all()).results ?? [];
    const opRows = (rows as any[]).map((r) => ({ anchor: String(r.anchor ?? ""), text: String(r.text ?? "") })).filter((r) => r.anchor);
    const matched = matchOperations(query, opRows);
    const parts: string[] = [];
    if (matched.length) {
      parts.push(`Operations whose name or description matches the question (AUTHORITATIVE — if one matches, the answer MUST name it and cite its line; never answer that the information is missing):\n${matched.map((m) => `- ${m.text}`).join("\n")}`);
    }
    parts.push(catalogNote(opRows.map((r) => r.anchor)));
    return parts.filter(Boolean).join("\n\n") || undefined;
  } catch {
    return undefined; // the lane is optional
  }
}
