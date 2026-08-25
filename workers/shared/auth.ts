// Shared auth: session validation + role constants used by both workers.
import { readSession } from "./session";

export const INTERNAL_ROLES = ["mc_member", "rc_member", "executive_secretary", "admin"] as const;

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
