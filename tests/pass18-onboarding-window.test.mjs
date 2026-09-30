/* Pass 18c (PR 13), the window's side: setup asks three things (Welcome, Models, Your first Trunk) and "Choose the
   model later" moves on without choosing one; the rest waits on Overview in "Finish setting up", whose ticks are only
   the engine's setup record (onboarding.completed), whose Open records the step and opens its page, and whose Hide is
   kept by the engine (onboarding.finishHidden). Headless; a scripted model. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newWindow, openPlace } from "./new-window-places.mjs";

const source = (path) => readFileSync(new URL(`../public/app/${path}`, import.meta.url), "utf8");
const list = (src, name) => {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(src);
  assert.ok(m, `${name} is a list`);
  return [...m[1].matchAll(/["']([^"']+)["']|(\w+)/g)].map((x) => x[1] ?? x[2]);
};
const liveIn = (src) => [...src.matchAll(/markLive\(\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]));
const FINISH = ["where", "yours", "reach", "tools", "keep", "people", "more", "check"];

/** Waits for the engine or the window to say so, never a fixed time. */
async function until(check, label, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { if (await check()) return; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise((r) => setTimeout(r, 50)); }
}

test("the source: three wizard steps, the engine's eleven ids kept, and the three actions registered and live", () => {
  const setup = source("flows/setup.js"), overview = source("places/overview.js");
  assert.deepEqual(list(setup, "WIZARD"), ["welcome", "models", "trunks"]);
  assert.equal(list(setup, "STEPS").length, 3, "the rail names three steps");
  assert.deepEqual(list(setup, "BODIES"), ["welcome", "models", "trunks"]);
  assert.deepEqual(list(setup, "IDS"), ["welcome", "where", "models", "yours", "trunks", "reach", "tools", "keep", "people", "more", "check"], "the engine record's ids stay");
  assert.match(setup, /on\("oblater18c"/);
  assert.ok(liveIn(setup).includes("oblater18c"));
  for (const act of ["fin18c", "finhide18c"]) {
    assert.match(overview, new RegExp(`on\\("${act}"`));
    assert.ok(liveIn(overview).includes(act), `${act} is live`);
  }
  assert.doesNotMatch(overview, /where:\s*true/, "no prototype example tick");
  assert.match(overview, /finishTile\(\)\}(\$\{restoredTile\(\)\})?<section class="tile ovs-status">/, "the card is drawn in Overview's own markup, first");
  assert.match(source("chat/nomodel.js"), /data-act="onboard" data-v="1"/, "the message box's Set up asks for Models, step 1 now");
});

test("setup shows three steps, and Choose the model later moves on without counting Models as done", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/onboarding", { done: false });
  await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("onboard")));
  const dlg = page.locator(".ob9");
  await dlg.waitFor();
  assert.equal(await dlg.locator(".ob-rail li").count(), 3);
  await page.locator("#ob-trust").check();
  await page.locator('[data-act="ob-next"]').click();
  await dlg.locator(".later18c").waitFor();
  await dlg.locator('[data-act="oblater18c"]').click();
  await dlg.locator('[data-act="ob-done"]').waitFor();
  await until(async () => (await call("/api/onboarding")).step === "trunks", "the step the wizard is on is saved");
  let view = await call("/api/onboarding");
  assert.equal(view.step, "trunks");
  assert.ok(!view.completed.includes("models"), "nothing was chosen, so Models is not done");
  await dlg.locator('.ob-rail [data-act="ob-go"][data-v="1"]').click();
  await dlg.locator(".later18c").waitFor();
  assert.match(await dlg.locator(".later18c .grow").innerText(), /You can choose a model any time/);
  await dlg.locator('.ob-rail [data-act="ob-go"][data-v="2"]').click();
  await dlg.locator('[data-act="ob-done"]').click();
  await dlg.waitFor({ state: "detached" });
  view = await call("/api/onboarding");
  assert.ok(view.finishedAt, "the last step finishes setup");
  assert.deepEqual(FINISH.filter((id) => view.completed.includes(id)), [], "and none of the eight is claimed as done");
  await page.locator('[data-act="guide"]').click();
  assert.equal(await page.locator('.pop [data-act="onboard-resume"]').innerText().then((s) => /0 of 8 done/.test(s)), true, "the Guide menu counts the eight honestly");
  assert.deepEqual(errors, []);
});

test("Finish setting up: ticks are the engine's, Open records and opens the page, Hide is kept", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/onboarding", { completed: ["reach", "check"] });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  const place = await openPlace(page, "overview");
  const card = place.locator(".fin18c");
  await card.waitFor();
  assert.equal(await place.locator(".tile").first().evaluate((n) => n.classList.contains("fin18c")), true, "first on Overview");
  assert.equal(await card.locator("li.ok18").count(), 2, "ticked only where the engine says done");
  assert.match(await card.locator(".th .hint").innerText(), /^2 of 8 done$/);
  assert.equal(await card.locator('[data-act="fin18c"]').count(), 6);
  await card.locator('[data-act="fin18c"][data-v="yours"]').click();
  await until(async () => (await call("/api/onboarding")).completed.includes("yours"), "Open recorded the step");
  const viewOf = (key) => page.evaluate((k) => import("/app/core/state.js").then((m) => [m.S.view, k === "tools" ? m.S.tabs.customize : m.S.setPage].join(" ")), key);
  await until(async () => (await viewOf("page")) === "settings appearance", "the page opened");
  assert.equal(await page.evaluate(() => import("/app/core/state.js").then((m) => [m.S.view, m.S.setPage].join(" "))), "settings appearance");
  await page.locator(".set-back").click(); // Settings covers the side list; its back button returns to it
  const again = await openPlace(page, "overview");
  assert.equal(await again.locator(".fin18c li.ok18").count(), 3);
  await again.locator('[data-act="fin18c"][data-v="tools"]').click();
  await until(async () => (await viewOf("tools")) === "customize tools", "Customize › Tools opened");
  const back = await openPlace(page, "overview");
  await back.locator('[data-act="finhide18c"]').click();
  await page.getByText("Hidden. Setup is still in the Guide menu.").first().waitFor();
  assert.equal((await call("/api/onboarding")).finishHidden, true, "Hide is the engine's");
  assert.equal(await back.locator(".fin18c").count(), 0);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  assert.equal(await (await openPlace(page, "overview")).locator(".fin18c").count(), 0, "still hidden after a reload");
  assert.deepEqual(errors, []);
});

test("the engine: finishHidden round-trips, merged, and all eight done draws no card", async (t) => {
  const { page, call, errors } = await newWindow(t);
  assert.equal((await call("/api/onboarding")).finishHidden, false);
  assert.equal((await call("/api/onboarding", { finishHidden: true })).finishHidden, true);
  assert.equal((await call("/api/state")).onboarding.finishHidden, true);
  assert.equal((await call("/api/onboarding", { finishHidden: false, completed: FINISH })).finishHidden, false);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  assert.equal(await (await openPlace(page, "overview")).locator(".fin18c").count(), 0, "all eight done: nothing left to finish");
  assert.deepEqual(errors, []);
});

test("Finish setting up keeps what setup did for a new person one tap away, each saved through its route", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/never-break", { mode: "on" }); // as a new install ships it (src/keep-running.ts)
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  const card = (await openPlace(page, "overview")).locator(".fin18c");
  await card.waitFor();
  /* Keep it running: a line each, drawn from the engine; turning one off is saved by its route. */
  await page.waitForFunction(() => { const s = document.getElementById("fin-gw"); return s && !s.disabled; });
  assert.equal(await page.locator("#fin-gw").isChecked(), true, "the gateway reads on from GET /api/never-break");
  assert.equal(await page.locator("#fin-upd").isChecked(), (await call("/api/comfort")).values.notify.autoUpdate === "install");
  assert.equal(await page.locator("#fin-boot").isDisabled(), true, "a checkout has no program to start at sign-in");
  await page.locator("#fin-gw").click();
  await page.getByText("Saved. This takes effect the next time Branch starts.").first().waitFor();
  assert.equal((await call("/api/never-break")).mode, "off", "turned off through POST /api/never-break");
  assert.equal(await page.locator("#fin-gw").isChecked(), false, "and drawn as the engine now has it");
  const was = (await call("/api/comfort")).values.notify.autoUpdate;
  await page.locator("#fin-upd").click();
  await page.waitForFunction(() => !document.getElementById("fin-upd")?.disabled);
  const want = was === "install" ? "off" : "install";
  await until(async () => (await call("/api/comfort")).values.notify.autoUpdate === want, "saved through POST /api/comfort");
  /* People: the owner's name. */
  await page.locator("#ob-name").fill("Robin");
  await page.locator("#ob-name").press("Enter");
  await until(async () => (await call("/api/profiles")).owner.name === "Robin", "saved through POST /api/profiles/owner/about");
  /* Reach it anywhere: pairing a phone opens the pairing dialog. */
  await card.locator('li [data-act="pair"]').click();
  await page.locator(".scrim").first().waitFor();
  assert.deepEqual(errors, []);
});

/* The two rows whose design page could not do what they promise now can: Where Branch runs adds a computer from
   Settings › General, and Two more things signs in to mail and calendar and brings back a backup from Settings › Accounts. */
test("Where Branch runs: Open goes to General, whose Add a computer opens the pairing choices", async (t) => {
  const { page, call, errors } = await newWindow(t);
  const place = await openPlace(page, "overview");
  await place.locator('.fin18c [data-act="fin18c"][data-v="where"]').click();
  const add = page.locator('.set-col [data-act="comp-add"]');
  await add.waitFor();
  await until(async () => (await call("/api/onboarding")).completed.includes("where"), "Open recorded the step");
  await add.click();
  await page.locator('.dlg [data-act="comp-add-go"][data-v="pair"]:not([disabled])').waitFor();
  assert.deepEqual(errors, []);
});

test("Two more things: Accounts saves your own Google app, signs in on Google's own page, and brings back a backup", async (t) => {
  const { app, page, call, errors } = await newWindow(t);
  const locker = (name) => app.store.secrets.resolve(app.runtime.owner, app.store.projects.active(app.runtime.owner).id, [name], { purpose: "test" }).then((found) => found[name]);
  const backup = await call("/api/backup"); // this Branch has no conversations yet, so its own backup may come back
  await page.evaluate(() => { window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }; });
  const place = await openPlace(page, "overview");
  await place.locator('.fin18c [data-act="fin18c"][data-v="more"]').click();
  const client = page.locator("#more18-google-client");
  await client.waitFor();
  await client.fill("1234-abc.apps.googleusercontent.com");
  const secret = page.locator("#more18-google-secret");
  assert.equal(await secret.getAttribute("type"), "password");
  await secret.fill("gocspx-typed-in-the-window");
  // A redraw before Save (an engine event arriving) keeps what was typed; seen losing it on Linux CI.
  await page.evaluate(async () => (await import("/app/core/dom.js")).renderNow());
  assert.equal(await secret.inputValue(), "gocspx-typed-in-the-window", "a redraw never takes the typed secret");
  await page.locator('[data-act="more18-save"][data-v="google"]').click();
  await until(async () => (await call("/api/personal/signin/google")).settings.clientSecretName === "GOOGLE_SIGNIN_CLIENT_SECRET", "the secret went into the locker (POST /api/personal/signin/google/secret)");
  assert.equal((await call("/api/personal/signin/google")).settings.clientId, "1234-abc.apps.googleusercontent.com", "saved through POST /api/personal/signin/google");
  assert.equal(JSON.stringify(await call("/api/personal/signin/google")).includes("gocspx-typed-in-the-window"), false, "never read back");
  await until(async () => (await secret.inputValue()) === "", "the field is emptied once saved");
  assert.equal((await page.content()).includes("gocspx-typed-in-the-window"), false, "never drawn back");
  await secret.fill("gocspx-typed-before-sign-in"); // Sign in saves first, and nothing redraws the page after it
  await page.locator('[data-act="more18-signin"][data-v="google"]').click();
  await until(() => page.evaluate(() => window.__opened.length === 1), "the sign-in page was opened");
  const opened = new URL(await page.evaluate(() => window.__opened[0]));
  assert.equal(opened.origin, "https://accounts.google.com", "only Google's own sign-in page");
  assert.equal(opened.searchParams.get("client_id"), "1234-abc.apps.googleusercontent.com");
  assert.equal(await page.locator("#more18-google-secret").inputValue(), "", "a saved secret is never kept in its field");
  assert.equal(await locker("GOOGLE_SIGNIN_CLIENT_SECRET"), "gocspx-typed-before-sign-in", "Sign in saved the new one first");
  // An address that is not Google's own sign-in page is never opened, whatever the answer says.
  await page.route("**/api/personal/signin/google/start", (route) => route.fulfill({ json: { id: "personal-google", url: "https://accounts.google.com.example.net/o/oauth2/v2/auth" } }));
  await page.locator('[data-act="more18-signin"][data-v="google"]').click();
  await page.waitForResponse((response) => response.url().endsWith("/api/personal/signin/google/start"));
  await page.unroute("**/api/personal/signin/google/start");
  assert.equal(await page.evaluate(() => window.__opened.length), 1, "nothing more was opened");
  const restores = [];
  page.on("request", (request) => { if (request.url().includes("/api/restore")) restores.push(request.url()); });
  await page.locator("#more18-file").setInputFiles({ name: "branch-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.locator(".toast").filter({ hasText: /^Brought back \d+ items\./ }).first().waitFor();
  await page.locator("#more18-file").setInputFiles({ name: "not-a-backup.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await page.locator(".toast").filter({ hasText: /backup/i }).last().waitFor();
  assert.ok(restores.length >= 2 && restores.every((url) => !/replace=/.test(url)), "a restore never replaces what is there");
  assert.deepEqual(errors, []);
});

test("Welcome: Bring back your Branch brings a backup back after setup's Trunk introductions, and not once the person wrote", async (t) => {
  const { app, page, call, errors } = await newWindow(t);
  const backup = await call("/api/backup");
  const trunk = (await call("/api/trunks", { name: "Inbox helper" })).trunk;
  await app.trunks.introduced(); // the engine's own introduction, in the Trunk's own conversation
  await call("/api/onboarding", { done: false });
  await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("onboard")));
  const tile = page.locator(".ob9 .ob-two15 .tile");
  await tile.waitFor();
  assert.match(await tile.innerText(), /Bring back your Branch/);
  const restores = [];
  page.on("request", (request) => { if (request.url().includes("/api/restore")) restores.push(request.url()); });
  await page.locator("#ob-restore-file").setInputFiles({ name: "branch-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.locator(".toast").filter({ hasText: /^Brought back \d+ items\./ }).first().waitFor();
  assert.equal(app.trunks.records.find(trunk.id), undefined, "setup's untouched Trunk gave way to the backup");
  // The success toast appears before the post-restore refresh finishes. The hidden file input can
  // be set while Restore is disabled, so wait for the same readiness a person needs to select again.
  await page.waitForFunction(() => document.querySelector('[data-act="ob-restore"]')?.disabled === false);
  await app.runtime.run({ prompt: "hi there" }); // the person wrote
  await page.locator("#ob-restore-file").setInputFiles({ name: "branch-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.locator(".toast").filter({ hasText: /already has conversations/ }).first().waitFor();
  assert.ok(restores.length === 2 && restores.every((url) => !/replace=/.test(url)), "a restore never replaces what is there");
  assert.deepEqual(errors, []);
});
