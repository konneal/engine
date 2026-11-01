import type { Blobs } from "./ports/blobs.ts";
import type { StoreQuery } from "./ports/store.ts";
import type { VectorIndex } from "./ports/vector.ts";
import type { ModelRunner } from "./ports/model.ts";
export declare const USER_DOC_LIMIT = 10;
export declare const USER_DOC_MAX_BYTES: number;
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
export declare function userDocumentChunkId(docId: string): string;
export declare function listUserDocuments(store: StoreQuery, sub: string): Promise<{
    documents: UserDocumentRow[];
}>;
export declare function getUserDocument(store: StoreQuery, sub: string, id: string): Promise<UserDocumentRow | null>;
/** The quota guard: 10 documents per member. Returns the refusal
 *  response or null. */
export declare function quotaRefusal(store: StoreQuery, sub: string): Promise<Response | null>;
/** The import: validate, store the original, record the row, and run
 *  the extraction under the request's waitUntil — the route answers
 *  202 with the importing row and the status endpoint tells the rest.
 *  Every quota rule is checked BEFORE anything is stored. */
export declare function createImport(ports: UserDocumentPorts, waitUntil: (p: Promise<unknown>) => void, sub: string, file: UploadBlob): Promise<{
    document: UserDocumentRow;
} | {
    error: Response;
}>;
/** The worker's half of the extraction: get text (vision for images,
 *  the PDF text layer for digital-born PDFs), then one structuring
 *  call. Statuses land on the row either way — importing | ready |
 *  no_text_layer | failed, never a silent empty import. */
export declare function processImport(ports: UserDocumentPorts, row: UserDocumentRow, mime: string, bytes: Uint8Array): Promise<void>;
/** The digital-born PDF's text layer: inflate FlateDecode content
 *  streams and scan the text-showing operators (Tj/TJ/'/"). Scanned
 *  PDFs have no text layer — the honest no_text_layer status answers
 *  them. No external dependency; Workers' DecompressionStream does the
 *  inflate. */
export declare function pdfTextLayer(bytes: Uint8Array): Promise<string>;
/** Pull the string literals out of one content stream's text ops. */
export declare function pdfTextOps(content: string): string;
/** Deletion is immediate and total: the R2 object, the lane vectors,
 *  the row. The caller has already checked ownership. */
export declare function deleteUserDocument(ports: UserDocumentPorts, sub: string, id: string): Promise<UserDocumentRow | null>;
