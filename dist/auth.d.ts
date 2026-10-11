import { SessionClaims } from "./session";
export interface AuthConfig {
    issuer: string;
    clientId: string;
    redirectUri: string;
    sessionSecret: string;
}
export declare function handleLogin(env: any, req: Request): Promise<Response>;
export declare function handleCallback(env: any, req: Request): Promise<Response>;
export declare function sessionFrom(req: Request, env: any): Promise<SessionClaims | null>;
export declare function handleMe(env: any, req: Request): Promise<Response>;
export declare function handleLogout(env: any, req: Request): Promise<Response>;
