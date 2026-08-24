export interface QueryFilters {
  doctype?: string;
  doc_number?: string;
  edition?: string;
  language?: string;
}

// bare "de"/"en" are omitted: they appear as ordinary words in French
// queries ("cellule de pesée", "en français") and would hijack the filter
const LANGS: Record<string, string> = {
  english: "en", anglais: "en",
  french: "fr", francais: "fr", français: "fr",
  german: "de", deutsch: "de", allemand: "de",
  arabic: "ar", arabe: "ar",
  spanish: "es", espanol: "es", español: "es",
  persian: "fa", farsi: "fa",
  ukrainian: "uk", ukrainien: "uk",
  serbian: "sr", serbe: "sr",
  polish: "pl", polonais: "pl",
};

// space-separated ("R 111") or OIML-prefixed ("OIML R60"). A glued
// letter+number ("E2", "M1") is an accuracy class, never a document
const DOC_RE_OIML = /\boiml\s+([rbdge])\s*(\d{1,3})(?:-(\d{1,2}))?\b/i;
const DOC_RE_SPACE = /\b([rbdge])\s+(\d{1,3})(?:-(\d{1,2}))?\b/i;
const EDITION_RE = /\b(19[5-9]\d|20[0-4]\d)\b/;

export function extractFilters(query: string): QueryFilters {
  const f: QueryFilters = {};
  const dm = query.match(DOC_RE_OIML) ?? query.match(DOC_RE_SPACE);
  if (dm) {
    f.doctype = dm[1].toUpperCase();
    f.doc_number = dm[2];
  }
  const em = query.match(EDITION_RE);
  if (em) f.edition = em[1];
  const lower = ` ${query.toLowerCase()} `;
  for (const [word, code] of Object.entries(LANGS)) {
    if (lower.includes(` ${word} `)) {
      f.language = code;
      break;
    }
  }
  return f;
}

export function toVectorizeFilter(f: QueryFilters): Record<string, string> | undefined {
  // a pinned doc number is near-selective on its own; including doctype
  // hides the dirty-corpus docs whose identifiers lost the series letter
  // ("OIML 106"), and the reranker resolves R/D number collisions
  if (f.doc_number) {
    const out: Record<string, string> = { doc_number: f.doc_number };
    if (f.edition) out.edition = f.edition;
    return out; // language filter omitted: the index is English-only
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v && k !== "language") out[k] = v;
  return Object.keys(out).length ? out : undefined;
}
