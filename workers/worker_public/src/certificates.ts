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

/** An AGGREGATE register question — "how many certificates are issued
 *  for R 60:2021?", "what is the latest certificate issued for R 60" —
 *  is served by DETERMINISTIC computation (COUNT, ORDER BY), never by
 *  the model counting the rows a note happens to carry. The register
 *  lane's own philosophy: the note answers the structure, the model
 *  narrates it (TODO.sota/04's machine-checkable ground truth, applied
 *  to the register plane 2026-10-11). */
export function registerAggregateIntent(query: string): "count" | "latest" | null {
  if (!/\bcertif(ied|icates?|ication)s?\b/i.test(query)) return null;
  if (/\b(latest|most recent|newest|last)\b/i.test(query)) return "latest";
  if (/\b(how many|count|number of|total|how much)\b/i.test(query)) return "count";
  return null;
}

/** The register's answers derive from the D1 snapshot, not the indexed
 *  corpus — but the answer cache (namespaced by INDEX_VERSION +
 *  corpus_gen) knows nothing about D1-plane loads, so a cached
 *  pre-register refusal preempted register-shaped questions the register
 *  answers (measured live 2026-10-28: cached refusals served over
 *  register-shaped asks until fresh). Such asks skip both cache reads
 *  and writes. */
export function registerBypassesCache(query: string): boolean {
  return isRegisterShaped(query) || registerAggregateIntent(query) !== null;
}

export interface RegisterAggregate {
  family: string;
  count: number;
  valid: number;
  suspended: number;
  latest: RegisterRow | null;
}

/** The family's aggregate, computed in SQL (the register is the ground
 *  truth; editions do not appear in it — certificates are issued per
 *  family). The latest row ranks by year then the sequence number's
 *  tail (the -YY.NN suffix carries the actual issue ordering). */
export async function registerAggregate(db: any, family: string): Promise<RegisterAggregate | null> {
  try {
    const digits = family.replace(/^[A-Za-z]+/, "");
    const rows = await db
      .prepare(
        "SELECT num, family, holder, model, year, status, pdf_key FROM certificates WHERE family = ?1 ORDER BY CAST(year AS INTEGER) DESC, num DESC LIMIT 1",
      )
      .bind(digits)
      .all();
    const totals = await db
      .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'Valid' THEN 1 ELSE 0 END) AS valid, SUM(CASE WHEN status = 'Suspended' THEN 1 ELSE 0 END) AS suspended FROM certificates WHERE family = ?1")
      .bind(digits)
      .first();
    if (!totals || !totals.n) return null;
    return {
      family: digits,
      count: Number(totals.n),
      valid: Number(totals.valid ?? 0),
      suspended: Number(totals.suspended ?? 0),
      latest: ((rows.results ?? [])[0] as RegisterRow) ?? null,
    };
  } catch {
    return null;
  }
}

/** The aggregate's authoritative note: the numbers are DATA — the
 *  model narrates, never recomputes. The edition disclaimer rides every
 *  family-scoped answer (the register has no edition dimension). */
export function aggregateNote(agg: RegisterAggregate): string {
  // the register stores the family as digits ("60"); the user-facing
  // name carries the series letter, which the certificate numbers
  // themselves carry ("R60/…") — derived from the data, never hardcoded
  const series = agg.latest?.num?.match(/^[A-Za-z]+/)?.[0] ?? "";
  const familyName = `${P().publisher.name} ${series} ${agg.family}`.trim();
  const latest = agg.latest
    ? `The latest certificate in the snapshot is ${agg.latest.num} (holder ${agg.latest.holder}, model "${agg.latest.model}"${agg.latest.year ? `, issued ${agg.latest.year}` : ""}, status ${agg.latest.status}).`
    : "No certificate rows are present in the snapshot.";
  const link = agg.latest?.pdf_key
    ? ` Its document: https://www.oimlsmart.org/cert-pdf/${agg.latest.pdf_key}`
    : "";
  return [
    `CERTIFICATE REGISTER — THIS NOTE ANSWERS THE QUESTION. Answer from THIS note; do not refuse for want of passages (the retrieval passages are irrelevant for register questions).`,
    `The ${familyName} family holds ${agg.count} certificate${agg.count === 1 ? "" : "s"} (${agg.valid} valid${agg.suspended ? `, ${agg.suspended} suspended` : ""}) — computed over the register snapshot; state these numbers verbatim.`,
    latest + link,
    "Certificates are issued per RECOMMENDATION FAMILY — the register carries no edition dimension, so an edition named in the question (e.g. 2021) does not narrow it; say so when the question names an edition. Qualify that the register is a snapshot, and cite the register.",
  ].join("\n");
}

/** A typed block for aggregate answers — the UI renders the count and
 *  the latest row's link as data, never from prose. */
export function aggregateBlock(agg: RegisterAggregate) {
  return {
    type: "register",
    payload: {
      family: agg.family,
      count: agg.count,
      valid: agg.valid,
      ...(agg.suspended ? { suspended: agg.suspended } : {}),
      ...(agg.latest
        ? {
            latest: {
              num: agg.latest.num,
              holder: agg.latest.holder,
              model: agg.latest.model,
              year: agg.latest.year,
              status: agg.latest.status,
              ...(agg.latest.pdf_key ? { url: `/cert-pdf/${agg.latest.pdf_key}` } : {}),
            },
          }
        : {}),
    },
  };
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

/** A PRINTED certificate number on a nameplate ("R76/2006-A-GB1-18.08")
 *  names the exact register row — it must not be shredded into word
 *  tokens that compete with it. */
export function printedCertificateNumber(query: string): string | null {
  const m = /\b([RDMB]\s?-?\d{2,3}\s?\/\s?\d{4}\s?-\s?[A-Z0-9]+\s?-\s?[^\s,;]+(?:\s?\.\s?\d+)?)/i.exec(query);
  return m ? m[1].replace(/\s+/g, "").replace(/-\./, ".") : null;
}

function editionSuffixYears(query: string): Set<string> {
  // "R 60:2021", "R 60-1:2021" — the EDITION carries no register
  // meaning (certificates key on family); its bare year token would
  // poison the token arms (the "2021" matched nothing: issue scheme
  // years differ from edition years). Collect them for stripping.
  const years = new Set<string>();
  for (const m of query.matchAll(/\b([RDMB])\s?-?\d{2,3}(?:-\d+)?\s?:\s?(\d{4})\b/gi)) {
    years.add(m[2]!);
  }
  return years;
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
  const editionYears = editionSuffixYears(query);
  const stop2 = new Set([...stop, "many", "issued", "issue", "issued", "latest", "newest", "recent", "total", "number"]);
  for (const w of query.split(/[^A-Za-z0-9&-]+/)) {
    if (w.length < 2) continue;
    if (stop2.has(w.toLowerCase())) continue;
    if (/^\d{4}$/.test(w) && editionYears.has(w)) continue; // an edition year, not an issue filter
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
  // a PRINTED certificate number names the row: query it first, and only
  // fall back to the token arms when it misses (an extraction may drop a
  // character; the prefix up to the sequence still scopes the family)
  const printed = printedCertificateNumber(query);
  if (printed) {
    try {
      const seq = printed.replace(/\.\d+$/, "");
      const res = await db
        .prepare(`SELECT num, family, holder, model, year, status, pdf_key FROM certificates WHERE REPLACE(num, ' ', '') = ?1 OR REPLACE(num, ' ', '') LIKE ?2 || '%' ORDER BY num LIMIT 6`)
        .bind(printed, seq)
        .all();
      if ((res.results ?? []).length) {
        console.log(`register-search: printed-number hit ${printed} → ${(res.results ?? []).length} rows`);
        return { rows: (res.results ?? []) as RegisterRow[], tokens: [printed] };
      }
      console.log(`register-search: printed number ${printed} missed the register — falling back to tokens`);
    } catch {
      // fall through to the token arms
    }
  }
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
  const links = rows.filter((r) => r.pdf_key).map((r) => `- ${r.num}: https://www.oimlsmart.org/cert-pdf/${r.pdf_key}`);
  // absence is stated per row: an unmarked gap invited the model to
  // generalize the URL pattern to a document-less row (a fabricated 404
  // link, observed live 2026-10-04)
  const absent = rows.filter((r) => !r.pdf_key && r.num).slice(0, 6).map((r) => `- ${r.num}: no document on file in this snapshot`);
  const parts: string[] = [];
  if (links.length) parts.push(`Documents on file:\n${links.join("\n")}`);
  if (absent.length) parts.push(`No document on file (do NOT construct a link for these):\n${absent.join("\n")}`);
  return parts.join("\n");
}

