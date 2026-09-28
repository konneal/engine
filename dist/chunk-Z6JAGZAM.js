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
    sql: `SELECT num, family, holder, model, year, status FROM certificates WHERE ${clauses.join(" OR ")} LIMIT 6`,
    params
  };
}
async function searchRegister(db, query) {
  if (!isRegisterShaped(query)) return null;
  const tokens = registerTokens(query);
  if (!tokens.length) return null;
  const built = buildRegisterQuery(tokens);
  let { sql, params } = built;
  const family = queryFamily(query);
  if (family) {
    sql = sql.replace(" WHERE ", " WHERE family = ?0 AND ");
    params.unshift(family);
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

export {
  isRegisterShaped,
  queryFamily,
  registerTokens,
  buildRegisterQuery,
  searchRegister,
  registerNote
};
