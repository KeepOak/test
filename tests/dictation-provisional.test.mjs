// Live dictation: a streaming program rewrites its current window until the line is final.
// Provisional windows replace each other; only finished lines are kept.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveVoiceSettings } from "../dist/voice.js";
import { saveDictationSettings } from "../dist/voice-dictation.js";
import { startDictation } from "../dist/voice-dictation-run.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-dictation-provisional-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveVoiceSettings(app.store, "local", { localSpeechModel: "/opt/models/base.en.bin" });
  saveDictationSettings(app.store, "local", { mode: "on", silenceSeconds: 5 });
  return app.store;
}

test("provisional windows replace each other and only final lines are kept", async (t) => {
  const store = await fixture(t);
  let say = () => {};
  const seen = [];
  const live = startDictation({
    store, owner: "local", platform: "darwin", present: (name) => name === "whisper-stream",
    speech: (command, onWords, onEnded) => {
      say = onWords;
      return { hear: () => true, stop: () => onEnded(null) };
    },
    sound: () => ({ stop() {} }), onHeard: (heard) => seen.push(heard.words), tickMs: 10,
  });
  t.after(() => live.stop());
  assert.equal(live.start(), null);
  say("hel", false);
  say("hello", false);
  say("hello there", true);
  say("how", false);
  say("how are you", false);
  assert.equal(seen.at(-1), "hello there how are you", JSON.stringify(seen));
});

test("the whisper stream rewrite protocol gives one provisional line, then the final one", async () => {
  const { StreamWords } = await import("../dist/voice-stream-words.js");
  const out = [];
  const words = new StreamWords((text, final) => out.push([text, final]));
  words.write("\x1b[2K\rhel");
  words.write("\x1b[2");
  words.write("K\rhello the");
  words.write("re\n");
  assert.deepEqual(out, [["hel", false], ["hello the", false], ["hello there", true]]);
});
