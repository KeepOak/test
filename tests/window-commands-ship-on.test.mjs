/**
 * Batch A: the shared slash commands ship on in this computer's own window, as they do in the terminal
 * (src/commands/settings.ts `windowShipsAs`). Only there: the phone, the chat apps, a window reached through a door and
 * a short-lived key keep the shipped off, and a saved switch wins everywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { commandMode, commandSettings, saveCommandSettings } from "../dist/commands/settings.js";
import { parseChatCommand } from "../dist/channels/chat-commands.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-window-commands-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, { key = server.token, body, headers = {} } = {}) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const runKey = app.sessionTokens.create(app.runtime.owner, { name: "phone", scope: "run" }).token;
  return { app, call, runKey, owner: app.runtime.owner };
}
const names = (answer) => (answer.body.commands ?? []).map((c) => c.name);

test("this computer's window lists and runs the shared commands, never saved", async (t) => {
  const f = await fixture(t);
  const list = await f.call("/api/commands?surface=window");
  assert.equal(list.status, 200);
  assert.equal(list.body.mode, "on");
  for (const name of ["bg", "usage", "new", "goal", "help"]) assert.ok(names(list).includes(name), `/${name} is listed`);
  assert.ok(list.body.commands.find((c) => c.name === "bg").listed, "/bg is shown in the list, not only when typed");
  const usage = await f.call("/api/commands/run", { body: { surface: "window", line: "/usage" } });
  assert.equal(usage.status, 200);
  assert.equal(usage.body.handled, true, "/usage is a command in the window");
  assert.equal(commandSettings(f.app.store, f.owner).mode, "off", "nothing was saved: the switch itself still ships off");
});

test("the phone, a short-lived key and a window through a door keep the shipped off", async (t) => {
  const f = await fixture(t);
  const phone = await f.call("/api/commands?surface=phone");
  assert.equal(phone.body.mode, "off");
  assert.ok(!names(phone).includes("bg"), "the phone lists no /bg");
  assert.deepEqual((await f.call("/api/commands/run", { body: { surface: "phone", line: "/usage" } })).body, { handled: false });

  const short = await f.call("/api/commands?surface=window", { key: f.runKey });
  assert.equal(short.body.mode, "off", "a short-lived key naming the window is not this computer's window");
  assert.ok(!names(short).includes("bg"));
  assert.deepEqual((await f.call("/api/commands/run", { key: f.runKey, body: { surface: "window", line: "/usage" } })).body, { handled: false });

  // The window's own key arriving from beyond this computer (the webhook door) is through a door.
  const door = { "x-branch-tunnel": "1" };
  const far = await f.call("/api/commands?surface=window", { headers: door });
  if (far.status === 200) {
    assert.equal(far.body.mode, "off", "a window through a door keeps the shipped off");
    assert.ok(!names(far).includes("bg"));
  } else assert.ok(far.status >= 400, "or the door refuses it outright");
  const farRun = await f.call("/api/commands/run", { headers: door, body: { surface: "window", line: "/usage" } });
  if (farRun.status === 200) assert.deepEqual(farRun.body, { handled: false });
  else assert.ok(farRun.status >= 400);
});

test("the chat apps and the phone read the switch off; the terminal and this window read it on", async (t) => {
  const f = await fixture(t);
  const { store } = f.app;
  assert.equal(commandMode(store, f.owner), "off", "the chat apps ask with no surface");
  assert.equal(commandMode(store, f.owner, "chat"), "off");
  assert.equal(commandMode(store, f.owner, "phone"), "off");
  assert.equal(commandMode(store, f.owner, "window"), "off", "a window nobody said is this computer's own");
  assert.equal(commandMode(store, f.owner, "window", true), "on");
  assert.equal(commandMode(store, f.owner, "terminal"), "on");
  assert.equal(parseChatCommand("/tokens", commandMode(store, f.owner)), null, "a chat still reads /tokens as a message");
});

test("a saved switch wins in this window too", async (t) => {
  const f = await fixture(t);
  saveCommandSettings(f.app.store, f.owner, { mode: "off" });
  const list = await f.call("/api/commands?surface=window");
  assert.equal(list.body.mode, "off");
  assert.ok(!names(list).includes("bg"), "saved off: the window keeps only the commands it had");
  assert.deepEqual((await f.call("/api/commands/run", { body: { surface: "window", line: "/usage" } })).body, { handled: false });
  saveCommandSettings(f.app.store, f.owner, { mode: "when-needed" });
  const needed = await f.call("/api/commands?surface=window");
  assert.equal(needed.body.mode, "when-needed");
  assert.equal(needed.body.commands.find((c) => c.name === "bg")?.listed, false, "when needed: works, not listed");
});

test("a loosening typed in this window still needs its separate yes, as POST /api/policy does", async (t) => {
  const { readPolicy, savePolicy } = await import("../dist/policy.js");
  const f = await fixture(t);
  savePolicy(f.app.store, f.owner, { preset: "careful" }); // so that "off" loosens it
  const before = readPolicy(f.app.store, f.owner).preset;
  assert.equal(before, "careful");
  const loose = await f.call("/api/commands/run", { body: { surface: "window", line: "/preset off" } });
  assert.equal(loose.body.handled, true);
  assert.match(loose.body.text, /confirm/, "it says what would loosen and how to say yes");
  assert.equal(readPolicy(f.app.store, f.owner).preset, before, "nothing changed without the yes");
});

/* A paired phone's own key is the full key on this computer's listener (server.ts ownerKeyFor); only the door mark
   keeps it off the window's shipped-on commands. Paired as tests/phone-key-rotate.test.mjs pairs one. */
test("a paired phone's own key naming the window, on this computer's listener, keeps the shipped off", async (t) => {
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { phoneSessionText } = await import("../dist/devices/book.js");
  const f = await fixture(t);
  const post = (path, body, key) => f.call(path, { key, body });
  assert.equal((await post("/api/devices/mode", { mode: "when-needed" })).status, 200);
  const invite = (await post("/api/devices/invite", { phone: true })).body;
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const { requestId } = (await f.call("/api/devices/pair", { key: "", body: { offer: invite.id, code: invite.code, name: "Phone", platform: "android", publicKey, offers: [] } })).body;
  assert.equal((await post(`/api/devices/requests/${requestId}`, { approve: true, codeMatches: true })).status, 200);
  const signature = sign(null, Buffer.from(phoneSessionText(requestId)), pair.privateKey).toString("base64");
  const session = (await f.call("/api/devices/pair/session", { key: "", body: { requestId, signature } })).body;
  assert.ok(session.token && session.deviceKey, JSON.stringify(Object.keys(session)));
  const headers = { "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey };
  const list = await f.call("/api/commands?surface=window", { key: session.token, headers });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.mode, "off", "the phone's key is through a door, whatever surface it names");
  assert.ok(!names(list).includes("bg"));
  const usage = await f.call("/api/commands/run", { key: session.token, headers, body: { surface: "window", line: "/usage" } });
  assert.deepEqual(usage.body, { handled: false });
});

/* Settings › General's "The shared commands" is the settings kit's command-catalog card: it shows this window's real
   state, and changing it or putting it back touches this window alone, never the phone's or the chat apps'. */
test("Settings › General's switch shows and saves this window's commands, and never the phone's or the chat apps'", async (t) => {
  const f = await fixture(t);
  const card = async () => (await f.call("/api/settings-kit")).body.settings.find((s) => s.key === "command-catalog");
  const field = async () => (await card()).fields.find((x) => x.field === "mode");
  assert.deepEqual([(await field()).value, (await field()).initial], ["on", "on"], "never saved: on, as this window does");
  const apply = (plan) => f.call("/api/settings-kit/apply", { body: { plan, accept: ["command-catalog.mode"], confirmLoosening: true } });
  assert.equal((await apply({ source: "set", key: "command-catalog", field: "mode", value: "off" })).status, 200);
  assert.equal((await field()).value, "off");
  assert.equal((await f.call("/api/commands?surface=window")).body.mode, "off", "switched off here, this window keeps only its own");
  assert.equal(commandMode(f.app.store, f.owner, "terminal"), "on", "the terminal keeps how it ships");
  assert.equal((await apply({ source: "set", key: "command-catalog", field: "mode", value: "on" })).status, 200);
  assert.equal((await f.call("/api/commands?surface=window")).body.mode, "on");
  for (const [surface, mode] of [["phone", commandMode(f.app.store, f.owner, "phone")], ["chat", commandMode(f.app.store, f.owner)]])
    assert.equal(mode, "off", `${surface}: switching it on here never turns it on there`);
  assert.equal((await f.call("/api/commands?surface=phone")).body.mode, "off");
  assert.equal(parseChatCommand("/tokens", commandMode(f.app.store, f.owner)), null);
  const reset = await f.call("/api/settings-kit/apply", { body: { plan: { source: "reset", key: "command-catalog" }, accept: ["command-catalog.mode"], confirmLoosening: true } });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal((await field()).value, "on", "put back: this window's commands are on, as it ships");
  assert.equal(commandMode(f.app.store, f.owner, "phone"), "off", "and the phone's stay off");
  assert.equal(commandMode(f.app.store, f.owner), "off", "and the chat apps' stay off");
});
