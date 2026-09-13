/** StoreQuery — the transitional relational port. The engine's
 *  repositories speak prepared statements (prepare/bind/first/all/
 *  batch); the Cloudflare adapter exposes D1 directly, and a Postgres
 *  adapter implements the same five methods over its driver. When the
 *  repository extraction completes, this narrows to semantic
 *  repositories (documents, sessions, memories…) and the SQL dialect
 *  disappears from the port entirely. */
export interface StoreQuery {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<{ results: T[] }>; run(): Promise<unknown> };
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results: T[] }>;
    run(): Promise<unknown>;
  };
  batch(statements: unknown[]): Promise<unknown[]>;
}

// the glossary lane's vector probe: the port view of a lane index
import type { VectorIndex } from "./vector.ts";
export type { VectorIndex };
