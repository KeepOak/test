/* Live updates in the real desktop app (Electron, hidden in the tray, never shown):
   - a change to the window's stylesheet is taken in place: nothing reloads, the typed words stay;
   - a change to the window's modules reloads the page, which puts back the open conversation, the typed words and the caret;
   - a newer engine takes over while a task works: the task finishes once, its answer arrives, and the window never says
     it lost the engine;
   - a newer engine that fails is rolled back and the window keeps working with the engine it had.
   The live builds are made from this checkout, in a folder of the test's own inside it (the packages are found above). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { connected, desktopOptions, mainLines, offScreen, onboarded, send } from "./fixtures/desktop-options.mjs";
import { scriptedModel } from "./fixtures/hot-model.mjs";
import { closeOwnedDesktop } from "./fixtures/desktop-close.mjs";
import { stageLive } from "../dist/hot-update/live-folder.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** A source to build from: this checkout's own build, with some files changed. */
async function source(scratch, name, edits, { engine = false } = {}) {
  const dir = join(scratch, `src-${name}`);
  await cp(join(root, "public"), join(dir, "public"), { recursive: true });
  if (engine) {
    await cp(join(root, "dist"), join(dir, "dist"), { recursive: true, filter: (path) => !/\.(map|d\.c?ts)$/.test(path) });
    for (const file of ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) await cp(join(root, file), join(dir, file)).catch(() => undefined);
  }
  for (const [file, change] of Object.entries(edits)) await writeFile(join(dir, file), change(await readFile(join(dir, file), "utf8").catch(() => "")));
  return dir;
}

async function outcomeFor(appRoot, from, commit, tier, changed) {
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const staged = await stageLive({ source: from, appRoot, commit, version, withEngine: tier !== "window" });
  return { tier, version, parts: [tier], dir: staged.dir, manifest: staged.manifest, digest: staged.digest, changed };
}
const apply = (electron, outcome) => electron.evaluate(async (_electron, outcome) =>
  globalThis.branchLiveForTests.hooks.apply({ ...outcome, parts: new Set(outcome.parts) }, { onStage: () => undefined })
    .then((applied) => ({ ok: true, applied }), (error) => ({ ok: false, error: error.message })), outcome);

async function launch(t, model) {
  const scratch = await mkdtemp(join(root, ".hot-test-"));
  t.after(() => discardTemp(scratch));
  const { options, home } = await desktopOptions({ hidden: true }); // never on the screen
  if (process.env.BRANCH_TEST_ELECTRON) options.executablePath = process.env.BRANCH_TEST_ELECTRON;
  Object.assign(options.env, { BRANCH_TEST_ENGINE_HOOKS: "1", BRANCH_TEST_LIVE_ROOT: join(scratch, "app"),
    BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: model.endpoint, BRANCH_MODEL: "m", BRANCH_API_KEY: "test-key" });
  const electron = await _electron.launch(options);
  const child = electron.process();
  console.log("isolated desktop", JSON.stringify({ pid: child.pid, home, launchedAt: new Date().toISOString() }));
  const lines = mainLines(electron);
  t.after(async () => {
    await offScreen(electron, "before owned cleanup");
    await closeOwnedDesktop(electron, home);
    assert.notEqual(child.exitCode, null, "the owned shell exited");
  });
  const page = await electron.firstWindow();
  await page.addInitScript(() => {
    const observe = () => new MutationObserver(() => {
      if (document.getElementById("offline18")) sessionStorage.setItem("hot-test-offline", "yes");
    }).observe(document.body, { childList: true, subtree: true });
    if (document.body) observe(); else document.addEventListener("DOMContentLoaded", observe, { once: true });
  });
  await onboarded(page).catch((error) => { throw new Error([error.message, ...lines.filter(Boolean).slice(-30)].join("\n")); });
  // Whether the window ever said it lost its engine (the offline notice), from now on.
  await page.evaluate(() => {
    window.saidOffline = false;
    new MutationObserver(() => { if (document.getElementById("offline18")) window.saidOffline = true; }).observe(document.body, { childList: true, subtree: true });
  });
  return { electron, page, scratch, appRoot: join(scratch, "app") };
}

test("the window takes a live update in place, and a reload keeps the conversation, the typed words and the caret", { timeout: 600000 }, async (t) => {
  const model = await scriptedModel(t, [{ text: "Hello from the model." }]);
  const { electron, page, scratch, appRoot } = await launch(t, model);
  await send(page, "Say hello");
  await page.locator(".msg, #scroll").filter({ hasText: "Hello from the model." }).first().waitFor({ timeout: 120000 });
  const chat = await page.evaluate(() => new URLSearchParams(location.search).get("desktop") !== null && document.getElementById("prompt") !== null);
  assert.equal(chat, true);
  await page.locator("#prompt").fill("a half-typed thought");
  await page.evaluate(() => { const box = document.getElementById("prompt"); box.focus(); box.setSelectionRange(2, 6); window.samePage = true; });

  // Only the stylesheet: swapped in place.
  const styles = await outcomeFor(appRoot, await source(scratch, "css", { "public/app.css": (text) => `${text}\n/* live */\n` }), "a".repeat(40), "window", [{ path: "public/app.css", part: "window" }]);
  const first = await apply(electron, styles);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.applied.tier, "window");
  await page.waitForFunction(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.href).join(" ").includes("?live="));
  // The old /app.css goes once its new one has loaded; the page's other stylesheets (per-area files) stay as they are.
  await page.waitForFunction(() => [...document.querySelectorAll('link[rel="stylesheet"]')].filter((link) => new URL(link.href).pathname === "/app.css").length === 1, undefined, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.samePage), true, "nothing reloaded");
  assert.equal(await page.locator("#prompt").inputValue(), "a half-typed thought");
  assert.equal(await page.evaluate(() => fetch("/app.css").then((r) => r.text()).then((text) => text.includes("/* live */"))), true, "the engine serves the new stylesheet");

  // A module: the page reloads and puts everything back.
  const probe = "document.documentElement.dataset.liveProbe = \"B\";\n";
  const modules = await outcomeFor(appRoot, await source(scratch, "js", { "public/app/main.js": (text) => `${text}\n${probe}` }), "b".repeat(40), "window", [{ path: "public/app/main.js", part: "window" }]);
  const second = await apply(electron, modules);
  assert.equal(second.ok, true, second.error);
  await page.waitForFunction(() => document.documentElement.dataset.liveProbe === "B", undefined, { timeout: 60000 });
  await connected(page);
  await page.locator("#prompt").waitFor();
  await page.waitForFunction(() => document.getElementById("prompt")?.value === "a half-typed thought", undefined, { timeout: 30000 });
  // Drafts are drawn before restoreOpen's painted frames; wait for its caret/focus restoration too.
  await page.waitForFunction(() => {
    const box = document.getElementById("prompt");
    return box?.selectionStart === 2 && box.selectionEnd === 6 && document.activeElement === box;
  }, undefined, { timeout: 30000 });
  const after = await page.evaluate(() => ({ same: window.samePage === true, caret: [document.getElementById("prompt").selectionStart, document.getElementById("prompt").selectionEnd],
    focused: document.activeElement?.id, kept: sessionStorage.getItem("branch-live-restore") }));
  assert.deepEqual(after, { same: false, caret: [2, 6], focused: "prompt", kept: null }, "reloaded, with the words, the caret and the focus back");
  await page.locator("#scroll").filter({ hasText: "Hello from the model." }).waitFor();
  await offScreen(electron, "after the live window updates");
});

test("a newer engine takes over while a task works: the task finishes once and the window never loses its engine", { timeout: 600000 }, async (t) => {
  const model = await scriptedModel(t, [{ text: "The long answer.", held: true }]);
  const { electron, page, scratch, appRoot } = await launch(t, model);
  const commit = "c".repeat(40);
  const outcome = await outcomeFor(appRoot, await source(scratch, "engine", {}, { engine: true }), commit, "engine", [{ path: "src/runtime.ts", part: "engine" }]);
  const before = await electron.evaluate(() => globalThis.branchEngineForTests.pid);
  await send(page, "Do the long thing");
  await model.until(1);
  const applying = apply(electron, outcome);
  for (;;) { if (await electron.evaluate(() => globalThis.branchEngineForTests.handingOver)) break; await page.waitForTimeout(50); }
  model.release(0);
  const result = await applying;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.applied.tier, "engine");
  assert.notEqual(await electron.evaluate(() => globalThis.branchEngineForTests.pid), before, "a new engine runs");
  await page.locator("#scroll").filter({ hasText: "The long answer." }).waitFor({ timeout: 60000 });
  assert.equal(await page.locator("#scroll").getByText("The long answer.", { exact: true }).count(), 1, "the answer, once");
  const runs = await page.evaluate(async () => (await (await fetch("/api/state")).json()).runs.filter((run) => run.prompt === "Do the long thing").map((run) => run.status));
  assert.deepEqual(runs, ["completed"], "one task, finished once");
  assert.equal(await page.evaluate(() => window.saidOffline), false, "the window never said it lost its engine");
  assert.equal(model.asked.length, 1, "the model was asked once");
  const state = JSON.parse(await readFile(join(appRoot, "live", "current.json"), "utf8"));
  assert.equal(state.engine.commit, commit, "the new engine is written down as in use");
  await offScreen(electron, "after the engine was handed over");
});

test("a newer engine that fails is rolled back, and the window keeps working with the engine it had", { timeout: 600000 }, async (t) => {
  const model = await scriptedModel(t, [{ text: "Still here." }]);
  const { electron, page, scratch, appRoot } = await launch(t, model);
  const commit = "d".repeat(40);
  const broken = `process.parentPort.postMessage({ kind: "loaded", contract: 1, commit: "${commit}" });\nprocess.parentPort.on("message", (event) => { if (event.data?.kind === "start") process.exit(3); });\n`;
  const from = await source(scratch, "broken", {}, { engine: true });
  await writeFile(join(from, "dist", "desktop", "engine-process.js"), broken);
  const outcome = await outcomeFor(appRoot, from, commit, "engine", [{ path: "src/runtime.ts", part: "engine" }]);
  const result = await apply(electron, outcome);
  assert.equal(result.ok, false);
  assert.match(result.error, /did not start properly/);
  assert.equal(await electron.evaluate(() => globalThis.branchEngineForTests.running), true, "the engine that was running before runs again");
  await send(page, "Are you there");
  await page.locator("#scroll").filter({ hasText: "Still here." }).waitFor({ timeout: 60000 });
  await mkdir(join(appRoot, "live"), { recursive: true });
  const state = await readFile(join(appRoot, "live", "current.json"), "utf8").then(JSON.parse, () => null);
  assert.equal(state?.engine ?? null, null, "the failed engine was never written down as in use");
});

test("a window module update during a task keeps its draft and receives one completed answer", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, [{ text: "The reply after a live reload.", held: true }]);
  const { electron, page, scratch, appRoot } = await launch(t, model);
  await send(page, "Keep working through the window update");
  await model.until(1);
  const conversation = await page.evaluate(async () => { const state = await (await fetch("/api/state")).json(); return state.runs.find((run) => run.prompt === "Keep working through the window update").sessionId; });
  await page.locator("#prompt").fill("a draft while the task works");
  await page.evaluate(() => document.getElementById("prompt").setSelectionRange(2, 7));
  const update = await outcomeFor(appRoot, await source(scratch, "while-working", {
    "public/app/main.js": (text) => `${text}\ndocument.documentElement.dataset.liveProbe = "working";\n`,
  }), "e".repeat(40), "window", [{ path: "public/app/main.js", part: "window" }]);
  const applying = apply(electron, update);
  await page.waitForFunction(() => document.body.textContent.includes("conversation to be confirmed"));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.liveProbe), undefined, "no guessed conversation or early reload");
  assert.equal(await page.locator("#prompt").inputValue(), "a draft while the task works");
  const pending = await readFile(join(appRoot, "live", "current.json"), "utf8").then(JSON.parse, () => null);
  assert.equal(pending?.window ?? null, null, "not recorded before acknowledgment");
  model.release(0);
  const result = await applying;
  assert.equal(result.ok, true, result.error);
  await page.waitForFunction(() => document.documentElement.dataset.liveProbe === "working", undefined, { timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("prompt")?.value === "a draft while the task works", undefined, { timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => [document.getElementById("prompt").selectionStart, document.getElementById("prompt").selectionEnd]), [2, 7]);
  assert.equal(await page.evaluate(async () => (await import("/app/core/state.js")).S.chat), conversation);
  await page.locator("#scroll").getByText("The reply after a live reload.", { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.locator("#scroll").getByText("The reply after a live reload.", { exact: true }).count(), 1);
  assert.equal(model.asked.length, 1, "reload does not repeat the model request");
  assert.equal(await page.locator("#prompt").inputValue(), "a draft while the task works");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("hot-test-offline")), null);
  await offScreen(electron, "after the window updated during a task");
});

test("a failed page during engine adoption rolls back both engine and window before recording it", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, [{ text: "The old page still works." }]);
  const { electron, page, scratch, appRoot } = await launch(t, model);
  const before = await electron.evaluate(() => globalThis.branchEngineForTests.pid);
  await page.locator("#prompt").fill("a draft before a broken page");
  const from = await source(scratch, "broken-page", { "public/app/main.js": () => 'throw new Error("isolated broken module");\n' }, { engine: true });
  const update = await outcomeFor(appRoot, from, "f".repeat(40), "engine", [
    { path: "src/runtime.ts", part: "engine" }, { path: "public/app/main.js", part: "window" },
  ]);
  const result = await apply(electron, update);
  assert.equal(result.ok, false); assert.match(result.error, /did not restore and draw/);
  assert.equal(await electron.evaluate(() => globalThis.branchEngineForTests.running), true);
  assert.notEqual(await electron.evaluate(() => globalThis.branchEngineForTests.pid), before, "the original engine was restarted by rollback");
  await page.waitForFunction(() => document.getElementById("prompt")?.value === "a draft before a broken page", undefined, { timeout: 30000 });
  assert.equal((await readFile(join(appRoot, "live", "current.json"), "utf8").then(JSON.parse, () => null))?.engine ?? null, null);
  await send(page, "Prove the old page works");
  await page.locator("#scroll").getByText("The old page still works.", { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(model.asked.length, 1);
  await offScreen(electron, "after failed-page recovery");
});
