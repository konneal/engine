// The licensed boundary note (TODO.rag/12): when a question is about a
// topic that matches a LICENSED standard the caller is not entitled to,
// the note gives the answer model the boundary posture — name the
// licensed document as the authoritative procedure, name the public
// publications that reference it, and never recite the licensed
// parameters as if from the source. Pure matching/text lives here; the
// inverse-cites D1 read lives at the call site.

export interface LicensedEntry {
  key: string;
  package?: string;
  doc_number?: string;
  title?: string;
}

export interface LicensedMatch {
  entry: LicensedEntry;
  matched: string[];
}

// title words that carry no topical identity — a question about "tests"
// or "immunity" must not alone light the boundary
const TITLE_STOPWORDS = new Set([
  "environmental", "testing", "test", "tests", "guidance", "generic",
  "standards", "standard", "electromagnetic", "compatibility",
  "environment", "description", "measurement", "techniques", "immunity",
  "residential", "commercial", "industrial", "environments", "and", "for", "the",
  "iec", "iso",
]);

export function distinctiveTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w) && !/^[0-9:-]+$/.test(w));
}

/** The licensed entry whose distinctive title tokens best match the
 *  question. Needs TWO token hits (or one hyphenated-compound hit) —
 *  a single shared word is not a topic match. */
export function matchLicensedTopic(query: string, licensed: LicensedEntry[]): LicensedMatch | null {
  const words = new Set(query.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean));
  let best: { entry: LicensedEntry; matched: string[] } | null = null;
  for (const entry of licensed) {
    if (!entry.title) continue;
    const matched = distinctiveTokens(entry.title).filter((w) => words.has(w));
    if (matched.length < 2) continue;
    if (!best || matched.length > best.matched.length) best = { entry, matched };
  }
  return best;
}

/** The note text: the posture instruction for an unentitled match. */
export function boundaryNoteText(match: LicensedMatch, citing: string[]): string {
  const doc = match.entry.doc_number ?? match.entry.key;
  const title = match.entry.title ?? doc;
  const refs = citing.length
    ? `The public corpus references it from ${citing.join(", ")}.`
    : "";
  return (
    `LICENSED BOUNDARY — ${title} (IEC ${doc}) is licensed content in this ` +
    `deployment; its procedure is NOT part of the public corpus you are grounded in. ` +
    `${refs} When answering: name the licensed document as the authoritative source of ` +
    `the procedure and say it is available to entitled callers; do NOT recite its ` +
    `conditioning or severity parameters (specific temperatures, humidity levels, ` +
    `durations or cycle counts) as if from the source — describe only what the public ` +
    `grounding passages themselves state, attributed to their own publications.`
  );
}
