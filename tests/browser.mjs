import { chromium } from "playwright";

const out = [];
const log = (s) => out.push(s);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on("requestfailed", (r) => errors.push(`reqfail: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));

await page.goto("https://ai.oimlsmart.org/", { waitUntil: "networkidle", timeout: 60000 });

const header = await page.evaluate(() => {
  const h = document.querySelector("header");
  const nav = document.querySelector("#nav-menu");
  const cs = h ? getComputedStyle(h) : null;
  return {
    headerExists: !!h,
    headerBg: cs?.backgroundColor,
    headerBorder: cs?.borderBottomColor,
    navExists: !!nav,
    navDisplay: nav ? getComputedStyle(nav).display : null,
    navLinks: nav ? nav.querySelectorAll("a").length : 0,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 40),
    heroTitle: document.querySelector(".page-hero__title")?.getComputedStyle?.fontSize || document.querySelector("h1") ? getComputedStyle(document.querySelector("h1")).fontSize : null,
    stylesheetCount: document.styleSheets.length,
    stylesheetHrefs: [...document.styleSheets].map((s) => s.href?.split("/").pop()).filter(Boolean),
    chatExists: !!document.getElementById("chat"),
    formExists: !!document.getElementById("askform"),
    suggestions: document.querySelectorAll(".suggestion").length,
    darkClass: document.documentElement.classList.contains("dark"),
  };
});
const layout = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { y: Math.round(r.top), h: Math.round(r.height), display: cs.display, sticky: cs.position };
  };
  return {
    scrollY: window.scrollY,
    header: box("header"),
    navMenu: box("#nav-menu"),
    hero: box(".page-hero"),
    heroTitle: box(".page-hero h1, .page-hero__title, h1"),
    composer: box("#askform"),
  };
});
log(JSON.stringify(header, null, 1));
log(JSON.stringify(layout, null, 1));
const fail = [];
if (layout.scrollY !== 0) fail.push(`page loads scrolled (scrollY=${layout.scrollY}) — load-time scroll regression`);
if (layout.header?.h < 40) fail.push("federation header not visible");
if (layout.header?.sticky !== "sticky") fail.push("header not sticky");
if (layout.navMenu?.display !== "flex") fail.push("nav-menu not laid out (display:flex missing)");
if ((layout.heroTitle?.h ?? 0) < 30) fail.push("hero headline not rendered at display size");
if ((layout.composer?.h ?? 0) < 40) fail.push("composer not visible");
if (errors.length) fail.push(`console/network errors: ${errors.slice(0, 3).join("; ")}`);
log(fail.length ? "browser e2e: FAIL\n  " + fail.join("\n  ") : "browser e2e: ALL PASS");
process.exitCode = fail.length ? 1 : 0;

await page.screenshot({ path: "artifacts/site-desktop.png", fullPage: false });
await page.setViewportSize({ width: 390, height: 844 });
await page.goto("https://ai.oimlsmart.org/", { waitUntil: "networkidle" });
await page.screenshot({ path: "artifacts/site-mobile.png" });

await browser.close();
console.log(out.join("\n"));
