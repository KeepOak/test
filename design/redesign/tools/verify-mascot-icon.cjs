/**
 * Checks that every page's favicon and brand mark is the mascot, served for real by YOUR engine.
 *
 *   PORT=<port> [OUT=<folder for screenshots>] node design/redesign/tools/verify-mascot-icon.cjs
 *
 * For /, /pair, /people and /dashboard it reads each <link rel="icon">, <link rel="apple-touch-icon">
 * and <img class="mark">, fetches it from the engine and checks it is a PNG of the size it claims.
 * The manifest's icons are checked the same way. Then it draws a stand-in browser tab strip (a real
 * browser's own tabs cannot be screenshotted headless) holding the served favicons at 16 CSS px, at
 * 1x and 2x, on a light and a dark tab, and saves the screenshots to OUT.
 */
const { chromium } = require("playwright");
const { mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const PORT = process.env.PORT;
const OUT = process.env.OUT;
if (!PORT) throw new Error("Set PORT to your own engine's port.");
const base = `http://127.0.0.1:${PORT}`;
const PAGES = ["/", "/pair", "/people", "/dashboard"];
const FILES = { "/people": "people.html", "/dashboard": "dashboard/index.html" };
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };

async function pngSize(path) {
  const response = await fetch(base + path);
  const bytes = Buffer.from(await response.arrayBuffer());
  const png = bytes.subarray(1, 4).toString("latin1") === "PNG";
  return { status: response.status, type: response.headers.get("content-type") ?? "", png,
    width: png ? bytes.readUInt32BE(16) : 0, height: png ? bytes.readUInt32BE(20) : 0 };
}

async function checkFile(page, path, sizes) {
  const got = await pngSize(path);
  check(got.status === 200 && /image\/png/.test(got.type) && got.png, `${page}: ${path} is served as a PNG`);
  if (sizes && sizes !== "any") check(sizes === `${got.width}x${got.height}`, `${page}: ${path} is ${sizes}`);
  check(!/keepoak|icon\.svg/.test(path), `${page}: ${path} is not the old Y or the KeepOak mark`);
}

/** A page's own file, for the ones the engine keeps unserved until switched on (people, dashboard). */
function refsFromFile(file) {
  const html = readFileSync(join(__dirname, "..", "..", "..", "public", file), "utf8");
  const tags = html.match(/<(link rel="(icon|apple-touch-icon)"|img class="mark"|span class="brand-icon"><img)[^>]*>/g) ?? [];
  return tags.map((tag) => ({ href: /(?:href|src)="([^"]+)"/.exec(tag)[1], sizes: /sizes="([^"]+)"/.exec(tag)?.[1] ?? null }));
}

async function checkPages(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const path of PAGES) {
    const response = await page.goto(base + path, { waitUntil: "domcontentloaded" });
    const off = response.status() === 404 && FILES[path];
    if (off) console.log(`     ${path} is switched off on this engine; checking the refs in public/${FILES[path]}`);
    const refs = off ? refsFromFile(FILES[path]) : await page.$$eval('link[rel="icon"], link[rel="apple-touch-icon"], img.mark, .brand-icon img',
      (nodes) => nodes.map((node) => ({ href: new URL(node.href || node.src).pathname, sizes: node.getAttribute("sizes") })));
    check(refs.some((ref) => /favicon-/.test(ref.href)), `${path}: names a mascot favicon`);
    for (const ref of refs) await checkFile(path, ref.href, ref.sizes);
  }
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  for (const icon of manifest.icons) await checkFile("manifest", icon.src, icon.sizes);
  check(errors.length === 0, `no page errors (${errors.join("; ") || "none"})`);
  await page.close();
}

function tabStrip() {
  const tab = (bg, tabBg, fg) => `<div style="background:${bg};padding:8px 8px 0;display:flex;gap:2px">
    <div style="background:${tabBg};color:${fg};border-radius:8px 8px 0 0;padding:8px 12px;display:flex;align-items:center;gap:8px;width:220px;font:12px 'Segoe UI',sans-serif">
    <img src="/assets/favicon-16.png" srcset="/assets/favicon-16.png 1x, /assets/favicon-32.png 2x" width="16" height="16"><span>Branch</span></div>
    <div style="color:${fg};opacity:.6;padding:8px 12px;font:12px 'Segoe UI',sans-serif">Another tab</div></div>`;
  return `<body style="margin:0">${tab("#dee1e6", "#ffffff", "#1f1f1f")}${tab("#202124", "#35363a", "#e8eaed")}</body>`;
}

async function screenshotTabs(browser) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 360, height: 84 } });
    // The strip is answered on the engine's own origin, so its favicons load from the engine itself.
    await page.route(`${base}/__mascot-tabs`, (route) => route.fulfill({ contentType: "text/html", body: tabStrip() }));
    await page.goto(`${base}/__mascot-tabs`, { waitUntil: "load" });
    const drawn = await page.$eval("img", (img) => img.complete && img.naturalWidth > 0 ? img.currentSrc : "");
    check(drawn !== "", `tab strip at ${scale}x drew ${new URL(drawn || base).pathname}`);
    await page.screenshot({ path: join(OUT, `favicon-tab-${scale}x.png`) });
    await page.close();
  }
}

(async () => {
  const browser = await chromium.launch();
  try {
    await checkPages(browser);
    await screenshotTabs(browser);
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
})();
