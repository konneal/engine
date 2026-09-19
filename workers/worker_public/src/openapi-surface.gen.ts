// GENERATED from workers/worker_public/openapi.yaml — do not edit.
// Regenerate: node scripts/gen-openapi-routes.mjs
export interface OpenApiRoute {
  method: string
  pattern: string
  operationId: string
}

export type OpenApiOperationId =
  | "askAnonymous"
  | "askKeyed"
  | "search"
  | "searchKeyed"
  | "absence"
  | "absenceKeyed"
  | "verify"
  | "verifyKeyed"
  | "research"
  | "researchKeyed"
  | "mcp"
  | "datasets"
  | "health"
  | "listConversations"
  | "createConversation"
  | "getConversation"
  | "renameConversation"
  | "deleteConversation"
  | "appendMessage"
  | "shareConversation"
  | "getShared"
  | "listMemories"
  | "createMemory"
  | "deleteMemory"
  | "listProjects"
  | "createProject"
  | "deleteProject"
  | "listProjectFiles"
  | "attachProjectFile"
  | "detachProjectFile"
  | "laneQuery"
  | "laneKeyed"
  | "feedback"
  | "adminEnrich"
  | "adminEnrichAlias"
  | "adminSection"
  | "adminSectionAlias"
  | "adminVectors"
  | "adminCaption"
  | "adminJudge"
  | "adminJudgeAlias"
  | "adminRevokeKey"
  | "authMe"
  | "authLogin"
  | "authCallback"
  | "authLogout"
  | "authLogoutLink"
  | "adminStats"
  | "adminListKeys"
  | "adminCreateKey"

export const OPENAPI_SURFACE: readonly (Omit<OpenApiRoute, "operationId"> & { operationId: OpenApiOperationId })[] = [
  {
    "method": "POST",
    "pattern": "/api/ask",
    "operationId": "askAnonymous"
  },
  {
    "method": "POST",
    "pattern": "/v1/ask",
    "operationId": "askKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/search",
    "operationId": "search"
  },
  {
    "method": "POST",
    "pattern": "/v1/search",
    "operationId": "searchKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/absence",
    "operationId": "absence"
  },
  {
    "method": "POST",
    "pattern": "/v1/absence",
    "operationId": "absenceKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/verify",
    "operationId": "verify"
  },
  {
    "method": "POST",
    "pattern": "/v1/verify",
    "operationId": "verifyKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/research",
    "operationId": "research"
  },
  {
    "method": "POST",
    "pattern": "/v1/research",
    "operationId": "researchKeyed"
  },
  {
    "method": "POST",
    "pattern": "/mcp",
    "operationId": "mcp"
  },
  {
    "method": "GET",
    "pattern": "/api/datasets",
    "operationId": "datasets"
  },
  {
    "method": "GET",
    "pattern": "/health",
    "operationId": "health"
  },
  {
    "method": "GET",
    "pattern": "/api/conversations",
    "operationId": "listConversations"
  },
  {
    "method": "POST",
    "pattern": "/api/conversations",
    "operationId": "createConversation"
  },
  {
    "method": "GET",
    "pattern": "/api/conversations/:id",
    "operationId": "getConversation"
  },
  {
    "method": "PATCH",
    "pattern": "/api/conversations/:id",
    "operationId": "renameConversation"
  },
  {
    "method": "DELETE",
    "pattern": "/api/conversations/:id",
    "operationId": "deleteConversation"
  },
  {
    "method": "POST",
    "pattern": "/api/conversations/:id/messages",
    "operationId": "appendMessage"
  },
  {
    "method": "POST",
    "pattern": "/api/conversations/:id/share",
    "operationId": "shareConversation"
  },
  {
    "method": "GET",
    "pattern": "/api/shared/:slug",
    "operationId": "getShared"
  },
  {
    "method": "GET",
    "pattern": "/api/memories",
    "operationId": "listMemories"
  },
  {
    "method": "POST",
    "pattern": "/api/memories",
    "operationId": "createMemory"
  },
  {
    "method": "DELETE",
    "pattern": "/api/memories/:id",
    "operationId": "deleteMemory"
  },
  {
    "method": "GET",
    "pattern": "/api/projects",
    "operationId": "listProjects"
  },
  {
    "method": "POST",
    "pattern": "/api/projects",
    "operationId": "createProject"
  },
  {
    "method": "DELETE",
    "pattern": "/api/projects",
    "operationId": "deleteProject"
  },
  {
    "method": "GET",
    "pattern": "/api/projects/:id/files",
    "operationId": "listProjectFiles"
  },
  {
    "method": "POST",
    "pattern": "/api/projects/:id/files",
    "operationId": "attachProjectFile"
  },
  {
    "method": "DELETE",
    "pattern": "/api/project-files/:id",
    "operationId": "detachProjectFile"
  },
  {
    "method": "POST",
    "pattern": "/api/lane",
    "operationId": "laneQuery"
  },
  {
    "method": "POST",
    "pattern": "/v1/lane",
    "operationId": "laneKeyed"
  },
  {
    "method": "POST",
    "pattern": "/api/feedback",
    "operationId": "feedback"
  },
  {
    "method": "POST",
    "pattern": "/v1/admin/enrich",
    "operationId": "adminEnrich"
  },
  {
    "method": "POST",
    "pattern": "/admin/enrich",
    "operationId": "adminEnrichAlias"
  },
  {
    "method": "POST",
    "pattern": "/v1/admin/section",
    "operationId": "adminSection"
  },
  {
    "method": "POST",
    "pattern": "/admin/section",
    "operationId": "adminSectionAlias"
  },
  {
    "method": "POST",
    "pattern": "/admin/vectors",
    "operationId": "adminVectors"
  },
  {
    "method": "POST",
    "pattern": "/admin/caption",
    "operationId": "adminCaption"
  },
  {
    "method": "POST",
    "pattern": "/v1/admin/judge",
    "operationId": "adminJudge"
  },
  {
    "method": "POST",
    "pattern": "/admin/judge",
    "operationId": "adminJudgeAlias"
  },
  {
    "method": "DELETE",
    "pattern": "/v1/admin/keys/:id",
    "operationId": "adminRevokeKey"
  },
  {
    "method": "GET",
    "pattern": "/auth/me",
    "operationId": "authMe"
  },
  {
    "method": "GET",
    "pattern": "/auth/login",
    "operationId": "authLogin"
  },
  {
    "method": "GET",
    "pattern": "/auth/callback",
    "operationId": "authCallback"
  },
  {
    "method": "POST",
    "pattern": "/auth/logout",
    "operationId": "authLogout"
  },
  {
    "method": "GET",
    "pattern": "/auth/logout",
    "operationId": "authLogoutLink"
  },
  {
    "method": "GET",
    "pattern": "/v1/admin/stats",
    "operationId": "adminStats"
  },
  {
    "method": "GET",
    "pattern": "/v1/admin/keys",
    "operationId": "adminListKeys"
  },
  {
    "method": "POST",
    "pattern": "/v1/admin/keys",
    "operationId": "adminCreateKey"
  }
] as const
