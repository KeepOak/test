// Reading a reply aloud sentence by sentence: the text is prepared for speech, split into
// sentences, and a streamed reply is only finished aloud when it matches the final answer.
// No sound is made; the store is a stand-in that records events.
import test from "node:test";
import assert from "node:assert/strict";
import { prepareSpokenText, spokenSentences } from "../dist/voice-spoken-text.js";
import { SpokenReplyStream } from "../dist/voice-reply-stream.js";

test("a reply is prepared for speech and split into whole sentences", () => {
  assert.equal(prepareSpokenText("## Result\n**It is 41 m** away, see [the map](https://example.com/x)."),
    "Result, It is 41 metres away, see the map.");
  assert.deepEqual(spokenSentences("Dr. Smith said it would rain today. Bring a coat, and an umbrella too.\n```js\nx()\n```"),
    ["Dr. Smith said it would rain today.", "Bring a coat, and an umbrella too."]);
});

function fakeStore(run) {
  const events = [], listeners = [];
  return {
    events,
    onEvent: (listener) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); },
    run: () => run,
    event: (_id, kind, data) => events.push({ kind, ...data }),
  };
}

test("a streamed reply is read as it arrives, and its tail only when it matches the final answer", () => {
  const run = { id: "r1", sessionId: "s1", status: "running", output: "" };
  const store = fakeStore(run);
  const stream = new SpokenReplyStream(store, "req-1", (text) => text, () => true);
  stream.start(run);
  stream.feed("The first sentence is long enough. The second");
  assert.deepEqual(store.events.filter((e) => e.kind === "voice.reply.sentence").map((e) => e.text),
    ["The first sentence is long enough."]);
  stream.finish({ ...run, status: "completed", output: "The first sentence is long enough. The second one differs." });
  const ended = store.events.find((e) => e.kind === "voice.reply.ended");
  assert.equal(ended.complete, false, "a final answer that differs is not finished aloud from the stream");
  assert.equal(store.events.filter((e) => e.kind === "voice.reply.sentence").length, 1);

  const again = fakeStore(run);
  const matching = new SpokenReplyStream(again, "req-2", (text) => text, () => true);
  matching.start(run);
  matching.feed("The first sentence is long enough. The last bit");
  matching.finish({ ...run, status: "completed", output: "The first sentence is long enough. The last bit" });
  assert.deepEqual(again.events.filter((e) => e.kind === "voice.reply.sentence").map((e) => e.text),
    ["The first sentence is long enough.", "The last bit."]);
  assert.equal(again.events.find((e) => e.kind === "voice.reply.ended").complete, true);
});
