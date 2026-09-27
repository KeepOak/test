import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { stageLive } from "../dist/hot-update/live-folder.js";
import { desktopOptions, onboarded, offScreen, send } from "./fixtures/desktop-options.mjs";
import { closeOwnedGateway } from "./fixtures/gateway-close.mjs";
import { scriptedModel } from "./fixtures/hot-model.mjs";
import { discardTemp } from "./temp-dir.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function launch(t, model) {
  // Here an explicit existing runtime is required; a build machine uses the one its install put in place.
  assert.ok(process.env.BRANCH_TEST_ELECTRON || process.env.CI, "an explicit existing runtime is required");
  const scratch = await mkdtemp(join(root, ".gateway-hot-")); t.after(() => discardTemp(scratch));
  const { options, home } = await desktopOptions({ hidden: true, gateway: true });
  if (process.env.BRANCH_TEST_ELECTRON) options.executablePath = process.env.BRANCH_TEST_ELECTRON;
  const appRoot = join(scratch, "app"); await mkdir(appRoot);
  Object.assign(options.env, { BRANCH_TEST_ENGINE_HOOKS: "1", BRANCH_TEST_LIVE_ROOT: appRoot,
    BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: model.endpoint, BRANCH_MODEL: "m", BRANCH_API_KEY: "test-key" });
  const electron = await _electron.launch(options), mainPid = await electron.evaluate(() => process.pid);
  console.log("isolated gateway hot shell", JSON.stringify({ mainPid, home, launchedAt: new Date().toISOString() }));
  const page = await electron.firstWindow(); await onboarded(page);
  const gatewayPid = JSON.parse(await readFile(join(home, "state", "running.json"), "utf8")).pid;
  console.log("isolated gateway hot broker", JSON.stringify({ mainPid: gatewayPid, home }));
  t.after(async () => { await offScreen(electron, "gateway hot cleanup"); await closeOwnedGateway(electron, home, gatewayPid); await discardTemp(home); });
  return { electron, page, home, scratch, appRoot, gatewayPid };
}

async function outcome(scratch, appRoot, name, commit, tier, edits, changed) {
  const dir = join(scratch, name); await cp(join(root, "public"), join(dir, "public"), { recursive: true });
  if (tier !== "window") {
    await cp(join(root, "dist"), join(dir, "dist"), { recursive: true, filter: (path) => !/\.(map|d\.c?ts)$/.test(path) });
    for (const file of ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) await cp(join(root, file), join(dir, file));
  }
  for (const [path, edit] of Object.entries(edits)) await writeFile(join(dir, path), edit(await readFile(join(dir, path), "utf8")));
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const staged = await stageLive({ source: dir, appRoot, commit, version, withEngine: tier !== "window" });
  return { tier, version, parts: [tier], ...staged, changed };
}
const apply = (electron, update) => electron.evaluate(async (_electron, update) => globalThis.branchLiveForTests.hooks.apply(
  { ...update, parts: new Set(update.parts) }, { onStage: () => undefined }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: error.message })), update);

test("the detached broker applies an acknowledged window update while keeping the shell's draft and caret", { timeout: 180000 }, async (t) => {
  const model = await scriptedModel(t, []), f = await launch(t, model);
  await f.page.locator("#prompt").fill("a gateway draft");
  await f.page.evaluate(() => document.getElementById("prompt").setSelectionRange(2, 6));
  const update = await outcome(f.scratch, f.appRoot, "window", "a".repeat(40), "window", {
    "public/app/main.js": (text) => `${text}\ndocument.documentElement.dataset.gatewayUpdate = "ready";\n`,
  }, [{ path: "public/app/main.js", part: "window" }]);
  const result = await apply(f.electron, update); assert.equal(result.ok, true, result.error);
  await f.page.waitForFunction(() => document.documentElement.dataset.gatewayUpdate === "ready");
  assert.equal(await f.page.locator("#prompt").inputValue(), "a gateway draft");
  assert.deepEqual(await f.page.evaluate(() => [document.getElementById("prompt").selectionStart, document.getElementById("prompt").selectionEnd]), [2, 6]);
  assert.equal(JSON.parse(await readFile(join(f.appRoot, "live", "current.json"), "utf8")).window.commit, update.manifest.commit);
  assert.equal(JSON.parse(await readFile(join(f.home, "state", "running.json"), "utf8")).pid, f.gatewayPid);
});

test("the detached broker adopts one newer engine while a task drains and keeps the same public owner", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, [{ text: "The retained answer.", held: true }]), f = await launch(t, model);
  const before = await f.electron.evaluate(() => globalThis.branchLiveForTests.engineState());
  await send(f.page, "Work through gateway adoption"); await model.until(1);
  const update = await outcome(f.scratch, f.appRoot, "engine", "b".repeat(40), "engine", {}, [{ path: "src/runtime.ts", part: "engine" }]);
  const applying = apply(f.electron, update);
  const until = Date.now() + 120000; let handingOver = false;
  while (Date.now() < until) {
    handingOver = (await f.electron.evaluate(() => globalThis.branchLiveForTests.engineState())).handingOver;
    if (handingOver) break; await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(handingOver, true, "the retained engine began draining the active task");
  model.release(0);
  const result = await applying; assert.equal(result.ok, true, result.error);
  await f.page.locator("#scroll").getByText("The retained answer.", { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(model.asked.length, 1);
  const state = await f.page.evaluate(async () => (await (await fetch("/api/state")).json()).runs.filter((run) => run.prompt === "Work through gateway adoption"));
  assert.deepEqual(state.map((run) => run.status), ["completed"]);
  const health = await fetch(JSON.parse(await readFile(join(f.home, "state", "running.json"), "utf8")).url + "/gateway/health").then((response) => response.json());
  assert.notEqual(health.worker.pid, before.pid); assert.equal(health.gateway.pid, f.gatewayPid);
});

test("a broken renderer rolls the retained engine and served window back before recording adoption", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, [{ text: "The recovered gateway page works." }]), f = await launch(t, model);
  await f.page.locator("#prompt").fill("a retained recovery draft");
  const update = await outcome(f.scratch, f.appRoot, "broken-page", "c".repeat(40), "engine", {
    "public/app/main.js": () => "throw new Error(\"isolated gateway page failure\");\n",
  }, [{ path: "src/runtime.ts", part: "engine" }, { path: "public/app/main.js", part: "window" }]);
  const result = await apply(f.electron, update); assert.equal(result.ok, false); assert.match(result.error, /did not restore and draw/);
  await f.page.waitForFunction(() => document.getElementById("prompt")?.value === "a retained recovery draft");
  assert.equal((await readFile(join(f.appRoot, "live", "current.json"), "utf8").then(JSON.parse, () => null))?.engine ?? null, null);
  await send(f.page, "Prove the retained old page works");
  await f.page.locator("#scroll").getByText("The recovered gateway page works.", { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(model.asked.length, 1);
});
