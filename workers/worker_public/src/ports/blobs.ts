/** Blobs — immutable object storage (unit assets, rendered documents).
 *  Every mainstream provider speaks S3; the reference adapter speaks
 *  R2's binding API. Objects are content-typed and read by key. */
export interface Blobs {
  get(key: string): Promise<{ body: ReadableStream | null; contentType?: string } | null>;
  put(key: string, value: string | ReadableStream | ArrayBuffer, contentType?: string): Promise<void>;
}
