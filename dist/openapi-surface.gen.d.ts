export interface OpenApiRoute {
    method: string;
    pattern: string;
    operationId: string;
}
export type OpenApiOperationId = "askAnonymous" | "askKeyed" | "search" | "searchKeyed" | "absence" | "absenceKeyed" | "verify" | "verifyKeyed" | "research" | "researchKeyed" | "mcp" | "datasets" | "health" | "listConversations" | "createConversation" | "getConversation" | "renameConversation" | "deleteConversation" | "appendMessage" | "shareConversation" | "getShared" | "listMemories" | "createMemory" | "deleteMemory" | "listProjects" | "createProject" | "deleteProject" | "listProjectFiles" | "attachProjectFile" | "detachProjectFile" | "laneQuery" | "laneKeyed" | "feedback" | "adminEnrich" | "adminEnrichAlias" | "adminSection" | "adminSectionAlias" | "adminVectors" | "adminCaption" | "adminJudge" | "adminJudgeAlias" | "adminRevokeKey" | "authMe" | "authLogin" | "authCallback" | "authLogout" | "authLogoutLink" | "adminStats" | "adminListKeys" | "adminCreateKey";
export declare const OPENAPI_SURFACE: readonly (Omit<OpenApiRoute, "operationId"> & {
    operationId: OpenApiOperationId;
})[];
