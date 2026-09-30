/* PLAT-182: after an accepted update (a new version or a new data format) the engine runs the doctor once, by itself,
   records its verdict, and never launches an installer while unattended. The first start only records a baseline.
   An in-memory store and a temporary folder; the only command it may run is `git --version`. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Store } from "../dist/store.js";
import { doctorFix } from "../dist/doctor-fix.js";
import { startPostUpdateDoctor } from "../dist/desktop/post-update-doctor.js";

const saved = (store) => store.get("settings", "local", "doctor-after-update")?.data;
async function until(check) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "the doctor never recorded its verdict");
}

test("PLAT-182: the first start records a baseline; a new version runs the doctor once and keeps its verdict", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "branch-doctor-"));
  t.after(() => discardTemp(workspace));
  const store = new Store(":memory:");
  const options = { store, owner: "local", workspace, port: 4321, redact: (text) => text.replaceAll(workspace, "<workspace>") };
  startPostUpdateDoctor({ ...options, version: "1.0.0" });
  assert.equal(saved(store).baseline, true);
  assert.equal(saved(store).version, "1.0.0");
  startPostUpdateDoctor({ ...options, version: "1.0.0" });
  assert.equal(saved(store).baseline, true, "the same version does not run it again");
  startPostUpdateDoctor({ ...options, version: "1.1.0" });
  await until(() => saved(store).baseline === false);
  const verdict = saved(store);
  assert.equal(verdict.version, "1.1.0");
  assert.equal(verdict.fixMode, true);
  assert.deepEqual(verdict.checks.map((check) => check.name).sort(), ["Address on this computer", "Git", "Web browsing", "Your files folder"]);
  assert.doesNotMatch(JSON.stringify(verdict), new RegExp(workspace.replaceAll("\\", "\\\\")), "paths are said through the redactor");
});

test("PLAT-182: an unattended repair never installs the browser; a person's own --fix still may", async () => {
  const ran = [];
  const deps = { run: async (file, args) => { ran.push([file, ...args].join(" ")); return "git version 2"; }, portFree: async () => true };
  const missing = { port: 1, workspace: tmpdir(), portIsOurs: true, browsersInstalled: async () => false };
  const unattended = await doctorFix({ ...missing, fix: true, browserRepair: "manual" }, deps);
  const browser = unattended.checks.find((check) => check.name === "Web browsing");
  assert.equal(browser.ok, false);
  assert.match(browser.fix, /npx playwright install chromium/);
  assert.deepEqual(ran, ["git --version"]);
  await doctorFix({ ...missing, fix: true }, deps);
  assert.ok(ran.includes("npx playwright install chromium --only-shell"));
});
