/**
 * Q50: a settings request said out loud in a live conversation takes the same path as a typed one.
 * The live model is offered Branch's own settings tools (they used to sit past the 48 tools a live
 * conversation is given, so a spoken "turn on the board" could never reach settings.find), an
 * ambiguous request comes back as one question with nothing planned, and a change is put to the owner
 * with its exact before and after. Nothing here opens a microphone or reaches the internet: the
 * service is a little local WebSocket server speaking OpenAI's documented words.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { acceptKey, frame, readFrame } from "../dist/ws.js";
import { LiveConversations } from "../dist/realtime-voice.js";
import { discardTemp } from "./temp-dir.mjs";

const until = async (check, what, limit = 30000) => {
  const deadline = Date.now() + limit;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`waited ${limit}ms and never saw ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
};

/** A stand-in for the service: it records what it was sent and says whatever the test tells it. */
async function fakeService() {
  const received = [];
  let client = null;
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket) => {
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(String(request.headers["sec-websocket-key"] ?? ""))}`, "", ""].join("\r\n"));
    client = { say: (value) => socket.write(frame(JSON.stringify(value))) };
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
        pending = pending.subarray(decoded.consumed);
        if (decoded.opcode === 0x8) { socket.end(Buffer.from([0x88, 0x00])); continue; }
        if (decoded.opcode !== 0x1) continue;
        try { received.push(JSON.parse(decoded.payload.toString("utf8"))); } catch { /* not JSON */ }
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
    endpoint: `http://127.0.0.1:${server.address().port}`,
    say: (value) => client?.say(value),
    of: (type) => received.filter((message) => message.type === type),
  };
}

async function liveConversation(t) {
  const service = await fakeService();
  const root = await mkdtemp(join(tmpdir(), "branch-settings-voice-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  // The learning core ships when needed (the ship-on rule); these tests move it from off, so the owner switches it off first.
  app.learningCore.configure({ mode: "off" });
  let live = null;
  // The conversation first, then the app, then the service: a socket still open keeps the service up.
  t.after(async () => { live?.closeAll(); await app.close(); await service.close(); await discardTemp(root); });
  app.runtime.models.register({
    id: "live-openai", name: "live-openai", model: "live-model", catalogId: "openai",
    provider: { name: "openai", complete: async () => ({ content: "", toolCalls: [] }), audio: () => ({ endpoint: service.endpoint, apiKey: "sk-test" }) },
  });
  app.runtime.models.configure("local", { activePreset: "live-openai" });
  live = new LiveConversations({
    store: app.store, runtime: app.runtime, models: app.runtime.models,
    policy: new NetworkPolicy({ allowPrivateAddresses: true }), owner: "local",
  });
  const run = app.store.createRun("local", "A live conversation");
  await live.start(run.id, run.sessionId, { audio: () => undefined, notice: () => undefined });
  const setup = await until(() => service.of("session.update")[0], "the session set up");
  const call = async (id, name, args) => {
    service.say({ type: "response.function_call_arguments.done", call_id: id, name, arguments: JSON.stringify(args) });
    const answer = await until(() => service.of("conversation.item.create").find((m) => m.item.call_id === id), `an answer to ${id}`);
    return answer.item.output;
  };
  const value = async (setting) => (await app.registry.execute("settings.list", { search: setting }, app.runtime.context({ source: "owner" })))
    .shown.find((row) => row.setting === setting)?.value;
  return { app, run, setup, call, value };
}

test("a live conversation is offered the settings tools, so a spoken request can be clarified first", async (t) => {
  const { setup } = await liveConversation(t);
  const offered = setup.session.tools.map((tool) => tool.name);
  assert.ok(offered.length <= 48, "still no more than a live conversation is given");
  for (const name of ["settings.find", "settings.list", "settings.change", "settings.loosen"])
    assert.ok(offered.includes(name), `${name} is offered to a live conversation`);
});

test("a spoken ambiguous settings request comes back as one question, and nothing is asked or changed", async (t) => {
  const { app, run, call, value } = await liveConversation(t);
  const before = { kanban: await value("flowboards-kanban.mode"), board: await value("asks-project-board.mode") };
  const output = JSON.parse(await call("find1", "settings.find", { request: "turn on the board" }));
  assert.equal(output.status, "ask");
  assert.equal(output.planned, false);
  assert.equal((output.question.match(/\?/g) ?? []).length, 1, "exactly one question");
  assert.deepEqual(output.choices.map((one) => one.setting).sort(), ["asks-project-board.mode", "flowboards-kanban.mode"]);
  assert.equal(app.runtime.approvals.waiting(run.sessionId).length, 0, "no change was put to the owner");
  assert.deepEqual({ kanban: await value("flowboards-kanban.mode"), board: await value("asks-project-board.mode") }, before);
});

test("a spoken change is put to the owner with its exact before and after, and waits for the yes", async (t) => {
  const { app, run, call, value } = await liveConversation(t);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const output = await call("change1", "settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] });
  assert.match(output, /Waiting for your yes/);
  assert.match(output, /What Branch learns from experience, Switch: off → on/, "the question says what it is now and would become");
  const asked = app.runtime.approvals.waiting(run.sessionId);
  assert.equal(asked.length, 1);
  assert.match(asked[0].question, /off → on/);
  assert.equal(await value("fly-core.mode"), "off", "nothing changes before the owner says yes");
});
