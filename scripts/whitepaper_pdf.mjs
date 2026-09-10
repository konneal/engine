// Whitepaper builder (#175, restyled per cim-2027): docs/whitepaper-oiml-smart-ai.html
// → screen HTML (as authored) + print HTML (cover page + print CSS injected) + PDF
// (playwright chromium; cover and body rendered separately like the cim-2027
// builder, page-numbered footer). Outputs: site/public/whitepaper.pdf (served)
// and artifacts/whitepaper-oiml-smart-ai.{html,print.html,pdf} (local copies).
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = `${ROOT}docs/whitepaper-oiml-smart-ai.html`;
const BRAND = "/Users/mulgogi/src/oimlsmart/branding/logo";
const ART = `${ROOT}artifacts`;
const PDF_SITE = `${ROOT}site/public/whitepaper.pdf`;
mkdirSync(ART, { recursive: true });

const stripXml = (svg) => svg.replace(/<\?xml[^>]*\?>/, "").trim();
const smart = stripXml(readFileSync(`${BRAND}/oiml-logo_cs-smart-dark.svg`, "utf8"));
const second = stripXml(readFileSync(`${BRAND}/oiml-logo_cs-dark.svg`, "utf8"));

const cover = `
<div class="cover">
  <div class="cover-inner">
    <div class="cover-logos"><div class="cover-logo smart">${smart}</div></div>
    <div class="cover-draft">DRAFT FOR COMMENTING</div>
    <div class="cover-eyebrow">OIML SMART PROGRAM · SYSTEM DESCRIPTION AND MEASURED EVALUATION</div>
    <h1 class="cover-title">OIML SMART AI:<br>a grounded question-answering service<br>over legal-metrology publications</h1>
    <p class="cover-lede">The knowledge staircase, the answer contract, execution semantics, the input data kinds and their enrichment, and platform-portable deployment — measured over ~900 OIML publications.</p>
    <div class="cover-rule"></div>
    <div class="cover-foot">
      <div class="cover-logo second">${second}</div>
      <div class="cover-meta"><div>2026-09-10</div></div>
    </div>
  </div>
</div>`;

const printCss = `
<style>
  @page { size: A4; margin: 20mm 24mm 22mm 24mm; }
  @page cover { margin: 0; }
  html, body { background: #fff !important; }
  body { background-image: none !important; }
  .wrap { max-width: 100%; padding: 0; }
  main.wrap { padding: 0; }
  .cover {
    page: cover; page-break-after: always;
    background: linear-gradient(155deg, #060e1c 0%, #0a1628 50%, #18294a 100%);
    color: #f5efe4; margin: 0; padding: 30mm 20mm 18mm;
    width: 210mm; height: 297mm; box-sizing: border-box;
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .cover-inner { display: flex; flex-direction: column; height: 100%; justify-content: space-between; }
  .cover-logo svg { width: 64mm; height: auto; }
  .cover-logo.smart { margin-bottom: 22mm; }
  .cover-logo.second svg { width: 20mm; }
  .cover-draft {
    display: inline-block; align-self: flex-start;
    font-family: 'IBM Plex Mono', monospace; font-size: 9pt; font-weight: 600;
    letter-spacing: 0.18em; color: #3a2a08; background: #fde68a;
    border: 1px solid #d97706; border-radius: 3px;
    padding: 2.2mm 4mm; margin-bottom: 10mm;
  }
  .cover-eyebrow { font-family: 'IBM Plex Mono', monospace; font-size: 8.5pt; letter-spacing: 0.22em; color: #89b4ef; margin-bottom: 7mm; }
  .cover-title { font-family: 'Fraunces', serif; font-weight: 500; font-size: 30pt; line-height: 1.16; letter-spacing: -0.01em; margin-bottom: 9mm; }
  .cover-lede { font-size: 11.5pt; font-weight: 300; color: #c2cad8; max-width: 150mm; line-height: 1.6; }
  .cover-rule { height: 1px; background: rgba(137,180,239,0.35); margin: 14mm 0 8mm; }
  .cover-foot { display: flex; align-items: center; gap: 8mm; }
  .cover-meta { font-size: 8.5pt; color: #8d9bb4; line-height: 1.6; }
  header.hero { display: none; }
  section { page-break-before: always; margin-bottom: 10mm; }
  section#intro { page-break-before: avoid; }
  h2 { font-size: 17pt; page-break-after: avoid; }
  h2 .no { font-size: 8pt; }
  h3 { page-break-after: avoid; }
  p, li { font-size: 9.8pt; }
  .figure { page-break-inside: avoid; }
  table { page-break-inside: auto; font-size: 8.8pt; }
  tr { page-break-inside: avoid; }
  .callout { page-break-inside: avoid; }
  footer { page-break-before: avoid; font-size: 8pt; }
</style>`;

const src = readFileSync(SRC, "utf8");
const withCover = src.replace("</head>", printCss + "\n</head>").replace("<body>", "<body>\n" + cover, 1);
writeFileSync(`${ART}/whitepaper-oiml-smart-ai.print.html`, withCover);
copyFileSync(SRC, `${ART}/whitepaper-oiml-smart-ai.html`);

// split cover / body so the cover gets zero page margins and the body the footer
const headEnd = withCover.indexOf("</head>") + "</head>".length;
const bodyStart = withCover.indexOf('<header class="hero">');
const coverStart = withCover.indexOf('<div class="cover">');
const coverOnly = withCover.slice(0, headEnd) + "\n<body>\n" + withCover.slice(coverStart, bodyStart) + "</body>\n</html>";
const bodyOnly = withCover.slice(0, coverStart) + withCover.slice(bodyStart);
writeFileSync("/tmp/wp-cover.html", coverOnly);
writeFileSync("/tmp/wp-body.html", bodyOnly);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("file:///tmp/wp-cover.html", { waitUntil: "networkidle" });
await page.pdf({ path: "/tmp/wp-cover.pdf", format: "A4", printBackground: true });
await page.goto("file:///tmp/wp-body.html", { waitUntil: "networkidle" });
await page.pdf({
  path: "/tmp/wp-body.pdf", format: "A4", printBackground: true, displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate: `<div style="font-family:'IBM Plex Sans',sans-serif;font-size:7pt;color:#6b7a92;width:100%;padding:0 24mm;display:flex;justify-content:space-between;">
    <span>OIML SMART AI · SYSTEM DESCRIPTION AND MEASURED EVALUATION</span>
    <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`,
});
await browser.close();
execSync(`pdfunite /tmp/wp-cover.pdf /tmp/wp-body.pdf "${ART}/whitepaper-oiml-smart-ai.pdf"`);
copyFileSync(`${ART}/whitepaper-oiml-smart-ai.pdf`, PDF_SITE);
console.log("whitepaper built:", PDF_SITE);
