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
  pdf_key?: string | null;
}

/** A question is register-shaped when it asks about certification
 *  standing of an identifiable model or holder — the deterministic
 *  trigger the citation-graph notes already use (query-shaped notes,
 *  never a router). */
export function isRegisterShaped(query: string): boolean {
  return /\bcertif(ied|icates?|ication)s?\b/i.test(query) && /\b(is|are|still|currently|valid|status|suspended|revoked|was|were|have|has|hold|holds|possess|carry|got)\b/i.test(query);
}

/** Search tokens: words that can identify a holder or a model — words of
 *  2+ characters that are not register question words, plus bare model
 *  numbers ("190", "HM14H1"). Upper-cased tokens match case-insensitively
 *  in SQL LIKE. */
/** The family the question names ("R 60", "R60", "D 31") — the register
 *  search filters to it, so a question about R 60 never presents R 76
 *  rows. */
export function queryFamily(query: string): string | null {
  const m = /\b([RDMB])\s?-?(\d{2,3})\b/i.exec(query);
  return m ? `${m[1].toUpperCase()}${m[2].padStart(2, "0")}` : null;
}

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

/** The register query for a token set. Numeric tokens (a model number
 *  like "190") must match as a STANDALONE value — `LIKE '%190%'` also
 *  catches "XK3190", which the live Utilcell probe demonstrated — so a
 *  number matches the exact model, or as a delimiter-separated word
 *  (hyphens and punctuation normalize to spaces). Word tokens keep the
 *  substring LIKE (names and model words do not overmatch the way
 *  numbers do). Each token takes its own numbered placeholder,
 *  referenced three times (holder, model, number). */
export function buildRegisterQuery(tokens: string[]): { sql: string; params: string[] } {
  const params: string[] = [];
  const clauses = tokens.map((t) => {
    if (/^\d+$/.test(t)) {
      // a number matches as a STANDALONE value: the exact model or
      // certificate number, or a delimiter-separated word (hyphens and
      // punctuation normalize to spaces) — never a substring ("190"
      // must not catch "XK3190")
      const padded = `% ${t.toLowerCase()} %`;
      params.push(t, t, padded);
      const n1 = params.length - 2;
      const n2 = params.length;
      return `(model = ?${n1} OR num = ?${n1} OR (' ' || REPLACE(REPLACE(REPLACE(LOWER(model), '-', ' '), ',', ' '), '.', ' ') || ' ') LIKE ?${n2})`;
    }
    params.push(`%${t}%`);
    const n = params.length;
    return `(holder LIKE ?${n} OR model LIKE ?${n} OR num LIKE ?${n})`;
  });
  return {
    sql: `SELECT num, family, holder, model, year, status, pdf_key FROM certificates WHERE family = ?FAMILY AND (${clauses.join(" OR ")}) LIMIT 6`,
    params,
  };
}

export async function searchRegister(db: any, query: string, force = false): Promise<{ rows: RegisterRow[]; tokens: string[] } | null> {
  // the shaping gate exists for ASK questions (is this a register
  // question?); a TOOL invocation already decided — skip the gate
  if (!force && !isRegisterShaped(query)) return null;
  const tokens = registerTokens(query);
  if (!tokens.length) return null;
  const built = buildRegisterQuery(tokens);
  let { sql, params } = built;
  const family = queryFamily(query);
  if (!family) {
    // a tool query that names no family must not carry the placeholder
    sql = sql.replace("family = ?FAMILY AND ", "");
  }
  if (family) {
    // the register's family column is the DIGITS ONLY ("60", "105") —
    // the letter+padding form ("R60") never matched a single row
    // the prepend shifts every token placeholder by one: renumber them,
    // or each token binds the family string and nothing matches
    sql = sql.replace(/\?(\d+)/g, (_, n) => `?${Number(n) + 1}`);
    sql = sql.replace("?FAMILY", "?1");
    params.unshift(family.replace(/^[A-Za-z]+/, ""));
  }
  try {
    const res = await db.prepare(sql).bind(...params).all();
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
/** Each certificate's location rides the note as a link when its PDF
 *  is in the R2 plane (TODO 7) — the user gets the document, not just
 *  the fact. */
export function certificateLinks(rows: RegisterRow[]): string {
  const links = rows.filter((r) => r.pdf_key).map((r) => `- ${r.num}: https://www.ommisa.org/cert-pdf/${r.pdf_key}`);
  return links.length ? `The certificates' documents:\n${links.join("\n")}` : "";
}

