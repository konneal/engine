// Personalized memory files (#171): per-member context documents the
// ask path injects when selected. Member-scoped CRUD — every query is
// owner-filtered by the session's sub; content is user-authored text,
// never corpus. Caps: 10 files, 8k chars each (the ask path further
// bounds the injected total).

import { json, err } from "./lib/http";

const MAX_FILES = 10;
const MAX_CONTENT = 8_000;
const MAX_NAME = 64;
const ID_RE = /^m:[a-f0-9]{16}$/;

const newId = () => "m:" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function handleMemories(env: any, sub: string, req: Request, route: { method: string; id?: string }): Promise<Response> {
  const { method, id } = route;
  if (method === "GET") {
    const rows = (await env.DB.prepare("SELECT id, name, content, enabled, updated_at FROM memories WHERE sub = ?1 ORDER BY updated_at DESC").bind(sub).all()).results ?? [];
    return json({ memories: rows });
  }
  if (method === "DELETE") {
    if (!id || !ID_RE.test(id)) return err(400, "invalid_input", "bad memory id");
    await env.DB.prepare("DELETE FROM memories WHERE id = ?1 AND sub = ?2").bind(id, sub).run();
    return json({ ok: true });
  }
  if (method === "POST") {
    const body: any = await req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
    const content = typeof body?.content === "string" ? body.content.slice(0, MAX_CONTENT) : "";
    if (!name || !content.trim()) return err(400, "invalid_input", "name and content are required");
    const now = Date.now();
    if (typeof body?.id === "string" && ID_RE.test(body.id)) {
      const r = await env.DB.prepare(
        "UPDATE memories SET name = ?1, content = ?2, updated_at = ?3 WHERE id = ?4 AND sub = ?5",
      ).bind(name, content, now, body.id, sub).run();
      if (!r.meta?.changes) return err(404, "not_found", "no such memory");
      return json({ ok: true, id: body.id });
    }
    const count = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE sub = ?1").bind(sub).first() as any)?.n ?? 0);
    if (count >= MAX_FILES) return err(400, "quota_exceeded", `at most ${MAX_FILES} memory files`);
    const mid = newId();
    await env.DB.prepare(
      "INSERT INTO memories (id, sub, name, content, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
    ).bind(mid, sub, name, content, now).run();
    return json({ ok: true, id: mid });
  }
  return err(405, "method_not_allowed", "GET, POST or DELETE");
}

/** The ask path's memory injection: fetch the SELECTED, OWNED files and
 *  render them as one bounded note. Returns [note, idsActuallyUsed] —
 *  unknown or foreign ids silently drop (a stale client selection is
 *  never an error, and never another user's memory). */
export async function memoryNote(env: any, sub: string, ids: string[]): Promise<[string | null, string[]]> {
  const wanted = [...new Set(ids.filter((x) => typeof x === "string" && ID_RE.test(x)))].slice(0, 4);
  if (!wanted.length) return [null, []];
  const rows = (await env.DB.prepare(
    `SELECT id, name, content FROM memories WHERE sub = ?1 AND id IN (${wanted.map((_, i) => `?${i + 2}`).join(",")})`,
  ).bind(sub, ...wanted).all()).results ?? [];
  if (!rows.length) return [null, []];
  let budget = 4_000;
  const parts: string[] = [];
  const used: string[] = [];
  for (const r of rows as any[]) {
    if (budget <= 200) break;
    const body = String(r.content).slice(0, budget);
    budget -= body.length;
    parts.push(`### ${r.name}\n${body}`);
    used.push(String(r.id));
  }
  return [
    "The user's own memory files — their stated context. Treat as trusted user facts (their lab, instruments, preferences); blend with the passages, never contradict them silently:\n" + parts.join("\n\n"),
    used,
  ];
}
