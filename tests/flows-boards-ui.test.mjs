/**
 * R17-H: the flows-and-boards cards, opened the way a person opens them, at 400 px wide, in a headless
 * browser against a scratch workspace. Every word on them is behind a key with real French, every
 * control has a label and a sentence saying what it does, and focus view folds the steps away.
 *
 * Redesign: the old cards (public/flows-boards.js) are replaced by prototype.html's own places: the shared board is
 * Automations › Board (its five lanes, a card moved with "Move to"; public/app/places/automations.js) and a request for
 * a package or tool server is a row in Inbox › Needs you, declined with Don't while Allow stays greyed for the security
 * review (public/app/places/inbox.js). A
 * message written while a task works goes through the engine's busy send from the message box (public/app/chat/chat.js).
 * What went with the old cards: "Go back in a flow", checks for procedures, widgets, the waiting-line card and the old
 * card anatomy (one h2, one filled button, a sentence per control), none of which the prototype draws; and the old
 * "focus view", which folded steps away (the prototype's Focus mode hides the side list and panel instead).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newWindow, openPlace } from "./new-window-places.mjs";
import { boardParts } from "../dist/flows-boards/settings.js";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the flows-and-boards cards has English and real French, and no colour is written down", async () => {
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  for (const file of ["places/automations.js", "places/inbox.js"]) {
    const source = await readFile(new URL(`app/${file}`, PUBLIC), "utf8");
    const keys = [...new Set([...source.matchAll(/\bt\("([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]))];
    assert.ok(keys.length > 40, `${file}: ${keys.length} keys`);
    // The same words in French on purpose: "version {version}".
    const cognates = new Set(["window.places.automations.version-version"]);
    assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || (en[key] === fr[key] && !cognates.has(key))), [], file);
    assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(source), false, `${file}: no colour written down`);
  }
  const commands = ["commands.queue", "commands.busy", "commands.focus", "commands.installs"];
  assert.deepEqual(commands.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
});

test("the board and the install requests sit in their homes, work from the window, and nothing scrolls sideways", async (t) => {
  const { app, page, errors, call } = await newWindow(t, { width: 400, height: 900, seed: async (branch) => {
    for (const part of boardParts) branch.flowsBoards.setMode(part, { mode: "on" });
    branch.flowsBoards.kanban.add({ title: "Rake the leaves" }, "owner");
    await branch.flowsBoards.installs.request({ kind: "mcp", name: "notes", server: { transport: "http", url: "https://mcp.example.com/mcp" }, why: "keep notes" }, "chat", "a chat app");
  } });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const lanes = async () => (await call("/api/flows-boards/board")).lanes;

  // Automations › Board: the engine's card, moved to Doing from the window.
  const place = await openPlace(page, "automations", "board");
  const card = place.locator(".col15[data-col15='todo'] .card15", { hasText: "Rake the leaves" });
  await card.waitFor({ timeout: 20000 });
  const id = await card.getAttribute("data-card15");
  await card.locator('[data-act="bmove15"]').click();
  await page.locator(`.pop [data-act="bto15"][data-id="${id}"][data-v="doing"]`).click();
  let moved = false;
  for (let i = 0; i < 100 && !moved; i++) { moved = (await lanes()).doing?.some((c) => c.id === id); if (!moved) await page.waitForTimeout(50); }
  assert.ok(moved, "the engine has the card in Doing");
  await place.locator(`.col15[data-col15='doing'] [data-card15="${id}"]`).waitFor({ timeout: 20000 });
  assert.ok(await wide() <= 0, "no sideways scrolling on the board at 400 px");

  // Inbox › Needs you: the request is there. Allow stays greyed for the security review (inbox.js initInbox, xdo);
  // Don't declines it in the engine, and nothing is installed either way.
  const inbox = await openPlace(page, "inbox", "needs");
  const row = inbox.locator(".prow", { hasText: "keep notes" });
  await row.waitFor({ timeout: 20000 });
  const [request] = app.flowsBoards.installs.waiting();
  const allow = row.locator(`[data-act="xdo"][data-id="${request.id}"][data-v="allowed"]`);
  await page.waitForFunction((rid) => document.querySelector(`[data-act="xdo"][data-id="${rid}"]`)?.getAttribute("aria-disabled") === "true", request.id, { timeout: 20000 });
  assert.equal(await allow.getAttribute("aria-disabled"), "true", "Allow is greyed: installing stays with the security review");
  await row.locator(`[data-act="xdo-no"][data-id="${request.id}"]`).click();
  for (let i = 0; i < 100 && app.flowsBoards.installs.waiting().length; i++) await page.waitForTimeout(50);
  const answered = (await call("/api/flows-boards/installs")).requests.find((r) => r.id === request.id);
  assert.equal(answered.status, "declined", "the engine holds the request declined");
  await row.waitFor({ state: "detached", timeout: 20000 });
  assert.ok(await wide() <= 0, "no sideways scrolling in Inbox at 400 px");
  assert.deepEqual(errors, []);
});

// Redesign: the old focus view (public/flows-boards.js branchFocusView, folding steps and in-between replies away) is not
// in prototype.html: its Focus mode (Ctrl+., public/app/shell/shell.js toggleFocus) hides the side list and the side
// panel and leaves every message in place. Nothing in the new window folds steps away.
test.skip("focus view folds away the steps and the in-between replies, and brings them back", async () => {});
