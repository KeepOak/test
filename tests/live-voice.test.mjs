/**
 * mac7/live-voice: speaking to Branch and seeing the words.
 *
 * Nothing here opens a microphone, records sound, starts a real speech program, plays a sound or
 * writes a file. The two places Branch would touch the outside world — the recorder and the speech
 * program — are handed in as fakes, through the same options `src/index.ts` fills with the real
 * ones, so what is proved here is the real wiring rather than a copy of it. Whether a program is on
 * this computer is a fake answer too, so no test depends on what happens to be installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { setLockdown } from "../dist/lockdown.js";
import { saveVoiceSettings, voiceSettings } from "../dist/voice.js";
import {
  cleanWords, dictationCapture, dictationEngine, dictationOwnerOnlyRefusal, dictationRefusal,
  dictationState, dictationView, loudness, RoomFloor, saveDictationSettings,
} from "../dist/voice-dictation.js";
import { failedWithinMs, mostCrashes, startDictation } from "../dist/voice-dictation-run.js";
import { ownerOnlyRead, taskRouteFor } from "../dist/short-lived-keys.js";
import { startServer } from "../dist/server.js";
import { chromium } from "playwright";

/** A program that is only ever there when a test says it is. */
const has = (...names) => (name) => names.includes(name);

/**
 * A speech program that is not a speech program: it remembers exactly what would have been run,
 * counts how many are open at once, says whatever the test tells it to say, and lets go when it is
 * stopped — which is what "the microphone is released" means on the path where the program is the
 * one holding it.
 */
function fakeSpeech({ dieAtOnce = false, slow = false } = {}) {
  const speech = { started: [], openNow: 0, mostOpenAtOnce: 0, heard: 0, dropped: 0, stops: 0, say: null };
  const runner = (command, onWords, onEnded) => {
    speech.started.push({ file: command.file, args: [...command.args] });
    speech.openNow += 1;
    speech.mostOpenAtOnce = Math.max(speech.mostOpenAtOnce, speech.openNow);
    let done = false;
    const finish = () => { if (done) return; done = true; speech.openNow -= 1; onEnded(null); };
    speech.say = (written) => { if (!done) onWords(written); };
    if (dieAtOnce) queueMicrotask(finish);
    return {
      hear(sound) {
        if (done) return false;
        if (slow) { speech.dropped += 1; return false; }
        speech.heard += sound.length;
        return true;
      },
      stop() { speech.stops += 1; finish(); },
    };
  };
  return { speech, runner };
}

/** A recorder that is not a recorder, for the one path where Branch is handed the sound itself. */
function fakeSound() {
  const sound = { started: [], openNow: 0, stops: 0, hand: null };
  const runner = (command, onSound, onEnded) => {
    sound.started.push({ file: command.file, args: [...command.args] });
    sound.openNow += 1;
    let done = false;
    sound.hand = onSound;
    return { stop() { if (done) return; done = true; sound.openNow -= 1; sound.stops += 1; onEnded(null); } };
  };
  return { sound, runner };
}

const until = async (check, what) => {
  for (let tries = 0; tries < 400; tries += 1) {
    if (check()) return;
    await new Promise((settle) => setTimeout(settle, 10));
  }
  throw new Error(`waited too long: ${what}`);
};

/**
 * The speech program the whole app is built with in L19, so a real browser press runs the real
 * route, the real listener and the real card — and still never opens a microphone or starts a
 * program. `say` is how the test makes it "hear" something.
 */
const speaking = { say: () => {} };

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-voice-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    // The one place the real app would touch the outside world, handed in as a fake.
    dictation: { platform: "darwin", present: has("whisper-stream"),
      speech: (command, onWords, onEnded) => {
        speaking.say = (written) => onWords(written);
        return { hear: () => true, stop: () => { speaking.say = () => {}; onEnded(null); } };
      } },
    ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // A streaming speech program and a model, neither of which is ever run: the program is a fake
  // handed in by each test, and whether it is "here" is a fake answer too.
  saveVoiceSettings(app.store, "local", { localSpeechModel: "/opt/models/base.en.bin" });
  return { app, root, store: app.store, owner: "local" };
}

/** A listener on a Mac with whisper-stream really on it, driven by fakes and nothing else. */
function listener(store, owner, parts, extra = {}) {
  return startDictation({
    store, owner, platform: "darwin", present: has("whisper-stream"),
    speech: parts.runner ?? parts.speech, sound: parts.sound ?? (() => ({ stop() {} })),
    onHeard: () => {}, tickMs: 10, ...extra,
  });
}

/** Sound that carries speech, and sound that is a quiet room. Samples, never a file. */
const speechSound = (bytes) => {
  const out = new Uint8Array(bytes);
  for (let at = 0; at + 1 < bytes; at += 2) { out[at] = 0x00; out[at + 1] = at % 4 === 0 ? 0x30 : 0xd0; }
  return out;
};
const quietSound = (bytes) => new Uint8Array(bytes);

/* ---------- the words ---------- */

test("L1 partial words arrive as the person speaks, and settle when the phrase ends", async (t) => {
  const { store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on", silenceSeconds: 1 });
  const parts = fakeSpeech();
  const seen = [];
  const live = listener(store, owner, { speech: parts.runner }, { onHeard: (heard) => seen.push(heard) });
  t.after(() => live.stop());
  assert.equal(live.start(), null, "dictation refused a press it should have taken");
  assert.equal(live.open, true, "the microphone should be open after a press");

  // Words arrive a piece at a time, as the program hears them, and each one is provisional.
  parts.speech.say("hello ");
  parts.speech.say("there");
  const provisional = seen.filter((heard) => !heard.settled).map((heard) => heard.words);
  assert.ok(provisional.includes("hello"), `no partial words arrived: ${JSON.stringify(seen)}`);
  assert.ok(provisional.includes("hello there"), `the words did not grow as they were spoken: ${JSON.stringify(seen)}`);
  assert.ok(seen.every((heard) => heard.settled === false), "words settled before the phrase had ended");

  // ...and the phrase settles, once, when it ends.
  live.stop();
  const settled = seen.filter((heard) => heard.settled);
  assert.deepEqual(settled.map((heard) => heard.words), ["hello there"]);
  assert.equal(live.open, false, "the microphone was still open after a stop");
});

test("L2 what a program writes out becomes words, and a program that will not stop is cut off", () => {
  // whisper.cpp's timings, and the codes a program uses to rewrite the line it last wrote.
  assert.equal(cleanWords("[2K[00:00:00.000 --> 00:00:02.000]  hello there \r"), "hello there");
  assert.equal(cleanWords("   \n  "), "");
  assert.equal(cleanWords("one\r\ntwo"), "one two");
});

/* ---------- silence ---------- */

test("L3 a quiet room ends the phrase and lets go of the microphone", async (t) => {
  const { store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on", silenceSeconds: 1 });
  const parts = fakeSpeech();
  const seen = [];
  const live = listener(store, owner, { speech: parts.runner }, { onHeard: (heard) => seen.push(heard) });
  t.after(() => live.stop());
  live.start();
  parts.speech.say("something");
  assert.equal(live.open, true);
  // Nobody says anything for longer than the owner allowed. Nothing presses anything: the tick is
  // what notices, which is the point — a microphone left open in a silent room is what this stops.
  await until(() => live.open === false, "a quiet room never let go of the microphone");
  assert.equal(parts.speech.stops, 1, "the speech program was not ended when the room went quiet");
  assert.deepEqual(seen.filter((heard) => heard.settled).map((heard) => heard.words), ["something"]);
});

test("L4 how loud a room is, worked out with nothing installed at all", () => {
  assert.equal(loudness(new Uint8Array(0)), 0);
  assert.equal(loudness(quietSound(3200)), 0);
  assert.ok(loudness(speechSound(3200)) > 0.2, "speech should be plainly louder than nothing");
  const room = new RoomFloor();
  // The first second is the room being learned, and nothing in it counts as speech.
  for (let frame = 0; frame < RoomFloor.learningFrames; frame += 1)
    assert.equal(room.speech(quietSound(640)), false, "something counted as speech before the room was learned");
  assert.equal(room.speech(quietSound(640)), false, "a quiet room counted as speech");
  assert.equal(room.speech(speechSound(640)), true, "speech did not count as speech");
  room.forget();
  assert.equal(room.speech(speechSound(640)), false, "the room was not learned again after being forgotten");
});

/* ---------- letting go of the microphone ---------- */

test("L5 the microphone is let go of on stop, on Lockdown, on the switch going off, and on close", async (t) => {
  const { app, store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on", silenceSeconds: 30 });
  const parts = fakeSpeech();
  const live = listener(store, owner, { speech: parts.runner });
  t.after(() => live.stop());

  // A press, then a press again: one microphone at a time, never two.
  live.start();
  assert.equal(live.open, true);
  live.start();
  assert.equal(live.open, false, "pressing Dictate twice should stop, not open a second microphone");
  assert.equal(parts.speech.mostOpenAtOnce, 1, "more than one speech program was open at once");

  // Lockdown, which wins over the switch whatever it says.
  live.start();
  assert.equal(live.open, true);
  setLockdown(store, owner, { on: true });
  await until(() => live.open === false, "Lockdown never let go of the microphone");
  assert.match(dictationRefusal(store, owner, "darwin", has("whisper-stream")), /Lockdown is on/);
  assert.match(live.start(), /Lockdown is on/, "a press under Lockdown should be refused, in those words");
  assert.equal(live.open, false, "Lockdown let a press open the microphone");
  setLockdown(store, owner, { on: false });

  // The switch going off, whoever turns it — the card, a settings file or another window.
  live.start();
  assert.equal(live.open, true);
  saveDictationSettings(store, owner, { mode: "off" });
  await until(() => live.open === false, "the switch going off never let go of the microphone");

  // Being locked is a state: while it is locked, nothing may start, whoever saves a setting.
  saveDictationSettings(store, owner, { mode: "on" });
  let locked = false;
  const lockable = listener(store, owner, { speech: parts.runner }, { locked: () => locked });
  lockable.start();
  assert.equal(lockable.open, true);
  locked = true;
  await until(() => lockable.open === false, "locking Branch never let go of the microphone");
  assert.match(lockable.start(), /Branch is locked/);
  assert.equal(lockable.open, false, "a locked Branch let a press open the microphone");
  lockable.stop();

  // And closing the app lets go of it: app.dictation is the real listener src/index.ts owns.
  assert.equal(typeof app.dictation.stop, "function");
  assert.equal(app.dictation.open, false);
});

test("L6 unlocking Branch does not reopen the microphone: only a press ever does", async (t) => {
  const { store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on" });
  const parts = fakeSpeech();
  let locked = false;
  const live = listener(store, owner, { speech: parts.runner }, { locked: () => locked });
  t.after(() => live.stop());
  live.start();
  locked = true;
  await until(() => live.open === false, "locking never let go of the microphone");
  locked = false;
  // The word that starts a turn listens again by itself when Branch is unlocked. This must not:
  // that would be a microphone opened without anybody pressing anything.
  live.refresh();
  await new Promise((settle) => setTimeout(settle, 60));
  assert.equal(live.open, false, "unlocking Branch reopened the microphone with nobody pressing anything");
  assert.equal(parts.speech.started.length, 1, "the speech program was started again by itself");
});

/* ---------- a program that dies, and one that will not keep up ---------- */

test("L7 a speech program that dies is handled, is not restarted by itself, and never spins", async (t) => {
  const { store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on", silenceSeconds: 30 });
  const parts = fakeSpeech({ dieAtOnce: true });
  const seen = [];
  const live = listener(store, owner, { speech: parts.runner }, { onHeard: (heard) => seen.push(heard) });
  t.after(() => live.stop());

  for (let press = 0; press < mostCrashes; press += 1) {
    assert.equal(live.start(), null, `press ${press + 1} should have been taken`);
    await until(() => live.open === false, "a dead speech program left the microphone open");
  }
  // It was never started again by itself between presses: one start per press and no more.
  assert.equal(parts.speech.started.length, mostCrashes, "a dead speech program was restarted by itself");
  // And after a few of those the next press is refused with a sentence rather than trying for ever.
  assert.match(live.start(), /stopped as soon as it was started/);
  assert.equal(live.open, false);
  assert.equal(parts.speech.started.length, mostCrashes, "the refused press started a program anyway");
  assert.ok(failedWithinMs > 0);
});

test("L8 a program that is not keeping up has its sound dropped, never piled up behind it", async (t) => {
  const { store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on", silenceSeconds: 30 });
  saveVoiceSettings(store, owner, { localSpeechStream: "/opt/bin/my-streamer" });
  const parts = fakeSpeech({ slow: true });
  const sounds = fakeSound();
  // Nothing named on the search path, so the owner's own streaming program is what is used — the
  // one path where Branch holds the recorder and is handed the sound itself.
  const live = startDictation({
    store, owner, platform: "darwin", present: has("rec"),
    speech: parts.runner, sound: sounds.runner, onHeard: () => {}, tickMs: 10,
  });
  assert.equal(live.start(), null, "the owner's own streaming program was not used");
  assert.equal(sounds.sound.started.length, 1, "no recorder was held open for a program that reads sound");
  assert.equal(sounds.sound.started[0].file, "rec", "a Mac should use the recorder the owner installed");
  // Nothing in the recorder's arguments is a file name, and nothing writes one.
  assert.equal(sounds.sound.started[0].args.some((arg) => /\.(wav|raw|txt|pcm)$/.test(arg)), false);

  // The first second is the room being learned, and a real room is quiet while it is learned.
  for (let piece = 0; piece < 20; piece += 1) live.hear(quietSound(3200));
  for (let piece = 0; piece < 200; piece += 1) live.hear(speechSound(3200));
  // The program said "no" every time. What matters is that nothing grew: it was dropped where it
  // arrived rather than queued, which is the one way a slow program could have piled up sound.
  assert.ok(parts.speech.dropped > 0, "a slow program was never actually asked");
  assert.equal(parts.speech.heard, 0, "sound reached a program that said it was not keeping up");
  assert.equal(live.open, true, "a slow program should not close the microphone by itself");
  live.stop();
  assert.equal(sounds.sound.openNow, 0, "the recorder was left holding the microphone");
});

/* ---------- nothing is written down ---------- */

test("L9 nothing is written to disk, and no file name is ever an argument", async (t) => {
  const { store, owner, root } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on", silenceSeconds: 30 });
  const before = await readdir(root, { recursive: true });
  const parts = fakeSpeech();
  const sounds = fakeSound();
  const live = listener(store, owner, { speech: parts.runner, sound: sounds.runner });
  t.after(() => live.stop());
  live.start();
  parts.speech.say("please do not write this down");
  live.hear(speechSound(6400));
  live.stop();
  const after = await readdir(root, { recursive: true });
  assert.deepEqual(after.sort(), before.sort(), "dictation left something behind on disk");

  // And no file name is ever an argument to the program that opens the microphone.
  const engine = dictationEngine(voiceSettings(store, owner), "darwin", has("whisper-stream"));
  assert.equal(engine.command.args.some((arg) => /\.(wav|raw|txt|pcm)$/.test(arg)), false,
    `a file name was an argument: ${engine.command.args.join(" ")}`);
  assert.deepEqual(engine.command.args, ["-m", "/opt/models/base.en.bin", "--step", "500", "--length", "5000"]);
  // The words themselves are screen state: what is handed out is dropped when the phrase ends.
  assert.equal(dictationState(store, owner, "darwin", false, has("whisper-stream")).open, false);
});

test("L10 no sound leaves this computer: nothing is fetched, and no service is ever the speech program", async (t) => {
  const reached = [];
  const { store, owner } = await fixture(t, {
    fetch: async (url) => { reached.push(String(url)); throw new Error("nothing here may reach the network"); },
  });
  saveDictationSettings(store, owner, { mode: "on", silenceSeconds: 30 });
  const parts = fakeSpeech();
  const live = listener(store, owner, { speech: parts.runner });
  t.after(() => live.stop());
  live.start();
  parts.speech.say("not a word of this leaves");
  live.stop();
  assert.deepEqual(reached, [], `dictation reached the network: ${reached.join(", ")}`);
  const engine = dictationEngine(voiceSettings(store, owner), "darwin", has("whisper-stream"));
  assert.equal(/https?:/.test(JSON.stringify(engine)), false, "a service turned up where a program should be");
});

/* ---------- a computer that cannot do this ---------- */

test("L11 with no speech program installed the card says which to install, and stays off", async (t) => {
  const { store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on" });
  for (const [platform, wanted] of [
    ["darwin", /brew install whisper-cpp/],
    ["linux", /sherpa-onnx/],
    ["win32", /whisper-stream/],
  ]) {
    const state = dictationState(store, owner, platform, false, has());
    assert.equal(state.canDictate, false, `${platform} claimed it could dictate with nothing installed`);
    assert.match(state.refusal, wanted, `${platform} never said what to install`);
    assert.match(state.refusal, /will not install one of its own, and will not download one/,
      `${platform} left out the promise that Branch installs nothing`);
    assert.equal(state.engine.command, null, "something would have been run with nothing installed");
  }
  // A program that is here but has no model is a different sentence, and is still off.
  saveVoiceSettings(store, owner, { localSpeechModel: "" });
  const noModel = dictationState(store, owner, "darwin", false, has("whisper-stream"));
  assert.equal(noModel.canDictate, false);
  assert.match(noModel.refusal, /no speech model is set up/);

  // And a press is refused rather than opening anything.
  const parts = fakeSpeech();
  const live = startDictation({ store, owner, platform: "darwin", present: has(),
    speech: parts.runner, sound: () => ({ stop() {} }), onHeard: () => {}, tickMs: 10 });
  t.after(() => live.stop());
  assert.match(live.start(), /brew install whisper-cpp/);
  assert.equal(live.open, false, "a computer that cannot dictate opened a microphone anyway");
  assert.deepEqual(parts.speech.started, [], "something was started on a computer that has nothing");
});

test("L12 it ships off, and the switch alone never opens a microphone", async (t) => {
  const { store, owner } = await fixture(t);
  const state = dictationState(store, owner, "darwin", false, has("whisper-stream"));
  assert.equal(state.settings.mode, "off", "dictation does not ship off");
  assert.match(state.refusal, /switched off/);
  const parts = fakeSpeech();
  const live = listener(store, owner, { speech: parts.runner });
  t.after(() => live.stop());
  assert.match(live.start(), /switched off/);
  assert.equal(live.open, false);

  // "On" means the control is offered, never that a microphone is open. Turning it on, on its own,
  // opens nothing at all: only a press does, which is the whole difference from a wake word.
  saveDictationSettings(store, owner, { mode: "on" });
  const on = listener(store, owner, { speech: parts.runner });
  t.after(() => on.stop());
  await new Promise((settle) => setTimeout(settle, 60));
  assert.equal(on.open, false, "turning the switch on opened a microphone by itself");
  assert.deepEqual(parts.speech.started, [], "turning the switch on started a speech program");
});

test("L17 the words are there for the window to collect, and are dropped when the phrase ends", async (t) => {
  const { store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on", silenceSeconds: 30 });
  const parts = fakeSpeech();
  const live = listener(store, owner, { speech: parts.runner });
  t.after(() => live.stop());
  assert.equal(live.words, "", "something was being held before anything was said");
  live.start();
  parts.speech.say("the words on the screen");
  // This is what the window reads, three times a second, to put the words in the message box.
  assert.equal(live.words, "the words on the screen");
  assert.equal(live.settled, false, "words settled while they were still being spoken");
  live.stop();
  assert.equal(live.settled, true, "the phrase never settled");
  assert.equal(live.words, "the words on the screen", "the settled words were gone before anyone could read them");
  // ...and the next press starts from nothing, so no phrase outlives the one after it.
  live.start();
  assert.equal(live.words, "", "the last phrase was still being held when the next one started");
});

test("L18 a speech program the owner named wins over one merely found on the search path", async (t) => {
  const { store, owner } = await fixture(t);
  saveVoiceSettings(store, owner, { localSpeechStream: "/opt/bin/chosen-by-me" });
  // whisper-stream is right there on the path. The owner said which program they wanted, so that
  // is the one that runs: quietly running something else instead is a substitution nobody would find.
  const engine = dictationEngine(voiceSettings(store, owner), "darwin", has("whisper-stream"));
  assert.equal(engine.command.file, "/opt/bin/chosen-by-me");
  assert.equal(engine.kind, "reads-sound");
});

/* ---------- whose it is ---------- */

test("L13 a chat task, a short-lived key, a Trunk and another computer are all refused", async (t) => {
  const { app } = await fixture(t);
  // A short-lived key: reading the card is refused, and starting it is refused by the fail-closed
  // rule — the path is deliberately not in the list of things a key may do, and not adding it *is*
  // the refusal. A key that could start it would be a microphone opened by something that is not
  // a person at this window.
  assert.ok(ownerOnlyRead("/api/voice/dictation"), "a short-lived key could read the dictation card");
  assert.ok(ownerOnlyRead("/api/voice/dictation/listen"));
  assert.equal(taskRouteFor("POST", "/api/voice/dictation"), null, "a short-lived key could change dictation");
  assert.equal(taskRouteFor("POST", "/api/voice/dictation/listen"), null, "a short-lived key could open the microphone");

  // A chat task, a Trunk and another computer all reach Branch through tools, and there is no tool
  // for this at all: nothing anywhere in the tool list can start, stop or change dictation.
  const tools = app.registry.names();
  // ...and this check can still go off: an empty list would pass the regular expression trivially.
  assert.ok(tools.length > 20, `only ${tools.length} tools were read, so this check cannot fail`);
  const names = tools.join(" ");
  assert.equal(/dictat/i.test(names), false, `a tool could reach dictation: ${names}`);
  // The same for the permissions: none of them is a way to open a microphone either.
  assert.equal(/dictat|microphone/i.test(app.registry.permissions().join(" ")), false,
    "a tool permission could reach the microphone");
});

test("L14 somebody else on this computer is not offered dictation at all", async (t) => {
  const { app, root, store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const ask = (init) => fetch(server.url + "/api/voice/dictation", {
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...init });

  assert.equal((await (await ask({})).json()).isOwner, true, "the owner cannot see their own card");
  const profile = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: profile.id, pin: "2468" });

  const seen = await (await ask({})).json();
  assert.equal(seen.isOwner, false);
  assert.equal(seen.canDictate, false, "somebody else was told this computer can dictate");
  assert.equal(seen.refusal, dictationOwnerOnlyRefusal);
  // Nothing of the owner's travelled: not the switch, not the program, not the model.
  const text = JSON.stringify(seen);
  assert.equal(text.includes("whisper"), false, `which speech program is here travelled: ${text}`);
  assert.equal(text.includes("/opt/models"), false, `the owner's model travelled: ${text}`);

  // ...and they cannot change it or start it either.
  for (const path of ["/api/voice/dictation", "/api/voice/dictation/listen"]) {
    const answer = await fetch(server.url + path, {
      method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "on", on: true }),
    });
    assert.equal(answer.ok, false, `somebody else on this computer reached ${path}`);
  }
  assert.equal(app.dictation.open, false, "somebody else on this computer opened the microphone");
});

test("L15 the view never carries the program's full path, and the card reads the real microphone", async (t) => {
  const { store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on" });
  saveVoiceSettings(store, owner, { localSpeechStream: "/home/someone/secret-folder/my-streamer" });
  const view = dictationView(store, owner, "linux", true, false, has());
  assert.equal(JSON.stringify(view).includes("secret-folder"), false,
    "the full path of the owner's own program travelled over the wire");
  // Whether the microphone is open is a fact about the listener, not about the switch.
  assert.equal(dictationView(store, owner, "darwin", true, true, has("whisper-stream")).open, true);
  assert.equal(dictationView(store, owner, "darwin", true, false, has("whisper-stream")).open, false);
});

test("L16 the recorder Branch would hold open is a real one, per system, and never for the other path", async (t) => {
  const { store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on" });
  // A program that opens the microphone itself needs no recorder from Branch at all.
  const ownMic = dictationEngine(voiceSettings(store, owner), "darwin", has("whisper-stream"));
  assert.equal(ownMic.kind, "own-microphone");
  assert.equal(dictationCapture(ownMic, "darwin", has("rec")), null, "a recorder was held open for nothing");
  assert.match(ownMic.how, /no sound ever reaches Branch at all/);

  // A program handed sound gets one recorder, held open, asked for the samples and nothing else.
  saveVoiceSettings(store, owner, { localSpeechStream: "/opt/bin/my-streamer" });
  const fed = dictationEngine(voiceSettings(store, owner), "linux", has());
  assert.equal(fed.kind, "reads-sound");
  const linux = dictationCapture(fed, "linux", has("arecord"));
  assert.deepEqual(linux, { file: "arecord",
    args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-"] });
  assert.equal(linux.args.includes("-d"), false, "the recorder was still given one window's length");
  assert.equal(dictationCapture(fed, "linux", has()), null, "a recorder appeared that is not on this computer");
  assert.match(dictationRefusal(store, owner, "linux", has()), /no recording program/);
});

/* ---------- the press, the words on the screen, and the microphone let go of ---------- */

test("L19 a person presses Dictate, sees the words appear, and the microphone closes when they stop", async (t) => {
  const { app, root, store, owner } = await fixture(t);
  saveDictationSettings(store, owner, { mode: "on", silenceSeconds: 30 });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

  /* Redesign: the prototype's Dictate is the microphone button in the composer (data-act="dict"); while it listens the
     composer shows "Listening… speak naturally" with Done (data-act="dict-done"). FEATURE-AUDIT dict/dict-done: the
     engine's dictation (POST /api/voice/dictation/listen, the words from GET /api/voice/dictation).
     WINDOW BUG: public/app/chat/dictate.js records in the browser (getUserMedia + MediaRecorder) and posts
     /api/voice/transcribe; it never opens the engine's dictation, and draws no listening row. */
  const dictate = page.locator('#composer [data-act="dict"]');
  await dictate.waitFor({ state: "visible", timeout: 15000 });
  assert.notEqual(await dictate.getAttribute("aria-disabled"), "true", "Dictate is live");
  assert.equal(app.dictation.open, false, "a microphone was open before anybody pressed anything");

  await dictate.click();
  // The listening row is on for exactly as long as the microphone is.
  await page.locator(".dict").filter({ hasText: "Listening" }).waitFor({ timeout: 15000 });
  assert.equal(app.dictation.open, true, "pressing Dictate did not open the microphone");

  // The fake speech program says something, and the words turn up in the message box.
  speaking.say("hello from the other side");
  await page.waitForFunction(() => document.getElementById("prompt")?.value.includes("hello from the other side"),
    null, { timeout: 15000 });

  // Nothing was sent: the words sit in the box and the conversation is still empty.
  assert.equal(app.store.runs(owner).length, 0, "dictation sent the message instead of filling the box");

  // Done stops it, and the microphone closes with it.
  await page.locator('[data-act="dict-done"]').click();
  await page.locator(".dict").waitFor({ state: "detached", timeout: 15000 });
  assert.equal(app.dictation.open, false, "the microphone was still open after the person stopped");
  assert.equal(await page.locator("#prompt").inputValue(), "hello from the other side",
    "the words the person spoke were lost when they stopped");
  assert.deepEqual(errors, []);
});
