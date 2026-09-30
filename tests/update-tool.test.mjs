/**
 * The owner asking Branch about its own updates, or asking it to update itself: the `branch.update` tool and `/update`
 * in the owner's own paired chat (src/comfort/update-tool.ts, src/comfort/update-now.ts, src/channels/router.ts). An
 * install asked for is taken by the app's own update loop on its next look: the plan says install, even with updating
 * by itself off. Stand-in chat app, model and GitHub; nothing leaves this computer and nothing is installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveComfort } from "../dist/comfort/settings.js";
import { updatePlan } from "../dist/comfort/auto-update.js";
import { installRequested } from "../dist/comfort/update-now.js";
import { setLockdown } from "../dist/lockdown.js";

const RUNNING = "a".repeat(40), PASSING = "b".repeat(40);
async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-tool-"));
  const provider = { name: "scripted", async complete(request) { return { content: `Echo: ${request.messages.at(-1).content}`, toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.updateFacts = { version: "0.19.4", commit: () => RUNNING, newestPassing: async () => PASSING };
  const owner = app.runtime.owner;
  saveComfort(app.store, owner, "notify", { releaseChannel: "beta", autoUpdate: "off" });
  return { app, owner };
}

test("branch.update says which version runs and the newest that passed; branch.install_update asks the loop, even with updating by itself off", async (t) => {
  const { app, owner } = await world(t);
  const tool = app.registry.registered("branch.update"), install = app.registry.registered("branch.install_update");
  assert.ok(tool && install, "the tools are there");
  // Installing is a change, so the approval policy asks about it in Ask first and a read-only task never has it.
  assert.equal(app.registry.permissionOf("branch.update"), "settings.read");
  assert.equal(app.registry.permissionOf("branch.install_update"), "settings.write");
  const context = { owner, runId: undefined, source: "owner", signal: new AbortController().signal };
  // The engine's own facts: this copy's version, and GitHub asked for the newest passing change (stand-in).
  const status = await tool.execute({}, context);
  assert.match(status.words, /Branch 0\.19\.4 is running/);
  assert.match(status.words, /Updating by itself is off\./);
  assert.equal(updatePlan(app.store, owner, { busyTasks: 0, updaterPhase: "available" }).step, "nothing", "off: nothing installs by itself");
  const asked = await install.execute({}, context);
  assert.equal(asked.asked, true);
  assert.equal(installRequested(app.store, owner), true);
  assert.equal(updatePlan(app.store, owner, { busyTasks: 0, updaterPhase: "available", installRequested: true }).step, "install",
    "asked for, it installs at the next safe moment");
  assert.equal(updatePlan(app.store, owner, { busyTasks: 1, workingTasks: 1, updaterPhase: "available", installRequested: true }).step, "nothing",
    "and still waits for work, as any update does");
  // A chat's task cannot ask for an install; the owner's own chat has /update for that.
  const run = app.store.createRun(owner, "from a chat");
  app.store.event(run.id, "run.started", { source: "channel" });
  await assert.rejects(install.execute({}, { ...context, runId: run.id, source: "channel" }), /owner|chat/i);
});

test("/update in the owner's own paired chat answers with an Install now button; anyone else, or under Lockdown, is refused", async (t) => {
  const { app, owner } = await world(t);
  app.channels.mergeWindowMs = 0;
  const sent = [], buttons = [];
  const adapter = { id: "tg", kind: "telegram", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); },
    async sendButtons(chatId, text, list) { buttons.push({ chatId, text, list }); return "b1"; } };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: [] });
  for (const sender of ["owner", "friend"])
    app.store.save("settings", owner, `channel-pair:tg:${sender}`, { status: "approved", code: "123456", name: sender, requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  app.channels.setOwnerCommandSettings({ on: false, accounts: [{ channel: "tg", sender: "owner" }] });
  let serial = 0;
  const say = (text, extra = {}) => app.channels.handle({ channel: "tg", chatId: "dm", chatKind: "direct", senderId: "owner",
    senderName: "Owner", addressed: true, messageId: `m${++serial}`, text, ...extra });
  await say("/update");
  assert.equal(buttons.length, 1, "the status goes with a button");
  assert.match(buttons[0].text, /Branch 0\.19\.4 is running/);
  assert.deepEqual(buttons[0].list, [{ label: "Install now", value: "/update install" }]);
  // The button's press comes back as its value.
  await say("/update install");
  assert.match(sent.at(-1).text, /^Asked: Branch installs the newest version at the next safe moment/);
  assert.equal(installRequested(app.store, owner), true);
  // A paired friend is not the owner.
  await say("/update", { senderId: "friend", chatId: "dm-friend" });
  assert.equal(buttons.length, 1);
  // Under Lockdown, not even the owner's own chat.
  setLockdown(app.store, owner, { on: true });
  await say("/update");
  assert.equal(buttons.length, 1, "no status and no button under Lockdown");
});
