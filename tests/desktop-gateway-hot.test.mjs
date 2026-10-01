import { processRunning } from "./process-running.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { proveOnce, sessionKey } from "../dist/engine-proof.js";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { stageLive } from "../dist/hot-update/live-folder.js";
import { connectDesktopControl } from "../dist/desktop/gateway-control.js";
import { gatewayLiveRequest } from "../dist/desktop/gateway-live.js";
import { desktopOptions, onboarded, offScreen, send } from "./fixtures/desktop-options.mjs";
import { closeOwnedGateway } from "./fixtures/gateway-close.mjs";
import { scriptedModel } from "./fixtures/hot-model.mjs";
import { discardTemp } from "./temp-dir.mjs";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function launch(t, model, extra = {}, { shellGoes = false } = {}) {
  // Here an explicit existing runtime is required; a build machine uses the one its install put in place.
  assert.ok(process.env.BRANCH_TEST_ELECTRON || process.env.CI, "an explicit existing runtime is required");
  const scratch = await mkdtemp(join(root, ".gateway-hot-")); t.after(() => discardTemp(scratch));
  const { options, home } = await desktopOptions({ hidden: true, gateway: true });
  if (process.env.BRANCH_TEST_ELECTRON) options.executablePath = process.env.BRANCH_TEST_ELECTRON;
  const appRoot = join(scratch, "app"); await mkdir(appRoot);
  Object.assign(options.env, { BRANCH_TEST_ENGINE_HOOKS: "1", BRANCH_TEST_LIVE_ROOT: appRoot,
    BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: model.endpoint, BRANCH_MODEL: "m", BRANCH_API_KEY: "test-key", ...extra });
  const electron = await _electron.launch(options), mainPid = await electron.evaluate(() => process.pid);
  console.log("isolated gateway hot shell", JSON.stringify({ mainPid, home, launchedAt: new Date().toISOString() }));
  const page = await electron.firstWindow(); await onboarded(page);
  const gatewayPid = JSON.parse(await readFile(join(home, "state", "running.json"), "utf8")).pid;
  console.log("isolated gateway hot broker", JSON.stringify({ mainPid: gatewayPid, home }));
  t.after(async () => {
    if (shellGoes) { await quitGateway(home, gatewayPid); await electron.close().catch(() => undefined); }
    else { await offScreen(electron, "gateway hot cleanup"); await closeOwnedGateway(electron, home, gatewayPid); }
    await discardTemp(home);
  });
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
/** The case's own gateway, proved and asked to quit, when its shell is already gone (tests/fixtures/gateway-close.mjs). */
async function quitGateway(home, gatewayPid) {
  const dataDir = join(home, "state"), presence = JSON.parse(await readFile(join(dataDir, "running.json"), "utf8"));
  assert.equal(presence.pid, gatewayPid, "the exact launched gateway still owns the running record");
  const token = (await readFile(join(dataDir, "session-token"), "utf8")).trim(), boot = await proveOnce(presence.url, token, 5000);
  assert.ok(boot, "the test-owned gateway proves itself before cleanup");
  await fetch(`${presence.url}/api/deployment/quit`, { method: "POST", headers: { authorization: `Bearer ${sessionKey(token, boot)}` }, signal: AbortSignal.timeout(10000) });
  const until = Date.now() + 15000;
  while (Date.now() < until) { if (!processRunning(gatewayPid)) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  assert.fail("the case's gateway did not quit");
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
  let result = await apply(f.electron, update);
  // A cold build machine can take longer than the 15 s paint wait on the first reload: that is a safe deferral (the old
  // page stays), and the same checked update is offered again, as the updater does. Any other refusal fails here.
  if (!result.ok && /did not restore and draw in time/.test(result.error)) { console.log("deferred once:", result.error); result = await apply(f.electron, update); }
  assert.equal(result.ok, true, result.error);
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

/** A chat service's side (Mattermost-shaped): the answers Branch posts back to its webhook. */
async function chatService(t) {
  const replies = [];
  const server = createServer((request, response) => {
    let raw = ""; request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => { try { replies.push(JSON.parse(raw)); } catch { replies.push({ raw }); } response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }));
  return { hook: `http://127.0.0.1:${server.address().port}/hooks/branch`, replies };
}

test("with no window open, the gateway takes a newer engine by itself while a chat app's turn works: one answer in the chat, the gateway never quits", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, [{ tool: "checklist.read", args: {} }, { tool: "files.list", args: {}, held: true }, { text: "Answered with no window open." }]);
  const chat = await chatService(t), secret = "gateway-chat-token-0123456789";
  const config = await mkdtemp(join(root, ".gateway-chat-")); t.after(() => discardTemp(config));
  const integrations = join(config, "integrations.json");
  await writeFile(integrations, JSON.stringify({ web: { allowPrivateAddresses: true }, channels: [{ id: "mattermost", type: "chat", service: "mattermost",
    webhookUrlSecret: "GATEWAY_CHAT_HOOK", secretSecret: "GATEWAY_CHAT_SECRET", activation: "always", pairing: false, allowlist: ["user-9"] }] }));
  const f = await launch(t, model, { BRANCH_INTEGRATIONS: integrations, GATEWAY_CHAT_HOOK: chat.hook, GATEWAY_CHAT_SECRET: secret }, { shellGoes: true });
  const dataDir = join(f.home, "state"), running = JSON.parse(await readFile(join(dataDir, "running.json"), "utf8"));
  const address = await f.page.evaluate(async () => (await (await fetch("/api/channels/addresses")).json()).addresses.find((one) => one.channel === "mattermost")?.address);
  assert.ok(address, "the chat service's address is there");
  const posted = fetch(new URL(new URL(address, running.url).pathname, running.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: secret, post_id: "p-gw-1", channel_id: "c1", channel_name: "town-square", user_id: "user-9", user_name: "alice", text: "What is on today?" }) });
  posted.catch(() => undefined);
  await model.until(2);
  const before = await (await fetch(`${running.url}/gateway/health`)).json();
  const update = await outcome(f.scratch, f.appRoot, "windowless", "d".repeat(40), "engine", {}, [{ path: "src/runtime.ts", part: "engine" }]);
  // The window goes for good, and with it the shell's place on the gateway: only the gateway and its engine are left.
  await f.electron.evaluate(({ BrowserWindow }) => { for (const one of BrowserWindow.getAllWindows()) one.destroy(); }).catch(() => undefined);
  // What the gateway's own update loop does with a checked build (gateway-updates.ts): asked here, it starts once no
  // shell is joined, so no window is told or waited for.
  const asking = await connectDesktopControl(dataDir);
  assert.equal(await asking.link.call("test-adopt-alone", gatewayLiveRequest({ ...update, parts: new Set(update.parts) }), 10000), true);
  asking.close();
  await new Promise((wake) => setTimeout(wake, 1000));
  const watching = await connectDesktopControl(dataDir); t.after(() => watching.close());
  const until = Date.now() + 120000; let handingOver = false;
  while (Date.now() < until) {
    handingOver = (await watching.link.call("test-engine", undefined, 5000)).handingOver;
    if (handingOver) break;
    const early = await watching.link.call("test-adopted-alone", undefined, 5000);
    assert.equal(early, null, `the adoption ended before it handed anything over: ${JSON.stringify(early)}`);
    await new Promise((wake) => setTimeout(wake, 50));
  }
  assert.equal(handingOver, true, "the engine began handing its work over with no window open");
  model.release(1);
  let adopted = null;
  while (!adopted && Date.now() < until) { adopted = await watching.link.call("test-adopted-alone", undefined, 5000); if (!adopted) await new Promise((wake) => setTimeout(wake, 200)); }
  assert.deepEqual(adopted, { ok: true }, JSON.stringify(adopted));
  const postedStatus = (await posted).status;
  const deadline = Date.now() + 60000;
  while (chat.replies.length < 1 && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 100));
  await new Promise((wake) => setTimeout(wake, 1500));
  assert.equal(chat.replies.length, 1, `one answer, once: ${JSON.stringify(chat.replies)}`);
  assert.match(JSON.stringify(chat.replies[0]), /Answered with no window open\./);
  assert.equal(model.asked.length, 3, "no step was asked of the model twice");
  assert.equal(postedStatus, 200, "the chat service's post was answered");
  const after = await (await fetch(`${running.url}/gateway/health`)).json();
  assert.equal(after.gateway.pid, before.gateway.pid, "the gateway never quit");
  assert.equal(after.gateway.pid, f.gatewayPid);
  assert.notEqual(after.worker.pid, before.worker.pid, "the newer engine runs now");
  assert.equal(JSON.parse(await readFile(join(f.appRoot, "live", "current.json"), "utf8")).engine.commit, update.manifest.commit, "adopted and recorded");
});
