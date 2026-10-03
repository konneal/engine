import {
  P
} from "./chunk-3FYJM7LH.js";

// workers/worker_public/src/certificates.ts
function isRegisterShaped(query) {
  return /\bcertif(ied|icates?|ication)s?\b/i.test(query) && /\b(is|are|still|currently|valid|status|suspended|revoked|was|were|have|has|hold|holds|possess|carry|got)\b/i.test(query);
}
function queryFamily(query) {
  const m = /\b([RDMB])\s?-?(\d{2,3})\b/i.exec(query);
  return m ? `${m[1].toUpperCase()}${m[2].padStart(2, "0")}` : null;
}
function printedCertificateNumber(query) {
  const m = /\b([RDMB]\s?-?\d{2,3}\s?\/\s?\d{4}\s?-\s?[A-Z0-9]+\s?-\s?[^\s,;]+(?:\s?\.\s?\d+)?)/i.exec(query);
  return m ? m[1].replace(/\s+/g, "").replace(/-\./, ".") : null;
}
function registerTokens(query) {
  const stop = /* @__PURE__ */ new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "still",
    "currently",
    "in",
    "on",
    "for",
    "of",
    "and",
    "or",
    "certificate",
    "certificates",
    "certified",
    "certification",
    "register",
    "status",
    "valid",
    "suspended",
    "revoked",
    "recommendation",
    "per",
    "under",
    "by",
    "with",
    "what",
    "which",
    "who",
    "does",
    "do",
    "load",
    "cell",
    "model",
    "manufacturer",
    "holder",
    "company",
    "r",
    "how",
    "to",
    "list",
    "show"
  ]);
  const tokens = [];
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
function buildRegisterQuery(tokens) {
  const params = [];
  const clauses = tokens.map((t) => {
    if (/^\d+$/.test(t)) {
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
    params
  };
}
async function searchRegister(db, query, force = false) {
  if (!force && !isRegisterShaped(query)) return null;
  const printed = printedCertificateNumber(query);
  if (printed) {
    try {
      const seq = printed.replace(/\.\d+$/, "");
      const res = await db.prepare(`SELECT num, family, holder, model, year, status, pdf_key FROM certificates WHERE REPLACE(num, ' ', '') = ?1 OR REPLACE(num, ' ', '') LIKE ?2 || '%' ORDER BY num LIMIT 6`).bind(printed, seq).all();
      if ((res.results ?? []).length) {
        console.log(`register-search: printed-number hit ${printed} \u2192 ${(res.results ?? []).length} rows`);
        return { rows: res.results ?? [], tokens: [printed] };
      }
      console.log(`register-search: printed number ${printed} missed the register \u2014 falling back to tokens`);
    } catch {
    }
  }
  const tokens = registerTokens(query);
  if (!tokens.length) return null;
  const built = buildRegisterQuery(tokens);
  let { sql, params } = built;
  const family = queryFamily(query);
  if (!family) {
    sql = sql.replace("family = ?FAMILY AND ", "");
  }
  if (family) {
    sql = sql.replace(/\?(\d+)/g, (_, n) => `?${Number(n) + 1}`);
    sql = sql.replace("?FAMILY", "?1");
    params.unshift(family.replace(/^[A-Za-z]+/, ""));
  }
  try {
    const res = await db.prepare(sql).bind(...params).all();
    return { rows: res.results ?? [], tokens };
  } catch {
    return { rows: [], tokens };
  }
}
function registerNote(rows) {
  if (!rows.length) {
    return `Certificate register: NO certificate matching the asked holder or model appears in the ${P().publisher.name}-CS register snapshot. State plainly that no such certificate is in this register, and that the register is a snapshot rather than the live certification status.`;
  }
  const lines = rows.map((r) => `- ${r.num}: holder ${r.holder}, model "${r.model}"${r.year ? `, issued ${r.year}` : ""} \u2014 status ${r.status}`);
  return [
    "Certificate register \u2014 the following certificates matched the asked holder or model. Quote the certificate number, the holder and the status verbatim; the register is a snapshot, so qualify any statement about current certification accordingly.",
    ...lines
  ].join("\n");
}
function certificateLinks(rows) {
  const links = rows.filter((r) => r.pdf_key).map((r) => `- ${r.num}: https://www.oimlsmart.org/cert-pdf/${r.pdf_key}`);
  const absent = rows.filter((r) => !r.pdf_key && r.num).slice(0, 6).map((r) => `- ${r.num}: no document on file in this snapshot`);
  const parts = [];
  if (links.length) parts.push(`Documents on file:
${links.join("\n")}`);
  if (absent.length) parts.push(`No document on file (do NOT construct a link for these):
${absent.join("\n")}`);
  return parts.join("\n");
}

export {
  isRegisterShaped,
  queryFamily,
  printedCertificateNumber,
  registerTokens,
  buildRegisterQuery,
  searchRegister,
  registerNote,
  certificateLinks
};
