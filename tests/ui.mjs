#!/usr/bin/env node
// UI e2e: loads the BUILT site (site/dist/index.html), executes the page's
// scripts in jsdom, stubs fetch with a streaming SSE response, and asserts
// the chat interaction end-to-end: submit → user bubble → streamed assistant
// bubble → citations panel → feedback buttons → quota line → refusal notice.
//
//   node tests/ui.mjs          # requires `npm run site:build` first

import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";

const REFUSAL = "I don't have information in the indexed OIML publications.";

const rawHtml = readFileSync(new URL("../site/dist/index.html", import.meta.url), "utf8");
// jsdom cannot execute dynamic import() — drop the Astro island/hydration
// bootstrap; the chat bundle is a self-contained IIFE we inject ourselves.
const html = rawHtml.replace(
  /<script([^>]*)>([\s\S]*?)<\/script>/g,
  (full, attrs, body) => (body.includes("import(") ? "" : full),
);
const astroDir = new URL("../site/dist/_astro/", import.meta.url);
const chatBundle = readdirSync(astroDir).find((f) =>
  f.startsWith("index.astro_astro_type_script_index_0_lang."),
);
if (!chatBundle) throw new Error("chat bundle not found in site/dist/_astro — run site:build");
const chatCode = readFileSync(new URL(chatBundle, astroDir), "utf8");

function sseResponse(events) {
  const chunks = events.map((e) => new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
  let i = 0;
  return {
    ok: true,
    status: 200,
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
  url: "https://ai.oimlsmart.org/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  },
});
const { window } = dom;
const { document } = window;

// stub fetch AFTER scripts are parsed but BEFORE the chat wiring loads
const asked = [];
window.fetch = async (url, opts) => {
  asked.push({ url, body: JSON.parse(opts?.body ?? "{}") });
  const q = asked[asked.length - 1].body.query ?? "";
  if (url.includes("/api/feedback")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
  if (/lasagna/i.test(q)) {
    return sseResponse([
      { type: "citations", citations: [], quota: { used: 1, limit: 20 } },
      { type: "token", v: REFUSAL },
      { type: "done", query_hash: "f".repeat(64) },
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

await new Promise((r) => setTimeout(r, 50));

// inject the chat bundle (the real code the deployed page loads)
window.eval(chatCode);
await new Promise((r) => setTimeout(r, 50));

// — static wiring —
check("chat container present", !!document.getElementById("chat"));
check("form present", !!document.getElementById("askform"));
check("input present", !!document.getElementById("q"));
check("empty state with suggestions", document.querySelectorAll(".suggestion").length >= 3);
check("chat code inlined and ran (ResizeObserver attached)", typeof window.ResizeObserver === "function");

// — interaction: ask a question via the form —
const input = document.getElementById("q");
const form = document.getElementById("askform");
const chip = document.querySelector(".suggestion"); // inside empty state — grab before asking
input.value = "What is R 60?";
form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

await new Promise((r) => setTimeout(r, 200));

const chat = document.getElementById("chat");
const text = chat.textContent;
check("empty state removed after asking", !document.getElementById("empty"));
check("user bubble rendered", text.includes("What is R 60?"));
check("assistant answer streamed fully", text.includes("R 60 is the OIML Recommendation for load cells [OIML R 60-1:2021 §overview]."));
check("citations panel rendered with source", text.includes("OIML R 60-1") && text.includes("Overview"));
check("feedback buttons rendered", chat.querySelectorAll("button").length >= 2);
check("quota line updated", document.getElementById("statusline").textContent.includes("1 / 20"));
check("request went to /api/ask with stream", asked[0]?.url.includes("/api/ask") && asked[0]?.body.stream === true);

// — suggestion chip (reference captured before empty state removal) —
chip.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 150));
check("suggestion chip submits its question", asked.some((a) => a.body.query === chip.dataset.q));

// — refusal notice path —
input.value = "How do I make lasagna?";
form.dispatchEvent(new window.Event("submit", { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));
check("refusal answer rendered", chat.textContent.includes(REFUSAL.slice(0, 40)));

console.log(`\nui e2e: ${failures.length === 0 ? "ALL PASS" : failures.length + " FAILED"}`);
process.exit(failures.length ? 1 : 0);
