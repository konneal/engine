import {
  LIMITS,
  sha256Hex
} from "./chunk-OMXAE27N.js";
import {
  P
} from "./chunk-3FYJM7LH.js";

// workers/worker_public/src/bubble.ts
function isAllowedBubbleOrigin(origin) {
  const d = P().publisher.domains;
  const suffix = d.origin_suffix ?? (d.public ? d.public.replace(/^[^.]+\./, "") : null);
  if (suffix) {
    const host = origin.startsWith("https://") ? origin.slice("https://".length) : "";
    const labels = host.split(".");
    if (host === suffix) return true;
    if (labels.length >= 3 && labels.slice(1).join(".") === suffix) return true;
  }
  if (/^http:\/\/localhost(:\d{1,5})?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d{1,5})?$/.test(origin)) return true;
  return false;
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function bubbleConfirmPage(opts) {
  const who = escapeHtml(opts.name);
  const host = escapeHtml(new URL(opts.origin).host);
  const jsSafe = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const payload = jsSafe({
    type: P().publisher.session_cookie ?? `${P().publisher.id}-session`,
    token: opts.token,
    name: opts.name,
    expiresAt: opts.expiresAt
  });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${P().publisher.product_name} \u2014 sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem 1.25rem;
         background: #faf6ee; color: #0a1628; line-height: 1.5; }
  main { max-width: 26rem; margin: 0 auto; }
  h1 { font-size: 1.15rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1rem; font-size: 0.925rem; }
  .who { font-weight: 600; }
  .row { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
  button { flex: 1; min-height: 44px; font: inherit; font-weight: 600; border-radius: 6px; cursor: pointer; }
  .go { background: #004996; color: #fff; border: 1px solid #004996; }
  .no { background: transparent; color: inherit; border: 1px solid #ddd2bd; }
  @media (prefers-color-scheme: dark) {
    body { background: #0a1628; color: #f5efe4; }
    .go { background: #89b4ef; color: #001230; border-color: #89b4ef; }
    .no { border-color: #1f3357; }
  }
</style>
</head>
<body>
<main>
  <h1>Continue to the ${P().publisher.product_name} assistant?</h1>
  <p>Signed in as <span class="who">${who}</span>. The page at <span class="who">${host}</span>
     asked to connect the assistant to your account, so your conversations sync there.</p>
  <p>The assistant can read the public corpus and your own assistant conversations \u2014 nothing else.</p>
  <div class="row">
    <button type="button" class="no" id="cancel">Cancel</button>
    <button type="button" class="go" id="go">Continue</button>
  </div>
  <p id="done" hidden>You can close this window.</p>
</main>
<script>
  var TARGET = ${jsSafe(opts.origin)};
  var PAYLOAD = ${payload};
  var done = document.getElementById("done");
  document.getElementById("cancel").addEventListener("click", function () { window.close(); done.hidden = false; });
  document.getElementById("go").addEventListener("click", function () {
    if (window.opener) {
      window.opener.postMessage(PAYLOAD, TARGET);
      window.close();
    }
    done.hidden = false;
  });
  if (!window.opener) {
    document.querySelector(".row").hidden = true;
    document.querySelector("h1").textContent = "Signed in.";
    done.hidden = false;
  }
</script>
</body>
</html>`;
}

// workers/worker_public/src/lib/http.ts
var json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...extra }
});
var err = (status, code, message) => json({ error: { code, message } }, status);
function corsHeaders(req) {
  const origin = req.headers.get("origin") ?? "";
  const allowed = isAllowedBubbleOrigin(origin);
  return allowed ? {
    "access-control-allow-origin": origin,
    // PATCH + DELETE: the conversations API speaks them (rename,
    // delete) — the embedded panel preflights cross-origin.
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400"
  } : {};
}
function withCors(res, cors) {
  if (!cors["access-control-allow-origin"]) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
async function authenticate(env, req) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const keyHash = await sha256Hex(m[1].trim());
  const row = await env.DB.prepare(
    "SELECT id, name, day_limit FROM api_keys WHERE key_hash = ?1 AND revoked = 0"
  ).bind(keyHash).first();
  return row ?? null;
}
async function readJson(req) {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") return null;
    return body;
  } catch {
    return null;
  }
}
function validateQuery(body) {
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > LIMITS.maxInputChars) return null;
  const lang = typeof body?.lang === "string" && /^[a-z]{2}$/.test(body.lang) ? body.lang : void 0;
  return { query, lang };
}

export {
  isAllowedBubbleOrigin,
  bubbleConfirmPage,
  json,
  err,
  corsHeaders,
  withCors,
  authenticate,
  readJson,
  validateQuery
};
