export interface AblateConfig {
    /** Registry projection (names; projectStages applies them). Null/absent
     *  = the serving default (adaptive routing decides). */
    stages: string[] | null;
    /** Skip the verdict engine (machineVerdict + condition sets): the
     *  answer model narrates from passages alone. */
    noVerdict: boolean;
    /** Force a route: "fast" drops the expansion lanes, "deep" keeps the
     *  full registry, "adaptive" (the default) lets the router decide
     *  (TODO.sota/05). The grid measures the routes by forcing them. */
    route: "fast" | "deep" | "adaptive";
}
export type AblateParse = {
    ok: true;
    config: AblateConfig | null;
} | {
    ok: false;
    status: number;
    code: string;
    message: string;
};
/** Parse and authorize an ablation configuration. Non-null config
 *  requires the admin token; a request that NAMES a configuration
 *  without the credential is 403 — never silently ignored, or a
 *  misconfigured runner would measure the full pipeline believing it
 *  measured its ablation. */
export declare function parseAblate(body: any, adminToken: string | undefined, presentedToken: string | null, knownStages: readonly string[]): AblateParse;
