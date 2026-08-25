// Shared auth: session validation + role constants used by both workers.
import { readSession } from "./session";

// Two tiers: anonymous (public) and member (both). No role gates.

export function authConfig(env: any) {
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) return null;
  return { sessionSecret };
}

export async function sessionFrom(req: Request, env: any) {
  const cfg = authConfig(env);
  if (!cfg) return null;
  return readSession(req, cfg.sessionSecret);
}
