/**
 * mac7/chat-allowlist: what a task started by a chat message may use.
 *
 * Every test here goes through the real router with a stand-in chat app, so what is checked is what
 * a person messaging Branch would actually get, not what a helper function returns on its own.
 * Nothing leaves this computer: the chat app, the model and every tool are stand-ins.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readPolicy, savePolicy } from "../dist/index.js";
import { chatPermissionsOf } from "../dist/channels/router.js";
import { chatSafePermissions, chatExtraPermissions, neverFromChat, neverFromChatFamilies,
  grantableToChat, chatApprovablePermissions } from "../dist/channels/chat-permissions.js";
import { isReadOnlyPermission } from "../dist/policy.js";
import { changesFor, applyChanges, resetProposals } from "../dist/settings-kit/changes.js";

/** A chat app stand-in: it only has to take a reply. */
function fakeChat(id = "chat") {
  const sent = [];
  let next = 100;
  return { sent, adapter: { id, kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push(text); return String(next++); } } };
}

/** The tools a chat sender used to be handed, as stand-ins, plus one nobody has ever heard of. */
const standIns = [
  { name: "code.run", permission: "code.execute" },
  { name: "desktop.click", permission: "desktop.control" },
  { name: "desktop.screenshot", permission: "desktop.view" },
  { name: "desktop.clipboard", permission: "desktop.clipboard" },
  { name: "process.stop", permission: "process.manage" },
  { name: "shell.execute", permission: "shell.execute" },
  { name: "demo.invented", permission: "invented.power" },
];

async function fixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-allowlist-"));
  const calls = [];
  const provider = { name: "scripted", complete: async (request) => { calls.push(request); return script(calls.length, request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // Whatever this copy does not already register (the screen and commands are behind switches) is
  // put in as a stand-in, so every permission a chat used to be handed really is in the registry.
  const already = new Set(app.registry.names());
  for (const { name, permission } of standIns) {
    if (already.has(name)) continue;
    app.registry.register({ name, permission, description: "stand-in", group: "core",
      parameters: z.object({}).strict(), execute: async () => ({ ran: name }) });
  }
  app.channels.mergeWindowMs = 0;
  // The steps line above a reply in an app without edits waits for a slow task; a busy test machine is not one.
  app.channels.liveTiming = { ...app.channels.liveTiming, progressAfterMs: 60_000 };
  const chat = fakeChat();
  await app.channels.attach(chat.adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  return { app, chat, root };
}
let nextId = 1;
const message = (text, extra = {}) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner",
  senderName: "Sam", text, addressed: true, messageId: `m${nextId++}`, ...extra });
/** A model that calls one tool for each message it is sent, and answers once the tool has had its say. */
const callsTool = (name) => (turn, request) =>
  request.messages.at(-1)?.role === "tool" ? { content: "Done.", toolCalls: [] }
    : { content: "", toolCalls: [{ id: `t${turn}`, name, arguments: "{}" }] };
/**
 * 0.18.1: under "No approvals" a chat's task is still held to "Ask before changes", so a change it
 * tries first waits for the owner. These tests are about the chat's list, not the question: the owner
 * says yes in their own window and the chat sends the message again, so the call reaches the list.
 */
async function ownerSaysYes(app, text) {
  const waiting = app.store.run(lastRun(app).id);
  assert.equal(waiting.status, "needs_input", "a chat's change did not wait for the owner under No approvals");
  app.runtime.approve(waiting.sessionId, "allow", "session");
  assert.equal(await app.channels.handle(message(text)), "replied");
}
/**
 * Q050 follow-up: a tool the chat's task was not given is refused before any question, so nothing waits for the owner
 * and there is no yes to give: the call fails at once, in the registry's own words.
 */
function refusedUnasked(app) {
  const run = app.store.run(lastRun(app).id);
  assert.notEqual(run.status, "needs_input", "a tool the chat's task was not given still waited for the owner");
  assert.equal(app.store.events(run.id).some((event) => event.kind === "policy.ask"), false, "the owner was asked about it");
  assert.equal(app.runtime.approvals.waiting(run.sessionId).length, 0);
}
/** The permissions the task the router started was given. */
const lastRun = (app) => app.store.runs(app.runtime.owner)[0];
const startedWith = (app) =>
  app.store.events(lastRun(app).id).find((event) => event.kind === "run.started").data.permissions;
/** How the last task's one tool call went: the event and its words. */
function toolOutcome(app) {
  const event = app.store.events(lastRun(app).id).find((e) => e.kind === "tool.failed" || e.kind === "tool.completed");
  return { kind: event?.kind, error: String(event?.data?.error ?? "") };
}

test("the short list a chat always has only looks at things", () => {
  assert.deepEqual([...chatSafePermissions], ["user.ask", "files.read", "memory.read", "skills.read", "web.read"]);
  for (const permission of chatSafePermissions)
    assert.equal(isReadOnlyPermission(permission), true, `${permission} is on the short list but can change something`);
});

test("a chat sender's task is never handed running code, the screen or stopping programs", async (t) => {
  const { app } = await fixture(t, callsTool("code.run"));
  assert.equal(await app.channels.handle(message("run this for me")), "replied");
  refusedUnasked(app);
  const given = startedWith(app);
  for (const refused of ["code.execute", "desktop.control", "desktop.view", "desktop.clipboard", "process.manage",
    "shell.execute", "remote.execute", "files.write", "channels.send", "invented.power"])
    assert.equal(given.includes(refused), false, `${refused} was handed to a chat sender's task`);
  const outcome = toolOutcome(app);
  assert.equal(outcome.kind, "tool.failed", "code.run ran instead of being refused");
  assert.match(outcome.error, /code\.execute|not available|Unknown tool/);
});

test("a chat sender's task can still answer, look things up and read a file", async (t) => {
  const { app, chat } = await fixture(t, callsTool("files.read"));
  assert.equal(await app.channels.handle(message("what is in README.md?")), "replied");
  for (const kept of ["user.ask", "files.read", "memory.read", "skills.read", "web.read"])
    assert.equal(startedWith(app).includes(kept), true, `${kept} was taken away from a chat sender's task`);
  assert.equal(chat.sent.at(-1), "Done.", "the reply still reaches the chat");
});

test("a permission nobody thought of is refused: the list is what is allowed, not what is taken away", async (t) => {
  const { app } = await fixture(t, callsTool("demo.invented"));
  assert.equal(await app.channels.handle(message("use the new thing")), "replied");
  refusedUnasked(app);
  assert.equal(startedWith(app).includes("invented.power"), false, "a permission added later was handed over by default");
  assert.equal(toolOutcome(app).kind, "tool.failed");
  // The pure function says the same, whatever else is registered.
  assert.deepEqual(chatPermissionsOf(["files.read", "invented.power", "devices.read", "shell.execute"]), ["files.read"]);
});

test("the owner's list allows exactly what it names, for that app and that person, and nothing more", async (t) => {
  const { app } = await fixture(t, callsTool("demo.invented"));
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "chat", sender: "owner", allow: ["invented.power"], note: "my own phone" }] });
  assert.equal(await app.channels.handle(message("use the new thing")), "replied");
  await ownerSaysYes(app, "use the new thing");
  const given = startedWith(app);
  assert.equal(given.includes("invented.power"), true, "the line the owner wrote was not honoured");
  assert.equal(toolOutcome(app).kind, "tool.completed");
  for (const refused of ["code.execute", "desktop.control", "process.manage", "files.write"])
    assert.equal(given.includes(refused), false, `naming one thing also handed over ${refused}`);
  // Somebody else on the same app, and the same person on another app, are not covered by that line.
  assert.deepEqual(chatExtraPermissions(app.channels.permissionSettings(), "chat", "stranger"), []);
  assert.deepEqual(chatExtraPermissions(app.channels.permissionSettings(), "telegram", "owner"), []);
});

test("the switch off means the lines do nothing, and no line can name what a chat may never have", async (t) => {
  const { app } = await fixture(t, callsTool("shell.execute"));
  app.channels.setPermissionSettings({ extras: false,
    rules: [{ channel: "*", sender: "*", allow: ["invented.power"], note: "not yet" }] });
  assert.deepEqual(chatExtraPermissions(app.channels.permissionSettings(), "chat", "owner"), []);
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "*", sender: "*", allow: [...neverFromChat, "devices.read"], note: "everything" }] });
  assert.deepEqual(chatExtraPermissions(app.channels.permissionSettings(), "chat", "owner"), []);
  assert.equal(await app.channels.handle(message("run a command")), "replied");
  refusedUnasked(app);
  assert.equal(startedWith(app).includes("shell.execute"), false, "a line handed a chat a command on this computer");
  assert.equal(toolOutcome(app).kind, "tool.failed");
});

test("the owner's own paired account is a chat like any other, and can still answer one approval", async (t) => {
  const { app, chat } = await fixture(t, callsTool("files.read"));
  // "owner" here is the owner's own account on the chat app: allowed to message, and still a chat.
  savePolicy(app.store, app.runtime.owner, { preset: "custom",
    rules: [{ tool: "files.read", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  const from = { senderId: "owner", senderName: "Sam" };
  assert.equal(await app.channels.handle(message("read README.md for me", from)), "replied");
  assert.deepEqual(startedWith(app).sort(), ["files.read", "memory.read", "skills.read", "user.ask", "web.read"],
    "the owner's own paired account gets the same short list as anybody else");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input", "a chat's task waits for a yes");
  assert.equal(await app.channels.handle(message("y", from)), "replied");
  assert.match(chat.sent.at(-1), /Done\./, "a bare y still answers the question the chat is waiting on");
});

test("putting the settings back turns the switch off and leaves the owner's own lines alone", async (t) => {
  const { app } = await fixture(t, callsTool("files.read"));
  const store = app.store, owner = app.runtime.owner;
  // mac7/chat-approvals: a line written without the switch reads back with it off, never on.
  const rules = [{ channel: "chat", sender: "owner", allow: ["files.write"], note: "my own phone", approvals: false }];
  app.channels.setPermissionSettings({ extras: true, rules });
  const { changes } = changesFor(store, owner, resetProposals("chat-permissions"));
  assert.deepEqual(changes.map((change) => [change.id, change.from, change.to, change.loosens]),
    [["chat-permissions.extras", true, false, false]], "only the switch is ever proposed, and turning it off is not loosening");
  applyChanges(store, owner, changes, { accept: changes.map((change) => change.id), confirmLoosening: true, why: "test" });
  const after = app.channels.permissionSettings();
  assert.equal(after.extras, false, "putting the settings back switches the extras off");
  assert.deepEqual(after.rules, rules, "a preset or a settings file never throws the owner's own lines away");
  // And a file that tried to write a line is refused outright: the lines are not a settings field.
  const { refused } = changesFor(store, owner, [{ key: "chat-permissions", field: "rules", value: [{ allow: ["shell.execute"] }] }]);
  assert.equal(refused.length, 1, "a settings file cannot write a line");
});

// ---- Integration review (mac7/chat-allowlist) ------------------------------------------------

test("a chat's task can load a skill, and the skill cannot smuggle it a tool the chat may not use", async (t) => {
  // Turn 1 reads the installed skills (skills.read); turn 2 does what such a document might tell it
  // to do next. The words are just words: the tool is still checked against the chat's own list.
  // Counted from the latest message the chat sent, so sending it again after the owner's yes replays both steps.
  const { app } = await fixture(t, (turn, request) => {
    const since = request.messages.length - 1 - request.messages.findLastIndex((m) => m.role === "user");
    return since === 0 ? { content: "", toolCalls: [{ id: `s${turn}`, name: "skills.list", arguments: "{}" }] }
      : since === 2 ? { content: "", toolCalls: [{ id: `c${turn}`, name: "code.run", arguments: "{}" }] }
        : { content: "Done.", toolCalls: [] };
  });
  assert.equal(await app.channels.handle(message("follow the skill for this")), "replied");
  refusedUnasked(app);
  assert.equal(startedWith(app).includes("skills.read"), true, "a chat's task cannot read the skills it is meant to follow");
  const events = app.store.events(lastRun(app).id).filter((e) => e.kind === "tool.completed" || e.kind === "tool.failed");
  assert.equal(events.find((e) => e.data.name === "skills.list")?.kind, "tool.completed", "reading the skills was refused");
  const ran = events.find((e) => e.data.name === "code.run");
  assert.equal(ran?.kind, "tool.failed", "a skill's instructions got the chat a tool it may not use");
  assert.match(String(ran?.data?.error ?? ""), /code\.execute|not available|Unknown tool/);
});

test("the names a line may never hold are whole families, not just the names that exist today", async (t) => {
  const { app } = await fixture(t, callsTool("files.read"));
  const invented = ["nodes.write", "personal.sync", "shell.session", "devices.act", "home.scene",
    "trunks.broadcast", "remote.shell"];
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "*", sender: "*", allow: invented, note: "every family" }] });
  assert.deepEqual(chatExtraPermissions(app.channels.permissionSettings(), "chat", "owner"), [],
    "a line named something in a family a chat may never have");
  for (const name of invented) assert.equal(grantableToChat(name), false, `${name} could be handed to a chat`);
  // And nothing a real install registers under one of those families is grantable either.
  for (const permission of app.registry.permissions())
    if (neverFromChatFamilies.some((family) => permission.startsWith(family)))
      assert.equal(grantableToChat(permission), false, `${permission} could be handed to a chat`);
});

test("the things a chat's task is not given by default, before any line of the owner's", async (t) => {
  const { app } = await fixture(t, callsTool("files.read"));
  assert.equal(await app.channels.handle(message("hello")), "replied");
  const given = startedWith(app);
  for (const absent of ["memory.write", "workflows.manage", "schedules.manage", "automations.propose",
    "skills.write", "git.remote", "github.manage", "specialists.manage", "procedures.use"])
    assert.equal(given.includes(absent), false, `${absent} is handed to a chat's task by default`);
  assert.deepEqual(given.sort(), ["files.read", "memory.read", "skills.read", "user.ask", "web.read"]);
});

test("a chat sender cannot answer their own task's question about what a line granted", async (t) => {
  const { app, chat } = await fixture(t, callsTool("demo.invented"));
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "chat", sender: "owner", allow: ["invented.power"], note: "my own phone" }] });
  savePolicy(app.store, app.runtime.owner, { preset: "custom",
    rules: [{ tool: "demo.invented", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  assert.equal(await app.channels.handle(message("use the new thing")), "replied");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input", "the granted thing did not wait for a yes");
  // The same sender says yes. It must not count: the line's promise is that a change is asked about.
  assert.equal(await app.channels.handle(message("y")), "replied");
  assert.match(chat.sent.at(-1), /Branch app window/, "a chat sender approved their own task's change");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input", "the task went ahead on the chat's own yes");
  assert.equal(app.runtime.waitingApprovals(app.store.run(lastRun(app).id).sessionId).length, 1,
    "the question was taken off the list without being answered");
  // "No" still works from the chat: refusing takes nothing away, and the task must not wait for ever.
  assert.equal(await app.channels.handle(message("n")), "replied");
  assert.match(chat.sent.at(-1), /will not do that/);
});

test("a yes from a chat still answers a question about the short list every chat has", async (t) => {
  const { app, chat } = await fixture(t, callsTool("files.read"));
  savePolicy(app.store, app.runtime.owner, { preset: "custom",
    rules: [{ tool: "files.read", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  assert.equal(await app.channels.handle(message("read README.md")), "replied");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input");
  assert.equal(await app.channels.handle(message("y")), "replied");
  assert.match(chat.sent.at(-1), /Done\./, "a yes about the short list stopped working");
});

test("a household person on this computer cannot write a line, and the owner still can", async (t) => {
  const { app } = await fixture(t, callsTool("files.read"));
  const person = app.store.profiles.create({ name: "Alex", pin: "4821" });
  app.store.profiles.switch({ profileId: person.id, pin: "4821" });
  assert.throws(() => app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "*", sender: "*", allow: ["files.write"], note: "not mine to give" }] }),
    /belongs to the owner/, "somebody else sharing this computer wrote a line");
  app.store.profiles.switch({ profileId: null });
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "*", sender: "*", allow: ["files.write"], note: "mine" }] });
  assert.deepEqual(chatExtraPermissions(app.channels.permissionSettings(), "chat", "owner"), ["files.write"]);
  // Every change is written down, so a line that appeared can be traced to when it was saved.
  assert.ok(app.store.audit.list(app.runtime.owner, { action: "policy.changed" })
    .some((entry) => entry.subject === "what a chat message's task may use"), "a rule change was not recorded");
});

// ---- mac7/chat-approvals: the per-sender switch that lets a chat answer its own question --------

/** A line of the owner's, written the way the card writes one. */
const line = (extra = {}) => ({ channel: "chat", sender: "owner", allow: ["invented.power"], note: "my own phone", ...extra });
/** What this chat and this person may say yes to, out of what their own lines granted. */
const mayApprove = (app, channel = "chat", sender = "owner") =>
  chatApprovablePermissions(app.channels.permissionSettings(), channel, sender);
/** A task that stops on the invented tool, with the owner's line already saved. */
async function stoppedOnAsk(t, rules) {
  const { app, chat } = await fixture(t, callsTool("demo.invented"));
  app.channels.setPermissionSettings({ extras: true, rules });
  savePolicy(app.store, app.runtime.owner, { preset: "custom",
    rules: [{ tool: "demo.invented", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  assert.equal(await app.channels.handle(message("use the new thing")), "replied");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input", "the granted thing did not wait for a yes");
  return { app, chat };
}

test("under the default No approvals a chat's change waits for the owner's window, and only the switch lets the chat answer", async (t) => {
  for (const approvals of [false, true]) {
    const { app, chat } = await fixture(t, callsTool("demo.invented"));
    app.channels.setPermissionSettings({ extras: true, rules: [line({ approvals })] });
    assert.equal(readPolicy(app.store, app.runtime.owner).preset, "off", "the preset under test is the default");
    assert.equal(await app.channels.handle(message("use the new thing")), "replied");
    assert.equal(app.store.run(lastRun(app).id).status, "needs_input", `approvals ${approvals}: the change did not wait`);
    assert.equal(await app.channels.handle(message("y")), "replied");
    if (approvals) assert.match(chat.sent.at(-1), /Done\./, "the switch did not let the chat's yes land");
    else {
      assert.match(chat.sent.at(-1), /Branch app window/, "the chat was not told the yes belongs in the window");
      assert.equal(app.store.run(lastRun(app).id).status, "needs_input", "a chat answered its own question");
    }
  }
});

test("a line may say yes from the chat only when the owner turned that on, and it starts off", async (t) => {
  // A line written without the switch reads back with it off, so an older saved line stays as it was.
  const { app, chat } = await stoppedOnAsk(t, [line()]);
  assert.equal(app.channels.permissionSettings().rules[0].approvals, false, "the switch is not off on a fresh line");
  assert.deepEqual(mayApprove(app), [], "a line nobody switched on lets a chat say yes");
  assert.equal(await app.channels.handle(message("y")), "replied");
  assert.match(chat.sent.at(-1), /Branch app window/, "the chat was not told where the yes belongs");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input", "the task went ahead on a yes the line did not allow");
});

test("with the switch on, that person on that app may say yes to what their own line granted", async (t) => {
  const { app, chat } = await stoppedOnAsk(t, [line({ approvals: true })]);
  assert.deepEqual(mayApprove(app), ["invented.power"]);
  assert.equal(await app.channels.handle(message("y")), "replied");
  assert.match(chat.sent.at(-1), /Done\./, "the switch did not let the yes land");
  const decided = app.store.audit.list(app.runtime.owner, { action: "approval.decided" });
  assert.equal(decided.length, 1, "the yes was not written down");
  assert.equal(decided[0].outcome, "allowed");
  assert.match(decided[0].reason, /answered on chat/, "the record does not say which chat app answered");
});

test("the switch reaches only what its own line granted, not what another line granted", async (t) => {
  const { app, chat } = await stoppedOnAsk(t, [
    line({ allow: ["files.write"], approvals: true, note: "writing, and I may say yes" }),
    line({ allow: ["invented.power"], note: "the new thing, but not my yes" }),
  ]);
  assert.deepEqual(mayApprove(app), ["files.write"], "a switched-on line lent its yes to another line's grant");
  assert.equal(await app.channels.handle(message("y")), "replied");
  assert.match(chat.sent.at(-1), /Branch app window/, "the chat approved what its own line did not grant");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input");
});

test("the switch never reaches a name a chat may never have, and never a standing yes", async (t) => {
  const { app, chat } = await stoppedOnAsk(t, [line({ allow: [...neverFromChat, "invented.power"], approvals: true })]);
  for (const never of neverFromChat) assert.equal(mayApprove(app).includes(never), false, `the switch reached ${never}`);
  assert.deepEqual(mayApprove(app), ["invented.power"], "the switch reached past what a chat may ever hold");
  // "Yes always" is a standing yes, and a chat never gets one however its line is written: a chat
  // message's task is not one the owner started, and Runtime.approve refuses a standing yes for
  // those whoever answered. The switch neither needs to add that refusal nor may get round it.
  // It is answered in a sentence rather than thrown: the throw was swallowed by the caller and the
  // letter went on to the assistant as an ordinary message (see the adversarial pass below).
  const always = await app.channels.answerApproval("chat", "c1", "a", { senderId: "owner", chatKind: "direct" });
  assert.match(always?.refusal ?? "", /standing yes cannot come from a chat/i, "a chat was given a standing yes");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input", "a standing yes from a chat went ahead");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).length, 0);
  const saved = app.store.get("settings", app.runtime.owner, "policy")?.data ?? {};
  assert.equal((saved.rules ?? []).filter((rule) => rule.remember === "always").length, 0,
    "a standing rule was written from a chat");
  // The one-off yes still works, so the refusal above is about "always" and nothing else.
  assert.equal(await app.channels.handle(message("y")), "replied");
  assert.match(chat.sent.at(-1), /Done\./);
});

test("a line's yes works one to one only, never in a group where anybody paired could press it", async (t) => {
  // In a group anybody paired may answer, so a line naming one person — or naming everybody — was
  // never the owner handing their yes to whoever else happens to be in the room. Same rule as the
  // standing yes, which is also only offered one to one.
  const { app, chat } = await stoppedOnAsk(t, [line({ approvals: true })]);
  assert.equal(await app.channels.handle(message("y", { chatKind: "group" })), "replied");
  assert.match(chat.sent.at(-1), /Branch app window/, "a group chat approved what a line granted");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input", "the task went ahead on a group's yes");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).length, 0);
  // One to one, the same person on the same line still may.
  assert.equal(await app.channels.handle(message("y")), "replied");
  assert.match(chat.sent.at(-1), /Done\./, "the line's yes stopped working one to one as well");
});

test("a person with no line of their own gets nothing from somebody else's switch", async (t) => {
  const { app } = await fixture(t, callsTool("files.read"));
  app.channels.setPermissionSettings({ extras: true, rules: [line({ approvals: true })] });
  assert.deepEqual(mayApprove(app, "chat", "stranger"), [], "somebody else on the same app inherited the switch");
  assert.deepEqual(mayApprove(app, "telegram", "owner"), [], "the same person on another app inherited the switch");
  // And the switch does nothing at all while the extras switch above it is off.
  app.channels.setPermissionSettings({ extras: false });
  assert.deepEqual(mayApprove(app), [], "a line said yes while the extras switch was off");
});

test("no preset or settings file can turn a line's yes on, and turning it on is written down", async (t) => {
  const { app } = await fixture(t, callsTool("files.read"));
  const store = app.store, owner = app.runtime.owner;
  const { refused } = changesFor(store, owner,
    [{ key: "chat-permissions", field: "approvals", value: true }, { key: "chat-permissions", field: "rules", value: [line({ approvals: true })] }]);
  assert.equal(refused.length, 2, "a settings file reached the switch that lets a chat say yes");
  app.channels.setPermissionSettings({ extras: true, rules: [line({ approvals: true })] });
  const written = store.audit.list(owner, { action: "policy.changed" })
    .filter((entry) => entry.subject === "what a chat message's task may use");
  assert.match(written[0].reason, /1 of them may answer yes from the chat/, "the record does not say a line may now say yes");
});

// ---- mac7/chat-approvals (integration review): the adversarial pass -----------------------------

test("typing a in a chat is answered in a sentence, and is never sent on to the assistant", async (t) => {
  /* The letter used to reach Runtime.approve, throw there, and be swallowed by the caller's catch,
     so the chat fell through to "this was not an answer" and the owner's phone quietly sent the
     assistant the letter "a". A standing yes cannot come from a chat: say so, and stop there. */
  const { app, chat } = await stoppedOnAsk(t, [line({ approvals: true })]);
  const runsBefore = app.store.runs(app.runtime.owner).length;
  assert.equal(await app.channels.handle(message("a")), "replied");
  assert.match(chat.sent.at(-1), /standing yes cannot come from a chat/i,
    `the chat was not told why "a" is refused: ${chat.sent.at(-1)}`);
  assert.equal(app.store.runs(app.runtime.owner).length, runsBefore, 'the letter "a" was sent on as an ordinary message');
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input", "the task went ahead on a standing yes");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).length, 0);
  const saved = app.store.get("settings", app.runtime.owner, "policy")?.data ?? {};
  assert.equal((saved.rules ?? []).filter((rule) => rule.remember === "always").length, 0,
    "a standing rule was written from a chat");
  /* And the one-off yes still lands, so the refusal is about "always" and nothing else. */
  assert.equal(await app.channels.handle(message("y")), "replied");
  assert.match(chat.sent.at(-1), /Done\./);
});

test("a chat is never offered the letter for a standing yes it cannot give", async () => {
  const { approvalFallbackNote } = await import("../dist/channels/router.js");
  assert.equal(/yes always/i.test(approvalFallbackNote), false,
    `a chat with no buttons is offered a letter that always refuses: ${approvalFallbackNote}`);
  assert.match(approvalFallbackNote, /reply y for yes/i);
  assert.match(approvalFallbackNote, /n for no/i);
});

test("a line naming everybody, or every app, never lends its yes however the box is ticked", async (t) => {
  /* The owner's words for this switch are one named person on one named app. A line written with *
     is the widest line there is — and both boxes in the card fall back to * when left empty — so a
     tick on one of those would hand the yes to everybody paired, which is not what was agreed. */
  for (const wide of [{ sender: "*" }, { channel: "*" }, { channel: "*", sender: "*" }]) {
    const { app, chat } = await stoppedOnAsk(t, [line({ ...wide, approvals: true })]);
    assert.equal(app.channels.permissionSettings().rules[0].approvals, false,
      `a line written with * kept its tick: ${JSON.stringify(wide)}`);
    assert.deepEqual(mayApprove(app), [], `a line written with * lent its yes: ${JSON.stringify(wide)}`);
    assert.equal(await app.channels.handle(message("y")), "replied");
    assert.match(chat.sent.at(-1), /Branch app window/, `a line written with * approved: ${JSON.stringify(wide)}`);
    assert.equal(app.store.run(lastRun(app).id).status, "needs_input");
  }
  /* The same line, naming the person and the app, still works: this refuses * and nothing more. */
  const { app, chat } = await stoppedOnAsk(t, [line({ approvals: true })]);
  assert.equal(await app.channels.handle(message("y")), "replied");
  assert.match(chat.sent.at(-1), /Done\./, "naming the person and the app stopped working too");
});

test("a line naming everybody still adds what it allows; only its yes is refused", async (t) => {
  /* Refusing the tick on a wide line must not quietly take away what that line was already for. */
  const { app } = await fixture(t, callsTool("files.read"));
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "*", sender: "*", allow: ["files.write"], note: "everybody", approvals: true }] });
  assert.deepEqual(chatExtraPermissions(app.channels.permissionSettings(), "chat", "owner"), ["files.write"]);
});

test("the sender must match exactly: a lookalike id gets nothing", async (t) => {
  /* A sender id is whatever the chat app reports, so a near miss must be a miss. */
  const lookalikes = ["owner ", " owner", "Owner", "OWNER", "owner​", "ownеr", "owneŕ", "owner\n"];
  const { app } = await fixture(t, callsTool("files.read"));
  app.channels.setPermissionSettings({ extras: true, rules: [line({ approvals: true })] });
  for (const sender of lookalikes) {
    if (sender === "owner") continue; // plain ASCII w: the same id, not a lookalike
    assert.deepEqual(mayApprove(app, "chat", sender), [],
      `a lookalike id was taken for the person the line names: ${JSON.stringify(sender)}`);
    assert.deepEqual(chatExtraPermissions(app.channels.permissionSettings(), "chat", sender), [],
      `a lookalike id was given what the line allows: ${JSON.stringify(sender)}`);
  }
  assert.deepEqual(mayApprove(app, "chat", "owner"), ["invented.power"], "the exact id stopped working");
});

test("a lookalike sender is refused end to end, not only by the helper", async (t) => {
  const { app } = await stoppedOnAsk(t, [line({ approvals: true })]);
  /* The first gate is pairing: an id nobody let in never reaches the question at all. */
  assert.equal(await app.channels.handle(message("y", { senderId: "Owner" })), "pairing");
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input");
  /* And behind that gate, the line still does not cover it: a chat app that reported the lookalike
     as somebody already paired would get No and the sentence, not the yes the line lends. */
  const answered = await app.channels.answerApproval("chat", "c1", "y", { senderId: "Owner", chatKind: "direct" });
  assert.equal(answered?.decision, "in-window", "a differently-cased id answered for the person named");
  assert.match(answered?.refusal ?? "", /Branch app window/);
  assert.equal(app.store.run(lastRun(app).id).status, "needs_input");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).length, 0);
});

test("a line for one chat app does nothing on another app with the same sender id", async (t) => {
  const { app } = await fixture(t, callsTool("demo.invented"));
  app.channels.setPermissionSettings({ extras: true, rules: [line({ channel: "telegram", approvals: true })] });
  savePolicy(app.store, app.runtime.owner, { preset: "custom",
    rules: [{ tool: "demo.invented", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  assert.deepEqual(mayApprove(app, "chat", "owner"), [], "a line for one app reached another");
  assert.equal(await app.channels.handle(message("use the new thing")), "replied");
  assert.equal(startedWith(app).includes("invented.power"), false, "another app's line handed this one the tool");
  // Q050 follow-up: not given, so refused before any question: there is nothing for a "y" to answer.
  refusedUnasked(app);
  assert.equal(toolOutcome(app).error, "Permission denied: invented.power");
});

test("Q187: preparing a change to Branch's own source is never handed to a chat, whatever a line says", () => {
  assert.equal(grantableToChat("git.remote"), false);
  assert.ok(neverFromChat.includes("git.remote"));
});
