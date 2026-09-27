/* The new window (public/app/**) for the Places, Memory, Trunks and Media tests: sign in with the session token, wait for
   the side list, and open a place and its tab the way a person does (the place in the side list, then the tab). */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "Hello from Branch.", toolCalls: [] }; } };

/** Signs a page in to the new window: the session token, Connect, then the side list. */
export async function signIn(page, server) {
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
}

/** An engine (or the one given), its server, and a signed-in page. `seed(app)` runs before the page opens. */
export async function newWindow(t, { app: given, root: givenRoot, provider = quiet, options = {}, seed, width = 1440, height = 950 } = {}) {
  const root = givenRoot ?? await mkdtemp(join(tmpdir(), "branch-rw-places-"));
  const app = given ?? await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  if (seed) await seed(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); if (!given) { await app.close(); await discardTemp(root); } });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await (await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  return { app, server, browser, page, errors, call, root };
}

/** Each place draws its own <main id="main"> inside the shell's #main, so a place is read through its .place. */
export const placeRoot = (page) => page.locator("#main .place").first();

/** On a narrow window the side list is slid away; "Show conversations" (data-act="side") slides it in. */
async function sideControl(page, selector) {
  const toggle = page.locator('[data-act="side"]:visible').first();
  const open = await page.evaluate(() => document.getElementById("app")?.classList.contains("side-open"));
  if (!open && await toggle.count()) await toggle.click();
  return page.locator(selector).first();
}

/** A place from the side list ("inbox", "library", "team", "customize", "automations", "overview"), then its tab. */
export async function openPlace(page, view, tab) {
  await (await sideControl(page, `#side [data-act="view"][data-v="${view}"]`)).click();
  if (tab) await page.locator(`#main .place [data-act="ptab"][data-v="${tab}"]`).first().click();
  if (tab) await page.locator(`#main .place [data-act="ptab"][data-v="${tab}"][aria-selected="true"]`).first().waitFor({ timeout: 20000 });
  return placeRoot(page);
}

/** A Settings page, from the gear at the foot of the side list. */
export async function openSettings(page, setPage) {
  await (await sideControl(page, '#side [data-act="view"][data-v="settings"]')).click();
  if (setPage) await page.locator(`[data-act="setpage"][data-v="${setPage}"]`).first().click();
}

/** The message box's + menu, "Attach files" (data-act="attach"): the system file picker, then chips in #attached. */
export async function attachFiles(page, files) {
  await page.locator('[data-act="plusmenu"]').click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator('.pop [data-act="attach"]').click();
  await (await chooser).setFiles(files);
}
