/**
 * setup-tools: Setup's "Tools to start with" is read from the engine (src/setup-tools.ts). Every thing a starter Trunk
 * is said to need is one the engine really has, and the counts are the approval settings' own answers.
 * A scripted model; no provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { setupToolsView, starterNeeds, setupKinds } from "../dist/setup-tools.js";
import { personalParts } from "../dist/personal/settings.js";
import { knownClis } from "../dist/own-clis.js";
import { browserSkillNames } from "../dist/browser-skills.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { savePolicy } from "../dist/policy.js";

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-setup-tools-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("every starter Trunk's need is a chat app, connector, command-line tool or skill the engine has", async () => {
  const recipes = JSON.parse(await readFile(new URL("../data/channel-setup.json", import.meta.url), "utf8")).recipes.map((r) => r.id);
  const known = { channel: recipes, personal: personalParts, cli: knownClis, skill: browserSkillNames };
  assert.deepEqual(Object.keys(starterNeeds), ["inbox", "expense", "researcher", "chief", "bug", "trip"]);
  for (const [starter, needs] of Object.entries(starterNeeds)) {
    assert.ok(needs.length > 0, `${starter} needs something`);
    for (const need of needs) assert.ok(known[need.kind]?.includes(need.id), `${starter}: ${need.kind} ${need.id} is one the engine has`);
  }
});

test("the kinds count only built-in tools, and each is counted once", async (t) => {
  const app = await branch(t);
  const view = setupToolsView(app.registry, app.store, app.runtime.owner);
  assert.deepEqual(view.kinds.map((k) => k.id), setupKinds.map((k) => k.id));
  const names = view.kinds.flatMap((k) => k.names);
  assert.equal(new Set(names).size, names.length, "no tool is in two kinds");
  assert.ok(names.every((name) => !/^(mcp|skill|client)\./.test(name)), "no lent tool");
  for (const k of view.kinds) {
    assert.equal(k.tools, k.names.length);
    assert.ok(k.asks + k.refused <= k.tools - k.off, `${k.id}: only tools that are on are judged`);
  }
});

test("asking first follows the mode a new conversation starts on", async (t) => {
  const app = await branch(t);
  const owner = app.runtime.owner;
  // A test engine has no command settings, so it has no shell.execute; this one stands in for it, never run.
  if (!app.registry.permissionOf("shell.execute"))
    app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "Run a program.", parameters: z.object({}).strict(), execute: async () => ({}) });
  const files =() => setupToolsView(app.registry, app.store, owner).kinds.find((k) => k.id === "files");
  const terminal = () => setupToolsView(app.registry, app.store, owner).kinds.find((k) => k.id === "terminal");
  assert.equal(setupToolsView(app.registry, app.store, owner).mode, "ask");
  const ask = files();
  assert.ok(ask.asks > 0, "changing a file asks first in Ask first");
  saveConversationModeSettings(app.store, owner, { newConversation: "plan" });
  assert.ok(files().refused > 0, "Plan refuses changes");
  saveConversationModeSettings(app.store, owner, { newConversation: "full" });
  assert.equal(files().asks, 0, "No approvals asks nothing about files");
  assert.ok(terminal().asks > 0, "a command nobody decided on still asks under No approvals");
  savePolicy(app.store, owner, { unmatchedCommands: "allow" });
  assert.equal(terminal().asks, 0, "unless the owner lets undecided commands run");
});
