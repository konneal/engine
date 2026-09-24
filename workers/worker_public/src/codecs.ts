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

// The OIML grammar is @oimlsmart/oiml-pubid — the estate's single
// source of truth (real tokenizer: editions, amendments, languages,
// the CS family — beyond what any regex here carried). This codec's
// job is the ADAPTATION: the parser takes the prefixed form and
// returns null for everything else; our callers also send bare forms
// ("R 60-1:2021") and the URN provenance shape. The ONE construct the
// strict grammar deliberately does not own is the DUAL-PUBLISHED print
// ("ISO 4064-1:2024|OIML R 49-1:2024") — that lives in the unified
// pubid grammar (@pubid/pubid, single-flavor import so the worker
// bundle carries only the OIML grammar), and the retrieval spine of a
// dual is its OIML side, whichever side prints first.
import { parseOimlPubid } from "@oimlsmart/oiml-pubid";
import { oimlGrammarImplementation } from "@pubid/pubid/dist/flavors/oiml/implementation.js";

const oimlParser = oimlGrammarImplementation();

const TYPE_LETTER: Record<string, string> = {
  recommendation: "R", document: "D", basic_publication: "B",
  "basic-publication": "B", guide: "G", expert_report: "E",
  "expert-report": "E", vocabulary: "V", seminar_report: "S",
  "seminar-report": "S",
};

interface PubidHash {
  _type?: string;
  number?: string | number;
  part?: string;
  year?: string;
  edition?: string;
}

/** The OIML side of a dual-published print, through the unified
 *  grammar. Singles go through the strict grammar above — this path
 *  exists for the pipe construct and nothing else. */
function dualOimlSpine(side: string): { doc_number: string; edition?: string; label: string } | null {
  try {
    const h = oimlParser.parse(side.trim()).toHash() as PubidHash;
    if (h.number === undefined) return null;
    const kind = String(h._type ?? "").split(":").pop() ?? "";
    const letter = TYPE_LETTER[kind] ?? "";
    if (!letter) return null;
    const num = String(Number(h.number));
    const part = h.part !== undefined ? String(h.part) : undefined;
    const ed = h.year !== undefined ? String(h.year) : h.edition !== undefined ? String(h.edition) : undefined;
    return {
      doc_number: num,
      ...(ed ? { edition: ed } : {}),
      label: `OIML ${letter} ${num}${part ? `-${part}` : ""}${ed ? `:${ed}` : ""}`,
    };
  } catch {
    return null;
  }
}

/** urn:oiml:pub:r:60-1:2021 (pub) / urn:oiml:pub:cs:pd-06 (CS) → the
 *  prefixed display form the parser takes. */
const urnToDisplay = (u: string) => {
  const pub = u.match(/^urn:oiml:pub:([a-z]+):(\d+)(?:-([0-9a-z]+))?(?::(\d{4}))?(?::[a-z]{1,7}(?:-[a-z]{1,7})?)?$/i);
  if (pub) return `OIML ${pub[1].toUpperCase()} ${pub[2]}${pub[3] ? `-${pub[3]}` : ""}${pub[4] ? `:${pub[4]}` : ""}`;
  const cs = u.match(/^urn:oiml:pub:cs:([a-z]+)-(\d+)(?::(\d{4}))?(?::[a-z]{1,7}(?:-[a-z]{1,7})?)?$/i);
  if (cs) return `OIML-CS ${cs[1].toUpperCase()}-${cs[2]}${cs[3] ? `:${cs[3]}` : ""}`;
  return null;
};

const parsePubid = (doc: string) => {
  const src = /^urn:/i.test(doc) ? urnToDisplay(doc) : /^(?:OIML|oiml)\b/i.test(doc) ? doc : `OIML ${doc}`;
  return src ? parseOimlPubid(src) : null;
};

/** OIML's grammar (delegated): type letter + 1–3 digits, optional part,
 *  optional edition year; part numbers are significant (R 60-1), the
 *  edition is never part of the number. */
export const oimlPubid: RefCodec = {
  parse(doc, edition) {
    // the dual-published print: the OIML side is the spine, whichever
    // side prints first — resolved before the strict grammar, whose
    // null would otherwise be the whole answer
    if (!/^urn:/i.test(doc) && doc.includes("|")) {
      const side = doc.split("|").map((s) => s.trim()).find((s) => /^(?:OIML|oiml)\b/i.test(s));
      const dual = side ? dualOimlSpine(side) : null;
      if (dual) return dual;
    }
    const p = parsePubid(doc);
    if (!p || p.series !== "pub") return null;
    const type = p.family.toUpperCase();
    const num = String(Number(p.number)); // R 060 → R 60 (display and steering agree)
    const ed = edition ?? p.year ?? undefined;
    return { doc_number: num, ...(ed ? { edition: ed } : {}), label: `OIML ${type} ${num}${p.part ? `-${p.part}` : ""}${ed ? `:${ed}` : ""}` };
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
    const p = parsePubid(di);
    if (p && p.series === "pub") return `${p.family.toUpperCase()}-${String(Number(p.number))}`;
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
