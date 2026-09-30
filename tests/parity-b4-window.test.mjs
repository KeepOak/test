/* Parity B4 (Team and Customize), the window's side: Share… and Share this Trunk… from the conversation menu, and a
   room's rules as the prototype's popover. Each change is read back from the engine. The parts held for the security
   review (a copy link, a carry-on key, hand-off, sharing a Trunk with people or the team, the Teams pattern) are drawn
   and stay greyed. Headless; a scripted model. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newWindow } from "./new-window-places.mjs";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
const greyed = async (loc) => (await loc.getAttribute("aria-disabled")) === "true";

async function withTrunks(t) {
  const w = await newWindow(t, { provider: quiet });
  await w.call("/api/trunks/switch", { part: "trunks", mode: "on" });
  await w.call("/api/trunks/switch", { part: "rooms", mode: "on" });
  const a = (await w.call("/api/trunks", { name: "Wren", title: "Checks" })).trunk;
  const b = (await w.call("/api/trunks", { name: "Pike", title: "Checks" })).trunk;
  const person = await w.call("/api/profiles", { name: "Sam", pin: "482913", role: "adult" });
  await w.page.reload();
  await w.page.locator("#app #side").waitFor({ state: "visible" });
  return { ...w, a, b, person };
}
const openChat = async (page, name) => { await page.locator(`#side [data-act="chat"]:has-text("${name}")`).first().click(); await page.waitForTimeout(400); };
const menu = async (page, selector) => { await page.locator('[data-act="chatmenu"]').first().click(); await page.locator(`.pop ${selector}`).click(); };

test("Share…: With people is saved and taken back in the engine; a copy, a key and hand-off stay greyed", async (t) => {
  const { page, call, a, person, errors } = await withTrunks(t);
  await openChat(page, "Wren");
  await menu(page, '[data-act="share10"][data-k="conv"]');
  const subject = `profile:${person.id}`, object = `conversation:${a.chatSessionId}`;
  const held = async () => (await call("/api/people/settings")).shares.filter((x) => x.object === object && x.subject === subject);
  await page.locator(`.dlg [data-act="share-rel"][data-subject="${subject}"][data-v="driver"]`).click();
  await page.waitForTimeout(400);
  assert.deepEqual((await held()).map((x) => x.relation), ["driver"]);
  await page.locator(`.dlg [data-act="share-rel"][data-subject="${subject}"][data-v="viewer"]`).click();
  await page.waitForTimeout(400);
  assert.deepEqual((await held()).map((x) => x.relation), ["viewer"], "a new relation replaces the old one");
  assert.equal(await page.locator(`.dlg [data-act="share-rel"][data-subject="${subject}"][data-v="viewer"]`).getAttribute("aria-pressed"), "true");
  await page.locator(`.dlg [data-act="share-rel"][data-subject="${subject}"][data-v="no"]`).click();
  await page.waitForTimeout(400);
  assert.deepEqual(await held(), []);
  for (const [tab, act] of [["copy", "share-link"], ["carry", "share-key"], ["handoff", "share-handoff"]]) {
    await page.locator(`.dlg [data-act="share-tab"][data-v="${tab}"]`).click();
    assert.ok(await greyed(page.locator(`.dlg [data-act="${act}"]`).first()), `${act} stays greyed`);
  }
  assert.deepEqual((await call("/api/shares")).shares, [], "no copy link was made");
  assert.deepEqual(errors, []);
});

test("Share this Trunk…: As a file is the engine's own file; with people and the team stay greyed", async (t) => {
  const { page, person, errors } = await withTrunks(t);
  await openChat(page, "Wren");
  await menu(page, '[data-act="share10"][data-k="trunk"]');
  assert.ok(await greyed(page.locator(`.dlg [data-act="share-trunk-rel"][data-subject="profile:${person.id}"]`).first()));
  await page.locator('.dlg [data-act="share-tab"][data-v="team"]').click();
  assert.ok(await greyed(page.locator('.dlg [data-act="share-team"]')));
  await page.locator('.dlg [data-act="share-tab"][data-v="file"]').click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator('.dlg [data-act="share-file"]').click()]);
  assert.equal(download.suggestedFilename(), "Wren.branch-trunk");
  const file = JSON.parse(readFileSync(await download.path(), "utf8"));
  assert.equal(file.format, "branch-trunk/1");
  assert.equal(file.trunk.name, "Wren");
  for (const kept of ["keys", "reach"]) assert.ok(!(kept in file.trunk), `the file never carries ${kept}`);
  assert.deepEqual(errors, []);
});

test("Room rules: the rule and the room's pattern are saved; the row names the rule; Teams stays greyed", async (t) => {
  const { page, call, a, b, errors } = await withTrunks(t);
  const { room } = await call("/api/trunks/rooms", { name: "Den", members: [a.id, b.id], people: [], rule: "mention" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await openChat(page, "Den");
  const saved = async () => (await call("/api/trunks")).rooms.find((r) => r.id === room.id);
  await page.locator('[data-act="chatmenu"]').first().click();
  assert.equal(await page.locator('.pop [data-act="room-rules"] .r').textContent(), "mentions only");
  await page.locator('.pop [data-act="room-rules"]').click();
  assert.equal(await page.locator('.pop [data-act="room-rule"][aria-checked="true"]').getAttribute("data-v"), "mention");
  assert.ok(await greyed(page.locator('.pop [data-act="room-pat-teams"]')));
  await page.locator('.pop [data-act="room-rule"][data-v="lead"]').click();
  await page.waitForTimeout(500);
  assert.equal((await saved()).rule, "lead");
  await menu(page, '[data-act="room-rules"]');
  await page.locator('.pop [data-act="room-pat"][data-v="parallel"]').click();
  await page.waitForTimeout(500);
  assert.equal((await saved()).pattern, "parallel");
  await page.locator('[data-act="chatmenu"]').first().click();
  assert.equal(await page.locator('.pop [data-act="room-rules"] .r').textContent(), "lead decides");
  await page.locator('.pop [data-act="room-rules"]').click();
  await page.locator('.pop [data-act="room-pat"][data-v="default"]').click();
  await page.waitForTimeout(500);
  assert.equal((await saved()).pattern, null);
  assert.deepEqual(errors, []);
});

/* TRUNK-036: the desktop app lets through a download the page made on its own origin (src/desktop/own-download.ts), so
   As a file is live there too; the file is a blob on the window's origin with a name safe for any disk. */
test("Share this Trunk…: As a file works in the desktop app too, as a blob on the window's own origin", async (t) => {
  const { page, call, errors } = await withTrunks(t);
  await call("/api/trunks", { name: "Wren / notes: v2", title: "Checks" });
  const url = new URL(page.url());
  url.searchParams.set("desktop", "1");
  await page.goto(url.href);
  await page.locator("#app #side").waitFor({ state: "visible" });
  await openChat(page, "Wren / notes");
  await menu(page, '[data-act="share10"][data-k="trunk"]');
  await page.locator('.dlg [data-act="share-tab"][data-v="file"]').click();
  const button = page.locator('.dlg [data-act="share-file"]');
  assert.equal(await greyed(button), false);
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  assert.ok(download.url().startsWith(`blob:${url.origin}/`), download.url());
  assert.equal(download.suggestedFilename(), "Wren-notes-v2.branch-trunk");
  assert.equal(JSON.parse(readFileSync(await download.path(), "utf8")).trunk.name, "Wren / notes: v2");
  assert.deepEqual(errors, []);
});

/* One handler per action name: a second on("<name>") throws while the window starts, and nothing after it is wired. */
test("every action name is registered once across the window", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
  walk("public/app");
  const seen = new Map();
  for (const f of files) for (const m of readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?<![\w.])on\("([\w:-]+)"/g)) seen.set(m[1], [...(seen.get(m[1]) ?? []), f]);
  const twice = [...seen].filter(([, where]) => where.length > 1).map(([name, where]) => `${name}: ${where.join(", ")}`);
  assert.deepEqual(twice, []);
});
