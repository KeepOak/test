/* QA 2026-09-28: the owner's ~/.codex/config.toml said `model = "gpt-6-sol"`, which Codex refuses with a ChatGPT sign-in,
   so every task through Codex failed. Branch now names the model on every call (`-c model=...`), the one the Codex
   connection has in Branch, and never reads or edits the owner's Codex settings. A stand-in `codex` reads its CODEX_HOME's
   config.toml as the real one does, lets `-c model=` win, and refuses what a ChatGPT sign-in cannot use. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliAgentProvider, cliAgentCatalog, codexDefaultModel, codexModels, registerCliAgent, runCliAgent } from "../dist/providers/cli-agent.js";
import { programCall } from "../dist/coding/hand-off.js";
import { discardTemp } from "./temp-dir.mjs";

const request = () => ({ messages: [{ role: "user", content: "Say hello" }], signal: new AbortController().signal });
const CONFIG = 'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n';
/* The stand-in: the model is `-c model=` when given, else config.toml's; a model in CODEX_HOME/refused.txt, or
   gpt-6-sol, is refused with Codex's own words. */
const FAKE = `
const { readFileSync } = require("node:fs"); const { join } = require("node:path");
const home = process.env.CODEX_HOME, args = process.argv.slice(2);
const set = args.map((a, i) => args[i - 1] === "-c" && a.startsWith("model=") ? a.slice(6) : null).filter(Boolean).pop();
const fromConfig = /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(home, "config.toml"), "utf8"))?.[1];
let refused = []; try { refused = readFileSync(join(home, "refused.txt"), "utf8").split(/\s+/).filter(Boolean); } catch {}
const model = set ?? fromConfig;
process.stdin.resume(); process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  if (model === "gpt-6-sol" || refused.includes(model)) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "The '" + model + "' model is not supported when using Codex with a ChatGPT account." } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "answered by " + model } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
});`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-codex-model-"));
  t.after(() => discardTemp(root));
  const home = join(root, "codex-home"), script = join(root, "codex.cjs");
  await mkdir(home);
  await writeFile(join(home, "config.toml"), CONFIG);
  await writeFile(script, FAKE);
  const codex = cliAgentCatalog.find((row) => row.id === "codex");
  const row = { ...codex, command: process.execPath, args: [script, ...codex.args] };
  const provider = new CliAgentProvider(row, { timeoutMs: 30_000 }, runCliAgent, { name: "CODEX_HOME", path: home });
  return { home, provider };
}

test("Codex answers with Branch's model even when the owner's config.toml names one its sign-in refuses, and the config is left alone", async (t) => {
  const { home, provider } = await fixture(t);
  const registered = [];
  registerCliAgent({ register: (preset) => registered.push(preset) }, { id: "codex" });
  assert.equal(registered[0].model, codexDefaultModel, "the Codex connection carries Branch's model");
  provider.model = registered[0].model;
  const said = await provider.complete(request());
  assert.equal(said.content, `answered by ${codexDefaultModel}`);
  assert.equal(await readFile(join(home, "config.toml"), "utf8"), CONFIG, "the owner's Codex settings are never edited");
});

test("a model the owner picks in Branch is the one named on the call", async (t) => {
  const { provider } = await fixture(t);
  provider.model = "gpt-5.5";
  assert.equal((await provider.complete(request())).content, "answered by gpt-5.5");
});

test("a model Codex refuses is said plainly, with the ones it supports", async (t) => {
  const { home, provider } = await fixture(t);
  await writeFile(join(home, "refused.txt"), "gpt-5.6-luna");
  provider.model = "gpt-5.6-luna";
  await assert.rejects(provider.complete(request()), (error) => {
    assert.match(error.message, /cannot use gpt-5\.6-luna with this sign-in/);
    for (const model of codexModels) assert.ok(error.message.includes(model), model);
    assert.doesNotMatch(error.message, /sign in again|own settings/i);
    return true;
  });
});

test("a model Codex cannot use with a ChatGPT sign-in is refused before the program starts", async () => {
  let started = false;
  const provider = new CliAgentProvider(cliAgentCatalog.find((row) => row.id === "codex"), {}, async () => { started = true; return { code: 0, stdout: "", stderr: "" }; });
  provider.model = "gpt-6-sol";
  await assert.rejects(provider.complete(request()), /cannot use gpt-6-sol with a ChatGPT sign-in\. Choose one it supports: gpt-5\.6-terra/);
  assert.equal(started, false);
});

test("a hand-off to Codex names Branch's model unless the task names its own", () => {
  const args = (model) => programCall("codex", "/work", model).args;
  assert.deepEqual(args().slice(args().indexOf("--model"), args().indexOf("--model") + 2), ["--model", codexDefaultModel]);
  assert.ok(args("gpt-5.5").includes("gpt-5.5"));
  assert.ok(!programCall("claude-code", "/work").args.includes("--model"), "Claude Code keeps its own choice");
});
