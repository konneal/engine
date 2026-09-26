import type { SessionClaims } from "./session.ts";
export declare function delegatedBearerFrom(req: Request, env: any): Promise<SessionClaims | null>;
