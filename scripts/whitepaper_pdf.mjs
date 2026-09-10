// Whitepaper PDF (#175): docs/whitepaper-oiml-smart-ai.md → print HTML
// (pandoc) → PDF (Playwright chromium). Output lands in site/public/ so
// the deployed site serves it at /whitepaper.pdf, and in artifacts/ for
// local copies. Deps already in the repo: pandoc (system), playwright.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { chromium } from "playwright";

const SRC = new URL("../docs/whitepaper-oiml-smart-ai.md", import.meta.url).pathname;
const HTML = new URL("../artifacts/whitepaper.html", import.meta.url).pathname;
const PDF_SITE = new URL("../site/public/whitepaper.pdf", import.meta.url).pathname;
const PDF_ART = new URL("../artifacts/whitepaper-oiml-smart-ai.pdf", import.meta.url).pathname;

mkdirSync(new URL("../artifacts/", import.meta.url).pathname, { recursive: true });
const body = execSync(`pandoc "${SRC}" -t html5 --standalone --metadata title="OIML SMART AI"`, { encoding: "utf8" });
const css = `
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.55; color: #16202e; max-width: none; margin: 0; padding: 0; }
  h1 { font-size: 22pt; margin: 0 0 4pt; color: #0a1628; }
  h1 + p em { display: block; font-size: 12pt; color: #3a4a63; margin-bottom: 16pt; }
  h2 { font-size: 14pt; margin: 18pt 0 6pt; color: #004996; page-break-after: avoid; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt; color: #0a1628; page-break-after: avoid; }
  p { margin: 0 0 8pt; text-align: justify; hyphens: auto; }
  pre { background: #f5ede0; border: 1px solid #ddd2bd; border-radius: 6px; padding: 10pt; font-size: 8.5pt; font-family: 'SF Mono', Menlo, monospace; white-space: pre; page-break-inside: avoid; }
  code { font-family: 'SF Mono', Menlo, monospace; font-size: 9.5pt; background: #f5ede0; padding: 0 2pt; border-radius: 3px; }
  ol, ul { margin: 0 0 8pt 18pt; } li { margin-bottom: 4pt; }
  hr { border: none; border-top: 1px solid #ddd2bd; margin: 14pt 0; }
  header#title-block-header h1 { display: none; } /* frontmatter title suppressed; the H1 in-body is the real title */
`;
writeFileSync(HTML, body.replace("</head>", `<style>${css}</style></head>`));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${HTML}`, { waitUntil: "networkidle" });
await page.pdf({ path: PDF_SITE, format: "A4", printBackground: true, margin: { top: "22mm", bottom: "20mm", left: "20mm", right: "20mm" } });
await browser.close();
copyFileSync(PDF_SITE, PDF_ART);
console.log("whitepaper pdf:", PDF_SITE, "and", PDF_ART);
