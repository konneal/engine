// Conversation attachments: the storage partition IS the isolation —
// no account may read or delete another account's file, ever.

import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteAttachment, ownedAttachment, parseDataUrl, readAttachment, sniffImage, uploadAttachment } from "../workers/worker_public/src/attachments.ts";

const PNG = "data:image/png;base64," + Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

function fakeEnv() {
  const objects = new Map<string, Uint8Array>();
  const rows = new Map<string, any>();
  return {
    objects,
    rows,
    env: {
      CHAT_UPLOADS: Object.assign(
        {
          async put(k: string, v: Uint8Array) { objects.set(k, v); },
          async get(k: string) { return objects.get(k) ? { body: objects.get(k)! } : null; },
          async delete(k: string) { objects.delete(k); },
        },
        { get objects() { return objects; } },
      ),
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: any[]) {
              return {
                async run() {
                  if (sql.startsWith("INSERT")) rows.set(args[0], { id: args[0], sub: args[1], mime: args[2], bytes: args[3], r2_key: args[4] });
                  if (sql.startsWith("DELETE")) rows.delete(args[0]);
                  return { meta: {} };
                },
                async first() {
                  for (const r of rows.values()) {
                    if (r.id === args[0] && r.sub === args[1]) return r;
                  }
                  return null;
                },
                async all() { return { results: [] }; },
              };
            },
          };
        },
      },
    },
    objects,
    rows,
  };
}

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
  const { env } = fakeEnv();
  const out = await uploadAttachment(env, "acct-A", PNG);
  assert.ok(!(out instanceof Response));
  const key = [...(env.CHAT_UPLOADS as any).objects.keys()][0] as string;
  assert.ok(key.startsWith(`att/acct-A/${out.id}`));
  const stream = await readAttachment(env, "acct-A", out.id);
  assert.ok(stream && stream.headers.get("content-type") === "image/png");
});

test("NO CROSS-ACCOUNT READS: a foreign subject gets 404, and cannot delete", async () => {
  const { env } = fakeEnv();
  const out = await uploadAttachment(env, "acct-A", PNG);
  assert.ok(!(out instanceof Response));
  // sub B asks for sub A's attachment: null (404 downstream), never bytes
  assert.equal(await readAttachment(env, "acct-B", out.id), null);
  assert.equal(await ownedAttachment(env, "acct-B", out.id), null);
  // sub B cannot delete it either — the object survives for the owner
  assert.equal(await deleteAttachment(env, "acct-B", out.id), false);
  const still = await readAttachment(env, "acct-A", out.id);
  assert.ok(still);
  // the owner deletes: the object and the row both go
  assert.equal(await deleteAttachment(env, "acct-A", out.id), true);
  assert.equal(await readAttachment(env, "acct-A", out.id), null);
});

test("a disallowed payload refuses before any storage write", async () => {
  const { env } = fakeEnv();
  const html = "data:text/html;base64," + Buffer.from("<script>").toString("base64");
  const out = await uploadAttachment(env, "acct-A", html);
  assert.ok(out instanceof Response);
  assert.equal((out as Response).status, 400);
  assert.equal((env.CHAT_UPLOADS as any).objects.size, 0);
});
