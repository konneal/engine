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

// The OIML grammar is the unified pubid grammar (@pubid/pubid's oiml
// flavor — single-flavor import so the worker bundle carries the OIML
// grammar and nothing else). This codec's job is the ADAPTATION: the
// grammar takes the prefixed form and returns null for everything
// else; our callers also send bare forms ("R 60-1:2021"), the URN
// provenance shape, and the dual-published print ("ISO
// 4064-1:2024|OIML R 49-1:2024") whose retrieval spine is its OIML
// side, whichever side prints first. The estate's former grammar
// (@oimlsmart/oiml-pubid) retired into this one (pubid/pubid-ts#63).
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

/** The spine of a printed identifier through the unified grammar: the
 *  type letter, the normalized number, the part and the edition year.
 *  A dual-published print resolves to its OIML member (the caller picks
 *  the side); unknown type kinds refuse — never a fabricated letter. */
function parseOimlSpine(display: string): { doc_number: string; edition?: string; label: string } | null {
  try {
    const h = oimlParser.parse(display.trim()).toHash() as PubidHash;
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
  // a dual-published print: the OIML side is the spine, whichever side
  // prints first — pick it before the bare-form normalization, which
  // would mis-prefix the co-publisher's side
  if (!/^urn:/i.test(doc) && doc.includes("|")) {
    const side = doc.split("|").map((s) => s.trim()).find((s) => /^(?:OIML|oiml)\b/i.test(s));
    return side ? parseOimlSpine(side) : null;
  }
  const src = /^urn:/i.test(doc) ? urnToDisplay(doc) : /^(?:OIML|oiml)\b/i.test(doc) ? doc : `OIML ${doc}`;
  return src ? parseOimlSpine(src) : null;
};

/** OIML's grammar (delegated): type letter + 1–3 digits, optional part,
 *  optional edition year; part numbers are significant (R 60-1), the
 *  edition is never part of the number. */
export const oimlPubid: RefCodec = {
  parse(doc, edition) {
    const p = parsePubid(doc);
    if (!p) return null;
    // the caller's edition is bibdata's truth — it wins over the print's
    if (edition && p.edition !== edition) {
      return { ...p, edition, label: p.label.split(":")[0] + `:${edition}` };
    }
    return p;
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
    if (p) {
      const m = /^OIML ([A-Z]+) (\d{1,3})/.exec(p.label);
      return m ? `${m[1]}-${m[2]}` : null;
    }
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
