/* Every Beta install is tried for real before it is used (src/desktop/beta-smoke.ts): the new version's engine, its
   window, a message answered by a stand-in model, Settings, and no page error. Here the try-out's steps drive a real
   browser page on a real engine; tests/desktop-beta-smoke.test.mjs runs them in the new version's own hidden window.
   Mutations, each turning a case here red:
     M1 smokeWindow: drop the page-errors step (push ok: true)            → "a page error fails the try-out"
     M2 smokeWindow: skip waiting for the answer                          → "a model that never answers fails the try-out"
     M3 smokeFailure: answer null whenever report.ok                      → "a report missing a step is a failure"
     M4 smokeEnv: keep BRANCH_ variables                                  → "nothing of the running install reaches the try-out"
     M5 canary.ts updateCanary: drop `!options?.required &&`              → "a Beta check runs with the switch off"
   (the Updater's side, tests/dev-channel.test.mjs: a failed try-out installs nothing, and Beta without one is refused.) */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { defaultPreset } from "../dist/providers.js";
import { saveOnboarding } from "../dist/onboarding.js";
import { SmokeStandIn, SmokeSteps, smokeEnv, smokeFailure, smokeReportPath, smokeWindow } from "../dist/desktop/beta-smoke.js";
import { updateCanary } from "../dist/never-break/canary.js";

async function engine(t, provider = new SmokeStandIn()) {
  const root = await mkdtemp(join(tmpdir(), "branch-beta-smoke-"));
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "workspace"), presets: [defaultPreset(provider)] });
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const tab = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  const page = { goto: async (url) => { await tab.goto(url); }, run: (script) => tab.evaluate(script), errors: () => [...errors] };
  return { server, tab, page };
}
const report = (steps) => ({ ok: steps.every((one) => one.ok), version: "0.19.3-dev.1-gabc", steps });

test("the try-out passes on a working version: window, a stand-in answer, Settings, no page error", async (t) => {
  const { server, page } = await engine(t);
  const steps = await smokeWindow(page, { url: server.url, token: server.token });
  assert.deepEqual(steps.map((one) => [one.step, one.ok]), [["window", true], ["answer", true], ["settings", true], ["errors", true]],
    JSON.stringify(steps));
  assert.equal(smokeFailure(report([{ step: "engine", ok: true, detail: "up" }, ...steps])), null);
});

test("a page error fails the try-out, and the owner is told it was the window", async (t) => {
  const { server, tab, page } = await engine(t);
  await tab.route("**/app/main.js", async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, body: `${await answer.text()}\nsetTimeout(() => { throw new Error("broken build"); }, 0);` });
  });
  const steps = await smokeWindow(page, { url: server.url, token: server.token });
  const errors = steps.find((one) => one.step === "errors");
  assert.equal(errors.ok, false);
  assert.match(errors.detail, /broken build/);
  const words = smokeFailure(report([{ step: "engine", ok: true, detail: "up" }, ...steps]));
  assert.match(words, /^The new Beta version was not used: when Branch tried it, its window showed an error \(.*broken build.*\)\. You are still on the version you had, and nothing was changed\.$/);
});

test("a model that never answers fails the try-out at the message", async (t) => {
  const silent = { name: "silent", audio: () => null, async complete() { throw new Error("no answer"); } };
  const { server, page } = await engine(t, silent);
  const steps = await smokeWindow(page, { url: server.url, token: server.token, timeoutMs: 6000 });
  assert.deepEqual(steps.find((one) => one.step === "answer"), { step: "answer", ok: false, detail: "the stand-in model's answer never showed" });
  assert.match(smokeFailure(report(steps)), /a test message got no answer/);
});

test("a report missing a step is a failure, and a missing report says the try-out did not finish", () => {
  const passed = SmokeSteps.map((step) => ({ step, ok: true, detail: "fine" }));
  assert.equal(smokeFailure(report(passed)), null);
  assert.match(smokeFailure(report(passed.filter((one) => one.step !== "settings"))), /Settings did not open \(the try-out stopped before it\)/);
  assert.match(smokeFailure(null, "it exited with code 1"), /^The new Beta version was not used: it exited with code 1\. You are still on the version you had/);
  assert.match(smokeFailure(report([{ step: "engine", ok: false, detail: "the database would not open" }])), /its engine did not start \(the database would not open\)/);
});

test("nothing of the running install reaches the try-out, and only `--branch-smoke=<report>` starts one", () => {
  const env = smokeEnv({ PATH: "/bin", BRANCH_DATA_DIR: "/owner/data", BRANCH_PROVIDER: "demo", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", HOME: "/home/o" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/o" });
  assert.equal(smokeReportPath(["app", "--branch-smoke=/tmp/r.json"]), "/tmp/r.json");
  assert.equal(smokeReportPath(["app", "--branch-smoke="]), null);
  assert.equal(smokeReportPath(["app", "--branch-smoke"]), null);
});

test("a Beta check runs with the never-break switch off; any other update's does not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-beta-canary-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "data"), { recursive: true });
  const asked = [];
  const canary = updateCanary({ dataDir: join(root, "data"), platform: "linux", executableName: "branch-agent", fromVersion: "1.0.0", target: null,
    snapshot: async () => { asked.push("copy"); throw new Error("stop here"); } });
  await canary(join(root, "staged"), "1.0.1");
  assert.deepEqual(asked, [], "the switch is off: nothing is checked, as before");
  await assert.rejects(canary(join(root, "staged"), "1.0.1", { required: true }), /stop here/);
  assert.deepEqual(asked, ["copy"], "a Beta install is checked on a copy whatever the switch says");
});
