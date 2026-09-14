export interface Env {
    RAG_BASE: string;
    /** the deployment's shared D1 (API keys + the derived documents
     *  registry: editions, active flags, supersession) */
    DB: D1Database;
}
declare const _default: {
    fetch(req: Request, env: Env): Promise<Response>;
};
export default _default;
