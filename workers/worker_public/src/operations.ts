// The operations catalog lane (TODO.new-era/6's platform surface): the
// smart-ops corpus is SMALL (169 operations) and name-addressable. When
// a question is operation-intent, the ENTIRE operation-name index rides
// the notes channel — the model matches "updates an entity record" to
// putEntityRecord semantically from the complete surface, instead of
// gambling on which sibling passage retrieval happens to surface.
// Pure composition lives here; the D1 call is a thin wrapper.

export function isOperationIntent(query: string): boolean {
  return /\b(operations?|endpoints?)\b/i.test(query);
}

export function catalogNote(anchors: string[]): string {
  if (!anchors.length) return "";
  return `The platform's indexed operations (the COMPLETE surface — every operation the system exposes; the answer must name the operation from this list when one matches the question):\n${anchors.map((a) => `- ${a}`).join("\n")}`;
}

export async function operationsCatalogNote(db: any, query: string): Promise<string | undefined> {
  if (!isOperationIntent(query)) return undefined;
  try {
    const rows = (await db.prepare("SELECT clause_anchor FROM chunks WHERE corpus = 'smart-ops' AND clause_anchor IS NOT NULL ORDER BY clause_anchor").all()).results ?? [];
    const note = catalogNote((rows as any[]).map((r) => r.clause_anchor).filter(Boolean));
    return note || undefined;
  } catch {
    return undefined; // the lane is optional
  }
}
