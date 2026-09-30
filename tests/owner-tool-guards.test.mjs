/**
 * household-followups: every owner-only guard inside a tool judges by the person a task was started
 * for, not by whoever the app window is switched to while the task runs.
 *
 * GUARDS lists each tool whose code refuses anybody but the owner, with one tool driven per guard.
 * Each is run three ways through the registry, as a task's own call:
 *   - a household person's task, after the window was switched back to the owner → refused;
 *   - the owner's own task, while the window is switched to a household person → not refused as
 *     "the owner's" (it may still fail for its own reasons: nothing is signed in, nothing connected);
 *   - no task behind the call at all, with the window on the person → refused (the window decides).
 *
 * The last test reads src/ and fails when a file that defines or wires a tool gains an owner check
 * (`requireOwner(` or `.isOwner()`) without being decided here, in GUARDS or NOT_TOOL_GUARDS.
 */
import test from "node:test";
import { z } from "zod";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { VaultAutofill, registerVaultAutofill } from "../dist/vault-autofill.js";
import { registerRestartTool } from "../dist/dashboard-api.js";

const ownersOnly = /belongs to the owner|Only the owner's own work|only the owner/i;

/** Each guard, where it lives, the tool that meets it, and what switches that tool on. */
/** Remote Git on, so the self-development tools are offered (src/self-development.ts). */
const remoteGitOn = (app) => {
  if (!app.registry.names().includes("git.push"))
    app.registry.register({ name: "git.push", permission: "git.remote", description: "test double", parameters: z.object({}).passthrough(), execute: async () => ({}) });
};
/** An unrelated repository: past the owner check it is refused at once, before any Git runs. */
const notBranch = { name: "guard-probe", repository: "https://github.com/alice/unrelated.git", base: "redesign/window",
  contract: { allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["npm test"], definitionOfDone: "done",
    sideEffects: [], rollbackPlan: "revert" } };
const GUARDS = [
  // Q187: preparing or widening a change to Branch's own source is the owner's own work.
  { file: "src/self-development.ts", tool: "branch.prepare_source_change", args: notBranch, setup: remoteGitOn },
  // selfdev: Branch restarting its own engine is the owner's own work; here nothing could start it again, so it never stops.
  { file: "src/dashboard-api.ts", tool: "branch.restart_engine", args: { why: "probe" },
    setup: (app) => registerRestartTool(app, "unused", { platform: "linux", env: {}, pid: 1, running: async () => null }) },
  { file: "src/self-development.ts", tool: "branch.widen_source_contract", args: { name: "guard-probe", reason: "probe", changes: { allowedPaths: ["docs/**"] } }, setup: remoteGitOn },
  // All six settings tools enter ownerHere before reading or planning a change.
  { file: "src/settings-kit/tools.ts", tool: "settings.find", args: { request: "turn on the learning" } },
  { file: "src/settings-kit/tools.ts", tool: "settings.list", args: {} },
  { file: "src/settings-kit/tools.ts", tool: "settings.change", args: { changes: [{ setting: "fly-core.mode", value: "off" }] } },
  { file: "src/settings-kit/tools.ts", tool: "settings.loosen", args: { changes: [{ setting: "fly-core.mode", value: "on" }] } },
  { file: "src/settings-kit/tools.ts", tool: "settings.why", args: { setting: "fly-core.mode" } },
  { file: "src/settings-kit/tools.ts", tool: "settings.undo", args: { record: "no-such-change" } },
  { file: "src/channels/connectors.ts", tool: "channels.broadcast", args: { text: "hello" } },
  // CHAT-023: listing, editing or deleting Branch's own sent chat messages is the owner's.
  { file: "src/channels/message-actions.ts", tool: "channels.own_messages", args: { channel: "telegram", chatId: "1" } },
  { file: "src/channels/message-actions.ts", tool: "channels.delete_message", args: { channel: "telegram", chatId: "1", messageId: "5" } },
  // router.ts checks the owner again (requireMessageActionOwner) before it touches the message.
  { file: "src/channels/router.ts", tool: "channels.edit_message", args: { channel: "telegram", chatId: "1", messageId: "5", text: "fixed" } },
  { file: "src/channels/connectors.ts", tool: "channels.digest", args: { channel: "telegram", chatId: "1" } },
  // Choosing the chat the morning brief goes to is choosing where the owner's messages go.
  { file: "src/brief.ts", tool: "brief.configure", args: { deliverTo: { channel: "telegram", chatId: "1" } } },
  { file: "src/brief.ts", tool: "brief.send", args: {},
    setup: (app) => app.store.save("settings", app.runtime.owner, "brief", { deliverTo: { channel: "telegram", chatId: "1" } }) },
  // A schedule that sends its result to a chat is sending to the owner's chats, only later.
  { file: "src/scheduler.ts", tool: "schedules.create",
    args: { prompt: "hello", kind: "task", dueAt: "2099-01-01T00:00:00.000Z", deliverTo: { channel: "telegram", chatId: "1" } } },
  { file: "src/workflows.ts", tool: "workflows.list", args: {} },
  { file: "src/asks/owner-only.ts", tool: "forecast.add", args: { question: "Will it rain on Friday?", probability: 0.4 },
    setup: (app) => app.asks.setMode("forecasts", { mode: "on" }) },
  { file: "src/personal/guard.ts", tool: "gcal.events", args: {}, setup: (app) => app.personal.setMode("google", { mode: "on" }) },
  { file: "src/personal/chat-files.ts", tool: "chat.send_file", args: { channel: "telegram", chatId: "1", path: "a.txt" },
    setup: (app) => app.personal.setMode("chat-files", { mode: "on" }) },
  { file: "src/flows-boards/tools.ts", tool: "board.cards", args: {}, setup: (app) => app.flowsBoards.setMode("kanban", { mode: "on" }) },
  { file: "src/reach/tools.ts", tool: "machines.list", args: {}, setup: (app) => app.reachParts.setMode("machines", { mode: "on" }) },
  { file: "src/wiki.ts", tool: "wiki.read", args: { title: "Roof" } },
  { file: "src/wiki.ts", tool: "wiki.search", args: { query: "roof" } },
  { file: "src/wiki.ts", tool: "wiki.history", args: { title: "Roof" } },
  { file: "src/wiki.ts", tool: "wiki.write", args: { title: "Roof", body: "Fixed on Tuesday." } },
  { file: "src/vault-autofill.ts", tool: "signin.fill", args: { login: "bank" }, setup: (app) => registerVaultAutofill(app.registry,
    new VaultAutofill({ store: app.store, owner: app.runtime.owner, page: { async fill() { return { filled: false }; } },
      read: async () => { throw new Error("nothing saved"); }, requireOwner: (what) => app.store.profiles.requireOwner(what) })) },
  // A watch that sends its news to a chat is sending to the owner's chats, each time it sees a change. The page is a
  // stand-in, so nothing is fetched.
  { file: "src/monitors.ts", tool: "monitor.create",
    args: { url: "https://example.test/p", every: 5, notifyVia: { channel: "telegram", chatId: "1" } },
    setup: (app) => { app.monitors.web.fetchPage = async () => ({ text: "" }); } },
  { file: "src/screen-watch.ts", tool: "monitors.screen.create",
    args: { label: "a light", region: { x: 0, y: 0, width: 8, height: 8 }, notifyVia: { channel: "telegram", chatId: "1" } } },
  { file: "src/coding/hand-off.ts", tool: "code.hand_off", args: { program: "codex", folder: "site", task: "tidy the README" } },
  // The owner's own Downloads, Desktop and Documents: the owner's task is asked (nothing is read before a yes), anybody
  // else's is refused.
  { file: "src/owner-folders.ts", tool: "files.list", args: { path: "~/Downloads" } },
  { file: "src/owner-folders.ts", tool: "files.move", args: { from: "~/Downloads/a.pdf", to: "~/Downloads/Documents/a.pdf" } },
];
/** Files with an owner check that is not a tool's guard, and why. */
const NOT_TOOL_GUARDS = {
  "src/session-tree.ts": "its requireOwner is about owning a conversation, not the profile switch",
  "src/sessions.ts": "its requireOwner is about owning a conversation, not the profile switch",
  "src/runtime.ts": "startedFor decides whom a new task is for; it records the person, it guards nothing",
  "src/web-pages.ts": "the owner check guards the HTTP switch, not the tool",
  "src/browser-control-api.ts": "its isOwner check refuses the owner's browser controls (/api/panels/browser) to anybody else; it defines no tool, and every page action goes through that tool's own hand-pressed gate",
  "src/sdk-kit.ts": "the owner check guards the HTTP switch, not a tool",
  "src/index.ts": "hands store.profiles.requireOwner to the guards listed above",
  "src/integrations/bootstrap.ts": "hands store.profiles.requireOwner to signin.fill (listed above)",
  "src/self-development-merge.ts": "its requireOwner (ownerHere) guards the owner's review-and-merge routes in Inbox; the branch.finish_source_change tool is gated by autoOwner instead: runtime.ownerFullAccessFor(context, true), which refuses any task that is not the owner's own direct Full Access task with the owner's profile active, and no person, household caller, paired door or short-lived key",
  "src/self-development-requests.ts": "its requireOwner (ownerHere) guards the owner's chat-request routes in Inbox, and installed() is a read-only proof that only refuses, never grants, when the window is on someone else; the tool path, fileOwnerTask (seasons.request_setting), is gated by ownerOnly(context), which judges by the task's recorded origin (runOrigin: person, key, lent door) and refuses Trunks and short-lived keys",
  "src/coding/project-tests.ts": "the isOwner check refuses `--allow-tests` when a run starts; during the task allowedForThisRun judges by the task's own recorded origin (runOrigin, taskPerson), not the window",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-tool-guards-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  for (const guard of GUARDS) await guard.setup?.(app);
  /** A task as the runtime writes one down: who it was started for is on its run.started. */
  const task = (person) => {
    const run = app.store.createRun(app.runtime.owner, "a task");
    app.store.event(run.id, "run.started", { source: "owner", parentRunId: null, ...(person ? { personProfileId: person } : {}) });
    return run.id;
  };
  const call = (tool, args, runId) => app.registry.execute(tool, args,
    app.runtime.context({ runId, permissions: app.registry.permissions() })).then(() => null, (error) => error.message);
  return { app, sam, task, call };
}

test("every owner-only tool guard refuses a person's task after the window is switched back to the owner", async (t) => {
  const { app, sam, task, call } = await fixture(t);
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const runId = task(sam.id);
  app.store.profiles.switch({ profileId: null });
  const through = [];
  for (const { tool, args } of GUARDS) {
    assert.ok(app.registry.inventory().some((entry) => entry.name === tool), `${tool} is not registered`);
    const refused = await call(tool, args, runId);
    if (!ownersOnly.test(refused ?? "")) through.push(`${tool}: ${refused ?? "ran"}`);
  }
  assert.deepEqual(through, [], "a household person's task got past an owner-only guard");
});

test("the owner's own task passes every owner-only tool guard while the window is on a person", async (t) => {
  const { app, sam, task, call } = await fixture(t);
  const runId = task(null);
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const refused = [];
  for (const { tool, args } of GUARDS) {
    const answer = await call(tool, args, runId);
    if (ownersOnly.test(answer ?? "")) refused.push(`${tool}: ${answer}`);
  }
  assert.deepEqual(refused, [], "the owner's task was refused as somebody else's");
});

test("with no task behind the call, the guards still judge by the window", async (t) => {
  const { app, sam, call } = await fixture(t);
  const bare = app.store.createRun(app.runtime.owner, "not a task").id; // no run.started
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const through = [];
  for (const { tool, args } of GUARDS) {
    const refused = await call(tool, args, bare);
    if (!ownersOnly.test(refused ?? "")) through.push(`${tool}: ${refused ?? "ran"}`);
  }
  assert.deepEqual(through, []);
});

async function sources(folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("every file that defines or wires a tool and checks for the owner is decided in this table", async () => {
  const root = join(import.meta.dirname, "..");
  const decided = new Set([...GUARDS.map((guard) => guard.file), ...Object.keys(NOT_TOOL_GUARDS)]);
  const undecided = [];
  for (const path of await sources(join(root, "src"))) {
    const text = await readFile(path, "utf8");
    const file = relative(root, path).split("\\").join("/");
    if (file === "src/profiles.ts") continue;
    const checks = /requireOwner\(|\.isOwner\(\)/.test(text);
    const tools = /execute: async|ToolContext|registry\.register|\.register\(\{/.test(text);
    if (checks && tools && !decided.has(file)) undecided.push(file);
  }
  assert.deepEqual(undecided, [], "a tool's owner check is not in tests/owner-tool-guards.test.mjs");
});
