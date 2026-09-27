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
export declare function sniffImage(head: Uint8Array, totalBytes: number): string | null;
/** A data URL (the composer's current shape) → { mime, bytes } or null. */
export declare function parseDataUrl(dataUrl: string): {
    mime: string;
    bytes: Uint8Array;
} | null;
export declare function uploadAttachment(env: any, sub: string, dataUrl: string): Promise<{
    id: string;
} | Response>;
/** The ownership check every access runs first: the row must exist and
 *  belong to the caller. A foreign id is indistinguishable from a
 *  missing one (404 — never a confirmation of someone else's file). */
export declare function ownedAttachment(env: any, sub: string, id: string): Promise<AttachmentRow | null>;
export declare function readAttachment(env: any, sub: string, id: string): Promise<Response | null>;
export declare function deleteAttachment(env: any, sub: string, id: string): Promise<boolean>;
