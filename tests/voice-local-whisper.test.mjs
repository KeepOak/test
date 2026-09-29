/**
 * RES-709: free, offline speech-to-text on this computer (src/voice-whisper.ts), push-to-talk and live captions in
 * the window, and Telegram voice notes through the same engine.
 *
 * Two kinds of proof. Most of this file drives the real worker code against a stand-in worker
 * (tests/fixtures/fake-whisper-worker.mjs, the same JSON-lines protocol with no Python), so it runs everywhere. The
 * "real" tests write out tests/fixtures/spoken-hello.wav with the faster-whisper really installed on this computer,
 * offline; they are skipped, saying why, where none is installed, and the "Local voice" CI job installs one and sets
 * BRANCH_REQUIRE_WHISPER=1 so that there they must run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveVoiceSettings } from "../dist/voice.js";
import { saveDictationSettings, dictationView } from "../dist/voice-dictation.js";
import { VoiceService, sttRouteFor } from "../dist/voice-service.js";
import {
  LocalWhisper, findLocalWhisper, pythonCandidates, whisperEnvironment, whisperWorkerScript,
} from "../dist/voice-whisper.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const spokenWav = join(here, "fixtures", "spoken-hello.wav");
const fakeWorker = join(here, "fixtures", "fake-whisper-worker.mjs");

/* ---------- finding it ---------- */

/** A computer whose files are only the ones named. */
function computer(files) {
  const all = new Map(Object.entries(files));
  return { exists: (path) => all.has(path.replace(/\\/g, "/")), read: (path) => {
    const found = all.get(path.replace(/\\/g, "/"));
    if (found === undefined) throw new Error("ENOENT");
    return found;
  } };
}
const choice = (extra = {}) => ({ localSpeechExecutable: "", localSpeechModel: "", localSpeechKind: "whisper-cpp", language: "", ...extra });
const hub = "/home/sam/.cache/huggingface/hub";
const model = (name, revision = "abc1234") => ({
  [`${hub}/models--Systran--faster-whisper-${name}/refs/main`]: `${revision}\n`,
  [`${hub}/models--Systran--faster-whisper-${name}/snapshots/${revision}/model.bin`]: "",
});
const uvPython = "/home/sam/.local/share/uv/tools/faster-whisper-cli/bin/python";

test("W1 it finds faster-whisper where its installers put it, and a model already on this computer", () => {
  const lookup = { env: {}, platform: "linux", home: "/home/sam", ...computer({ [uvPython]: "", ...model("base"), ...model("tiny.en") }) };
  const found = findLocalWhisper(choice(), lookup);
  assert.equal(found.available, true);
  assert.equal(found.python.replace(/\\/g, "/"), uvPython);
  assert.equal(found.modelName, "tiny.en", "the fastest model on this computer comes first");
  assert.match(found.model.replace(/\\/g, "/"), /faster-whisper-tiny\.en\/snapshots\/abc1234$/);
  assert.match(found.how, /Nothing is sent anywhere and nothing is charged/);

  // Another language skips the English-only models.
  assert.equal(findLocalWhisper(choice({ language: "fr" }), lookup).modelName, "base");

  // On Windows, uv puts it under APPDATA.
  const windows = pythonCandidates({ APPDATA: "C:/Users/sam/AppData/Roaming" }, "win32", "C:/Users/sam").map((one) => one.replace(/\\/g, "/"));
  assert.ok(windows.includes("C:/Users/sam/AppData/Roaming/uv/tools/faster-whisper-cli/Scripts/python.exe"));
});

test("W2 missing pieces say what to install, and Branch downloads nothing", () => {
  const none = findLocalWhisper(choice(), { env: {}, platform: "linux", home: "/home/sam", ...computer({}) });
  assert.equal(none.available, false);
  assert.match(none.how, /uv tool install faster-whisper-cli/);
  assert.match(none.how, /Branch installs and downloads nothing itself/);

  const noModel = findLocalWhisper(choice(), { env: {}, platform: "linux", home: "/home/sam", ...computer({ [uvPython]: "" }) });
  assert.equal(noModel.available, false);
  assert.match(noModel.how, /no speech model is/);
  assert.equal(noModel.how.includes(uvPython), false, "the full path of the owner's program would travel to the card");

  // A half-downloaded model (no model.bin) is not a model.
  const half = { [`${hub}/models--Systran--faster-whisper-base/refs/main`]: "abc1234" };
  assert.equal(findLocalWhisper(choice(), { env: {}, platform: "linux", home: "/home/sam", ...computer({ [uvPython]: "", ...half }) }).available, false);
});

test("W3 the Python and model the owner named win over what is found", () => {
  const files = computer({ "/opt/py/bin/python3": "", "/models/mine/model.bin": "", [uvPython]: "", ...model("tiny.en") });
  const found = findLocalWhisper(choice({ localSpeechKind: "faster-whisper", localSpeechExecutable: "/opt/py/bin/python3", localSpeechModel: "/models/mine" }),
    { env: {}, platform: "linux", home: "/home/sam", ...files });
  assert.equal(found.python, "/opt/py/bin/python3");
  assert.equal(found.model, "/models/mine");
});

test("W4 the worker is offline, gets none of Branch's secrets, and never writes a file", () => {
  const env = whisperEnvironment({ PATH: "/bin", OPENAI_API_KEY: "sk-secret", BW_SESSION: "vault", HOME: "/home/sam" });
  assert.equal(env.HF_HUB_OFFLINE, "1");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.BW_SESSION, undefined);
  assert.match(whisperWorkerScript, /local_files_only=True/);
  assert.doesNotMatch(whisperWorkerScript, /open\(|write_text|\.save\(/, "the worker writes nothing to disk");
});

/* ---------- the worker, against a stand-in ---------- */

/** LocalWhisper whose "Python" is Node running the stand-in worker; records what it was started with. */
function standIn(extraEnv = {}) {
  const started = [];
  const whisper = new LocalWhisper({}, (python, args, env) => {
    started.push({ python, args, env });
    return spawn(process.execPath, [fakeWorker], { env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  });
  return { whisper, started };
}
const ready = { available: true, python: "/fake/python", model: "/fake/model", modelName: "base", how: "fake" };

test("W5 one worker answers every recording, one at a time, and a busy live caption is skipped", async (t) => {
  const { whisper, started } = standIn();
  t.after(() => whisper.stop());
  const first = await whisper.transcribe(ready, new Uint8Array(10));
  assert.deepEqual(first, { text: "heard 10 bytes", language: "en" });
  assert.equal((await whisper.transcribe(ready, new Uint8Array(20), { language: "de" })).language, "de");
  assert.equal(started.length, 1, "the model is loaded once, not for every recording");
  assert.deepEqual(started[0].args.slice(0, 4), ["-X", "utf8", "-u", "-c"]);
  assert.equal(started[0].args.at(-1), "/fake/model");

  // A finished recording waits its turn; a live caption asked for meanwhile is dropped, not queued.
  const slow = whisper.transcribe(ready, Buffer.from("SLOW"));
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(await whisper.transcribe(ready, new Uint8Array(5), { partial: true }), null);
  assert.equal((await slow).text, "heard 4 bytes");
  assert.equal((await whisper.transcribe(ready, new Uint8Array(5), { partial: true })).text, "heard 5 bytes (partial)");
});

test("W6 a worker that fails says why in words, and the next recording starts a fresh one", async (t) => {
  const { whisper, started } = standIn();
  t.after(() => whisper.stop());
  await assert.rejects(whisper.transcribe(ready, Buffer.from("BAD")), /could not write that out: Invalid data/);
  await assert.rejects(whisper.transcribe(ready, Buffer.from("CRASH")), /faster-whisper stopped: RuntimeError: the model file is damaged/);
  assert.equal(whisper.alive, false);
  assert.equal((await whisper.transcribe(ready, new Uint8Array(3))).text, "heard 3 bytes");
  assert.equal(started.length, 2);

  const broken = standIn({ FAKE_WHISPER_NO_START: "1" });
  t.after(() => broken.whisper.stop());
  await assert.rejects(broken.whisper.transcribe(ready, new Uint8Array(3)), /No module named 'faster_whisper'/);
  await assert.rejects(whisper.transcribe({ ...ready, available: false, how: "install it" }, new Uint8Array(3)), /install it/);
  await assert.rejects(whisper.transcribe(ready, new Uint8Array(0)), /no sound in it/);
});

test("W7 left on auto, the free program here is used before any paid service", () => {
  const settings = { sttRoute: "auto", keepAudioOnThisComputer: false, localSpeechExecutable: "" };
  const paid = { name: "openai", audio: () => ({ endpoint: "https://api.openai.com/v1", apiKey: "sk" }) };
  assert.equal(sttRouteFor(settings, paid, false).kind, "openai");
  const free = sttRouteFor(settings, paid, true);
  assert.equal(free.kind, "local");
  assert.match(free.reason, /nothing is sent or charged/);
  assert.equal(sttRouteFor({ ...settings, sttRoute: "openai" }, paid, true).kind, "openai", "the owner's own choice is kept");
});

/* ---------- the window route and Telegram, through the real app ---------- */

async function fixture(t, whisper) {
  const root = await mkdtemp(join(tmpdir(), "branch-local-whisper-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), localSpeech: whisper,
    dictation: { platform: "win32", present: () => false } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, server, root, owner: "local" };
}
/** A LocalWhisper that finds the stand-in as if it were installed. */
function installedStandIn() {
  const made = standIn();
  made.whisper.find = () => ({ ...ready });
  return made;
}

test("W8 the microphone is off until the owner turns dictation on; then the window's words come back", async (t) => {
  const { whisper } = installedStandIn();
  const { app, server, owner } = await fixture(t, whisper);
  const hear = (partial = false, body = new Uint8Array(1234)) => fetch(`${server.url}/api/voice/dictation/hear${partial ? "?partial=1" : ""}`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "audio/webm;codecs=opus" }, body });

  const card = await (await fetch(`${server.url}/api/voice/dictation`, { headers: { authorization: `Bearer ${server.token}` } })).json();
  assert.equal(card.mode, "off", "dictation ships off");
  assert.equal(card.engine.kind, "window-mic");
  assert.equal(card.canDictate, true);
  const off = await hear();
  assert.equal(off.status, 409);
  assert.match((await off.json()).error, /Dictation is switched off/);

  saveDictationSettings(app.store, owner, { mode: "on" });
  const partial = await hear(true);
  assert.equal(partial.status, 200);
  assert.deepEqual(await partial.json(), { text: "heard 1234 bytes (partial)", partial: true });
  assert.equal((await (await hear()).json()).text, "heard 1234 bytes");
  assert.equal(app.store.runs(owner).length, 0, "hearing words sent nothing: they go in the box");

  const wrongType = await fetch(`${server.url}/api/voice/dictation/hear`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(wrongType.status, 415);

  // Somebody else on this computer cannot use the owner's microphone route.
  const profile = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: profile.id, pin: "2468" });
  const other = await hear();
  assert.equal(other.ok, false);
  assert.match((await other.json()).error, /owner/);
});

test("W9 a Telegram voice note is written out by the same free engine, and nothing is fetched", async (t) => {
  const { whisper } = installedStandIn();
  const { app, owner } = await fixture(t, whisper);
  let fetched = 0;
  const noNetwork = { assertAllowed: async () => { fetched += 1; throw new Error("nothing may be sent"); } };
  const voice = new VoiceService(app.store, app.runtime.models, noNetwork,
    async () => { fetched += 1; throw new Error("nothing may be fetched"); }, { whisper });
  const written = await voice.transcribe(owner, { bytes: new Uint8Array(77), mediaType: "audio/ogg", name: "voice-note", seconds: 2 });
  assert.equal(written.text, "heard 77 bytes");
  assert.equal(written.route, "local");
  assert.equal(written.cost.amount, 0);
  assert.equal(fetched, 0);
  // The channel router is wired to the app's own voice service, which finds the same engine.
  assert.equal(await app.channels.transcribeVoice({ bytes: new Uint8Array(9), mediaType: "audio/ogg", name: "note" }), "heard 9 bytes");
  // Asked to keep audio here, it still works: this route never leaves the computer.
  saveVoiceSettings(app.store, owner, { keepAudioOnThisComputer: true });
  assert.equal((await voice.transcribe(owner, { bytes: new Uint8Array(5), mediaType: "audio/ogg", name: "n" })).text, "heard 5 bytes");
});

/* ---------- the real thing, offline ---------- */

/** The faster-whisper really installed here (or the Python CI names), or why there is none. */
function realWhisper() {
  const named = process.env.BRANCH_WHISPER_PYTHON;
  return findLocalWhisper(choice(named ? { localSpeechKind: "faster-whisper", localSpeechExecutable: named } : {}));
}
const required = process.env.BRANCH_REQUIRE_WHISPER === "1";
function realOrSkip(t) {
  const found = realWhisper();
  if (!found.available) {
    if (required) assert.fail(`BRANCH_REQUIRE_WHISPER is set but: ${found.how}`);
    t.skip(`no faster-whisper on this computer: ${found.how}`);
    return null;
  }
  return found;
}

test("W10 real: the fixture WAV is written out on this computer, offline", { timeout: 180_000 }, async (t) => {
  const found = realOrSkip(t);
  if (!found) return;
  const whisper = new LocalWhisper();
  t.after(() => whisper.stop());
  const heard = await whisper.transcribe(found, await readFile(spokenWav));
  assert.match(heard.text, /hello/i);
  assert.match(heard.text, /water/i);
  assert.match(heard.text, /garden/i);
  assert.equal(heard.language, "en");
});

test("W11 real: push-to-talk in the window fills the box with live captions, with a fake microphone", { timeout: 360_000 }, async (t) => {
  const found = realOrSkip(t);
  if (!found) return;
  const { chromium } = await import("playwright");
  const whisper = new LocalWhisper();
  whisper.find = () => found;
  const { app, server, owner, root } = await fixture(t, whisper);
  t.after(() => whisper.stop());
  saveDictationSettings(app.store, owner, { mode: "on" });
  // Chromium's fake microphone plays the WAV, over and over; nothing real is opened.
  const audio = join(root, "mic.wav");
  await writeFile(audio, await readFile(spokenWav));
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audio}`] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fetch(`${server.url}/api/onboarding`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const mic = page.locator('#composer [data-act="dict"]');
  await mic.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#composer [data-act="dict"]')?.getAttribute("aria-disabled") !== "true");

  // Hold to talk: the live caption shows words while the button is still held.
  const box = await mic.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.locator(".composer .dict-cap").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const words = document.querySelector(".composer .dict-cap")?.textContent ?? "";
    return /[a-z]{3}/i.test(words) && !words.startsWith("Listening");
  }, null, { timeout: 60_000 });
  assert.ok(await page.locator(".composer .dict").isVisible(), "the caption came only after letting go");
  await page.waitForTimeout(3000);
  await page.mouse.up();
  // The settled words are the whole recording written out once more; on a busy computer that can take a while.
  await page.locator(".dict").waitFor({ state: "detached", timeout: 180_000 });
  const typed = await page.locator("#prompt").inputValue();
  assert.match(typed, /garden|water|hello/i, `the settled words did not land in the box: "${typed}"`);
  // Other work may start on its own (a Trunk introducing itself); none of it is what was said.
  const sent = app.store.runs(owner).filter((run) => /garden|water|hello/i.test(run.prompt));
  assert.deepEqual(sent.map((run) => run.prompt), [], "the words were sent instead of waiting in the box");
  assert.deepEqual(errors, []);
});

/* ---------- the card ---------- */

test("W12 the card says what the microphone button would use, and never the program's full path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-local-whisper-card-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), localSpeech: null });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const python = join(root, "tools", "python.exe");
  await mkdir(join(root, "tools"), { recursive: true });
  await writeFile(python, "");
  const card = dictationView(app.store, "local", "win32", true, false, () => false,
    findLocalWhisper(choice({ localSpeechKind: "faster-whisper", localSpeechExecutable: python }), { env: {}, home: root }));
  assert.equal(card.engine.kind, "none");
  assert.match(card.engine.how, /no speech model is/);
  assert.equal(JSON.stringify(card).includes(root), false, "the full path travelled");
});
