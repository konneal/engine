/** Kv — the hot read path's get/put with TTL. Ephemeral by contract:
 *  answer caches and quota counters treat this as disposable state
 *  (generation stamps + TTLs), so any adapter that honors the two
 *  operations is conformant. */
export interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { ttlSec?: number }): Promise<void>;
}
