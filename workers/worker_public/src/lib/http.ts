// Shared HTTP response helpers (DRY: previously duplicated ×3).
export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

export const err = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);
