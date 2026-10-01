/* QA 2026-09-28: the owner's ~/.codex/config.toml said `model = "gpt-6-sol"`, which Codex refuses with a ChatGPT sign-in,
   so every task through Codex failed. Branch now names the model on every call (`-c model=...`): the one picked in
   Settings › Models, else the most capable one Codex takes (src/codex-models.ts). Which ones it takes is learned from
   Codex itself: one tiny call per model, again whenever Codex's version changes; only a clear answer or a clear refusal
   is kept. The owner's Codex settings are never read or edited. A stand-in `codex` reads its CODEX_HOME's config.toml as
   the real one does, lets `-c model=` win, answers `--version`, and takes only the models in accepts.txt. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliAgentProvider, cliAgentCatalog, codexDefaultModel, registerCliAgent, runCliAgent } from "../dist/providers/cli-agent.js";
import { CodexModels, codexVerified } from "../dist/codex-models.js";
import { programCall } from "../dist/coding/hand-off.js";
import { createBranch } from "../dist/index.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode } from "../dist/accounts/manage.js";
import { discardTemp } from "./temp-dir.mjs";

const request = () => ({ messages: [{ role: "user", content: "Say hello" }], signal: new AbortController().signal });
const CONFIG = 'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n';
const FAKE = `
const { readFileSync, existsSync } = require("node:fs"); const { join } = require("node:path");
const home = process.env.CODEX_HOME, args = process.argv.slice(2);
const read = (name, fallback) => { try { return readFileSync(join(home, name), "utf8"); } catch { return fallback; } };
if (args.includes("--version")) { console.log(read("version.txt", "codex-cli 1.0.0").trim()); process.exit(0); }
const set = args.map((a, i) => args[i - 1] === "-c" && a.startsWith("model=") ? a.slice(6) : null).filter(Boolean).pop();
const model = set ?? /^model\\s*=\\s*"([^"]+)"/m.exec(read("config.toml", ""))?.[1];
const accepts = read("accepts.txt", "gpt-5.6-terra gpt-5.6-luna gpt-5.6-sol gpt-5.5").split(/\\s+/).filter(Boolean);
process.stdin.resume(); process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  if (existsSync(join(home, "signed-out"))) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "Authentication required" } })); process.exit(1);
  }
  if (!accepts.includes(model)) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "The '" + model + "' model is not supported when using Codex with a ChatGPT account." } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "answered by " + model } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
});`;

/** A stand-in Codex, its own folder (with the owner's config), and the shared choice, in a throwaway store. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-codex-model-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const home = join(root, "codex-home"), script = join(root, "codex.cjs");
  await mkdir(home);
  await writeFile(join(home, "config.toml"), CONFIG);
  await writeFile(script, FAKE);
  const codex = cliAgentCatalog.find((row) => row.id === "codex");
  const row = { ...codex, command: process.execPath, args: [script, ...codex.args] };
  const choice = new CodexModels(app.store, app.runtime.owner);
  const provider = new CliAgentProvider(row, { timeoutMs: 30_000 }, runCliAgent, { name: "CODEX_HOME", path: home });
  provider.codexModels = choice;
  return { app, home, provider, choice };
}

test("Codex answers with Branch's model even when the owner's config.toml names one its sign-in refuses, and the config is left alone", async (t) => {
  const { home, provider } = await fixture(t);
  const registered = [];
  registerCliAgent({ register: (preset) => registered.push(preset) }, { id: "codex" });
  assert.equal(registered[0].model, codexDefaultModel, "the Codex connection is listed under Branch's model");
  const said = await provider.complete(request());
  assert.equal(said.content, `answered by ${codexDefaultModel}`);
  assert.equal(codexDefaultModel, "gpt-5.6-terra", "the most capable checked model; Sol is the light one");
  assert.equal(await readFile(join(home, "config.toml"), "utf8"), CONFIG, "the owner's Codex settings are never edited");
});

test("a model picked in Settings › Models is the one named on the next call", async (t) => {
  const { provider, choice } = await fixture(t);
  choice.choose({ chosen: "gpt-5.5" });
  assert.equal((await provider.complete(request())).content, "answered by gpt-5.5");
  choice.choose({ chosen: null });
  assert.equal((await provider.complete(request())).content, `answered by ${codexDefaultModel}`);
  assert.throws(() => choice.choose({ chosen: "gpt-6-sol" }), /does not take gpt-6-sol/, "a model Codex has not taken cannot be picked");
});

test("a model Codex refuses is said plainly, with the ones it takes", async (t) => {
  const { home, provider, choice } = await fixture(t);
  choice.choose({ chosen: "gpt-5.6-luna" });
  await writeFile(join(home, "accepts.txt"), "gpt-5.6-terra gpt-5.5");
  await assert.rejects(provider.complete(request()), (error) => {
    assert.match(error.message, /cannot use gpt-5\.6-luna with this sign-in/);
    assert.match(error.message, /gpt-5\.6-terra/);
    assert.doesNotMatch(error.message, /sign in again|own settings/i);
    return true;
  });
});

test("the check learns what Codex takes: GPT-6 once Codex takes it, refusals kept, the best one becomes the default", async (t) => {
  const { home, provider, choice } = await fixture(t);
  await writeFile(join(home, "accepts.txt"), "gpt-5.6-terra gpt-5.6-luna gpt-5.6-sol gpt-5.5");
  let kept = await choice.check(provider.probe(), "new");
  assert.deepEqual(kept.refused.sort(), ["gpt-6-luna", "gpt-6-sol"], "the GPT-6 models Codex refused are kept as refused");
  assert.equal(kept.version, "codex-cli 1.0.0");
  assert.equal(choice.chosen(), "gpt-5.6-terra");
  assert.equal(await choice.check(provider.probe(), "new"), null, "the same Codex version is not asked again");

  // A new Codex version that takes GPT-6 Luna: checked again by itself, and Luna becomes the best it takes.
  await writeFile(join(home, "version.txt"), "codex-cli 1.1.0");
  await writeFile(join(home, "accepts.txt"), "gpt-6-luna gpt-5.6-terra gpt-5.6-luna gpt-5.6-sol gpt-5.5");
  kept = await choice.check(provider.probe(), "new");
  assert.deepEqual(kept.accepted, ["gpt-6-luna"]);
  assert.deepEqual(kept.refused, ["gpt-6-sol"]);
  assert.equal(choice.offered()[0], "gpt-6-luna");
  assert.equal((await provider.complete(request())).content, "answered by gpt-6-luna");
});

test("a sign-in failure during the check proves nothing, so nothing is kept and it is tried again later", async (t) => {
  const { home, provider, choice } = await fixture(t);
  await writeFile(join(home, "signed-out"), "");
  assert.equal(await choice.check(provider.probe(), "all"), null);
  assert.equal(choice.settings().version, null, "the version is left unchecked");
  assert.deepEqual(choice.settings().refused, []);
  await rm(join(home, "signed-out"));
  assert.ok(await choice.check(provider.probe(), "new"), "checked once Codex answers again");
});

test("every Codex account reads the pick at call time, not when its connection was built", async (t) => {
  const { app } = await fixture(t);
  const calls = [];
  const spawn = async (row, _prompt, _signal, _limits, home) => {
    const at = row.args.indexOf("-c");
    calls.push({ model: at < 0 ? null : row.args[at + 1], home: home?.path ?? "primary" });
    return { code: 0, stdout: JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "ok" } }), stderr: "" };
  };
  registerCliAgent(app.runtime.models, { id: "codex" }, {}, spawn);
  const service = accountsServiceFor(app.runtime.models);
  service.deps.spawnAgent = spawn;
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: "cli-codex", label: "Second" })).accounts.at(-1).id;
  const preset = app.runtime.models.presets.get("cli-codex");
  const extra = await service.providerFor("cli-codex", "cli", preset, second);
  await extra.complete(request());
  const { codexModelsFor } = await import("../dist/codex-models.js");
  codexModelsFor(app.runtime.models).choose({ chosen: "gpt-5.5" });
  await extra.complete(request());
  await preset.provider.complete(request());
  assert.deepEqual(calls.map((c) => c.model), [`model=${codexDefaultModel}`, "model=gpt-5.5", "model=gpt-5.5"]);
  assert.ok(calls[0].home.endsWith(second), "the extra account ran in its own folder");
});

test("a hand-off to Codex names Branch's model unless the task names its own", () => {
  const args = (model) => programCall("codex", "/work", model).args;
  assert.deepEqual(args().slice(args().indexOf("--model"), args().indexOf("--model") + 2), ["--model", codexDefaultModel]);
  assert.ok(args("gpt-5.5").includes("gpt-5.5"));
  assert.ok(!programCall("claude-code", "/work").args.includes("--model"), "Claude Code keeps its own choice");
  assert.ok(codexVerified.includes(codexDefaultModel));
});

test("Codex answering as a model works in Branch's own empty folder, and only there skips the repository trust check", async () => {
  const { codexArgs, codexWorkDir } = await import("../dist/providers/cli-agent.js");
  const dir = codexWorkDir();
  assert.match(dir, /branch-codex-work$/);
  const calls = [];
  const provider = new CliAgentProvider(cliAgentCatalog.find((row) => row.id === "codex"), {}, async (row) => {
    calls.push(row.args);
    return { code: 0, stdout: JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "ok" } }), stderr: "" };
  });
  await provider.complete(request());
  const args = calls[0];
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 3), ["-C", dir, "--skip-git-repo-check"]);
  assert.deepEqual(codexArgs(["exec", "--json", "-"], "gpt-5.5"), ["exec", "-c", "model=gpt-5.5", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "--json", "-"], "no folder given: the trust check stays");
  assert.ok(!programCall("codex", "/work").args.includes("--skip-git-repo-check"), "a hand-off to the owner's own folder keeps Codex's trust check");
});

test("a program that prints nothing at all is stopped with a plain reason instead of hanging", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-codex-silent-"));
  t.after(() => discardTemp(root));
  const script = join(root, "silent.cjs");
  await writeFile(script, "process.stdin.resume(); setTimeout(() => {}, 60000);");
  const codex = cliAgentCatalog.find((row) => row.id === "codex");
  const provider = new CliAgentProvider({ ...codex, command: process.execPath, args: [script, ...codex.args] }, { firstOutputMs: 1500 }, runCliAgent);
  const started = Date.now();
  await assert.rejects(provider.complete(request()), /said nothing at all for 2 seconds, so it was stopped/);
  assert.ok(Date.now() - started < 20000, "stopped at the silence limit, not the whole task's");
});

test("Codex's answer is taken at the end of its turn, not after it has spent its time closing its own tool servers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-codex-slow-exit-"));
  t.after(() => discardTemp(root));
  const script = join(root, "slow-exit.cjs");
  await writeFile(script, `process.stdin.resume(); process.stdin.on("end", () => {
    console.log(JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "done" } }));
    console.log(JSON.stringify({ type: "turn.completed" }));
    setTimeout(() => process.exit(0), 8000);
  });`);
  const codex = cliAgentCatalog.find((row) => row.id === "codex");
  const provider = new CliAgentProvider({ ...codex, command: process.execPath, args: [script, ...codex.args] }, {}, runCliAgent);
  const started = Date.now();
  assert.equal((await provider.complete(request())).content, "done");
  assert.ok(Date.now() - started < 6000, `answered at the turn's end (${Date.now() - started} ms)`);
});
