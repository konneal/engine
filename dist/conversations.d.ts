export declare function handleConversations(env: any, sub: string, req: Request, route: {
    method: string;
    id?: string;
}): Promise<Response>;
export declare function handleAppendMessage(env: any, sub: string, req: Request, convId: string): Promise<Response>;
