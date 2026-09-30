import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import {
  SpeechRegistry, SpeechEngineSettingsSchema, azure, builtInSpeech, deepgram, elevenlabs, program, programArguments,
} from "../dist/speech-engines.js";
import { SpeechEngineService } from "../dist/speech-engine-service.js";

/**
 * Bucket 17: speech as plug-ins. The services are a fetch that records what it was sent, the
 * reading-aloud program is a function that writes the file the real one would, and nothing plays.
 */
const policy = () => new NetworkPolicy({}, async () => ["93.184.216.34"]);
function recordingFetch(answer) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return answer(String(url), init);
  };
  return { sent, fetch };
}
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const sound = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
const clip = { bytes: new Uint8Array([82, 73, 70, 70]), mediaType: "audio/wav", name: "clip.wav" };
const context = (fetch, settings = {}, key = "sk-test") => ({
  settings: SpeechEngineSettingsSchema.parse(settings), key, fetch, policy: policy(), run: async () => "",
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-b17s-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

test("Deepgram, ElevenLabs and Azure are each asked in their own shape, with the key where they expect it", async () => {
  const dg = recordingFetch(() => json({ results: { channels: [{ detected_language: "en", alternatives: [{ transcript: " hello " }] }] } }));
  assert.deepEqual(await deepgram.listen(clip, context(dg.fetch)), { text: "hello", language: "en" });
  assert.match(dg.sent[0].url, /^https:\/\/api\.deepgram\.com\/v1\/listen\?model=nova-3/);
  assert.equal(dg.sent[0].init.headers.authorization, "Token sk-test");
  assert.equal(dg.sent[0].init.redirect, "error");

  const el = recordingFetch(() => sound());
  const spoken = await elevenlabs.speak("Hi <there>", context(el.fetch, { voice: "abcDEF123456" }));
  assert.equal(el.sent[0].url, "https://api.elevenlabs.io/v1/text-to-speech/abcDEF123456?output_format=mp3_44100_128");
  assert.equal(el.sent[0].init.headers["xi-api-key"], "sk-test");
  assert.equal(JSON.parse(el.sent[0].init.body).text, "Hi <there>");
  assert.equal(spoken.mediaType, "audio/mpeg");
  await assert.rejects(elevenlabs.speak("x", context(el.fetch, { voice: "a voice (v1)" })), /id/);
  assert.throws(() => SpeechEngineSettingsSchema.parse({ voice: "../../v1/user" }), /name or id/, "a voice can never become a path");

  const az = recordingFetch(() => sound());
  await azure.speak("Tom & <Jerry>", context(az.fetch, { azureRegion: "westeurope" }));
  assert.equal(az.sent[0].url, "https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1");
  assert.match(az.sent[0].init.body, /Tom &amp; &lt;Jerry&gt;/, "the words are data inside the SSML, never markup");
  await assert.rejects(azure.speak("x", context(az.fetch)), /region/);
  await assert.rejects(deepgram.listen(clip, context(dg.fetch, {}, null)), /needs its key/);
});

test("a blocked address is refused before a byte is sent", async () => {
  const dg = recordingFetch(() => json({}));
  const blocked = { ...context(dg.fetch), policy: new NetworkPolicy({ blockedHosts: ["api.deepgram.com"] }, async () => ["93.184.216.34"]) };
  await assert.rejects(deepgram.listen(clip, blocked), /blocked list/);
  assert.equal(dg.sent.length, 0);
});

test("a program on this computer reads aloud with only the owner's own arguments", async (t) => {
  assert.deepEqual(programArguments(["--model", "v.onnx", "-i", "{text}", "-f", "{out}"], "/t/w.txt", "/t/o.wav"),
    ["--model", "v.onnx", "-i", "/t/w.txt", "-f", "/t/o.wav"]);
  assert.throws(() => programArguments(["--model", "v.onnx"], "/t/w.txt", "/t/o.wav"), /\{out\}/);
  const ran = [];
  const run = async (file, args) => {
    ran.push({ file, args });
    await writeFile(args[args.indexOf("-f") + 1], Buffer.from("RIFFWAVE"));
    return "";
  };
  const settings = SpeechEngineSettingsSchema.parse({ program: "/opt/piper/piper", programArgs: ["-i", "{text}", "-f", "{out}"] });
  const spoken = await program.speak("; rm -rf ~", { settings, key: null, fetch, policy: policy(), run });
  assert.equal(ran[0].file, "/opt/piper/piper");
  assert.ok(!ran[0].args.some((arg) => arg.includes("rm -rf")), "the words travel in a file, never as an argument");
  assert.equal(spoken.mediaType, "audio/wav");
  assert.equal(Buffer.from(spoken.bytes).toString(), "RIFFWAVE");
  t.diagnostic("the temporary folder is removed by the engine itself");
});

test("engines and spoken commands register once, under a usable name", () => {
  const registry = new SpeechRegistry();
  registry.register({ id: "my-voice", label: "Mine", local: true, speak: async () => ({ bytes: new Uint8Array(), mediaType: "audio/wav", voice: "m" }) });
  assert.throws(() => registry.register({ id: "my-voice", label: "Again", local: true, speak: async () => null }), /already/);
  assert.throws(() => registry.register({ id: "Bad Name", label: "x", local: true, speak: async () => null }), /usable/);
  assert.throws(() => registry.register({ id: "mute", label: "x", local: true }), /neither/);
  const built = builtInSpeech();
  assert.deepEqual(built.list().map((engine) => engine.id), ["deepgram", "elevenlabs", "azure", "program"]);
  assert.equal(built.match("Stop!"), "stop");
  assert.equal(built.match("say that again"), "repeat");
  assert.equal(built.match("Arrête"), "stop", "French commands match without their accents");
  assert.equal(built.match("please stop the build on the server now"), null, "a real request is never a command");
  assert.equal(built.match("stop the build"), null);
});

test("the voice service asks the chosen engine first, and only while the switch is on", async (t) => {
  const { app } = await fixture(t);
  const dg = recordingFetch(() => json({ results: { channels: [{ alternatives: [{ transcript: "from deepgram" }] }] } }));
  const service = new SpeechEngineService({
    store: app.store, registry: builtInSpeech(), policy: policy(), fetch: dg.fetch,
    secret: async (owner, name) => (name === "DEEPGRAM_API_KEY" ? "dg-key" : null),
  });
  app.voice.engines = service;
  // The ship-on rule: other speech services ship "when needed" (src/speech-engines.ts); nothing is sent until the owner
  // picks one. The owner switches them off to see that off uses the usual route.
  assert.equal(service.settings("local").mode, "when-needed");
  service.save("local", { mode: "off" });
  assert.equal(service.settings("local").mode, "off");
  service.save("local", { listen: "deepgram" });
  await assert.rejects(app.voice.transcribe("local", clip), (error) => !/deepgram/i.test(error.message), "off: the usual route is used");
  assert.equal(dg.sent.length, 0);
  service.save("local", { mode: "when-needed" });
  const heard = await app.voice.transcribe("local", clip);
  assert.equal(heard.text, "from deepgram");
  assert.equal(heard.route, "engine:deepgram");
  assert.equal(heard.cost.amount, null, "no price is invented");
  assert.equal(dg.sent[0].init.headers.authorization, "Token dg-key");

  app.store.save("settings", "local", "voice", { keepAudioOnThisComputer: true });
  await assert.rejects(app.voice.transcribe("local", clip), /stay on this computer.*Deepgram/);
  assert.equal(dg.sent.length, 1, "nothing more was sent");
  assert.throws(() => service.save("local", { speak: "nothing-here" }), /cannot read aloud/);
  assert.throws(() => service.save("local", { listen: "program" }), /cannot write speech out/);
  assert.throws(() => service.save("local", { program: "piper" }), /full place/);
  assert.equal(service.save("local", { secrets: { azure: "MY_AZURE" } }).secrets.deepgram, "DEEPGRAM_API_KEY", "one secret name changes, the others stay");
});

test("the Voice screen lists the engines, and a spoken command comes back with the words", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body) => {
    const response = await fetch(server.url + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: "Bearer " + server.token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  // The app's own wiring takes a key out of the locker by name, and a missing one is simply absent.
  const secret = app.voice.engines["deps"].secret;
  assert.equal(await secret("local", "DEEPGRAM_API_KEY", "test"), null);
  await app.store.secrets.put("local", "default", "DEEPGRAM_API_KEY", "dg-from-locker");
  assert.equal(await secret("local", "DEEPGRAM_API_KEY", "test"), "dg-from-locker");
  const view = await call("/api/voice/engines");
  assert.equal(view.status, 200);
  assert.equal(view.body.settings.mode, "when-needed", "it ships when needed (the ship-on rule)");
  assert.ok(view.body.engines.some((engine) => engine.id === "elevenlabs" && engine.speaks && engine.listens));
  assert.ok(view.body.commands.some((command) => command.id === "stop"));
  assert.equal((await call("/api/voice/engines", { mode: "off" })).body.settings.mode, "off");
  assert.equal((await call("/api/voice/command", { text: "stop" })).body.command, null, "no commands while it is off");
  assert.equal((await call("/api/voice/engines", { mode: "on" })).body.settings.mode, "on");
  assert.equal((await call("/api/voice/command", { text: "stop" })).body.command, "stop");

  app.voice.transcribe = async () => ({ text: "Stop.", route: "openai", language: null, cost: { amount: 0 } });
  const heard = await fetch(server.url + "/api/voice/transcribe", {
    method: "POST", headers: { authorization: "Bearer " + server.token, "content-type": "audio/webm" }, body: new Uint8Array([1, 2]),
  });
  assert.equal((await heard.json()).command, "stop");
});

test("integrator: a short-lived key cannot choose the video programs, the speech services, or the reading-aloud program", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const acting = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 60 });
  const host = new URL(server.url).host;
  const post = (path, body, key) => fetch(server.url + path, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", host }, body: JSON.stringify(body),
  });
  for (const [path, body] of [
    ["/api/media/programs", { mode: "on", ffmpeg: "/bin/sh" }],
    ["/api/voice/engines", { mode: "on", speak: "program", program: "/bin/sh", programArgs: ["-c", "{out}"] }],
  ]) {
    const refused = await post(path, body, acting.token);
    assert.equal(refused.status, 401, path);
    assert.match((await refused.json()).error, /cannot choose which programs/);
  }
  assert.equal(app.voice.engines.settings("local").program, "", "nothing was saved");
  assert.equal(app.voice.engines.settings("local").mode, "when-needed", "as it ships: nothing the key sent was saved");
  assert.equal((await post("/api/voice/engines", { mode: "on" }, server.token)).status, 200, "the app window still can");
  const commands = builtInSpeech().intentList().map((intent) => intent.id);
  assert.deepEqual(commands, ["stop", "repeat", "slower", "faster"], "spoken commands only stop, repeat or change the speed");
});
