/* MODEL-086: vLLM one-click on Linux starts the owner's existing local model directory with a named built-in tool
   parser, listening on this computer only, offline and without usage reports. Nothing is downloaded or run here:
   only the start plan and the directory check are exercised. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { startPlan, candidatePaths } from "../dist/local-launch.js";
import { localVllmModel, vllmEnvironment } from "../dist/local-vllm.js";
import { Store } from "../dist/store.js";
import { OneClick } from "../dist/local-oneclick.js";
import { saveLocalModelsMode } from "../dist/local-jobs.js";
import { asCaller } from "../dist/caller.js";
import { enterPairedDoor } from "../dist/people/context.js";

const linux = { platform: "linux", arch: "x64", home: "/home/sam", env: { PATH: "/usr/bin" } };
const win32 = { platform: "win32", arch: "x64", home: "C:\\Users\\sam", env: { Path: "C:\\Windows" } };

test("MODEL-086: vLLM starts one local directory on 127.0.0.1 with its tool parser, offline", () => {
  const plan = startPlan("vllm", "/usr/bin/vllm", { file: "/models/qwen", context: 8192, port: 51000, toolParser: "hermes" }, linux);
  assert.equal(plan.instead, null);
  assert.deepEqual(plan.serve.slice(0, 7), ["/usr/bin/vllm", "serve", "/models/qwen", "--host", "127.0.0.1", "--port", "51000"]);
  assert.deepEqual(plan.serve.slice(-3), ["--enable-auto-tool-choice", "--tool-call-parser", "hermes"]);
  assert.deepEqual(plan.env, vllmEnvironment);
  assert.equal(plan.env.HF_HUB_OFFLINE, "1");
  assert.equal(plan.env.VLLM_NO_USAGE_STATS, "1");
});

test("MODEL-086: a repository name, an unknown parser or another system is refused instead of started", () => {
  for (const model of [{ file: "Qwen/Qwen3-8B", toolParser: "hermes" }, { file: "/models/qwen", toolParser: "made-up" }, { file: "/models/qwen" }])
    assert.equal(startPlan("vllm", "/usr/bin/vllm", model, linux).serve, null, JSON.stringify(model));
  assert.equal(startPlan("vllm", "vllm", { file: "/models/qwen", toolParser: "hermes" }, win32).serve, null);
  assert.deepEqual(candidatePaths("vllm", win32), [], "vLLM is looked for on Linux only");
});

test("MODEL-086: the model directory must exist with a small config.json, and its context is capped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-vllm-"));
  t.after(() => discardTemp(root));
  const dir = join(root, "qwen");
  await mkdir(dir);
  await writeFile(join(dir, "config.json"), JSON.stringify({ max_position_embeddings: 32768 }));
  const found = await localVllmModel(dir, linux);
  assert.equal(found.context, 8192);
  assert.match(found.label, /^vLLM · qwen$/);
  await assert.rejects(localVllmModel("qwen", linux), /absolute local model directory/);
  await assert.rejects(localVllmModel(dir, win32), /only on Linux/);
  await writeFile(join(dir, "config.json"), "x".repeat(70000));
  await assert.rejects(localVllmModel(dir, linux), /bounded local config\.json/);
});

test("MODEL-086: vLLM setup is refused through a door (a paired phone or from beyond), and still reached from this computer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-vllm-door-"));
  const store = new Store(join(root, "branch.sqlite"));
  t.after(async () => { store.close(); await discardTemp(root); });
  const owner = store.profiles.scope();
  saveLocalModelsMode(store, owner, { mode: "when-needed" });
  const launcher = { at: linux, find: async () => "/usr/bin/vllm", owns: () => false, stopRuntime: async () => {} };
  const oneClick = new OneClick({ store, owner, launcher, dataDir: join(root, "data"), library: async () => { throw new Error("offline"); },
    room: async () => { throw new Error("not asked for vLLM"); } });
  const setup = { runtime: "vllm", name: join(root, "no-such-model"), found: true, toolParser: "hermes" };
  const doorRefusal = /this computer|own Branch window|through a door/i;
  const caller = (kind, throughDoor) => ({ kind, lockdown: false, appLocked: false, throughDoor, fromThisComputer: !throughDoor || kind === "legacy-phone", household: false });
  for (const [kind, throughDoor] of [["owner-remote", true], ["phone-with-own-key", true], ["legacy-phone", true]])
    await assert.rejects(asCaller(caller(kind, throughDoor), () => oneClick.begin(setup)), doorRefusal, kind);
  await assert.rejects(new Promise((resolve, reject) => setImmediate(() => { enterPairedDoor(); oneClick.begin(setup).then(resolve, reject); })),
    doorRefusal, "the paired door");
  await assert.rejects(asCaller(caller("owner-here", false), () => oneClick.begin(setup)),
    (error) => !doorRefusal.test(error.message) && /ENOENT|not available/.test(error.message), "the owner here gets as far as the model directory");
});
