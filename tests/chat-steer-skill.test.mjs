/**
 * CHAT-192 `/steer` and CHAT-205 `/skill`, from the one command table. A stand-in model that waits until it is let go
 * holds a task working, so a note can be passed to it; a stand-in chat app carries the chat's own `/steer`. Nothing
 * leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { lookup } from "../dist/commands/catalog.js";
import { saveCommandSettings } from "../dist/commands/settings.js";

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-steer-skill-"));
  const asked = [];
  let release = null, held = false;
  // The first request of the task to "write the report" waits until the test lets it go, so the task is working meanwhile.
  const provider = { name: "scripted", async complete(request) {
    asked.push(request);
    if (!held && JSON.stringify(request.messages).includes("write the report")) {
      held = true;
      await new Promise((resolve) => { release = resolve; });
    }
    return { content: `Echo ${asked.length}`, toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { release?.(); await app.close(); await discardTemp(root); });
  const run = (line, sessionId, surface = "window") => executeCommand(commandHost(app.runtime), { surface, line, sessionId, access: "full", ownWindow: surface === "window" });
  const waitFor = async (check) => { for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(check(), "timed out"); };
  return { app, asked, run, waitFor, let: () => release?.(), holding: () => release !== null };
}
const said = (request) => JSON.stringify(request.messages);

test("the table: /steer and /skill on the window, the phone, the terminal and chats, as the chat's own level", () => {
  for (const name of ["steer", "skill"]) {
    assert.deepEqual(lookup(name).surfaces, ["window", "phone", "terminal", "chat"]);
    assert.equal(lookup(name).level, "run");
  }
  assert.equal(lookup("steer").whileWorking, true, "it matters while a task works, so chats read it then");
});

test("/steer passes a note to the task working in this conversation, and says so when nothing is", async (t) => {
  const w = await world(t);
  const session = w.app.store.createSession(w.app.runtime.owner);
  assert.match((await w.run("/steer use the newer figures", session)).text, /Nothing is working/);
  const working = w.app.runtime.run({ prompt: "write the report", sessionId: session, source: "owner", onTextDelta: () => undefined });
  await w.waitFor(() => w.holding());
  assert.match((await w.run("/steer", session)).text, /Send \/steer and the note/);
  assert.match((await w.run("/steer use the newer figures", session)).text, /Passed on/);
  const runId = w.app.store.runs(w.app.runtime.owner).find((one) => one.sessionId === session).id;
  const [steered] = w.app.store.events(runId).filter((event) => event.kind === "run.steered");
  assert.equal(steered.data.note, "use the newer figures", "handed to the working task, as the Steer box does");
  assert.equal(steered.data.from, undefined, "from the owner's own window, so not named as somebody else");
  w.let();
  await working;
});

test("/skill pins a switched-on skill to the conversation, lists them, and /skill off unpins it", async (t) => {
  const w = await world(t);
  const owner = w.app.runtime.owner;
  const session = w.app.store.createSession(owner);
  assert.match((await w.run("/skill", session)).text, /No skills are switched on/);
  for (const [name, body] of [["report-writer", "Write reports in short numbered sections."], ["report-checker", "Check every figure twice."]])
    w.app.store.skills.install(owner, { document: `---\nname: ${name}\ndescription: ${name} helps.\n---\n${body}\n` });
  assert.match((await w.run("/skill", session)).text, /No skill is pinned here\. Send \/skill and one of: report-checker, report-writer/);
  assert.match((await w.run("/skill report", session)).text, /More than one skill starts with "report"/);
  assert.match((await w.run("/skill nothing-like-it", session)).text, /There is no switched-on skill/);
  assert.match((await w.run("/skill report-writer", session)).text, /Pinned report-writer/);
  assert.match((await w.run("/skill", session)).text, /report-writer is pinned here/);
  await w.app.runtime.run({ prompt: "go", sessionId: session, source: "owner", onTextDelta: () => undefined });
  assert.ok(w.asked.some((request) => said(request).includes("Write reports in short numbered sections.")), "its instructions go with every turn");
  assert.match((await w.run("/skill off", session)).text, /Unpinned/);
  assert.match((await w.run("/skill off", session)).text, /No skill is pinned here/);
});

test("in a chat, /steer is the chat's own note to its working task, by the same path as a message typed while it works", async (t) => {
  const w = await world(t);
  w.app.channels.mergeWindowMs = 0;
  saveCommandSettings(w.app.store, w.app.runtime.owner, { mode: "on" });
  w.app.channels.setSwitches({ commands: "on" });
  const sent = [];
  const adapter = { id: "tg", kind: "telegram", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push(text); return String(sent.length); } };
  await w.app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["ann"] });
  let n = 0;
  const say = (text) => w.app.channels.handle({ channel: "tg", chatId: "dm", chatKind: "direct", senderId: "ann", senderName: "Ann", addressed: true, messageId: `m${++n}`, text });
  const first = say("write the report");
  await w.waitFor(() => w.holding());
  await say("/steer use the newer figures");
  assert.ok(!w.asked.some((request) => said(request).includes("/steer")), "the command word itself is not passed on");
  const before = w.asked.length;
  w.let();
  await first;
  // The note is the same as one typed while it works: read by the task, or, when it came too late, answered next.
  await w.waitFor(() => w.asked.slice(before).some((request) => said(request).includes("use the newer figures")));
  const note = said(w.asked.slice(before).find((request) => said(request).includes("use the newer figures")));
  assert.ok(!note.includes("/steer use"), "only the note, not the command");
});
