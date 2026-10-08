// ── The ablation request boundary (TODO.sota/09) ──
//
// A runner (scripts/ablate.mjs in the deployment repo) scores pipeline
// configurations — stage lists, verdict-engine off — over the dev half
// of the benchmark. The configuration rides the /v1/ask body:
//
//   ablate_stages:  ["dense", "poolOpen", ...]   // registry projection
//   ablate_no_verdict: true                     // verdict engine off
//
// gated by the ADMIN credential in the x-admin-token header (the same
// secret the /admin routes carry; the ask bearer stays a normal tier
// key, so quota and telemetry behave exactly as for a real ask).
//
// The cache law: an ablated answer is request-scoped context — it must
// never be served to a later caller nor written for one. ask.ts honors
// that by bypassing every answer-cache read and write when a
// configuration is active.
//
// Self-contained (no imports) so the unit tests run on plain node type
// stripping, like anchors/refusal/verdict.

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
  /** Speculative draft-verify (TODO.sota/02 row 2): cheap drafts per
   *  diversified subset + one strong verifier. Off in serving until the
   *  gate promotes it; the grid arms it per ask. */
  speculative: boolean;
}

export type AblateParse =
  | { ok: true; config: AblateConfig | null }
  | { ok: false; status: number; code: string; message: string };

/** Parse and authorize an ablation configuration. Non-null config
 *  requires the admin token; a request that NAMES a configuration
 *  without the credential is 403 — never silently ignored, or a
 *  misconfigured runner would measure the full pipeline believing it
 *  measured its ablation. */
export function parseAblate(
  body: any,
  adminToken: string | undefined,
  presentedToken: string | null,
  knownStages: readonly string[],
): AblateParse {
  const rawStages = body?.ablate_stages;
  const noVerdict = body?.ablate_no_verdict === true;
  const rawRoute = body?.ablate_route;
  const speculative = body?.ablate_speculative === true;
  const namesAblation = rawStages !== undefined && rawStages !== null;
  const routeAblation = rawRoute !== undefined && rawRoute !== null && rawRoute !== "adaptive";

  if (!namesAblation && !noVerdict && !routeAblation && !speculative) return { ok: true, config: null };

  if (!adminToken || presentedToken !== adminToken) {
    return {
      ok: false,
      status: 403,
      code: "ablation_forbidden",
      message: "ablation fields require the admin credential (x-admin-token)",
    };
  }

  let route: AblateConfig["route"] = "adaptive";
  if (routeAblation) {
    if (rawRoute !== "fast" && rawRoute !== "deep") {
      return { ok: false, status: 400, code: "invalid_ablation", message: "ablate_route must be \"fast\", \"deep\" or \"adaptive\"" };
    }
    route = rawRoute;
  }

  let stages: string[] | null = null;
  if (namesAblation) {
    if (!Array.isArray(rawStages) || rawStages.length === 0) {
      return { ok: false, status: 400, code: "invalid_ablation", message: "ablate_stages must be a non-empty array of stage names" };
    }
    if (rawStages.some((n: unknown) => typeof n !== "string")) {
      return { ok: false, status: 400, code: "invalid_ablation", message: "ablate_stages must contain only stage-name strings" };
    }
    const known = new Set(knownStages);
    const unknown = (rawStages as string[]).filter((n) => !known.has(n));
    if (unknown.length) {
      return { ok: false, status: 400, code: "invalid_ablation", message: `unknown stage(s): ${unknown.join(", ")}` };
    }
    stages = [...new Set(rawStages as string[])];
  }

  return { ok: true, config: { stages, noVerdict, route, speculative } };
}
