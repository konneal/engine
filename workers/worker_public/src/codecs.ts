// The serving-side identifier codec registry — the TS mirror of
// ingest/codecs.py. Each publisher has an identifier grammar; the
// profile declares the codec id and every publisher-specific parse
// (how a question names a document, how a label reads, how graph node
// ids are shaped) lives in the codec implementation, never in domain
// code. The plain-slug codec is the generic floor: no grammar, no
// doc-number steering — labels are the identifier as given.
import { P } from "./profile.ts";

export interface DocScope {
  doc_number: string;
  edition?: string;
  label: string;
}

export interface RefCodec {
  /** The explicit form: "R 60-1:2021", "urn:…" — null when unparseable. */
  parse(doc: string, edition?: string): DocScope | null;
  /** The gap-tolerant scan over question text — null when nothing names a document. */
  scanQuestion(query: string): DocScope | null;
  /** The graph's node id → document number — null for other shapes. */
  graphDocNumber(nodeId: string): string | null;
  /** A docidentifier's family key ("R-60") for edition steering — null when not of the grammar. */
  familyOf(docidentifier: string): string | null;
}

/** OIML's grammar: type letter (R/D/B/G/E) + 1–3 digits, optional part,
 *  optional edition year; the URN provenance form; part numbers are
 *  significant (R 60-1), the edition is never part of the number. */
export const oimlPubid: RefCodec = {
  parse(doc, edition) {
    const m =
      doc.match(/^urn:oiml:pub:([rdbge]):(\d{1,3})(?:-[0-9A-Za-z]+)?(?::(\d{4}))?$/i) ??
      doc.match(/^(?:OIML\s+)?([RDBGE])\s*(\d{1,3})(?:-[0-9A-Za-z]+)?(?::(\d{4}))?$/i);
    if (!m) return null;
    const type = m[1].toUpperCase();
    const ed = edition ?? m[3] ?? undefined;
    return { doc_number: m[2], ...(ed ? { edition: ed } : {}), label: `OIML ${type} ${m[2]}${ed ? `:${ed}` : ""}` };
  },
  scanQuestion(query) {
    const re = /\b(OIML\s+)?([RDBGE])(\s*)0*(\d{1,3})(?:\s*[-–]\s*\d+)?(?:\s*:\s*(\d{4}))?/gi;
    for (const m of query.matchAll(re)) {
      const [, oimlPrefix, letter, gap, digits, edition] = m;
      // a glued single digit is a class/designation ("E2 weights"), never a naming
      if (digits!.length === 1 && !oimlPrefix && !gap) continue;
      const num = String(Number(digits));
      const type = letter!.toUpperCase();
      return { doc_number: num, ...(edition ? { edition } : {}), label: `OIML ${type} ${num}${edition ? `:${edition}` : ""}` };
    }
    return null;
  },
  graphDocNumber(nodeId) {
    const m = nodeId.match(/^doc:OIML-[A-Z]-(\d+)-/);
    return m ? m[1] : null;
  },
  familyOf(di) {
    const m = /^(?:OIML\s+)?([A-Z])\s?(\d{1,3})(?:[-–]([0-9A-Za-z]+))?/.exec(di);
    return m ? `${m[1]}-${m[2]}` : null;
  },
};

/** The generic floor: the identifier is whatever string it is. */
export const plainSlug: RefCodec = {
  parse: () => null,
  scanQuestion: () => null,
  graphDocNumber: () => null,
  familyOf: () => null,
};

const REGISTRY: Record<string, RefCodec> = {
  "oiml-pubid": oimlPubid,
  "plain-slug": plainSlug,
};

export function refCodec(): RefCodec {
  return REGISTRY[P().publisher.codec] ?? plainSlug;
}
