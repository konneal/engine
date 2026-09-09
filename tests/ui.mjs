#!/usr/bin/env node
// UI e2e (Playwright): serves the BUILT site (site/dist) locally, stubs the
// API routes (SSE ask stream included) via request interception, and drives
// the real Vue app in a real browser: ask → stream → citations → actions →
// sessions (create/switch/rename/delete/filter) → persistence → XSS safety.
//
//   npm run site:build && node tests/ui.mjs

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const DIST = new URL("../site/dist/", import.meta.url);
const REFUSAL = "I don't have information in this in the indexed OIML publications.";
const XSS_PAYLOAD =
  'Answer: <script>window.__pwned=1</script> <img src=x onerror="window.__pwned=1"> [click](javascript:alert(1)) **bold** `code`';

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname;
    let file = join(DIST.pathname, path === "/" ? "index.html" : path);
    if (!file.startsWith(DIST.pathname)) file = join(DIST.pathname, "index.html");
    const body = await readFile(normalize(file));
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const sse = (events) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const CITES = () => [
  {
    doc_id: "clean:r060/1", docidentifier: "OIML R 60-1", edition: "2021",
    clause_anchor: "overview", clause_title: "Document overview",
    snippet: "Metrological regulation for load cells", status: "in-force",
  },
  {
    doc_id: "dirty:r60-2000-e", docidentifier: "OIML R 60", edition: "2000",
    clause_anchor: "4.1.2", clause_title: "4.1.2 Maximum number of verification intervals",
    snippet: "§4.1.2 4.1.2 The maximum number of load cell verification intervals shall be within the following limits",
    status: "superseded", superseded_by: "OIML R 60:2017",
  },
];

const asked = [];
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures.push(name); console.log(`  ✗ ${name} ${detail}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.route("**/api/**", (route) => {
  const url = route.request().url();
  const json = (obj) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(obj) });
  if (url.includes("/auth/me")) {
    return json({ authenticated: false, name: null, email: null, roles: [], tier: "anon", sign_in_available: true });
  }
  if (url.includes("/api/datasets")) {
    return json({
      datasets: [
        { id: "oiml", label: "OIML Publications", description: "English corpus", enabled: true },
        { id: "iso", label: "ISO/IEC Conformity Assessment", description: "internal", enabled: false, requires: "an OIML SMART account" },
      ],
      suggestions: ["What is R 60?", "What is a load cell?", "What is the OIML-CS?", "Qu'est-ce que le OIML-CS ?"],
    });
  }
  if (url.includes("/api/feedback")) return json({ ok: true });
  if (url.includes("/api/conversations")) return json({ conversations: [] });
  if (url.includes("/api/ask")) {
    asked.push({ url, body: route.request().postDataJSON() });
    const q = asked.at(-1).body.query ?? "";
    let events;
    if (/lasagna/i.test(q)) {
      events = [{ type: "citations", citations: [], quota: { used: 1, limit: 20 } }, { type: "token", v: REFUSAL }, { type: "done", query_hash: "f".repeat(64) }];
    } else if (/table/i.test(q)) {
      events = [
        { type: "citations", citations: CITES(), quota: { used: 3, limit: 20 } },
        { type: "token", v: "The limits are given in [[u:table-1]] — classes A to D." },
        { type: "done", model: "@cf/zai-org/glm-5.3-flash", query_hash: "b".repeat(64),
          blocks: [{ unit_id: "u:table-1", type: "table", docidentifier: "OIML R 60-1", edition: "2",
                     payload: { caption: "n_LC limits", columns: [{ label: "Class" }, { label: "n_LC min" }],
                                rows: ["A | 50 000", "B | 5 000", "C | 500", "D | 100"] } }] },
      ];
    } else if (/^xss/i.test(q)) {
      events = [{ type: "citations", citations: [], quota: { used: 2, limit: 20 } }, { type: "token", v: XSS_PAYLOAD }, { type: "done", query_hash: "c".repeat(64) }];
    } else {
      events = [
        { type: "citations", citations: CITES(), quota: { used: 1, limit: 20 } },
        { type: "token", v: "R 60 is the OIML Recommendation for load cells [OIML R 60-1:2021 " },
        { type: "token", v: "§overview]." },
        { type: "done", model: "@cf/qwen/qwen3-30b-a3b-fp8", query_hash: "a".repeat(64), follow_ups: ["What are the accuracy classes?", "How is n_LC limited?"] },
      ];
    }
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(events) });
  }
  return json({ ok: true });
});
await page.route("**/auth/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));

await page.addInitScript(() => {
  window.prompt = () => "Renamed chat";
  window.confirm = () => true;
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(".suggestion", { timeout: 10000 });

const sidebar = page.locator("#sidebar");
const chat = page.locator("#sidebar ~ main");
const input = page.locator("textarea");

// — static wiring —
check("app frame present", (await sidebar.count()) === 1 && (await chat.count()) === 1);
check("composer present", (await input.count()) === 1);
check("greeting with API-driven suggestions", (await page.locator(".suggestion").count()) === 4);
check("datasets panel renders API rows", (await sidebar.locator(".dataset-row").count()) === 2);
check("ISO dataset shown as locked", (await sidebar.locator(".dataset-row .ds-dot.locked").count()) === 1);

// — dataset toggles —
const oimlRow = sidebar.locator(".dataset-row", { hasText: "OIML Publications" });
await oimlRow.click();
await page.waitForTimeout(80);
check("dataset toggles off (dot + strike)", (await oimlRow.locator(".ds-dot.off").count()) === 1 && /line-through/.test((await oimlRow.locator("span.truncate").first().getAttribute("class")) ?? ""));
await oimlRow.click();
await page.waitForTimeout(80);
check("dataset toggles back on", (await oimlRow.locator(".ds-dot.on").count()) === 1);

// — ask flow —
await input.fill("What is R 60?");
await input.press("Enter");
await page.waitForSelector(".assistant-body", { timeout: 10000 });
await page.waitForFunction(() => document.querySelector(".assistant-body")?.textContent?.includes("Recommendation for load cells"), null, { timeout: 10000 });

check("greeting removed after asking", (await page.locator(".suggestion").count()) === 0);
check("user message rendered", (await chat.textContent()).includes("What is R 60?"));
check("assistant answer streamed fully", (await chat.textContent()).includes("R 60 is the OIML Recommendation for load cells"));

check("sources panel rendered", (await chat.textContent()).includes("Sources") && (await chat.textContent()).includes("OIML R 60-1"));
check("superseded badge shown with successor", (await chat.textContent()).includes("superseded") && (await chat.textContent()).includes("OIML R 60:2017"));
check("source chips collapsed by default", (await page.locator(".src-card:not(.open-card)").count()) === 2);
await page.locator(".src-chip").first().click();
check("source chip expands its card", (await page.locator(".src-card:not(.open-card)").count()) === 1);
check("inline citation links rendered", (await page.locator(".cite-ref").count()) >= 1);
check("doubled clause numbers deduplicated", !/4\.1\.2\s*4\.1\.2/.test(await chat.textContent()));
check("message actions rendered", (await page.locator(".assistant-body ~ * button, .msg-acts button, button.act").count()) >= 1);
const chips = page.locator(".assistant-body ~ * .follow-up");
check("follow-up suggestion chips rendered", (await chips.count()) >= 2);
check("quota meter updated", (await chat.textContent()).includes("1 / 20"));
const askReq = asked.find((a) => a.url.includes("/api/ask"));
check("request went to /api/ask with stream", !!askReq && askReq.body.stream === true);

// — sessions: persistence + sidebar —
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("rag.chats.v1") ?? "[]"));
check("conversation persisted to localStorage", stored.length === 1 && stored[0].messages?.length === 2);
check("sidebar shows conversation", (await sidebar.textContent()).includes("What is R 60?"));
check("topbar title set", (await chat.textContent()).includes("What is R 60?"));

// — new chat + switching —
await sidebar.locator("button", { hasText: "+ New chat" }).click();
await page.waitForSelector(".suggestion");
check("new chat shows greeting", (await page.locator(".suggestion").count()) === 4);
check("sidebar lists both conversations", (await sidebar.locator(".chat-item").count()) === 2);

await sidebar.locator(".chat-item", { hasText: "What is R 60?" }).click();
await page.waitForSelector(".assistant-body");
check("switching restores the thread", (await chat.textContent()).includes("Recommendation for load cells"));

// — rename + delete —
await sidebar.locator(".chat-item", { hasText: "What is R 60?" }).locator('button[title="Rename"]').dispatchEvent("click");
check("rename updates the sidebar", (await sidebar.textContent()).includes("Renamed chat"));

const countBefore = await sidebar.locator(".chat-item").count();
await sidebar.locator(".chat-item", { hasText: "Renamed chat" }).locator('button[title="Delete"]').dispatchEvent("click");
await page.waitForTimeout(200);
check("delete removes the conversation", (await sidebar.locator(".chat-item").count()) === countBefore - 1);

// — filter —
await input.fill("What is a load cell?");
await input.press("Enter");
await page.waitForFunction(() => document.querySelector(".assistant-body")?.textContent?.includes("Recommendation"), null, { timeout: 10000 });
const filterInput = sidebar.locator("input").last();
await filterInput.fill("load cell");
await page.waitForTimeout(200);
check("filter narrows the list", (await sidebar.locator(".chat-item").count()) === 1);
await filterInput.fill("no such topic");
await page.waitForTimeout(200);
check("filter hides non-matches", (await sidebar.locator(".chat-item").count()) === 0);
await filterInput.fill("");

// — XSS safety —
await sidebar.locator("input").last().fill("");
await input.fill("xss probe");
await input.press("Enter");
await page.waitForFunction(() => document.body.textContent?.includes("window.__pwned=1"), null, { timeout: 10000 });
const pwned = await page.evaluate(() => typeof window.__pwned !== "undefined" && window.__pwned);
check("script tags never execute", !pwned);
check("payload rendered as text, not HTML", (await page.locator(".assistant-body").last().textContent()).includes("<script>window.__pwned=1</script>"));
check("no javascript: links survive", (await page.locator('.assistant-body a[href^="javascript:"]').count()) === 0);

// — follow-up chips: clicking one asks it as the next question —
const chipSet = page.locator(".follow-up");
if ((await chipSet.count()) >= 1) {
  await chipSet.first().dispatchEvent("click");
  await page.waitForTimeout(400);
  check("follow-up chip asks the question", (await chat.textContent()).includes("What are the accuracy classes?"));
} else {
  check("follow-up chip asks the question", false, "no chips rendered");
}

// — dark mode regression (2026-08-28 incident: a mangled `.dark { display:
//    none }` rule from a site-shell component blanked the whole page in
//    dark) — assert the page still LAYS OUT with html.dark set —
await page.evaluate(() => document.documentElement.classList.add("dark"));
await page.waitForTimeout(300);
const darkState = await page.evaluate(() => ({
  htmlDisplay: getComputedStyle(document.documentElement).display,
  bodyH: Math.round(document.body.getBoundingClientRect().height),
}));
check("dark mode renders (html not display:none)", darkState.htmlDisplay !== "none");
check("dark mode has layout (body height > 100)", darkState.bodyH > 100, `bodyH=${darkState.bodyH}`);
await page.evaluate(() => document.documentElement.classList.remove("dark"));


// — answer contract v2: typed blocks render —
await input.fill("show me the table");
await input.press("Enter");
await page.waitForSelector(".unit-table", { timeout: 10000 });
check("typed table block rendered", (await page.locator(".unit-table tbody tr").count()) === 4);
check("table payload cells exact", (await page.locator(".unit-table").textContent()).includes("50 000"));
check("block badge + source shown", (await page.locator(".block-head .src-badge").first().textContent()) === "TABLE");
check("ref token rendered in prose", (await chat.textContent()).includes("[[u:table-1]]"));

check("no uncaught page errors", errors.length === 0, errors[0] ?? "");

await browser.close();
server.close();
console.log(failures.length === 0 ? "\nui: all checks passed" : `\nui: ${failures.length} FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
