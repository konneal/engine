// Member conversation storage (TODO.impl/15): D1-backed, keyed by the
// session's `sub`. Anonymous users get 401 — their history is local-only
// by design. The client is the source of truth; the server is append-only
// storage with last-write-wins on title/updatedAt.

import { LIMITS } from "./config";

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const err = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

interface ConvRow {
  id: string;
  sub: string;
  title: string;
  created_at: string;
  updated_at: string;
}

async function ownedConversation(env: any, sub: string, id: string): Promise<ConvRow | null> {
  if (!ID_RE.test(id)) return null;
  const row = await env.DB.prepare(
    "SELECT id, sub, title, created_at, updated_at FROM conversations WHERE id = ?1 AND sub = ?2",
  )
    .bind(id, sub)
    .first();
  return (row as ConvRow) ?? null;
}

export async function handleConversations(
  env: any,
  sub: string,
  req: Request,
  route: { method: string; id?: string },
): Promise<Response> {
  const { method, id } = route;
  const now = new Date().toISOString();

  if (method === "GET" && !id) {
    const rows: any = await env.DB.prepare(
      "SELECT c.id, c.title, c.updated_at, COUNT(m.id) AS messages FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id WHERE c.sub = ?1 GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 50",
    )
      .bind(sub)
      .all();
    return json({ conversations: rows.results ?? [] });
  }

  if (method === "POST" && !id) {
    const body: any = await req.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.slice(0, 120) : "";
    const cid = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO conversations (id, sub, title, created_at, updated_at) VALUES (?1,?2,?3,?4,?4)",
    )
      .bind(cid, sub, title, now)
      .run();
    return json({ id: cid }, 201);
  }

  if (id && method === "GET") {
    const conv = await ownedConversation(env, sub, id);
    if (!conv) return err(404, "not_found", "No such conversation");
    const msgs: any = await env.DB.prepare(
      "SELECT id, role, content, citations, model, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC",
    )
      .bind(id)
      .all();
    return json({
      conversation: { id: conv.id, title: conv.title, createdAt: conv.created_at, updatedAt: conv.updated_at },
      messages: (msgs.results ?? []).map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        citations: m.citations ? JSON.parse(m.citations) : null,
        model: m.model,
        at: m.created_at,
      })),
    });
  }

  if (id && method === "PATCH") {
    const body: any = await req.json().catch(() => null);
    if (typeof body?.title !== "string" || !body.title.trim() || body.title.length > 120) {
      return err(400, "invalid_input", "title (1-120 chars) is required");
    }
    const conv = await ownedConversation(env, sub, id);
    if (!conv) return err(404, "not_found", "No such conversation");
    await env.DB.prepare("UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3 AND sub = ?4")
      .bind(body.title.trim(), now, id, sub)
      .run();
    return json({ ok: true });
  }

  if (id && method === "DELETE") {
    const conv = await ownedConversation(env, sub, id);
    if (!conv) return err(404, "not_found", "No such conversation");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?1").bind(id),
      env.DB.prepare("DELETE FROM conversations WHERE id = ?1 AND sub = ?2").bind(id, sub),
    ]);
    return json({ ok: true });
  }

  return err(405, "method_not_allowed", "Unsupported method");
}

export async function handleAppendMessage(env: any, sub: string, req: Request, convId: string): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  const role = body?.role;
  const content = typeof body?.content === "string" ? body.content : "";
  if ((role !== "user" && role !== "assistant") || !content.trim() || content.length > LIMITS.maxOutputTokens * 4) {
    return err(400, "invalid_input", "role (user|assistant) and content are required");
  }
  let citations: string | null = null;
  if (body?.citations != null) {
    if (!Array.isArray(body.citations) || body.citations.length > 16) {
      return err(400, "invalid_input", "citations must be an array of at most 16 items");
    }
    citations = JSON.stringify(body.citations);
  }
  const conv = await ownedConversation(env, sub, convId);
  if (!conv) return err(404, "not_found", "No such conversation");
  const now = new Date().toISOString();
  const mid = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, citations, model, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    ).bind(mid, convId, role, content, citations, typeof body?.model === "string" ? body.model.slice(0, 80) : null, now),
    env.DB.prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2 AND sub = ?3").bind(now, convId, sub),
  ]);
  return json({ id: mid }, 201);
}
