// Conversation attachments (TODO.new-era/8, Tier 1): a member's uploaded
// image persists until they delete it. The guarantees, in order:
//
//   1. NO CROSS-ACCOUNT READS — the R2 object key embeds the owner's
//      subject (`att/{sub}/{id}`), and every route re-checks the D1
//      row's ownership against the caller before touching storage. A
//      logic slip cannot cross accounts, because the key-space itself
//      is partitioned.
//   2. Stored until deleted — by the owner, or by the cascade when
//      their conversation is deleted. No TTL quietly eats member files.
//   3. The content is verified, not the extension: the magic bytes
//      decide what the file is.
//
// Storage rides the Blobs port and the row rides the StoreQuery port —
// the module never names a provider binding (the ports purity lint).

import type { Blobs } from "./ports/blobs.ts";
import type { StoreQuery } from "./ports/store.ts";

export interface AttachmentDeps {
  blobs: Blobs;
  store: StoreQuery;
}

const MAX_BYTES = 4_000_000;
const ALLOWED: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface AttachmentRow {
  id: string;
  sub: string;
  mime: string;
  bytes: number;
  created_at: string;
}

/** Sniff the image type from the magic bytes — the declared type is
 *  never trusted. Returns null for anything that is not one of the four
 *  allowed images or that exceeds the cap. */
export function sniffImage(head: Uint8Array, totalBytes: number): string | null {
  if (totalBytes > MAX_BYTES || totalBytes < 12) return null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.length >= 12 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return "image/webp";
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return "image/gif";
  return null;
}

/** A data URL (the composer's current shape) → { mime, bytes } or null. */
export function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:(image\/[a-z+]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!m) return null;
  const raw = atob(m[2]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const mime = ALLOWED[m[1]] ? m[1] : sniffImage(bytes.subarray(0, 12), bytes.length);
  if (!mime || bytes.length > MAX_BYTES) return null;
  return { mime, bytes };
}

export async function uploadAttachment(deps: AttachmentDeps, sub: string, dataUrl: string): Promise<{ id: string } | Response> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    return new Response(JSON.stringify({ error: { code: "invalid_input", message: "A PNG, JPEG, WebP or GIF image of at most 4 MB is required" } }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const id = crypto.randomUUID();
  // the key embeds the owner — the storage partition IS the isolation
  const key = `att/${sub}/${id}`;
  await deps.blobs.put(key, parsed.bytes.buffer as ArrayBuffer, parsed.mime);
  await deps.store.prepare("INSERT INTO attachments (id, sub, mime, bytes, r2_key) VALUES (?1,?2,?3,?4,?5)").bind(id, sub, parsed.mime, parsed.bytes.length, key).run();
  return { id };
}

/** The ownership check every access runs first: the row must exist and
 *  belong to the caller. A foreign id is indistinguishable from a
 *  missing one (404 — never a confirmation of someone else's file). */
export async function ownedAttachment(deps: AttachmentDeps, sub: string, id: string): Promise<AttachmentRow | null> {
  const row = await deps.store.prepare("SELECT id, sub, mime, bytes, created_at FROM attachments WHERE id = ?1 AND sub = ?2").bind(id, sub).first();
  return (row as AttachmentRow) ?? null;
}

export async function readAttachment(deps: AttachmentDeps, sub: string, id: string): Promise<Response | null> {
  const row = await ownedAttachment(deps, sub, id);
  if (!row) return null;
  const obj = await deps.blobs.get(`att/${row.sub}/${row.id}`);
  if (!obj) return null;
  return new Response(obj.body, {
    headers: { "content-type": obj.contentType ?? row.mime, "cache-control": "private, max-age=86400" },
  });
}

export async function deleteAttachment(deps: AttachmentDeps, sub: string, id: string): Promise<boolean> {
  const row = await ownedAttachment(deps, sub, id);
  if (!row) return false;
  await deps.blobs.delete(`att/${sub}/${id}`);
  await deps.store.prepare("DELETE FROM attachments WHERE id = ?1 AND sub = ?2").bind(id, sub).run();
  return true;
}
