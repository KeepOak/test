import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

const scratch = join(tmpdir(), "Codex-session-files");
const say = content => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }] });
async function fixture(t, steps) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-adaptive-"));
  const requests = [];
  const provider = { name: "adaptive-fixture", async complete(request) {
    requests.push(request);
    return steps[Math.min(requests.length - 1, steps.length - 1)];
  } };
  const app = await createBranch({ workspace: join(root, "work"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, requests, root };
}

test("an unsupported inability claim gets a tool discovery turn and completes real work", async t => {
  const { app, requests, root } = await fixture(t, [
    say("I can't read files on your computer."),
    call("tools.search", { query: "read file" }),
    call("files.read", { path: "sample.txt" }),
    say("The file says adaptive proof."),
  ]);
  await writeFile(join(root, "work/sample.txt"), "adaptive proof");
  const run = await app.runtime.run({ prompt: "Read sample.txt for me", permissions: ["files.read"] });
  assert.equal(run.output, "The file says adaptive proof.");
  assert.equal(requests.length, 4);
  assert.equal(app.store.events(run.id).filter(e => e.kind === "model.capability_unchecked").length, 1);
  assert.ok(app.store.events(run.id).some(e => e.kind === "tool.started" && e.data.name === "files.read"));
  assert.equal(await readFile(join(root, "work/sample.txt"), "utf8"), "adaptive proof");
});

test("a repeated unevidenced refusal stops after one correction", async t => {
  const { app, requests } = await fixture(t, [say("I cannot edit files.")]);
  const run = await app.runtime.run({ prompt: "Edit sample.txt", permissions: ["files.read"] });
  assert.equal(requests.length, 2);
  assert.equal(run.status, "failed");
  assert.match(run.output, /checking.*tools/i);
});

test("a real tool result can establish that the task cannot proceed", async t => {
  const { app, requests } = await fixture(t, [call("files.read", { path: "absent.txt" }), say("I cannot read the missing file.")]);
  const run = await app.runtime.run({ prompt: "Read absent.txt", permissions: ["files.read"] });
  assert.equal(requests.length, 2);
  assert.equal(run.output, "I cannot read the missing file.");
  assert.equal(app.store.events(run.id).some(e => e.kind === "model.capability_unchecked"), false);
});

test("explanations, plans and explicit permission refusals do not trigger work", async t => {
  for (const [prompt, answer, extra] of [
    ["How would you install a tool?", "I cannot install tools here.", {}],
    ["Install this tool", "I cannot install it without your approval.", {}],
    ["Translate this sentence into English", "I cannot read files.", {}],
    ["Write a story about a robot", "I cannot read files, said the robot.", {}],
    ["Write a sentence saying you cannot read files", "I cannot read files.", {}],
    ['Write "I cannot read files."', "I cannot read files.", {}],
    ["Edit this sentence: I cannot read files.", "I cannot read files.", {}],
    ["Repeat: I cannot read files.", "I cannot read files.", {}],
    ["Read sample.txt", "I cannot read files.", { dryRun: true }],
  ]) {
    const { app, requests } = await fixture(t, [say(answer)]);
    const run = await app.runtime.run({ prompt, permissions: ["files.read"], ...extra });
    assert.equal(requests.length, 1, prompt);
    assert.equal(run.output, answer);
  }
});

test("self-configuration routes directly to available settings tools", async t => {
  const { app, requests } = await fixture(t, [say("Ready.")]);
  await app.runtime.run({ prompt: "Change your own settings", permissions: ["settings.read", "settings.write"] });
  const names = requests[0].tools.map(tool => tool.name);
  assert.ok(names.includes("settings.find"));
  assert.ok(names.includes("settings.list"));
  assert.ok(requests[0].messages.some(m => m.role === "system" && /settings.*source code/i.test(m.content)));
});

test("capability requests never widen a restricted task's tools", async t => {
  const { app, requests } = await fixture(t, [say("This task can only read files.")]);
  await app.runtime.run({ prompt: "Install a plugin, change your settings and improve yourself", permissions: ["files.read"] });
  const names = requests[0].tools.map(tool => tool.name);
  for (const name of ["settings.change", "skills.sync", "shell.execute", "code.run", "addon.draft", "branch.prepare_source_change"])
    assert.equal(names.includes(name), false, name);
  assert.equal(requests[0].messages.some(m => /For changes to Branch's source/.test(m.content)), false);
});
