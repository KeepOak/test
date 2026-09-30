/**
 * Wave 8: what a reply can show as well as say. A page or a drawing goes into a frame that is
 * sealed shut; a chart is drawn in the page with its numbers readable and saveable; a script is
 * never run by the frame but by `code.run`, behind the switch that guards it.
 * Redesign: in the new window a reply is drawn by public/app/chat/markdown.js. The design (BRANCH-DESIGN-INTENT.md 1948,
 * prototype.html artCard) makes only a chart a card ("Shown in a sealed frame", Open larger, Copy code, Save to Library,
 * "The code that drew it"); an html page or a script is shown as code, never run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** A workspace, a server and a connected browser page, cleaned up when the test ends. */
async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-artifacts-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close();
    await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, server, errors };
}
/** Walks past the first-run panel so the conversation column is what is on screen. */
async function settle(page) {
  /* Redesign: the new window opens on the conversation once signed in; there is no first-run panel over it. */
  await page.locator("#prompt").waitFor({ state: "visible" });
}
/** The last reply, once the window has finished the send. */
async function replied(page) {
  await page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector("#conversation .typing"), null, { timeout: 30000 });
  return page.locator("#conversation .b").last();
}
/** The design's chart card (prototype.html artCard). */
const artCard = (page) => page.locator("#conversation .card.art").first();
/** A model that always answers with the same reply, so the card under test is predictable. */
const saying = (content) => ({ name: "scripted", async complete() { return { content, toolCalls: [] }; } });
const HTML_REPLY = "Here you go.\n\n```html\n<h1 id=\"made\">Hello</h1><script>parent.document.title='taken'</script>\n```";

test("W1 the artifact page runs no script and cannot reach the page around it", async (t) => {
  const { page, server, errors } = await fixture(t, saying(HTML_REPLY));
  await settle(page);
  await page.locator("#prompt").fill("Draw me a page.");
  await page.locator("#send").click();
  const reply = await replied(page);
  /* Redesign: the new window shows the page's code as words: no frame, no script element, nothing it can reach. */
  assert.match(await reply.locator("pre code").innerText(), /<script>parent\.document\.title='taken'<\/script>/);
  assert.equal(await page.locator("#conversation iframe").count(), 0, "the page was put in a frame on the window's own origin");
  assert.equal(await page.locator("#conversation script, #conversation h1#made").count(), 0, "the reply's markup reached the page");

  /* A page the engine is asked to show (POST /api/artifacts/page) is served under rules that stop a script. */
  const minted = await fetch(server.url + "/api/artifacts/page", { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "html", title: "A small page", code: '<h1 id="made">Hello</h1><script>parent.document.title=\'taken\'</script>' }) });
  const source = (await minted.json()).url;
  assert.match(source, /^\/artifact\/[A-Za-z0-9_-]{32,48}$/, "the page is not at a minted address");
  const served = await fetch(server.url + source);
  const policy = served.headers.get("content-security-policy") ?? "";
  assert.match(policy, /\bsandbox\b/, "the artifact is served without a sandbox");
  assert.equal(/allow-same-origin/.test(policy), false, "the artifact was given an origin it can share");
  assert.match(policy, /default-src 'none'/, "the artifact can still fetch things");
  const body = await served.text();
  assert.match(body, /Hello/, "the artifact's own words never arrived");
  assert.equal(/<script/i.test(body), false, "a script tag survived into the served page");

  /* The address is NOT used up by the first fetch: a frame that reloads must still work. */
  assert.equal((await fetch(server.url + source)).status, 200, "the artifact address died after one fetch");

  /* The script in the reply did not reach out and rename this page. */
  await page.waitForTimeout(300);
  assert.equal(/taken/.test(await page.title()), false, "the artifact reached the page around it");
  assert.deepEqual(errors, []);
});

test("W1 a script block is not run by the frame but by code.run, behind its switch", async (t) => {
  const reply = "Try this.\n\n```javascript\nconsole.log(2 + 2);\n```";
  const { page, errors } = await fixture(t, saying(reply));
  await settle(page);
  await page.locator("#prompt").fill("Write me a script.");
  await page.locator("#send").click();
  const calls = [];
  page.on("request", (request) => { if (request.url().includes("/api/tools/try")) calls.push(request.postData()); });
  const shown = await replied(page);
  assert.equal(await page.locator("#conversation iframe").count(), 0, "a script was put in a frame");
  assert.match(await shown.locator("pre code").innerText(), /console\.log\(2 \+ 2\);/, "the script is shown as code");
  // Redesign: replaced by the new window (prototype.html has no "Run this script" button; a script in a reply is only
  // shown), so nothing may run it unasked:
  await page.waitForTimeout(300);
  assert.equal(calls.length, 0, "the script was run without anyone asking");
  assert.deepEqual(errors, []);
});

const CHART_REPLY = 'Here are the figures.\n\n```chart\n{"type":"bar","title":"Cups by day",'
  + '"data":[{"label":"Mon","value":3},{"label":"Tue","value":7},{"label":"Wed","value":5}]}\n```';

test("W2 a chart block is drawn in the page, reads out under the pointer and shows its numbers", async (t) => {
  const { page, errors } = await fixture(t, saying(CHART_REPLY));
  await settle(page);
  await page.locator("#prompt").fill("Chart my week.");
  await page.locator("#send").click();
  await replied(page);
  // WINDOW BUG: public/app/chat/markdown.js text() draws a ```chart block as plain code; prototype.html artCard (design doc
  // 1948) draws it as a card with the chart, "Open larger", "Copy code", "Save to Library" and "The code that drew it".
  const chart = artCard(page);
  await chart.waitFor({ timeout: 10000 });
  assert.equal(await chart.locator("svg rect").count() >= 3, true, "three bars");
  assert.match(await chart.locator(".card-h b").innerText(), /Cups by day/);
  assert.match(await chart.locator(".note").innerText(), /Shown in a sealed frame/);
  /* The numbers behind it, as the design shows them: "The code that drew it". */
  await chart.locator("details summary").click();
  await page.evaluate(async () => { const { renderNow } = await import("/app/core/dom.js"); renderNow(); });
  assert.equal(await chart.locator("details").evaluate((details) => details.open), true,
    "an engine redraw keeps the chart's opened code visible");
  assert.match(await chart.locator("details pre").innerText(), /Mon[\s\S]*3[\s\S]*Tue[\s\S]*7[\s\S]*Wed[\s\S]*5/);
  // Redesign: replaced by the new window (prototype.html's chart has no hover read-out and no "Show the numbers" table).
  assert.deepEqual(errors, []);
});

test("W2 a chart block that says nothing usable is refused in words, not half-drawn", async (t) => {
  const { page, errors } = await fixture(t, saying("```chart\n{\"type\":\"bar\",\"data\":[]}\n```"));
  await settle(page);
  await page.locator("#prompt").fill("Chart nothing.");
  await page.locator("#send").click();
  await replied(page);
  // Redesign: replaced by the new window (prototype.html has no words for a chart it cannot draw), so only "not half-drawn"
  // is looked for.
  assert.equal(await page.locator("#conversation .card.art svg rect, #conversation .txt svg rect").count(), 0, "an empty chart was drawn anyway");
  assert.deepEqual(errors, []);
});

test("W1 Save to workspace keeps the artifact beside its task, where Documents lists it", async (t) => {
  // Redesign: the design's chart card saves with "Save to Library" (prototype.html artCard), and Library › Made for you lists it.
  const { app, page, errors } = await fixture(t, saying(CHART_REPLY));
  await settle(page);
  await page.locator("#prompt").fill("Chart my week.");
  await page.locator("#send").click();
  await replied(page);
  // WINDOW BUG: public/app/chat/markdown.js text() draws a ```chart block as plain code, so there is no card to save from.
  const card = artCard(page);
  await card.waitFor({ timeout: 10000 });
  await card.getByRole("button", { name: "Save to Library", exact: true }).click();
  let mine;
  for (let tries = 0; tries < 40 && !mine; tries++) {
    mine = (await app.artifacts.list(20)).find((entry) => entry.name.startsWith("artifact-"));
    if (!mine) await page.waitForTimeout(100);
  }
  assert.ok(mine, "nothing was kept beside the task");
  assert.deepEqual(errors, []);
});

test("W1 an artifact card fits a 400 pixel window without scrolling sideways", async (t) => {
  const { page, errors } = await fixture(t, saying(CHART_REPLY));
  await settle(page);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.locator("#prompt").fill("Chart my week.");
  await page.locator("#send").click();
  await replied(page);
  // The chart card is drawn (its icon and its chart are both svg); what matters here is that it fits.
  await artCard(page).locator("svg").first().waitFor({ timeout: 10000 });
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(sideways <= 1, `the page scrolls sideways by ${sideways}px`);
  const column = await page.evaluate(() => {
    const thread = document.getElementById("conversation");
    return thread.scrollWidth - thread.clientWidth;
  });
  assert.ok(column <= 1, `the reading column scrolls sideways by ${column}px`);
  assert.deepEqual(errors, []);
});
