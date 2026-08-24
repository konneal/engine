// Public read-only shared conversations (TODO.rag/09).

import { LIMITS } from "./config";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const err = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

const SLUG_RE = /^[a-z0-9]{10}$/;

function makeSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

export async function handleShareConversation(
  env: any,
  ownerSub: string,
  title: string,
  messages: any[],
): Promise<Response> {
  if (messages.length === 0 || messages.length > 100) {
    return err(400, "invalid_input", "Cannot share an empty or oversized conversation");
  }
  // rate limit: 10 shares/day per user
  const day = new Date().toISOString().slice(0, 10);
  const count = Number((await env.CACHE.get(`sh:${day}:${ownerSub.slice(0, 20)}`)) ?? "0");
  if (count >= 10) return err(429, "rate_limited", "Daily share limit reached");
  await env.CACHE.put(`sh:${day}:${ownerSub.slice(0, 20)}`, String(count + 1), { expirationTtl: 90000 });

  const slug = makeSlug();
  const cleanMessages = messages.slice(0, 50).map((m: any) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: (m.content ?? "").slice(0, LIMITS.maxOutputTokens * 2),
    citations: m.citations ? JSON.parse(m.citations) : null,
  }));
  await env.DB.prepare(
    "INSERT INTO shared_conversations (slug, owner_sub, title, messages, created_at) VALUES (?1,?2,?3,?4,?5)",
  )
    .bind(slug, ownerSub, title.slice(0, 120), JSON.stringify(cleanMessages), new Date().toISOString())
    .run();
  return json({ slug, url: `/c/${slug}` }, 201);
}

export async function handleGetShared(env: any, slug: string): Promise<Response> {
  if (!SLUG_RE.test(slug)) return err(400, "invalid_input", "Invalid link");
  const row = await env.DB.prepare("SELECT title, messages, created_at FROM shared_conversations WHERE slug = ?1")
    .bind(slug)
    .first();
  if (!row) return err(404, "not_found", "This shared link has expired or was removed");
  return json({
    title: (row as any).title,
    created_at: (row as any).created_at,
    messages: JSON.parse((row as any).messages),
  });
}
