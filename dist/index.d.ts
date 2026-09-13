export { setProfile } from "./profile.ts";
import type { Env } from "./env";
export type { Env };
import { type Route } from "./lib/router";
export declare const ROUTES: Route[];
declare const _default: {
    fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
};
export default _default;
