// Answer contract v2 — symbolic unit references (SymGen-style,
// arXiv:2311.09188): the model may write [[u:<id>]] tokens pointing at
// typed MKO units among the passages. Every reference is VALIDATED
// against the units actually present in usedHits; invalid refs are
// dropped from the rendered text (logged, never shown). The payload
// data itself never passes through the LLM — blocks are resolved from
// the producer-validated D1 unit_payloads table.

export interface ResolvedBlock {
  unit_id: string;
  type: string;
  docidentifier: string;
  edition?: string;
  payload: Record<string, unknown>;
}

const REF = /\[\[(u:[A-Za-z0-9_-]+)\]\]/g;

/** unit ids the passages actually contain (chunk metadata carries
 *  unit_id on typed MKO chunks). */
export function availableUnitIds(hits: ReadonlyArray<{ metadata: { unit_id?: string | undefined } }>): Set<string> {
  const ids = new Set<string>();
  for (const h of hits) {
    const u = h.metadata?.unit_id;
    if (u) ids.add(u);
  }
  return ids;
}

export function parseRefs(text: string): string[] {
  return [...text.matchAll(REF)].map((m) => m[1]);
}

/** Drop refs that don't resolve to a used passage unit — a dangling ref
 *  renders as nothing (the token removed), and the violation is logged. */
export function sanitizeRefs(text: string, available: ReadonlySet<string>): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const out = text.replace(REF, (full, id: string) => {
    if (available.has(id)) return full;
    dropped.push(id);
    return "";
  });
  return { text: out, dropped };
}

/** Resolve validated refs to producer payloads from D1 (unit_payloads).
 *  Unknown-to-D1 ids are skipped — a ref without a payload renders as a
 *  plain token, never as fabricated data. */
export async function resolveBlocks(
  db: D1Database,
  refs: string[],
): Promise<ResolvedBlock[]> {
  if (!refs.length) return [];
  const uniq = [...new Set(refs)].slice(0, 12);
  const blocks: ResolvedBlock[] = [];
  for (let i = 0; i < uniq.length; i += 20) {
    const batch = uniq.slice(i, i + 20);
    const placeholders = batch.map((_, n) => `?${n + 1}`).join(",");
    try {
      const res = await db
        .prepare(`SELECT unit_id, type, docidentifier, edition, payload FROM unit_payloads WHERE unit_id IN (${placeholders})`)
        .bind(...batch)
        .all();
      for (const r of res.results ?? []) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(r.payload));
        } catch {
          continue;
        }
        blocks.push({
          unit_id: String(r.unit_id),
          type: String(r.type),
          docidentifier: String(r.docidentifier ?? ""),
          edition: r.edition ? String(r.edition) : undefined,
          payload,
        });
      }
    } catch (e) {
      console.log("resolveBlocks failed:", String(e).slice(0, 150));
    }
  }
  return blocks;
}

/** One pass: validate + resolve + strip invalid tokens. */
export async function contractV2(
  db: D1Database,
  answer: string,
  usedHits: ReadonlyArray<{ metadata: { unit_id?: string | undefined } }>,
): Promise<{ text: string; blocks: ResolvedBlock[]; dropped: string[] }> {
  const available = availableUnitIds(usedHits);
  const { text, dropped } = sanitizeRefs(answer, available);
  if (dropped.length) console.log("refs: dropped", dropped.length, "invalid (not in passages)");
  const refs = parseRefs(text);
  const blocks = await resolveBlocks(db, refs);
  return { text, blocks, dropped };
}

/** Detect table-retyping: a markdown table in the answer while a typed
 *  table unit was available to reference. Enforcement signal for the
 *  corrective regen (same pattern as quote-anchor violations). */
export function tableRetyped(text: string, availableTable: boolean): boolean {
  if (!availableTable) return false;
  return /(^|\n)\s*\|[^\n]+\|\s*(\n\s*\|[-: |]+\|\s*)?(\n|$)/.test(text) && (text.match(/\|/g) ?? []).length >= 6;
}
