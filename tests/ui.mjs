#!/usr/bin/env node
// UI e2e: loads the BUILT site (site/dist/index.html), executes the chat
// bundle in jsdom, stubs fetch with streaming SSE responses, and asserts
// the app end-to-end: ask → stream → citations → actions → sessions
// (create/switch/rename/delete/filter) → persistence → XSS safety.

import { readFileSync, readdirSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const vc = new VirtualConsole();
vc.on("jsdomError", (e) => console.log("  [jsdomError]", String(e?.detail || e).slice(0, 200)));
vc.on("error", (m) => console.log("  [console.error]", String(m).slice(0, 200)));
vc.on("log", (...args) => { const s = args.map(String).join(" "); if (s.includes("[dbg]")) console.log("  [log]", s.slice(0, 400)); });

const REFUSAL = "I don't have information in the indexed OIML publications.";

const rawHtml = readFileSync(new URL("../site/dist/index.html", import.meta.url), "utf8");
// jsdom cannot execute dynamic import() — drop the Astro island bootstrap;
// the chat bundle is a self-contained script we inject ourselves.
const html = rawHtml.replace(
  /<script([^>]*)>([\s\S]*?)<\/script>/g,
  (full, attrs, body) => (body.includes("import(") ? "" : full),
);
const astroDir = new URL("../site/dist/_astro/", import.meta.url);
const chatBundle = readdirSync(astroDir).find(
  (f) =>
    f.startsWith("index.astro_astro_type_script_index_") &&
    readFileSync(new URL(f, astroDir), "utf8").includes('getElementById("chat")'),
);
if (!chatBundle) throw new Error("chat bundle not found in site/dist/_astro — run site:build");
const chatCode = readFileSync(new URL(chatBundle, astroDir), "utf8");

const XSS_PAYLOAD =
  'Answer: <script>window.__pwned=1</script> <img src=x onerror="window.__pwned=1"> [click](javascript:alert(1)) **bold** `code`';

function sseResponse(events) {
  const chunks = events.map((e) => new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        };
      },
    },
  };
}

const failures = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const dom = new JSDOM(html, {
  virtualConsole: vc,
  url: "https://ai.oimlsmart.org/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.matchMedia =
      window.matchMedia ||
      ((q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  },
});
const { window } = dom;
const { document } = window;

const asked = [];
window.fetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body ?? "{}");
  if (url.includes("/auth/me")) {
    return { ok: true, status: 200, json: async () => ({ authenticated: false, name: null, email: null, roles: [], tier: "anon", sign_in_available: true }) };
  }
  if (url.includes("/api/feedback")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
  if (url.includes("/api/conversations")) return { ok: true, status: 200, json: async () => ({ conversations: [] }) };
  if (url.includes("/api/datasets"))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        datasets: [
          { id: "oiml", label: "OIML Publications", description: "English corpus", enabled: true },
          { id: "iso", label: "ISO/IEC Conformity Assessment", description: "internal", enabled: false, requires: "mc_member" },
        ],
      }),
    };
  asked.push({ url, body });
  const q = body.query ?? "";
  if (/lasagna/i.test(q)) {
    return sseResponse([
      { type: "citations", citations: [], quota: { used: 1, limit: 20 } },
      { type: "token", v: REFUSAL },
      { type: "done", query_hash: "f".repeat(64) },
    ]);
  }
  if (/^xss/i.test(q)) {
    return sseResponse([
      { type: "citations", citations: [], quota: { used: 2, limit: 20 } },
      { type: "token", v: XSS_PAYLOAD },
      { type: "done", query_hash: "c".repeat(64) },
    ]);
  }
  return sseResponse([
    {
      type: "citations",
      citations: [
        {
          doc_id: "clean:r060/1",
          docidentifier: "OIML R 60-1",
          edition: "2021",
          clause_anchor: "overview",
          clause_title: "Document overview",
          snippet: "Metrological regulation for load cells",
        },
      ],
      quota: { used: 1, limit: 20 },
    },
    { type: "token", v: "R 60 is the OIML Recommendation for load cells [OIML R 60-1:2021 " },
    { type: "token", v: "§overview]." },
    { type: "done", model: "@cf/qwen/qwen3-30b-a3b-fp8", query_hash: "a".repeat(64) },
  ]);
};

window.prompt = () => "Renamed chat";
window.confirm = () => true;

await new Promise((r) => setTimeout(r, 50));
window.eval(chatCode);
await new Promise((r) => setTimeout(r, 120));

const $ = (id) => document.getElementById(id);
const chat = $("chat");

// — static wiring —
check("app frame present", !!$("app") && !!$("sidebar"));
check("chat container present", !!chat);
check("composer present", !!$("askform") && document.getElementById("q")?.tagName === "TEXTAREA");
check("session list present", !!$("chatlist"));
check("account block present", !!$("accountblock"));
check("empty state with suggestions", document.querySelectorAll(".suggestion").length >= 3);
check("sign-in affordance rendered", $("accountblock")?.textContent.includes("Sign in"));
await new Promise((r) => setTimeout(r, 60));
check("datasets panel shows both datasets", $("datasets")?.querySelectorAll(".dataset-row").length === 2);
check("ISO dataset shown as locked", $("datasets")?.textContent.includes("ISO/IEC") && $("datasets")?.querySelector(".ds-dot.off") !== null);

// — ask flow —
const input = $("q");
const form = $("askform");
input.value = "What is R 60?";
form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await new Promise((r) => setTimeout(r, 250));

check("empty state removed after asking", !$("empty"));
check("user bubble rendered", chat.textContent.includes("What is R 60?"));
check("assistant answer streamed fully", chat.textContent.includes("R 60 is the OIML Recommendation for load cells"), JSON.stringify(chat.textContent.slice(0, 200)));
check("sources panel rendered", chat.textContent.includes("Sources") && chat.textContent.includes("OIML R 60-1"));
check("message actions rendered", [...chat.querySelectorAll("button")].some((b) => b.textContent === "Copy"));
check("quota meter updated", $("quotameter").textContent.includes("1 / 20"));
const askReq = asked.find((a) => a.url.includes("/api/ask"));
check("request went to /api/ask with stream", !!askReq && askReq.body.stream === true);

// — sessions: persistence + sidebar —
const stored = JSON.parse(window.localStorage.getItem("rag.chats.v1") ?? "[]");
check("conversation persisted to localStorage", stored.length === 1 && stored[0].messages.length === 2);
check("sidebar shows conversation", $("chatlist").textContent.includes("What is R 60?"));
check("topbar title set", $("chatitle").textContent.includes("What is R 60?"));

// — new chat + switching —
$("newchat").dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 80));
check("new chat shows empty state", !!$("empty"));
check("sidebar lists both conversations", $("chatlist").querySelectorAll(".chat-item").length === 2);

const r60Item = [...$("chatlist").querySelectorAll(".chat-item")].find((i) =>
  i.textContent.includes("What is R 60?"),
);
r60Item.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 80));
check("switching restores the thread", chat.textContent.includes("Recommendation for load cells"));

// — rename + delete —
const renameBtn = $("chatlist").querySelector('[data-act="rename"]');
renameBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 80));
check("rename updates the sidebar", $("chatlist").textContent.includes("Renamed chat"));

const countBefore = $("chatlist").querySelectorAll(".chat-item").length;
$("chatlist").querySelector('[data-act="delete"]').dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 80));
check("delete removes the conversation", $("chatlist").querySelectorAll(".chat-item").length === countBefore - 1);

// — filter —
input.value = "What is a load cell?";
form.dispatchEvent(new window.Event("submit", { bubbles: true }));
await new Promise((r) => setTimeout(r, 250));
$("chatfilter").value = "load cell";
$("chatfilter").dispatchEvent(new window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
check("filter narrows the list", $("chatlist").querySelectorAll(".chat-item").length === 1);

// — XSS safety —
$("chatfilter").value = "";
$("chatfilter").dispatchEvent(new window.Event("input", { bubbles: true }));
input.value = "xss probe";
form.dispatchEvent(new window.Event("submit", { bubbles: true }));
await new Promise((r) => setTimeout(r, 250));
check("markdown renders bold", chat.querySelector("strong") !== null);
check("markdown renders code", chat.querySelector("code") !== null);
check("script tags never execute", !window.eval("typeof window.__pwned !== 'undefined' && window.__pwned"));
check("javascript: hrefs rejected", !chat.innerHTML.includes("javascript:"));
check("raw <script> escaped in DOM", chat.querySelector("script") === null);

// — regenerate bypasses the answer cache —
const regen = [...chat.querySelectorAll("button")].find((b) => b.textContent === "Regenerate");
regen.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 250));
const freshReq = asked.filter((a) => a.url.includes("/api/ask") && a.body.fresh === true);
check("regenerate asks with fresh=true", freshReq.length >= 1);

// — refusal path —
input.value = "How do I make lasagna?";
form.dispatchEvent(new window.Event("submit", { bubbles: true }));
await new Promise((r) => setTimeout(r, 250));
check("refusal answer rendered", chat.textContent.includes(REFUSAL.slice(0, 40)));

console.log(`\nui e2e: ${failures.length === 0 ? "ALL PASS" : failures.length + " FAILED"}`);
process.exit(failures.length ? 1 : 0);
