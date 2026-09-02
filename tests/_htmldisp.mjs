import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("https://ai.oimlsmart.org/", { waitUntil: "load" });
await page.waitForTimeout(1500);
const res = await page.evaluate(() => {
  const html = document.documentElement;
  const light = getComputedStyle(html).display;
  html.classList.add("dark");
  const dark = getComputedStyle(html).display;
  // find the rule
  let rule = null;
  for (const sheet of document.styleSheets) {
    try {
      for (const r of sheet.cssRules) {
        if (r.selectorText && /\.dark[, ]*[,{]/.test(r.selectorText) && r.style?.display === "none") {
          rule = r.cssText.slice(0, 160);
        }
      }
    } catch {}
  }
  return { light, dark, rule };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
