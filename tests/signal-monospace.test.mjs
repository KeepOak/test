import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { SignalAdapter } from "../dist/channels/signal-cli.js";
import { signalMonospace } from "../dist/channels/signal-format.js";

/* CHAT-114: code on Signal is shown in its own monospace ranges (signal-cli textStyle), not as literal backticks. */
function fakeSignal() {
  const written = [];
  const child = { stdout: new PassThrough(), stdin: { writable: true, write: (line) => written.push(JSON.parse(line)) }, on: () => undefined, kill: () => undefined };
  const adapter = new SignalAdapter({ id: "signal", path: "anything", account: "+15550000000", exists: async () => true, spawnProcess: () => child });
  return { adapter, written };
}

test("fences and inline code become MONOSPACE ranges with the markers taken out", () => {
  const made = signalMonospace("Run `npm test` then:\n```bash\necho hi\n```\ndone");
  assert.equal(made.text, "Run npm test then:\necho hi\n\ndone");
  assert.deepEqual(made.textStyle, ["4:8:MONOSPACE", "19:8:MONOSPACE"]);
  assert.equal(made.text.substr(4, 8), "npm test");
  assert.equal(made.text.substr(19, 8), "echo hi\n");
  // UTF-16 offsets, as signal-cli counts them.
  const emoji = signalMonospace("🌳 `a`");
  assert.deepEqual(emoji, { text: "🌳 a", textStyle: ["3:1:MONOSPACE"] });
  assert.deepEqual(signalMonospace("keep `this`", { plain: true }), { text: "keep `this`", textStyle: [] });
});

test("the Signal adapter sends the ranges with the message", async (t) => {
  const signal = fakeSignal();
  await signal.adapter.start(async () => undefined);
  t.after(() => signal.adapter.stop());
  await signal.adapter.send("+15551111111", "Try `ls -la` here");
  const sent = signal.written.find((line) => line.method === "send");
  assert.equal(sent.params.message, "Try ls -la here");
  assert.deepEqual(sent.params.textStyle, ["4:6:MONOSPACE"]);
  await signal.adapter.send("+15551111111", "no code at all");
  assert.equal("textStyle" in signal.written.filter((line) => line.method === "send").at(-1).params, false);
});
