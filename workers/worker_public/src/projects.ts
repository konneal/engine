// Projects (#187 design): a container owning memory files and a set of
// conversations. Every query is owner-filtered through the owning
// project's sub; file caps mirror the personal-memory tier (10 × 8k).
// Membership is a MOVE (conversations.project_id set/clear) — the next
// answer re-scopes, history keeps its recorded grounding.
import { json, err } from "./lib/http";

const MAX_FILES = 10;
const MAX_CONTENT = 8_000;
const MAX_NAME = 64;
const PROJECT_ID_RE = /^p:[a-f0-9]{16}$/;
const FILE_ID_RE = /^pf:[a-f0-9]{16}$/;

const hex16 = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function ownedProject(env: any, sub: string, id: string) {
  if (!PROJECT_ID_RE.test(id)) return null;
  return await env.DB.prepare("SELECT id, name, created_at FROM projects WHERE id = ?1 AND sub = ?2").bind(id, sub).first();
}

export async function handleProjects(env: any, sub: string, req: Request, route: { method: string; id?: string }): Promise<Response> {
  const { method, id } = route;
  if (method === "GET") {
    const rows = (await env.DB.prepare(
      "SELECT p.id, p.name, p.created_at, (SELECT COUNT(*) FROM project_files f WHERE f.project_id = p.id) AS file_count, "
      + "(SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS conversation_count "
      + "FROM projects p WHERE p.sub = ?1 ORDER BY p.created_at DESC",
    ).bind(sub).all()).results ?? [];
    return json({ projects: rows });
  }
  if (method === "POST") {
    const body: any = await req.json().catch(() => null);
    if (typeof body?.project_id === "string") {
      // move a conversation in/out of a project (membership-as-move)
      const convId = String(body.conversation_id ?? "");
      if (!/^[a-zA-Z0-9_-]{8,64}$/.test(convId)) return err(400, "invalid_input", "bad conversation id");
      const target = body.project_id === null ? null : String(body.project_id);
      if (target && !(await ownedProject(env, sub, target))) return err(404, "not_found", "no such project");
      const r = await env.DB.prepare("UPDATE conversations SET project_id = ?1 WHERE id = ?2 AND sub = ?3").bind(target, convId, sub).run();
      if (!r.meta?.changes) return err(404, "not_found", "no such conversation");
      return json({ ok: true });
    }
    if (typeof body?.id === "string" && PROJECT_ID_RE.test(body.id)) {
      if (!(await ownedProject(env, sub, body.id))) return err(404, "not_found", "no such project");
      const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
      if (!name) return err(400, "invalid_input", "name required");
      await env.DB.prepare("UPDATE projects SET name = ?1 WHERE id = ?2 AND sub = ?3").bind(name, body.id, sub).run();
      return json({ ok: true, id: body.id });
    }
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
    if (!name) return err(400, "invalid_input", "name required");
    const pid = "p:" + hex16();
    await env.DB.prepare("INSERT INTO projects (id, sub, name, created_at) VALUES (?1, ?2, ?3, ?4)").bind(pid, sub, name, Date.now()).run();
    return json({ ok: true, id: pid });
  }
  if (method === "DELETE") {
    if (!id || !PROJECT_ID_RE.test(id)) return err(400, "invalid_input", "bad project id");
    if (!(await ownedProject(env, sub, id))) return err(404, "not_found", "no such project");
    await env.DB.batch([
      env.DB.prepare("UPDATE conversations SET project_id = NULL WHERE project_id = ?1 AND sub = ?2").bind(id, sub),
      env.DB.prepare("DELETE FROM project_files WHERE project_id = ?1").bind(id),
      env.DB.prepare("DELETE FROM projects WHERE id = ?1 AND sub = ?2").bind(id, sub),
    ]);
    return json({ ok: true });
  }
  return err(405, "method_not_allowed", "GET, POST or DELETE");
}

export async function handleProjectFiles(env: any, sub: string, req: Request, route: { method: string; id?: string }): Promise<Response> {
  const { method, id } = route;
  if (method === "GET") {
    if (!id || !PROJECT_ID_RE.test(id)) return err(400, "invalid_input", "bad project id");
    if (!(await ownedProject(env, sub, id))) return err(404, "not_found", "no such project");
    const rows = (await env.DB.prepare("SELECT id, name, content, updated_at FROM project_files WHERE project_id = ?1 ORDER BY updated_at DESC").bind(id).all()).results ?? [];
    return json({ files: rows });
  }
  if (method === "POST") {
    const body: any = await req.json().catch(() => null);
    const projectId = typeof body?.project_id === "string" ? body.project_id : "";
    if (!PROJECT_ID_RE.test(projectId) || !(await ownedProject(env, sub, projectId))) return err(404, "not_found", "no such project");
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
    const content = typeof body?.content === "string" ? body.content.slice(0, MAX_CONTENT) : "";
    if (!name || !content.trim()) return err(400, "invalid_input", "name and content are required");
    const now = Date.now();
    if (typeof body?.id === "string" && FILE_ID_RE.test(body.id)) {
      const r = await env.DB.prepare(
        "UPDATE project_files SET name = ?1, content = ?2, updated_at = ?3 WHERE id = ?4 AND project_id = ?5",
      ).bind(name, content, now, body.id, projectId).run();
      if (!r.meta?.changes) return err(404, "not_found", "no such file");
      return json({ ok: true, id: body.id });
    }
    const count = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM project_files WHERE project_id = ?1").bind(projectId).first() as any)?.n ?? 0);
    if (count >= MAX_FILES) return err(400, "quota_exceeded", `at most ${MAX_FILES} files per project`);
    const fid = "pf:" + hex16();
    await env.DB.prepare(
      "INSERT INTO project_files (id, project_id, name, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    ).bind(fid, projectId, name, content, now).run();
    return json({ ok: true, id: fid });
  }
  if (method === "DELETE") {
    if (!id || !FILE_ID_RE.test(id)) return err(400, "invalid_input", "bad file id");
    await env.DB.prepare(
      "DELETE FROM project_files WHERE id = ?1 AND project_id IN (SELECT id FROM projects WHERE sub = ?2)",
    ).bind(id, sub).run();
    return json({ ok: true });
  }
  return err(405, "method_not_allowed", "GET, POST or DELETE");
}
