import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NetworkPolicy } from "../dist/network-policy.js";
import { acceptKey, frame, readFrame } from "../dist/ws.js";
import { OpenAiRealtimeSession } from "../dist/realtime-openai.js";

// Cutting into a live OpenAI answer: cancel it, trim the answer to the sound actually heard,
// keep what the person is saying, and drop late sound from the cancelled answer.
// A local WebSocket stand-in only; no microphone, no speaker, no network.
async function fakeService(t) {
  const received = [], sockets = [];
  let client = null;
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket) => {
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(String(request.headers["sec-websocket-key"] ?? ""))}`, "", ""].join("\r\n"));
    sockets.push(socket);
    client = (value) => socket.write(frame(JSON.stringify(value)));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
        pending = pending.subarray(decoded.consumed);
        if (decoded.opcode === 0x8) { socket.end(Buffer.from([0x88, 0x00])); continue; }
        if (decoded.opcode === 0x1) received.push(JSON.parse(decoded.payload.toString("utf8")));
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { for (const socket of sockets) socket.destroy(); server.close(done); }));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, say: (value) => client?.(value),
    of: (type) => received.filter((m) => m.type === type) };
}

const until = async (check, what) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`never saw ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

test("cutting in truncates to the sound heard and ignores the cancelled answer's late sound", async (t) => {
  const service = await fakeService(t);
  const session = new OpenAiRealtimeSession(new NetworkPolicy({ allowPrivateAddresses: true }), {
    model: "live-model", voice: "verse", instructions: "", serverVoiceDetection: false, tools: [],
  }, { endpoint: service.endpoint, apiKey: "k" });
  const sound = [];
  session.onAudio = (bytes) => sound.push(bytes.length);
  await session.open();
  t.after(() => session.close());

  service.say({ type: "response.created", response: { id: "r1" } });
  // 100 ms of 24 kHz 16-bit sound is 4800 bytes.
  service.say({ type: "response.audio.delta", response_id: "r1", item_id: "i1", content_index: 0,
    delta: Buffer.alloc(4800).toString("base64") });
  await until(() => sound.length === 1, "the first sound");

  session.interrupt([{ itemId: "i1", contentIndex: 0, audioEndMs: 40 }]);
  await until(() => service.of("conversation.item.truncate").length === 1, "a truncate");
  const truncate = service.of("conversation.item.truncate")[0];
  assert.deepEqual([truncate.item_id, truncate.content_index, truncate.audio_end_ms], ["i1", 0, 40]);
  assert.equal(service.of("response.cancel").length, 1, "the answer is cancelled");
  assert.equal(service.of("input_audio_buffer.clear").length, 0, "what the person is saying is kept");

  service.say({ type: "response.audio.delta", response_id: "r1", item_id: "i1", content_index: 0,
    delta: Buffer.alloc(480).toString("base64") });
  service.say({ type: "response.created", response: { id: "r2" } });
  service.say({ type: "response.audio.delta", response_id: "r2", item_id: "i2", content_index: 0,
    delta: Buffer.alloc(960).toString("base64") });
  await until(() => sound.length === 2, "the next answer's sound");
  assert.deepEqual(sound, [4800, 960], "late sound from the cancelled answer is not played");
});
