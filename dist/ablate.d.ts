export interface AblateConfig {
    /** Registry projection (names; projectStages applies them). Null/absent
     *  = the full registry. */
    stages: string[] | null;
    /** Skip the verdict engine (machineVerdict + condition sets): the
     *  answer model narrates from passages alone. */
    noVerdict: boolean;
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
