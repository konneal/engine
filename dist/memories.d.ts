export declare function handleMemories(env: any, sub: string, req: Request, route: {
    method: string;
    id?: string;
}): Promise<Response>;
/** The ask path's memory injection: fetch the SELECTED, OWNED files and
 *  render them as one bounded note. Ids may be personal (m:…) or the
 *  user's project files (pf:…) — ownership resolves both ways, and a
 *  foreign id silently drops (a stale selection is never an error, and
 *  never another user's memory). Returns [note, idsActuallyUsed]. */
export declare function memoryNote(env: any, sub: string, ids: string[]): Promise<[string | null, string[]]>;
