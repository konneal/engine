// The selective brute-force escalation (TODO.sota/21): when the
// compressed pipeline's retrieval grades weak on a DOCUMENT-SCOPED
// question, answer from the WHOLE publication uncut — deepseek's 1M
// context — instead of the window. The measured justification
// (TODO.sota/18.1): brute force answers 13/13 doc-scoped dev cases
// (100%) where the compressed window scores ~92.9%, at ~200–250k
// tokens per question. The trigger gates the spend: member/key tier
// only, one resolved document, after the corrective retry failed.
//
// The citation contract (settled in writing before the build,
// TODO.sota/21): the escalated answer cites clause numbers in prose,
// verified AGAINST THE ASSEMBLED DOCUMENT — every clause-like token
// the answer references must exist in the document's own clause set.
// Verified clause citations are honest anchors; anything else fails
// the answer to the honest refusal.

import type { StoreQuery } from "./ports/store.ts";
import { P } from "./profile.ts";

export interface AssembledDocument {
  docidentifier: string;
  text: string;
  clauses: Set<string>;
  truncated: boolean;
}

/** Assemble the WHOLE document from the chunks table in reading order
 *  (rowid preserves the parse's order — TODO.impl/02's invariant),
 *  capped. The clause set is every clause anchor the document carries,
 *  plus their dotted prefixes (a citation of 5.3.2 verifies when the
 *  document carries 5.3.2 itself or a longer clause beneath it). */
export async function assembleDocument(store: StoreQuery, docidentifier: string, capChars: number, lang = "en"): Promise<AssembledDocument | null> {
  const res = await store
    .prepare(
      `SELECT text, clause_anchor, status, language FROM chunks
       WHERE docidentifier = ?1 AND language = ?2 AND status = 'in-force'
       ORDER BY rowid`,
    )
    .bind(docidentifier, lang)
    .all();
  const rows = (res.results ?? []) as unknown as { text: string; clause_anchor: string }[];
  if (!rows.length) return null;
  const clauses = new Set<string>();
  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  for (const r of rows) {
    const anchor = (r.clause_anchor || "").trim();
    if (anchor) {
      clauses.add(anchor);
      const segs = anchor.split(".");
      for (let i = 1; i < segs.length; i++) clauses.add(segs.slice(0, i).join("."));
    }
    if (total + r.text.length > capChars) {
      truncated = true;
      break;
    }
    parts.push(r.text);
    total += r.text.length;
  }
  if (!parts.length) return null;
  return { docidentifier, text: parts.join("\n\n"), clauses, truncated };
}

/** The clause-like tokens the ANSWER references (d.d and d.d.d shapes,
 *  including ranges "5.3–5.5"). Every token must resolve in the
 *  document's clause set — a cited clause the document does not carry
 *  makes the whole answer unverifiable. */
export function verifyAnchors(answer: string, clauses: Set<string>): { ok: boolean; missing: string[] } {
  const cited = new Set<string>();
  for (const m of answer.matchAll(/\b(\d{1,2}(?:\.\d{1,2}){1,3})\b/g)) cited.add(m[1]);
  for (const m of answer.matchAll(/\b(\d{1,2}\.\d{1,2})\s?[–—-]\s?(\d{1,2}(?:\.\d{1,2}){1,3})\b/g)) cited.add(m[2]);
  const missing: string[] = [];
  for (const c of cited) {
    if (!clauses.has(c) && ![...clauses].some((k) => k.startsWith(`${c}.`) || k === c)) missing.push(c);
  }
  return { ok: missing.length === 0, missing };
}

/** The system prompt reads the publisher from the profile — the
 *  publisher-leak lint's law (a hardcoded name is a leak). */
export const escalationSystem = (): string =>
  `You are ${P().publisher.name}, the answer service over legal-metrology publications. ` +
  "Answer the question using ONLY the publication text below. Cite the clause numbers you use. " +
  "If the publication does not answer it, say so plainly.";

/** The escalation's daily budget: a per-bucket KV counter. */
export async function escalationAllowed(kv: any, bucketId: string, dailyCap: number, day: string): Promise<boolean> {
  if (dailyCap <= 0) return false;
  const n = Number((await kv.get(`esc:${day}:${bucketId}`)) ?? "0");
  return n < dailyCap;
}

export async function chargeEscalation(kv: any, bucketId: string, day: string): Promise<void> {
  const key = `esc:${day}:${bucketId}`;
  await kv.put(key, String(Number((await kv.get(key)) ?? "0") + 1), { expirationTtl: 172_800 });
}
