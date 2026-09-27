// Conversation attachments: the storage partition IS the isolation —
// no account may read or delete another account's file, ever.

import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteAttachment, ownedAttachment, parseDataUrl, readAttachment, sniffImage, uploadAttachment } from "../workers/worker_public/src/attachments.ts";

function fakeDeps() {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  const blobs = {
    async put(key: string, value: ArrayBuffer, contentType?: string) {
      objects.set(key, { body: new Uint8Array(value), contentType });
    },
    async get(key: string) {
      const o = objects.get(key);
      return o ? { body: o.body as unknown as ReadableStream, contentType: o.contentType } : null;
    },
    async delete(key: string) { objects.delete(key); },
  };
  const rows = new Map<string, any>();
  const store = {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async run() {
              if (sql.startsWith("INSERT")) rows.set(args[0], { id: args[0], sub: args[1], mime: args[2], bytes: args[3], r2_key: args[4] });
              if (sql.startsWith("DELETE")) rows.delete(args[0]);
              return {};
            },
            async first() {
              for (const r of rows.values()) if (r.id === args[0] && r.sub === args[1]) return r;
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return {}; },
      };
    },
    async batch() { return []; },
  };
  const deps = { blobs: blobs as any, store: store as any };
  return { deps, objects };
}

const PNG = "data:image/png;base64," + Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

test("the magic bytes decide the type; disallowed or oversized content refuses", () => {
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]), 100), "image/png");
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 100), "image/jpeg");
  assert.equal(sniffImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 100), null);
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]), 5_000_001), null);
  const parsed = parseDataUrl(PNG);
  assert.ok(parsed && parsed.mime === "image/png");
  assert.equal(parseDataUrl("data:text/html;base64,PGh0bWw+"), null);
});

test("an upload partitions storage by subject, and the owner reads it back", async () => {
  const { deps, objects } = fakeDeps();
  const out = await uploadAttachment(deps, "acct-A", PNG);
  assert.ok(!(out instanceof Response));
  const key = [...objects.keys()][0] as string;
  assert.ok(key.startsWith(`att/acct-A/${out.id}`));
  const stream = await readAttachment(deps, "acct-A", out.id);
  assert.ok(stream && stream.headers.get("content-type") === "image/png");
});

test("NO CROSS-ACCOUNT READS: a foreign subject gets 404, and cannot delete", async () => {
  const { deps, objects } = fakeDeps();
  const out = await uploadAttachment(deps, "acct-A", PNG);
  assert.ok(!(out instanceof Response));
  // sub B asks for sub A's attachment: null (404 downstream), never bytes
  assert.equal(await readAttachment(deps, "acct-B", out.id), null);
  assert.equal(await ownedAttachment(deps, "acct-B", out.id), null);
  // sub B cannot delete it either — the object survives for the owner
  assert.equal(await deleteAttachment(deps, "acct-B", out.id), false);
  const still = await readAttachment(deps, "acct-A", out.id);
  assert.ok(still);
  // the owner deletes: the object and the row both go
  assert.equal(await deleteAttachment(deps, "acct-A", out.id), true);
  assert.equal(await readAttachment(deps, "acct-A", out.id), null);
});

test("a disallowed payload refuses before any storage write", async () => {
  const { deps, objects } = fakeDeps();
  const html = "data:text/html;base64," + Buffer.from("<script>").toString("base64");
  const out = await uploadAttachment(deps, "acct-A", html);
  assert.ok(out instanceof Response);
  assert.equal((out as Response).status, 400);
  assert.equal(objects.size, 0);
});
