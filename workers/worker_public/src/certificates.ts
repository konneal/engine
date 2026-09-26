// The certificate register as a STRUCTURED search surface (TODO.new-era/6):
// "is model X from holder Y still certified?" is an exact-match question,
// not a similarity question. The register rows live in D1 (the
// certificates plane's `certificates` table); this stage decides when a
// question is register-shaped, queries the table, and returns the rows as
// an authoritative note for the prompt. A miss is a MISS: "not in this
// register snapshot" is stated verbatim, never softened into a guess.

import { P } from './profile.ts';

export interface RegisterRow {
  num: string;
  family: string;
  holder: string;
  model: string;
  year: string;
  status: string;
}

/** A question is register-shaped when it asks about certification
 *  standing of an identifiable model or holder — the deterministic
 *  trigger the citation-graph notes already use (query-shaped notes,
 *  never a router). */
export function isRegisterShaped(query: string): boolean {
  return /\bcertif(ied|icates?|ication)s?\b/i.test(query) && /\b(is|are|still|currently|valid|status|suspended|revoked|was|were)\b/i.test(query);
}

/** Search tokens: words that can identify a holder or a model — words of
 *  2+ characters that are not register question words, plus bare model
 *  numbers ("190", "HM14H1"). Upper-cased tokens match case-insensitively
 *  in SQL LIKE. */
export function registerTokens(query: string): string[] {
  const stop = new Set([
    "the", "a", "an", "is", "are", "was", "were", "still", "currently", "in", "on", "for", "of", "and", "or",
    "certificate", "certificates", "certified", "certification", "register", "status", "valid", "suspended",
    "revoked", "recommendation", "per", "under", "by", "with", "what", "which", "who", "does", "do",
    "load", "cell", "model", "manufacturer", "holder", "company", "r", "how", "to", "list", "show",
  ]);
  const tokens: string[] = [];
  const publisherWord = P().publisher.name.toLowerCase();
  for (const w of query.split(/[^A-Za-z0-9&-]+/)) {
    if (w.length < 2) continue;
    if (stop.has(w.toLowerCase())) continue;
    if (w.toLowerCase() === publisherWord) continue;
    if (/^\d+$/.test(w) && w.length < 2) continue;
    if (!tokens.includes(w)) tokens.push(w);
  }
  return tokens.slice(0, 6);
}

export async function searchRegister(db: any, query: string): Promise<{ rows: RegisterRow[]; tokens: string[] } | null> {
  if (!isRegisterShaped(query)) return null;
  const tokens = registerTokens(query);
  if (!tokens.length) return null;
  const clauses = tokens.map(() => "(holder LIKE ?1 OR model LIKE ?1 OR num LIKE ?1)").join(" OR ");
  const params = tokens.map((t) => `%${t}%`);
  try {
    const res = await db
      .prepare(`SELECT num, family, holder, model, year, status FROM certificates WHERE ${clauses} LIMIT 6`)
      .bind(...params)
      .all();
    return { rows: (res.results ?? []) as RegisterRow[], tokens };
  } catch {
    // a missing table or a D1 hiccup degrades to no-note honestly
    return { rows: [], tokens };
  }
}

export function registerNote(rows: RegisterRow[]): string {
  if (!rows.length) {
    return `Certificate register: NO certificate matching the asked holder or model appears in the ${P().publisher.name}-CS register snapshot. State plainly that no such certificate is in this register, and that the register is a snapshot rather than the live certification status.`;
  }
  const lines = rows.map((r) => `- ${r.num}: holder ${r.holder}, model "${r.model}"${r.year ? `, issued ${r.year}` : ""} — status ${r.status}`);
  return [
    "Certificate register — the following certificates matched the asked holder or model. Quote the certificate number, the holder and the status verbatim; the register is a snapshot, so qualify any statement about current certification accordingly.",
    ...lines,
  ].join("\n");
}
