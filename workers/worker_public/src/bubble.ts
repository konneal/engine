// The bubble bridge (TODO.ai-platform/01 in the smart repo): the
// assistant panel the shared chrome (@oimlsmart/site-shell's AiBubble)
// embeds in every estate property cannot ride the rag_session cookie —
// SameSite=Lax never crosses origins on fetch, and the estate bans
// shared-domain cookies (the SSO doctrine, identity guide §8a: every
// property keeps its OWN session, established by its own OP round-trip).
//
// The bridge: the panel opens /auth/login?mode=bubble&origin=<its own
// origin> in a popup. The standard OIDC code+PKCE dance runs unchanged
// (the OP session makes it one click); the callback then renders a
// CONFIRM page — never auto-sends — that postMessages the session token
// (the same HMAC-signed payload the cookie carries) to the requesting
// origin only. The panel holds the token in memory (sessionStorage
// survives reloads) and calls the API with `Authorization: Bearer`.
// The token is the service's OWN session artifact — it can act on this
// service only, never on the OP or other properties.

import { P } from "./profile.ts";
/** The origins a bubble may ride from: the estate pattern (the same rule
 *  corsHeaders applies) plus localhost for the local dev posture. */
export function isAllowedBubbleOrigin(origin: string): boolean {
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The confirm page the callback renders in bubble mode. Static inline
 *  HTML+JS, everything escaped, targetOrigin = the validated origin
 *  (never "*"). The token leaves ONLY on the user's explicit Continue —
 *  a popup the user never asked for (a page opening it under the OP's
 *  SSO session) shows the request and stops here. */
export function bubbleConfirmPage(opts: { name: string; origin: string; token: string; expiresAt: number }): string {
  const who = escapeHtml(opts.name);
  const host = escapeHtml(new URL(opts.origin).host);
  // JSON embedded in a <script> block: escape `<` so a claim value can
  // never close the element early (</script> breakout).
  const jsSafe = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  const payload = jsSafe({
    type: P().publisher.session_cookie ?? `${P().publisher.id}-session`,
    token: opts.token,
    name: opts.name,
    expiresAt: opts.expiresAt,
  });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${P().publisher.product_name} — sign in</title>
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
  <p>The assistant can read the public corpus and your own assistant conversations — nothing else.</p>
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
