/**
 * The assistant's own files in Settings › Instructions & personality, with
 * an editor, a preview, the size limit Branch reads, and an undo of the last save. The owner's alone:
 * a household profile and a short-lived key are refused the text and every change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn, openSettings } from "./new-window-places.mjs";

async function served(t) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "assistant-files-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  app.store.save("settings", app.runtime.owner, "onboarding", { done: true }); // setup opens on the first draw otherwise (flows/flows.js); not what this is about
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, call, root };
}

test("F1 undo puts back the text before the last save, and removes a file the save made", async (t) => {
  const { app, call } = await served(t);
  const soul = join(app.store.folder, "SOUL.md");
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be brief." })).status, 200);
  assert.equal(await readFile(soul, "utf8"), "Be brief.\n");
  assert.ok((await call("GET", "/api/settings-kit/files/soul")).body.lastSave, "a save here can be undone");
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be very brief." })).status, 200);
  const undone = await call("POST", "/api/settings-kit/files/undo", { slot: "soul" });
  assert.equal(undone.status, 200);
  assert.equal(await readFile(soul, "utf8"), "Be brief.\n", "only the last save is undone");
  assert.equal((await call("GET", "/api/settings-kit/files/soul")).body.lastSave, null, "one undo, then nothing waits");
  assert.equal((await call("POST", "/api/settings-kit/files/undo", { slot: "soul" })).status, 409);
  await call("POST", "/api/settings-kit/files", { slot: "user", text: "Call me Taofik." });
  assert.ok(existsSync(join(app.store.folder, "USER.md")));
  assert.equal((await call("POST", "/api/settings-kit/files/undo", { slot: "user" })).status, 200);
  assert.equal(existsSync(join(app.store.folder, "USER.md")), false, "a file the save made is taken away again");
});

test("F2 a change made elsewhere since the save is never overwritten, and the size limit holds", async (t) => {
  const { app, call } = await served(t);
  await call("POST", "/api/settings-kit/files", { slot: "soul", text: "First." });
  await writeFile(join(app.store.folder, "SOUL.md"), "Changed in another editor.\n");
  const refused = await call("POST", "/api/settings-kit/files/undo", { slot: "soul" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /changed after it was saved here/);
  assert.equal(await readFile(join(app.store.folder, "SOUL.md"), "utf8"), "Changed in another editor.\n");
  const long = await call("POST", "/api/settings-kit/files", { slot: "soul", text: "x".repeat(8001) });
  assert.equal(long.status, 400);
  assert.equal((await call("GET", "/api/settings-kit/files/soul")).body.limit, 8000);
});

test("F3 a household profile and a short-lived key get neither the text nor the undo", async (t) => {
  const { app, call } = await served(t);
  const first = await call("POST", "/api/settings-kit/files", { slot: "memory", text: "The NAS backs up at two." });
  assert.equal(first.status, 200, first.body.error);
  const run = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("GET", "/api/settings-kit/files/memory", undefined, run)).status, 401);
  assert.equal((await call("POST", "/api/settings-kit/files/undo", { slot: "memory" }, run)).status, 401);
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  const read = await call("GET", "/api/settings-kit/files/memory");
  assert.equal(read.status, 400);
  assert.ok(!JSON.stringify(read.body).includes("NAS"), "not a word of the file reaches a household person");
  assert.equal((await call("POST", "/api/settings-kit/files/undo", { slot: "memory" })).status, 400);
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  const owners = await call("POST", "/api/settings-kit/files/undo", { slot: "memory" });
  assert.equal(owners.status, 200, `the owner still can: ${owners.body.error}`);
  const tools = [...app.runtime.registry?.list?.() ?? []].map((tool) => tool.name ?? tool);
  assert.ok(!tools.some((name) => /context\.(write|save|edit)/.test(name)), "no tool writes these files, so no chat app can");
});

test("F4 the card: eight files, an editor, Save, and put back the last save", async (t) => {
  // Redesign: Settings › Instructions & personality (public/app/settings/pages/instructions.js) lists the files as rows;
  // Edit or Write (data-act="if-open") opens prototype.html's editor (a textarea named for the file, "Earlier versions" with
  // "Put this back", Save). The prototype's editor has no Preview tab, no byte counter and no "Start from the usual shape":
  // replaced by the new window, so those are not looked for; an over-long file is refused by the engine instead.
  const { app, server } = await served(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signIn(page, server);
    await openSettings(page, "instructions");
    assert.equal(await page.locator('[data-act="setpage"][data-v="instructions"]').first().getAttribute("aria-current"), "true");
    const rows = page.locator('.rows .prow:has([data-act="if-open"])');
    await rows.nth(7).waitFor({ timeout: 15000 });
    assert.equal(await rows.count(), 8);
    await page.locator('[data-act="if-open"][data-f="heartbeat"]').click();
    const dialog = page.locator(".dlg");
    const text = dialog.getByLabel("HEARTBEAT.md", { exact: true });
    await text.fill("x".repeat(8001));
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(existsSync(join(app.runtime.workspace, "HEARTBEAT.md")), false, "too long is never saved");
    await text.fill(`# Morning ${width}`);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await readFile(join(app.runtime.workspace, "HEARTBEAT.md"), "utf8"), `# Morning ${width}\n`);
    await page.locator('[data-act="if-open"][data-f="heartbeat"]').click();
    await page.locator('.dlg [data-act="if-back"]').click();
    await page.waitForFunction(() => document.querySelector(".dlg #if-text")?.value === "");
    assert.equal(existsSync(join(app.runtime.workspace, "HEARTBEAT.md")), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("F4b switching profiles clears an open owner-only editor before it can be read", async (t) => {
  // Redesign: the English and French intros of the old pages are replaced by the new window's words (no /i18n.js), so they
  // are not looked for; what the owner's editor may show a household person is.
  const { server, call } = await served(t);
  const privateText = "The private backup phrase is owner-only.";
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "memory", text: privateText })).status, 200);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await signIn(page, server);
  await openSettings(page, "instructions");
  await page.locator('[data-act="if-open"][data-f="memory"]').click();
  assert.equal(await page.getByLabel("MEMORY.md", { exact: true }).inputValue(), `${privateText}\n`);

  const person = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: person.id, pin: "2468" })).status, 200);
  // WINDOW BUG: the window never learns of the switch (public/app/main.js connect() re-reads the engine only on an event,
  // and no read follows POST /api/profiles/switch within 15 s), so public/app/settings/pages/instructions.js keeps the open
  // editor and its owner-only text on screen for a household person, and Settings › Instructions stays in the list.
  await page.waitForFunction(() => !document.querySelector(".dlg #if-text"), null, { timeout: 15000 }).catch(() => undefined);
  const householdView = await page.evaluate((privateValue) => ({
    editorCount: document.querySelectorAll(".dlg #if-text").length,
    privateTextVisible: document.body.innerText.includes(privateValue) || [...document.querySelectorAll("textarea")].some((box) => box.value.includes(privateValue)),
    instructionsListed: Boolean(document.querySelector('[data-act="setpage"][data-v="instructions"]')?.checkVisibility()),
  }), privateText);
  assert.deepEqual(householdView, { editorCount: 0, privateTextVisible: false, instructionsListed: false });

  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettings(page);
  assert.equal(await page.locator('[data-act="setpage"][data-v="instructions"]').first().isVisible(), true);
});

// Integration review: undo re-checks where the file is and whether it may be written, and the saved
// texts never reach the diagnostics summary.
test("F5 undo refuses once the file moved or its folder lost trust, and the diagnostics summary holds no text", async (t) => {
  const { app, call } = await served(t);
  const { settingsSummary } = await import("../dist/diagnostic-api.js");
  const { saveFolderTrustSettings, decideFolder } = await import("../dist/folder-trust.js");
  await writeFile(join(app.store.folder, "SOUL.md"), "calm");
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be kind." })).status, 200);
  assert.ok(!JSON.stringify(settingsSummary(app)).includes("calm"), "the text before a save is not in the diagnostics summary");
  // A SOUL.md now in the project is the one Branch reads, so the saved one is no longer "this file".
  await writeFile(join(app.runtime.workspace, "SOUL.md"), "Project soul.\n");
  const moved = await call("POST", "/api/settings-kit/files/undo", { slot: "soul" });
  assert.equal(moved.status, 409);
  assert.match(moved.body.error, /no longer where it was saved/);
  assert.equal(await readFile(join(app.store.folder, "SOUL.md"), "utf8"), "Be kind.\n");
  assert.equal(await readFile(join(app.runtime.workspace, "SOUL.md"), "utf8"), "Project soul.\n");
  // A project file saved while the folder was trusted is not put back after the owner distrusts it.
  const saved = await call("POST", "/api/settings-kit/files", { slot: "tools", text: "Use the NAS." });
  assert.equal(saved.status, 200, saved.body.error);
  saveFolderTrustSettings(app.store, app.runtime.owner, { mode: "on" });
  decideFolder(app.store, app.runtime.owner, app.runtime.workspace, { folder: "", decision: "distrust" });
  const distrusted = await call("POST", "/api/settings-kit/files/undo", { slot: "tools" });
  assert.equal(distrusted.status, 409);
  assert.equal(await readFile(join(app.runtime.workspace, "TOOLS.md"), "utf8"), "Use the NAS.\n", "nothing written in a folder that is not trusted");
});
