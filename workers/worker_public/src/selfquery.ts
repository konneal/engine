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

const DOC_RE = /\b(?:oiml\s+)?([rbdge])\s?(\d{1,3})(-(\d{1,2}))?\b/i;
const EDITION_RE = /\b(19[5-9]\d|20[0-4]\d)\b/;

export function extractFilters(query: string): QueryFilters {
  const f: QueryFilters = {};
  const dm = query.match(DOC_RE);
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
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}
