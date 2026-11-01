// The member's own documents (TODO.sota/20 v1): import → privately
// index → answer beside the corpus. The structural isolation law: user
// documents live in a USER lane — their own Vectorize index (USER_DOCS)
// and their own R2 bucket (USER_DOCS) — never the public production
// index with a filter (the 2026-09-02 incident's law). Every vector in
// the lane carries its owner's sub; the ask-path federation (slice 4)
// queries the lane ONLY with the session's own sub — mandatory by
// construction, the query helper below takes no unfiltered path.
//
// Retention, stated to the member verbatim in the UI: 10 documents, 20
// MB each, held until the member deletes; deletion is immediate and
// total (the R2 object, the lane vectors and the row go together).
//
// Extraction v1, honest about formats: images ride the ratified vision
// lane (the nameplate message pattern — the image rides its OWN short
// trailing user message); digital-born PDFs give up their text layer
// (inflate + the text-op scan) and the model structures it; a scanned
// PDF with no text layer is answered honestly (status no_text_layer) —
// the rasterization lane is future work, not a silent empty import.
// One model call classifies and extracts (kind + typed fields + a
// retrieval summary); the Clef instrument joins when the import eval
// runs on the first real documents.
//
// Port purity: this module names no provider binding — the route table
// wires cfStore/cfBlobs/cfVectorIndex/cfModelRunner; tests inject
// fakes.

import type { Blobs } from "./ports/blobs.ts";
import type { StoreQuery } from "./ports/store.ts";
import type { VectorIndex } from "./ports/vector.ts";
import type { ModelRunner } from "./ports/model.ts";
import { MODELS } from "./config.ts";
import type { Hit } from "../../shared/chunk.ts";

export const USER_DOC_LIMIT = 10;
export const USER_DOC_MAX_BYTES = 20 * 1024 * 1024;
const ACCEPTED_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

export interface UserDocumentRow {
  id: string;
  owner_sub: string;
  name: string;
  kind: string | null;
  status: string;
  bytes: number;
  r2_key: string | null;
  fields: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserDocumentPorts {
  store: StoreQuery;
  blobs: Blobs;
  lane: VectorIndex;
  model: ModelRunner;
}

export interface UploadBlob {
  arrayBuffer(): Promise<ArrayBuffer>;
  size: number;
  type: string;
  name: string;
}

/** The lane's one chunk id per document — deterministic, so deletion
 *  can drop it by id without an index listing round-trip. */
export function userDocumentChunkId(docId: string): string {
  return `ud-${docId}`;
}

export async function listUserDocuments(store: StoreQuery, sub: string): Promise<{ documents: UserDocumentRow[] }> {
  const res = await store
    .prepare("SELECT id, owner_sub, name, kind, status, bytes, r2_key, fields, error, created_at, updated_at FROM user_documents WHERE owner_sub = ?1 ORDER BY created_at DESC")
    .bind(sub)
    .all();
  return { documents: (res.results ?? []) as unknown as UserDocumentRow[] };
}

export async function getUserDocument(store: StoreQuery, sub: string, id: string): Promise<UserDocumentRow | null> {
  const row = await store
    .prepare("SELECT id, owner_sub, name, kind, status, bytes, r2_key, fields, error, created_at, updated_at FROM user_documents WHERE id = ?1 AND owner_sub = ?2")
    .bind(id, sub)
    .first();
  return (row as unknown as UserDocumentRow) ?? null;
}

/** The quota guard: 10 documents per member. Returns the refusal
 *  response or null. */
export async function quotaRefusal(store: StoreQuery, sub: string): Promise<Response | null> {
  const row = await store.prepare("SELECT COUNT(*) AS n FROM user_documents WHERE owner_sub = ?1").bind(sub).first<{ n: number }>();
  const n = Number(row?.n ?? 0);
  if (n >= USER_DOC_LIMIT) {
    return new Response(JSON.stringify({ error: { code: "quota_exceeded", message: `You hold the maximum of ${USER_DOC_LIMIT} documents. Delete one to import another.` } }), { status: 403, headers: { "content-type": "application/json" } });
  }
  return null;
}

/** The import: validate, store the original, record the row, and run
 *  the extraction under the request's waitUntil — the route answers
 *  202 with the importing row and the status endpoint tells the rest.
 *  Every quota rule is checked BEFORE anything is stored. */
export async function createImport(ports: UserDocumentPorts, waitUntil: (p: Promise<unknown>) => void, sub: string, file: UploadBlob): Promise<{ document: UserDocumentRow } | { error: Response }> {
  const mime = file.type || "";
  if (!ACCEPTED_MIMES.has(mime)) {
    return { error: new Response(JSON.stringify({ error: { code: "invalid_type", message: "Upload a PNG, JPEG, WebP image or a PDF." } }), { status: 415, headers: { "content-type": "application/json" } }) };
  }
  if (file.size > USER_DOC_MAX_BYTES) {
    return { error: new Response(JSON.stringify({ error: { code: "too_large", message: `Documents are limited to ${Math.floor(USER_DOC_MAX_BYTES / (1024 * 1024))} MB.` } }), { status: 413, headers: { "content-type": "application/json" } }) };
  }
  const refused = await quotaRefusal(ports.store, sub);
  if (refused) return { error: refused };

  const id = crypto.randomUUID();
  const r2Key = `${sub}/${id}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await ports.blobs.put(r2Key, bytes.buffer as ArrayBuffer, mime);
  const now = new Date().toISOString();
  const row: UserDocumentRow = {
    id, owner_sub: sub, name: file.name || "document", kind: null,
    status: "importing", bytes: bytes.byteLength, r2_key: r2Key,
    fields: null, error: null, created_at: now, updated_at: now,
  };
  await ports.store.prepare(
    "INSERT INTO user_documents (id, owner_sub, name, kind, status, bytes, r2_key, fields, error, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
  )
    .bind(id, sub, row.name, row.kind, row.status, row.bytes, row.r2_key, row.fields, row.error, now, now)
    .run();
  waitUntil(processImport(ports, row, mime, bytes).catch(() => {}));
  return { document: row };
}

interface Extraction {
  kind: "certificate" | "test_report" | "other";
  fields: Record<string, string>;
  summary: string;
  text: string;
}

/** The worker's half of the extraction: get text (vision for images,
 *  the PDF text layer for digital-born PDFs), then one structuring
 *  call. Statuses land on the row either way — importing | ready |
 *  no_text_layer | failed, never a silent empty import. */
export async function processImport(ports: UserDocumentPorts, row: UserDocumentRow, mime: string, bytes: Uint8Array): Promise<void> {
  const setStatus = async (status: string, fields: Record<string, string> | null, error: string | null) => {
    await ports.store.prepare("UPDATE user_documents SET status = ?1, kind = ?2, fields = ?3, error = ?4, updated_at = ?5 WHERE id = ?6")
      .bind(status, fields ? extractKind(fields) : null, fields ? JSON.stringify(fields) : null, error, new Date().toISOString(), row.id)
      .run();
  };
  try {
    let text: string;
    if (mime === "application/pdf") {
      text = await pdfTextLayer(bytes);
      if (!text || text.replace(/\s+/g, "").length < 40) {
        await setStatus("no_text_layer", null, "This PDF has no extractable text layer. Export page images (PNG/JPEG) and import those — the vision lane reads them directly.");
        return;
      }
    } else {
      // images: the vision lane transcribes (the nameplate pattern —
      // transcription-first framing beats extract-a-JSON on plates)
      text = await visionTranscribe(ports.model, mime, bytes);
      if (!text || text.replace(/\s+/g, "").length < 20) {
        await setStatus("failed", null, "The vision lane could not read this image. Try a sharper photo.");
        return;
      }
    }
    const extraction = await structureDocument(ports.model, row.name, mime, text);
    // the lane chunk: the summary leads, the verbatim text carries the
    // rest — the federation cites THIS document's content
    const fieldsLine = Object.entries(extraction.fields).map(([k, v]) => `${k}: ${v}`).join("; ");
    const chunkText = `Member document (${extraction.kind}) — ${row.name}. ${fieldsLine}. ${extraction.summary}\n\n${extraction.text.slice(0, 8000)}`;
    const [vector] = await ports.model.embed([chunkText]);
    // the lane vector carries the ChunkMeta shape the pipeline speaks
    // (toHits reads text from metadata.chunk_text) plus user_sub — the
    // filter key the federation's mandatory-by-construction scope
    await ports.lane.upsert([
      {
        id: userDocumentChunkId(row.id),
        values: vector,
        metadata: {
          user_sub: row.owner_sub,
          doc_id: `ud-${row.id}`,
          docidentifier: `Member document — ${row.name}`,
          doctype: "user",
          doc_number: extraction.kind,
          edition: "",
          language: "en",
          clause_anchor: "",
          clause_title: row.name.slice(0, 120),
          tier: "member",
          corpus: "user_docs",
          text_ref: "",
          kind: extraction.kind,
          name: row.name.slice(0, 120),
          chunk_text: chunkText.slice(0, 1800),
        },
      },
    ]);
    await setStatus("ready", { kind: extraction.kind, ...extraction.fields, summary: extraction.summary }, null);
  } catch (e) {
    await setStatus("failed", null, String(e).slice(0, 200)).catch(() => {});
  }
}

function extractKind(fields: Record<string, string>): string {
  return fields.kind || "other";
}

async function visionTranscribe(model: ModelRunner, mime: string, bytes: Uint8Array): Promise<string> {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  const dataUrl = `data:${mime};base64,${btoa(binary)}`;
  const res = await model.run({
    model: MODELS.member,
    messages: [
      { role: "system", content: "Transcribe everything you can read in this document image — certificate numbers, holders, models, values, dates, clause references. Transcribe first; organize nothing." },
      { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] },
    ],
    maxTokens: 2048,
    effort: "low",
    temperature: 0.15,
  });
  return res.text ?? "";
}

/** One structuring call: classify + typed fields + a retrieval summary.
 *  The response's JSON object is taken; prose around it is ignored. */
async function structureDocument(model: ModelRunner, name: string, mime: string, text: string): Promise<Extraction> {
  const res = await model.run({
    model: MODELS.member,
    messages: [
      { role: "system", content: `You classify and structure an imported metrology document. Answer with ONE JSON object: {"kind": "certificate"|"test_report"|"other", "fields": {…short typed fields…}, "summary": "one paragraph a retrieval engine can answer from"}. Certificates carry certificate numbers (like R60/2021-XX1-24.01), holders, models, issue dates. Test reports carry measured values, uncertainties, instruments, clause references. Fields use snake_case names, values verbatim from the text. Never invent a value the text does not carry.` },
      { role: "user", content: `Document name: ${name}\nFormat: ${mime}\n\nText:\n${text.slice(0, 12000)}` },
    ],
    maxTokens: 2048,
    effort: "low",
    temperature: 0.15,
  });
  const raw = res.text ?? "";
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) throw new Error("the structuring call returned no JSON object");
  const parsed = JSON.parse(m[0]) as { kind?: string; fields?: Record<string, unknown>; summary?: string };
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.fields ?? {})) {
    if (typeof v === "string" || typeof v === "number") fields[k.slice(0, 40)] = String(v).slice(0, 200);
  }
  const kind = parsed.kind === "certificate" || parsed.kind === "test_report" ? parsed.kind : "other";
  return { kind, fields, summary: String(parsed.summary ?? "").slice(0, 1200), text };
}

/** The digital-born PDF's text layer: inflate FlateDecode content
 *  streams and scan the text-showing operators (Tj/TJ/'/"). Scanned
 *  PDFs have no text layer — the honest no_text_layer status answers
 *  them. No external dependency; Workers' DecompressionStream does the
 *  inflate. */
export async function pdfTextLayer(bytes: Uint8Array): Promise<string> {
  const raw = new TextDecoder("latin1").decode(bytes);
  const parts: string[] = [];
  const streamRe = /stream\r?\n?/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const chunk = raw.slice(start, end);
    streamRe.lastIndex = end;
    // Flate streams begin 0x78; raw text streams (uncompressed) carry
    // the operators directly
    let content = "";
    if (chunk.charCodeAt(0) === 0x78) {
      try {
        const ds = new DecompressionStream("deflate");
        const stream = new Blob([new Uint8Array([...chunk].map((c) => c.charCodeAt(0) & 0xff))]).stream().pipeThrough(ds);
        content = await new Response(stream).text();
      } catch {
        continue;
      }
    } else if (/\bTj\b|\bTJ\b/.test(chunk)) {
      content = chunk;
    } else {
      continue;
    }
    parts.push(pdfTextOps(content));
    if (parts.join("").length > 200_000) break;
  }
  return parts.join("\n");
}

/** Pull the string literals out of one content stream's text ops. */
export function pdfTextOps(content: string): string {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\()])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    let s = m[0].slice(1, -1);
    s = s.replace(/\\([nrtbf()/\\])/g, (_, c: string) => ({ n: "\n", r: "", t: "\t", b: "", f: "", "(": "(", ")": ")", "/": "/", "\\": "\\" }[c] ?? c));
    s = s.replace(/\\([0-7]{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (s.trim()) out.push(s);
  }
  return out.join(" ");
}

/** The federation's one door: the caller's OWN lane, filtered by their
 *  sub — the filter is a required parameter, there is no unfiltered
 *  path. Returns Hit-shaped matches (toHits convention: text from
 *  metadata.chunk_text). */
export async function queryUserLane(model: ModelRunner, lane: VectorIndex, sub: string, query: string, k: number): Promise<Hit[]> {
  const [vector] = await model.embed([query]);
  const matches = await lane.query({ vector, topK: k, filter: { user_sub: sub } });
  return matches.map((m) => ({
    id: m.id,
    score: m.score,
    metadata: m.metadata as never,
    text: String((m.metadata as any)?.chunk_text ?? ""),
  }));
}

/** Deletion is immediate and total: the R2 object, the lane vectors,
 *  the row. The caller has already checked ownership. */
export async function deleteUserDocument(ports: UserDocumentPorts, sub: string, id: string): Promise<UserDocumentRow | null> {
  const row = await getUserDocument(ports.store, sub, id);
  if (!row) return null;
  if (row.r2_key) await ports.blobs.delete(row.r2_key).catch(() => {});
  await ports.lane.deleteIds([userDocumentChunkId(id)]).catch(() => {});
  await ports.store.prepare("DELETE FROM user_documents WHERE id = ?1 AND owner_sub = ?2").bind(id, sub).run();
  return row;
}
