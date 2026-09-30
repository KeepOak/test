/**
 * owner-dm-signin: a test can never start this computer's real Claude Code or Codex (they answer through the owner's own
 * sign-in). Branch's own spawns refuse under the test runner unless the program is a stand-in in the temporary folder,
 * is not installed at all, or a person opted in with BRANCH_REAL_AGENT_TESTS=1. Here "the real program" is an empty
 * file outside a temporary folder the test points the system at; nothing is ever started.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { realAgentRefusal, realAgentTestRefusal } from "../dist/providers/real-agent-guard.js";
import { rowFor, runCliAgent } from "../dist/providers/cli-agent.js";
import { NativeProcess } from "../dist/providers/claude-subscription-process.js";
import { startCodexAppServer } from "../dist/asks/codex-app-server.js";

/** A folder holding "installed" claude and codex, and the system's temporary folder moved elsewhere, so they are not stand-ins. */
async function installed(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-real-agent-guard-"));
  const bin = join(root, "bin"), elsewhere = join(root, "temp");
  await mkdir(bin);
  await mkdir(elsewhere);
  for (const name of ["claude", "claude.cmd", "codex", "codex.cmd"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const saved = { PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, opt: process.env.BRANCH_REAL_AGENT_TESTS };
  process.env.PATH = bin + delimiter + (saved.PATH ?? "");
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = elsewhere;
  delete process.env.BRANCH_REAL_AGENT_TESTS;
  t.after(async () => {
    for (const [key, value] of Object.entries({ PATH: saved.PATH, TEMP: saved.TEMP, TMP: saved.TMP, TMPDIR: saved.TMPDIR, BRANCH_REAL_AGENT_TESTS: saved.opt }))
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await discardTemp(root);
  });
  return { bin };
}

test("the rule: only claude and codex, only when installed outside the temporary folder, only under the test runner", async (t) => {
  const { bin } = await installed(t);
  assert.ok(process.env.NODE_TEST_CONTEXT, "the test runner sets it");
  assert.equal(realAgentRefusal("claude"), realAgentTestRefusal);
  assert.equal(realAgentRefusal("codex"), realAgentTestRefusal);
  assert.equal(realAgentRefusal(join(bin, "claude")), realAgentTestRefusal, "named by its full path too");
  assert.equal(realAgentRefusal("gemini"), null, "other programs are not this guard's");
  assert.equal(realAgentRefusal("claude", { PATH: join(bin, "nothing-here") }), null, "not installed: the missing answer stays testable");
  process.env.BRANCH_REAL_AGENT_TESTS = "1";
  assert.equal(realAgentRefusal("claude"), null, "a person may opt in on this computer");
});

test("an unswapped spawn fails loudly and starts nothing", async (t) => {
  await installed(t);
  const signal = new AbortController().signal;
  await assert.rejects(runCliAgent(rowFor({ id: "claude-code" }), "hello", signal, { timeoutMs: 5000, maxOutputChars: 1000 }),
    { message: realAgentTestRefusal });
  assert.throws(() => new NativeProcess({ command: "claude", args: [], env: process.env, cwd: process.cwd() }), { message: realAgentTestRefusal });
  assert.throws(() => startCodexAppServer("codex", process.env), { message: realAgentTestRefusal });
  // A test's own stand-in spawn is never asked about.
  let started = 0;
  const standIn = () => { started++; throw new Error("stand-in reached"); };
  assert.throws(() => new NativeProcess({ command: "claude", args: [], env: process.env, cwd: process.cwd() }, standIn), /stand-in reached/);
  assert.equal(started, 1);
});
