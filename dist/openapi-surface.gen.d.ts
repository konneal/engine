export interface OpenApiRoute {
    method: string;
    pattern: string;
    operationId: string;
}
export type OpenApiOperationId = "askAnonymous" | "askKeyed" | "search" | "searchKeyed" | "verify" | "verifyKeyed" | "research" | "researchKeyed" | "mcp" | "datasets" | "keyUsage" | "health" | "listConversations" | "createConversation" | "getConversation" | "renameConversation" | "deleteConversation" | "appendMessage" | "shareConversation" | "getShared" | "uploadAttachment" | "listAttachments" | "getAttachment" | "deleteAttachment" | "listMemories" | "createMemory" | "deleteMemory" | "listProjects" | "createProject" | "deleteProject" | "listProjectFiles" | "attachProjectFile" | "detachProjectFile" | "laneQuery" | "laneKeyed" | "feedback" | "adminEnrich" | "adminEnrichAlias" | "adminSection" | "adminFamilySummary" | "adminSectionAlias" | "adminFamilySummaryAlias" | "adminVectors" | "adminCaption" | "adminJudge" | "adminJudgeAlias" | "adminRevokeKey" | "authMe" | "authLogin" | "authCallback" | "authLogout" | "authLogoutLink" | "adminStats" | "adminListKeys" | "adminCreateKey";
export declare const OPENAPI_SURFACE: readonly (Omit<OpenApiRoute, "operationId"> & {
    operationId: OpenApiOperationId;
})[];
