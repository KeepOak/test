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
