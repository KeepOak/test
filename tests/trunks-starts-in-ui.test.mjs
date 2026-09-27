/* Q44 (DG-107): the studio's "Starts in", headless on 127.0.0.1. It lists This computer and the owner's
   paired computers only (never a phone, never a made-up one), saves the choice, says plainly that
   Branch cannot start a Trunk there yet, and is in French too.
   Redesign: prototype.html's Trunk editor (Customize › Trunks › Edit) has Look and What it may do, and no "Starts in";
   where a Trunk starts is set through the engine (POST /api/trunks/<id> startsIn), and what the new window must still do
   is keep a refused follow-up from stopping the Trunk. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";

/** Answers at once, except that "wait here" is held until the test lets it go, so a Trunk can be seen working. */
const held = [];
const scripted = { name: "scripted", async complete(request) {
  const last = request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  if (/wait here/.test(last)) await new Promise((resolve) => held.push(resolve));
  return { content: "Here it is.", toolCalls: [] };
} };
const until = async (check) => { for (let i = 0; i < 500 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 20)); assert.ok(await check()); };
const tower = "a1b2c3d4e5f60718";
const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-23T00:00:00.000Z",
  lastSeen: null, offers: [], enabled: [], folder: null, sharedWith: [] });

/** `before` runs once the Trunk is made and before the window connects, which is when it reads the paired devices. */
async function fixture(t, before = async () => undefined, { devicesFail = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-starts-in-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  app.store.save("settings", app.runtime.owner, "devices-book", { mode: "on", requests: [],
    devices: [device(tower, "Tower", "linux"), device("0f1e2d3c4b5a6978", "Pixel", "android")] });
  assert.equal(app.devices.book.devices().length, 2);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { for (const release of held.splice(0)) release(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await call("/api/trunks", { name: "Scout", title: "Watches prices", description: "" });
  await before({ app, call, trunk });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (devicesFail) await page.route(/\/api\/devices$/, (route) => route.abort());
  await signIn(page, server);
  const raw = (path, body) => fetch(new URL(path, server.url), { method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { call, raw, page, errors, trunk };
}

test("the window's follow-up while a Trunk works goes through busy send, is refused in plain words, and never stops it", async (t) => {
  const f = await fixture(t, async ({ call }) => {
    assert.equal((await call("/api/flows-boards/switch", { part: "waiting-line", mode: "on" })).mode, "on");
    assert.equal((await call("/api/flows-boards/busy", { mode: "interrupt" })).busyMode, "interrupt");
  });
  const busySends = [];
  f.page.on("response", (response) => { if (response.url().endsWith("/api/flows-boards/busy/send")) busySends.push(response.status()); });
  // The Trunk's own conversation, from its row in the side list.
  await f.page.locator(`#side .list [data-act="chat"][data-id="${f.trunk.chatSessionId}"]`).click();
  await f.page.locator("#prompt").fill("wait here");
  await f.page.locator("#send").click();
  await until(() => held.length === 1);
  assert.equal((await f.call(`/api/trunks/${f.trunk.id}`, { startsIn: tower })).trunk.startsIn, tower, "moved while it works");
  // A message typed while it works goes as a follow-up, as a person would send it.
  // WINDOW BUG: public/app/chat/chat.js:172 send() returns while a reply is coming, so a message typed while a task works is
  // neither sent nor put in the waiting line (prototype.html: "Waiting line · sent after this step"); nothing reaches busy send.
  await f.page.locator("#prompt").fill("and this too");
  await f.page.locator("#prompt").press("Enter");
  await f.page.locator(".toast").filter({ hasText: /starts on Tower/ }).waitFor({ timeout: 15000 });
  assert.deepEqual(busySends, [409], "busy send itself refused it");
  assert.equal(await f.page.getByText("this goes next", { exact: false }).count(), 0, "never told it goes next");
  assert.deepEqual((await f.call(`/api/sessions/${f.trunk.chatSessionId}/followups`)).followUps, [], "nothing queued");
  held.shift()();
  await f.page.locator("#conversation").getByText("Here it is.").waitFor({ timeout: 15000 });
  assert.deepEqual(f.errors, []);
});

