/* A person's press lasts 80-200 ms. The window used to draw the sidebar, the title bar and the status bar anew on every
   redraw, and a redraw that landed between pointerdown and pointerup (an engine event, a poll) replaced the button under
   the pointer, so the press never became a click: the Places header, a conversation row and the title bar's buttons
   "only worked sometimes". A region is now drawn again only when its markup changed, and never under a press
   (public/app/core/dom.js paintChanged, pressIn).
   Mutation: in public/app/core/dom.js make paintChanged always paint (drop the unchanged check and the pressIn check),
   and every press case here goes red. The tooltip case: a tap on a phone left the control's tip on screen; tips now
   follow a mouse or the keyboard only (core/ui.js listenTips). Mutation: drop its pointerType checks and it goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function signedIn(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-press-redraw-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const sessions = [];
  // trunk-one-row: the side list has one row per Trunk, so each conversation here is a Trunk's own.
  for (const words of ["First conversation", "Second conversation"]) {
    const trunk = app.trunks.create({ name: words.split(" ")[0] });
    app.store.message(trunk.chatSessionId, { role: "user", content: words });
    app.store.message(trunk.chatSessionId, { role: "assistant", content: "Done." });
    sessions.push(trunk.chatSessionId);
  }
  await app.trunks.introduced();
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block", ...options });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(`#side [data-act="chat"][data-id="${sessions[0]}"]`).waitFor({ state: "visible", timeout: 120000 });
  return { page, sessions, errors };
}

/* Holds a real mouse press on the control for 150 ms while the window redraws; `change` also changes what the sidebar
   shows first (a conversation's last line, as a new message does), so the sidebar's markup really differs. */
async function pressDuringRedraw(page, selector, change) {
  // The window may be drawing again as its own reads arrive, which takes the control away for a moment: it is measured
  // once it is back on screen.
  let box = null;
  for (let tries = 0; tries < 50 && !box; tries++) {
    await page.locator(selector).first().waitFor({ state: "visible" });
    box = await page.locator(selector).first().boundingBox();
  }
  assert.ok(box, `${selector} is on screen`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(async (change) => {
    const [{ E }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    if (change) E.sessions[0].lastMessage = `${E.sessions[0].lastMessage ?? ""} and more`;
    renderNow();
  }, change);
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test("a press on the Places header still folds it when a redraw lands mid-press", async (t) => {
  const { page, errors } = await signedIn(t);
  const header = '#side [data-act="places14"]';
  for (const change of [false, true, false, true]) {
    const before = await page.locator(header).getAttribute("aria-expanded");
    await pressDuringRedraw(page, header, change);
    assert.notEqual(await page.locator(header).getAttribute("aria-expanded"), before, `the press folded or unfolded Places (sidebar changed: ${change})`);
  }
  assert.deepEqual(errors, []);
});

test("a redraw at pointer release preserves the button until its click is handled", async (t) => {
  const { page, errors } = await signedIn(t);
  await page.evaluate(async () => {
    const [{ E }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    document.addEventListener("pointerup", () => {
      E.sessions[0].lastMessage = "An incoming message at pointer release";
      renderNow();
    }, { capture: true, once: true });
  });
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  assert.equal(await page.evaluate(async () => (await import("/app/core/state.js")).S.view), "settings");
  await page.locator(".settings .set-page").waitFor();
  assert.deepEqual(errors, []);
});

test("a press on a conversation row still opens it when a redraw lands mid-press", async (t) => {
  const { page, sessions, errors } = await signedIn(t);
  for (const [i, change] of [[1, true], [0, false], [1, false], [0, true]]) {
    const row = `#side [data-act="chat"][data-id="${sessions[i]}"]`;
    await pressDuringRedraw(page, row, change);
    await page.waitForFunction((row) => document.querySelector(row)?.getAttribute("aria-current") === "true", row, { timeout: 5000 });
  }
  assert.deepEqual(errors, []);
});

test("a press whose end never comes does not keep the sidebar from being drawn", async (t) => {
  const { page, sessions, errors } = await signedIn(t);
  const row = `#side [data-act="chat"][data-id="${sessions[0]}"]`;
  // A pointerdown with no pointerup (a drag that left the window, a lost mouseup), then a change the sidebar shows.
  await page.evaluate(async (row) => {
    const [{ E }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    document.querySelector(row).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    E.sessions.find((s) => (s.sessionId ?? s.id) === row.match(/data-id="([^"]+)"/)[1]).lastMessage = "A new line";
    renderNow();
  }, row);
  await page.waitForFunction((row) => document.querySelector(row)?.textContent.includes("A new line"), row, { timeout: 3000 });
  assert.deepEqual(errors, []);
});

test("a tap on a phone leaves no tooltip behind; a mouse still gets one", async (t) => {
  const { page, errors } = await signedIn(t, { hasTouch: true });
  // A greyed control ("Coming soon" as its tip): tapping it changes nothing, so nothing redraws the tip away either.
  // Named by what it is (its tag and data-* attributes, and its place among the controls that share them), not by an id
  // written on it: the window draws again as its reads arrive, and the control drawn in its place has no such id.
  // The window draws its greyed controls as its reads arrive: wait for one on screen before naming it.
  await page.waitForFunction(() => [...document.querySelectorAll("#app .soon[data-tip]")].some((n) => n.getClientRects().length && n.getBoundingClientRect().top > 0));
  const tipped = await page.evaluate(() => {
    const el = [...document.querySelectorAll("#app .soon[data-tip]")].find((n) => n.getClientRects().length && n.getBoundingClientRect().top > 0);
    const selector = el.tagName.toLowerCase() + ".soon" + [...el.attributes].filter((a) => a.name.startsWith("data-") && a.name !== "data-tip")
      .map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join("");
    return { selector: `#app ${selector}`, index: [...document.querySelectorAll(`#app ${selector}`)].indexOf(el) };
  });
  await page.locator(tipped.selector).nth(tipped.index).tap({ force: true }); // a real touch tap: hover, press, focus and release all come from the finger
  await page.waitForTimeout(900); // past the tip's delay
  assert.equal(await page.locator(".tipx").count(), 0, "no tip stays after a tap");
  await page.mouse.move(0, 0);
  await page.locator('.titlebar [data-act="theme-flip"]').hover();
  await page.locator(".tipx").waitFor({ timeout: 3000 });
  assert.deepEqual(errors, []);
});

test("a press on a title bar button still works when a redraw lands mid-press", async (t) => {
  const { page, errors } = await signedIn(t);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "");
  for (const change of [true, false]) {
    const before = await theme();
    await pressDuringRedraw(page, '.titlebar [data-act="theme-flip"]', change);
    assert.notEqual(await theme(), before, `the press switched between light and dark (sidebar changed: ${change})`);
  }
  assert.deepEqual(errors, []);
});
