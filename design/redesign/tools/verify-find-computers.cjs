// find-computers: "Add a computer or phone" › On your network against a running engine, checked through GET
// /api/devices/find. Start an engine of your own (its node door on a port of your own):
//   BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> BRANCH_NODE_PORT=<another port> node dist/cli.js start
// then: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-find-computers.cjs
// It never presses Pair on a real computer (that would hand it an invitation); Pair is proven on stand-ins in
// tests/find-computers.test.mjs and tests/find-computers-window.test.mjs.
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
const get = async (path) => {
  const r = await fetch(BASE + "/api/" + path, { headers: { authorization: "Bearer " + TOKEN } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
};
const results = [];
const check = (what, ok, detail = "") => { results.push([ok ? "PASS" : "FAIL", what, detail]); if (!ok) process.exitCode = 1; };
const skip = (what, why) => results.push(["SKIP", what, why]);
const until = async (test, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };

(async () => {
  check("not looking before the tab opens", (await get("devices/find")).looking === false);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await fetch(BASE + "/api/onboarding", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#app #side").waitFor();
  errors.length = 0; // the window's first request before sign-in is refused (401) by design

  await page.locator('[data-act="machines"]').first().click();
  await page.locator('[data-act="addcomp"]').click();
  await page.locator("#ac-found").waitFor({ state: "attached" });
  check("opening On your network starts looking (GET devices/find looking)", await until(async () => (await get("devices/find")).looking === true));
  await page.waitForTimeout(6000); // a Tailscale look and a few local-network asks
  const view = await get("devices/find");
  const names = await page.locator("#ac-found .prow b").allTextContents();
  const ids = await page.locator('#ac-found [data-act="ac-pair"]').evaluateAll((els) => els.map((e) => [e.dataset.v, e.getAttribute("aria-disabled")]));
  if (view.found.length === 0) {
    check("nothing found: no rows drawn", names.length === 0 && ids.length === 0);
    skip("rows and Pair against real computers", "the engine found none here; tests/find-computers-window.test.mjs proves them on stand-ins");
  } else {
    check("the rows are the engine's found list, by name", JSON.stringify(names) === JSON.stringify(view.found.map((f) => f.name)), JSON.stringify(names));
    check("each row's Pair is live and names the engine's id", ids.every(([id, off], i) => id === view.found[i].id && off === null), JSON.stringify(ids));
  }
  const notes = await page.locator("#ac-found .hint").allTextContents();
  check("the engine's notes are shown verbatim", JSON.stringify(notes) === JSON.stringify([view.tailnet, view.network].filter(Boolean)), JSON.stringify(notes));

  await page.locator('[data-act="ac-tab"][data-v="phone"]').click();
  check("another tab stops looking", await until(async () => (await get("devices/find")).looking === false));
  await page.locator('[data-act="ac-tab"][data-v="network"]').click();
  check("back on the tab looks again", await until(async () => (await get("devices/find")).looking === true));
  await page.locator('.dlg [data-act="dlg-close"]').click();
  check("closing the dialog stops looking", await until(async () => (await get("devices/find")).looking === false));

  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  for (const [verdict, what, detail] of results) console.log(`${verdict}  ${what}${detail ? `  (${detail})` : ""}`);
})().catch((error) => { console.error(error); process.exit(1); });
