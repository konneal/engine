// The user-documents lane's pure halves: the deterministic chunk id,
// the PDF text-layer scan, and the quota guard's exact refusal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfTextLayer, pdfTextOps, quotaRefusal, userDocumentChunkId } from "../workers/worker_public/src/userDocuments.ts";

test("the lane chunk id is deterministic per document", () => {
  assert.equal(userDocumentChunkId("abc-123"), "ud-abc-123");
  assert.equal(userDocumentChunkId("abc-123"), userDocumentChunkId("abc-123"));
});

test("pdf text ops pull string literals with escapes decoded", () => {
  const out = pdfTextOps("(Hello World) Tj (R60\\/2021) Tj (A\\)B) TJ");
  assert.match(out, /Hello World/);
  assert.match(out, /R60\/2021/);
  assert.match(out, /A\)B/);
});

test("pdf text layer reads an uncompressed content stream", async () => {
  const content = "BT (Certificate R60/2021-DK1-24.01) Tj ET";
  const pdf = `%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`;
  const bytes = new Uint8Array([...pdf].map((c) => c.charCodeAt(0)));
  const text = await pdfTextLayer(bytes);
  assert.match(text, /Certificate R60\/2021-DK1-24\.01/);
});

test("the quota guard refuses the eleventh document with its number", async () => {
  const full = { prepare: () => ({ bind: () => ({ first: async () => ({ n: 10 }) }) }) };
  const refusal = await quotaRefusal(full, "sub-1");
  assert.ok(refusal);
  assert.equal(refusal.status, 403);
  const body = await refusal.json();
  assert.match(body.error.message, /maximum of 10 documents/);
  const roomy = { prepare: () => ({ bind: () => ({ first: async () => ({ n: 9 }) }) }) };
  assert.equal(await quotaRefusal(roomy, "sub-1"), null);
});
