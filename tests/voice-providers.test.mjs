import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, GeminiProvider, OpenAIProvider, ToolRegistry } from "../dist/index.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { Transcription, estimateAudioCost, hiddenChildOptions, localSttArgs } from "../dist/voice-stt.js";
import { Speech, powershellArgs, sapiScript, estimateSpeechCost } from "../dist/voice-tts.js";
import { TalkMode, talkNext } from "../dist/voice-talk.js";
import { VoiceService, registerVoice, sttRouteFor, ttsRouteFor } from "../dist/voice-service.js";
import { chooseFromProfile, defaultProfiles, routeByProfile, saveProfileSettings } from "../dist/model-profiles.js";
import { findPreset, parseModelCommand, switchModel } from "../dist/model-switch.js";
import { countModels, modelsUrl } from "../dist/provider-probe.js";
import { geminiPresetFromToken, googleGeminiSignIn } from "../dist/gemini-signin.js";
import { saveVoiceSettings, voiceSettings } from "../dist/voice.js";

/**
 * Every test here uses stand-ins. Nothing opens a microphone, nothing plays a sound, nothing runs
 * PowerShell, and nothing leaves this computer: the speech services are little local HTTP servers
 * and the two programs Branch would start are replaced by a function that records its arguments.
 */
const openPolicy = () => new NetworkPolicy({ allowPrivateAddresses: true });
const clip = (name = "recording") => ({ bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), mediaType: "audio/webm", name, seconds: 60 });

/** A stand-in speech service that answers in whichever shape the test asks for. */
async function fakeService(t, routes) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let raw = Buffer.alloc(0);
    for await (const part of request) raw = Buffer.concat([raw, Buffer.from(part)]);
    seen.push({ url: request.url, headers: request.headers, length: raw.byteLength });
    const answer = routes[request.url] ?? routes[request.url.split("?")[0]];
    if (!answer) { response.writeHead(404).end("{}"); return; }
    const body = answer(raw, request);
    if (Buffer.isBuffer(body)) { response.writeHead(200, { "content-type": "audio/mpeg" }); response.end(body); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, endpoint: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t, presets) {
  const root = await mkdtemp(join(tmpdir(), "branch-voice7-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(presets ? { presets } : {}) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
const scripted = (name, text = "answered") => ({ name, calls: 0, async complete() { this.calls += 1; return { content: `${name} ${text}`, toolCalls: [] }; } });

/* ---------- V1: writing speech out, in all three shapes ---------- */

test("the three speech-to-text shapes are each read correctly, and each one reports its own cost", async (t) => {
  const service = await fakeService(t, {
    "/audio/transcriptions": () => ({ text: "hello from whisper", language: "en" }),
    "/v1beta/models/gemini-2.5-flash:generateContent": () => ({
      candidates: [{ content: { parts: [{ text: "hello from gemini" }] } }],
    }),
  });
  const ran = [];
  const stt = new Transcription(openPolicy(), fetch, async (file, args) => { ran.push({ file, args }); return "  [00:00.000 --> 00:01.000]  hello from this computer\n"; });

  const whisper = await stt.transcribe(clip(), { kind: "openai", provider: { endpoint: service.endpoint, apiKey: "sk-test" } });
  assert.equal(whisper.text, "hello from whisper");
  assert.equal(whisper.language, "en");
  assert.equal(whisper.route, "openai");
  // A minute of whisper-1 at the published price; never a guess, and never a made-up zero.
  assert.equal(whisper.cost.amount, 0.006);
  assert.equal(whisper.cost.confidence, "table");

  const gemini = await stt.transcribe(clip(), { kind: "gemini", provider: { endpoint: service.endpoint, apiKey: "goog-key" } });
  assert.equal(gemini.text, "hello from gemini");
  assert.equal(gemini.route, "gemini");
  assert.equal(gemini.cost.amount, null, "Gemini has no per-minute price on file, so no figure is invented");
  const geminiCall = service.seen.at(-1);
  assert.equal(geminiCall.headers["x-goog-api-key"], "goog-key", "a key goes in the header, never in the address");
  assert.ok(!geminiCall.url.includes("key="), "no credential is ever put in the address");

  const local = await stt.transcribe(clip(), { kind: "local", local: { executable: process.execPath, model: "ggml-base.en.bin", kind: "whisper-cpp" } });
  assert.equal(local.text, "hello from this computer");
  assert.equal(local.route, "local");
  assert.equal(local.cost.amount, 0, "a program on this computer genuinely costs nothing");
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].args.slice(0, 3), ["-f", ran[0].args[1], "--no-timestamps"]);
  assert.ok(!ran[0].args.some((arg) => /output/i.test(arg)), "the transcript is read from what the program prints, so no file is asked for");
});

test("the command line for each local speech program is built, and an unconfigured one refuses in plain words", async (t) => {
  const cpp = localSttArgs({ executable: "w.exe", model: "ggml.bin", kind: "whisper-cpp" }, "C:/tmp/clip.wav", "en");
  assert.ok(cpp.includes("-m") && cpp.includes("ggml.bin") && cpp.includes("-l") && cpp.includes("en"));
  assert.ok(!localSttArgs({ executable: "w.exe", model: "", kind: "whisper-cpp" }, "C:/tmp/clip.wav", null).includes("-m"));

  const stt = new Transcription(openPolicy(), fetch, async () => "");
  // RES-709: faster-whisper runs through its own worker (tests/voice-local-whisper.test.mjs), never with
  // whisper.cpp's flags; with no worker it refuses rather than starting the program the wrong way.
  await assert.rejects(
    stt.transcribe(clip(), { kind: "local", local: { executable: "C:/py/python.exe", model: "", kind: "faster-whisper" } }),
    /No speech program is set up on this computer/,
  );
  await assert.rejects(
    stt.transcribe(clip(), { kind: "local", local: { executable: "", model: "", kind: "whisper-cpp" } }),
    /No speech program is set up on this computer/,
  );
  assert.equal(estimateAudioCost("whisper-1", undefined, "openai").amount, null, "an unknown length means no price, not zero");
});

/* ---------- V1: a voice note on a chat app ---------- */

test("a voice note arriving on a channel is written out, answered, and quoted back", async (t) => {
  const { app } = await fixture(t);
  const heard = [];
  app.channels.transcribeVoice = async (audio) => { heard.push(audio); return "turn the heating up"; };
  const sent = [];
  const adapter = {
    id: "fake", kind: "fake",
    botName: () => "branch",
    async start(onMessage) { this.deliver = onMessage; },
    async send(chatId, text) { sent.push({ chatId, text }); return "m1"; },
    async stop() {},
  };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["speaker"] });
  const outcome = await app.channels.handle({
    channel: "fake", chatId: "chat-1", chatKind: "direct", senderId: "speaker", senderName: "Sam",
    text: "", addressed: true, messageId: "v1",
    voice: { mediaType: "audio/ogg", seconds: 3, bytes: async () => new Uint8Array([1, 2, 3]) },
  });
  assert.equal(outcome, "replied");
  assert.equal(heard.length, 1);
  assert.equal(heard[0].mediaType, "audio/ogg");
  assert.deepEqual([...heard[0].bytes], [1, 2, 3]);
  const reply = sent.find((entry) => entry.text.includes("You said"));
  assert.ok(reply, "the transcript is quoted back so the person can see what was heard");
  assert.match(reply.text, /You said \(from your voice note\): "turn the heating up"/);
  const run = app.store.runs("local").at(-1);
  assert.match(run.prompt, /turn the heating up/, "the words that were heard are what the task ran on");
});

test("a voice note that cannot be written out is refused in words, not silently dropped", async (t) => {
  const { app } = await fixture(t);
  const sent = [];
  const adapter = {
    id: "fake2", kind: "fake", botName: () => null,
    async start(onMessage) { this.deliver = onMessage; },
    async send(chatId, text) { sent.push(text); return "m2"; },
    async stop() {},
  };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["speaker"] });
  const outcome = await app.channels.handle({
    channel: "fake2", chatId: "c", chatKind: "direct", senderId: "speaker", senderName: "Sam",
    text: "", addressed: true, messageId: "v2",
    voice: { mediaType: "audio/ogg", bytes: async () => new Uint8Array([1]) },
  });
  assert.equal(outcome, "failed");
  assert.match(sent.join("\n"), /could not make out that voice note/);
});

/* ---------- V2: reading text aloud, including the offline Windows voice ---------- */

test("the OpenAI shape hands back sound, and the Windows voice is built as a script without being run", async (t) => {
  const service = await fakeService(t, { "/audio/speech": () => Buffer.from([0xff, 0xfb, 0x10, 0x00]) });
  const started = [];
  const speech = new Speech(openPolicy(), fetch, async (file, args) => { started.push({ file, args }); return ""; });
  const spoken = await speech.speak({ text: "hello", voice: "alloy", speed: 1 }, { kind: "openai", provider: { endpoint: service.endpoint, apiKey: "sk-test" } });
  assert.ok(spoken.bytes instanceof Uint8Array && spoken.bytes.byteLength === 4);
  assert.equal(spoken.mediaType, "audio/mpeg");
  assert.equal(spoken.cost.amount, estimateSpeechCost("tts-1", 5, "openai").amount);

  // The script itself is what is checked; running it would make a sound on the owner's computer.
  const script = sapiScript({ rate: 1.5, withVoice: true });
  assert.match(script, /Add-Type -AssemblyName System\.Speech/);
  assert.match(script, /\$speech\.Rate = 5/);
  assert.match(script, /\$speech\.Speak\(\$words\)/, "the words are read from a file, not written into the script");
  assert.match(script, /ReadAllText\(\(Join-Path \$here 'speech\.txt'\)/);
  assert.match(script, /SelectVoice\(\[System\.IO\.File\]::ReadAllText/);
  assert.ok(!sapiScript({ rate: 1, withVoice: false }).includes("SelectVoice"), "no voice chosen means no SelectVoice line");
  const args = powershellArgs("C:/tmp/speak.ps1");
  assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:/tmp/speak.ps1"]);
  assert.ok(!args.some((arg) => arg === "-Command"), "the words are never handed over as a command line");
  assert.equal(estimateSpeechCost("a-voice-nobody-priced", 100, "openai").amount, null);
  assert.equal(estimateSpeechCost("windows", 100, "windows").amount, 0);
  assert.equal(started.length, 0, "nothing was started for the OpenAI route");
});

test("a reply full of PowerShell never reaches PowerShell as anything but a data file", async (t) => {
  // Everything an attacker could hide in a reply, all at once.
  const nasty = "hi $(Start-Process calc) `\"; Start-Process calc; #` 'quoted' \"double\" ${env:PATH}";
  const script = sapiScript({ rate: 1, withVoice: true });
  for (const payload of ["Start-Process", "$(", "`", "quoted", "${env:"])
    assert.ok(!script.includes(payload), `the script must not carry ${payload}`);
  // The script is the same no matter what is being said: only the rate ever varies.
  assert.equal(sapiScript({ rate: 1, withVoice: true }), script);

  if (process.platform === "win32") {
    const started = [];
    const speech = new Speech(openPolicy(), fetch, async (file, args) => {
      started.push({ file, args });
      // Stand in for PowerShell: read the words the way the real script does, and write the wav.
      const folder = dirname(args[args.length - 1]);
      const words = await readFile(join(folder, "speech.txt"), "utf8");
      assert.equal(words, nasty, "the words arrive as a file, unchanged, including the non-ASCII ones");
      assert.equal(await readFile(join(folder, "voice.txt"), "utf8"), nasty);
      await writeFile(join(folder, "speech.wav"), Buffer.from("RIFF"));
      return "";
    });
    const spoken = await speech.speak({ text: nasty, voice: nasty, speed: 1 }, { kind: "windows" });
    assert.equal(spoken.route, "windows");
    assert.equal(spoken.cost.amount, 0);
    assert.equal(started.length, 1);
    assert.equal(started[0].file, "powershell.exe");
    assert.deepEqual(started[0].args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
    assert.match(started[0].args[5], /\.ps1$/, "the only thing handed over is the path of a script file");
    for (const argument of started[0].args)
      assert.ok(!argument.includes("Start-Process"), "no part of the reply is ever an argument");
    const written = await readFile(started[0].args[5], "utf8").catch(() => "");
    assert.equal(written, "", "the temporary folder is removed once the sound has been read back");
  }
  // The child is started with no console window, asserted on the options the runner is built from.
  assert.equal(hiddenChildOptions.windowsHide, true);
});

test("Gemini reads text aloud through its own route and hands back the sound inline", async (t) => {
  const service = await fakeService(t, {
    "/v1beta/models/gemini-2.5-flash-preview-tts:generateContent": () => ({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: Buffer.from("sound").toString("base64") } }] } }],
    }),
  });
  const speech = new Speech(openPolicy(), fetch, async () => "");
  const spoken = await speech.speak({ text: "hello", voice: "Kore", speed: 1 }, { kind: "gemini", provider: { endpoint: service.endpoint, apiKey: "goog" } });
  assert.equal(Buffer.from(spoken.bytes).toString("utf8"), "sound");
  assert.equal(spoken.route, "gemini");
  assert.equal(spoken.voice, "Kore");
});

/* ---------- V4: keeping audio on this computer ---------- */

test("\"keep audio on this computer\" refuses every route that would send it away, including the tool", async (t) => {
  const stt = new Transcription(openPolicy(), fetch, async () => "local words");
  await assert.rejects(
    stt.transcribe(clip(), { kind: "openai", provider: { endpoint: "https://example.test", apiKey: "k" } }, { keepOnThisComputer: true }),
    /not sent anywhere/,
  );
  const speech = new Speech(openPolicy(), fetch, async () => "");
  await assert.rejects(
    speech.speak({ text: "hi", voice: "", speed: 1 }, { kind: "openai", provider: { endpoint: "https://example.test", apiKey: "k" } }, { keepOnThisComputer: true }),
    /nothing was sent away/,
  );

  // The tool path, proved without starting a program or letting a single request leave: the fake
  // network counts every call, and the stand-in for PowerShell refuses to pretend it ran.
  const spoken = await fakeService(t, { "/audio/speech": () => Buffer.from([0xff, 0xfb]) });
  const { app, root } = await fixture(t, [{
    id: "cloud", name: "Cloud",
    provider: new OpenAIProvider({ endpoint: spoken.endpoint, model: "gpt-4o", apiKey: "sk-test" }), model: "gpt-4o",
  }]);
  let reached = 0;
  const counted = (input, init) => { reached += 1; return fetch(input, init); };
  const registry = new ToolRegistry();
  const voice = new VoiceService(app.store, app.runtime.models, openPolicy(), counted,
    async () => { throw new Error("no program was started in this test"); });
  registerVoice(registry, voice, app.store);
  const run = await app.runtime.run({ prompt: "say something" });
  const context = app.runtime.context({ runId: run.id });

  saveVoiceSettings(app.store, "local", { ...voiceSettings(app.store, "local"), ttsRoute: "openai", useProviderVoice: true });
  const allowed = await registry.execute("voice.say", { text: "read this out", voice: "", speed: 1 }, context);
  assert.equal(allowed.route, "openai");
  assert.equal(reached, 1, "with the setting off, the words do go to the provider");
  const recorded = app.store.events(run.id).filter((event) => event.kind === "voice.spoken").map((event) => event.data);
  assert.equal(recorded.length, 1, "what it cost is written into the task's own record");
  assert.equal(recorded[0].route, "openai");
  assert.equal(recorded[0].cost, estimateSpeechCost("tts-1", "read this out".length, "openai").amount);

  // mac2: the computer's own voice ships switched off; it is switched on here so the refusal below
  // is the one this test is about.
  saveVoiceSettings(app.store, "local", { ...voiceSettings(app.store, "local"), keepAudioOnThisComputer: true, systemVoice: "on" });
  await assert.rejects(
    registry.execute("voice.say", { text: "read this out", voice: "", speed: 1 }, context),
    /no program was started in this test|part of Windows|no system voice on this computer|spd-say/,
    "the refusal lives in the service, so the tool cannot go round it",
  );
  assert.equal(reached, 1, "with the setting on, nothing at all left this computer");

  // The sound tools in the media toolbox are a second way out, so they are held to the same
  // promise: with the setting on, neither of them reaches a service, wired to voice or not.
  await writeFile(join(root, "workspace", "clip.wav"), Buffer.from("RIFF0000WAVE"));
  for (const wired of [undefined, voice]) {
    app.media.voice = wired;
    await assert.rejects(
      app.registry.execute("media.speak", { text: "read this out", voice: "" }, context),
      /stay on this computer|no program was started in this test|part of Windows|no system voice on this computer|spd-say/,
    );
    await assert.rejects(
      app.registry.execute("media.transcribe", { path: "clip.wav", timestamps: false }, context),
      /stay on this computer|No speech program is set up/,
    );
  }
  app.media.voice = undefined;
  assert.equal(reached, 1, "the media tools sent nothing away either");

  // The chosen route itself says "this computer" whenever the setting is on.
  const settings = voiceSettings(app.store, "local");
  assert.equal(sttRouteFor(settings, undefined).kind, "local");
  assert.equal(ttsRouteFor(settings, undefined).kind, "windows");
  assert.match(sttRouteFor(settings, undefined).reason, /stay on this computer/);
});

/* ---------- V3: the talk-mode state machine ---------- */

test("talk mode goes idle, listening, thinking, speaking and back, and pressing again interrupts", () => {
  const talk = new TalkMode();
  assert.equal(talk.state, "idle");
  assert.equal(talk.send("press").state, "listening");
  assert.equal(talk.send("release").state, "thinking");
  assert.equal(talk.send("transcribed").state, "thinking");
  assert.equal(talk.send("answered").state, "speaking");
  const stopped = talk.send("press");
  assert.equal(stopped.state, "idle");
  assert.equal(stopped.stopSound, true, "pressing while it is speaking cuts it off");
  assert.match(talk.status, /Hold the Talk button/);

  talk.send("press");
  assert.equal(talk.send("failed").state, "idle", "a failure always returns to idle");
  assert.equal(talkNext("listening", "answered").state, "listening", "an event that makes no sense changes nothing");
  assert.equal(talkNext("speaking", "spoken").state, "idle");
  assert.equal(talkNext("thinking", "interrupt").stopSound, true);
});

/* ---------- M1: switching model for one conversation ---------- */

test("switching the model changes one conversation and leaves every other one alone", async (t) => {
  const alpha = scripted("alpha"), beta = scripted("beta");
  const { app } = await fixture(t, [
    { id: "alpha", name: "Alpha", provider: alpha, model: "alpha-1" },
    { id: "beta", name: "Beta", provider: beta, model: "beta-9" },
  ]);
  const first = await app.runtime.run({ prompt: "one" });
  const other = await app.runtime.run({ prompt: "elsewhere" });
  const result = switchModel(app.runtime.models, "local", first.sessionId, "Beta");
  assert.equal(result.preset, "beta");
  assert.match(result.message, /now uses Beta \(beta-9\)/);
  assert.equal(app.runtime.models.plan("local", first.sessionId).choice.presetId, "beta");
  assert.equal(app.runtime.models.plan("local", other.sessionId).choice.presetId, "alpha", "the other conversation is untouched");

  // The tool finds the conversation from the task it is part of.
  const context = app.runtime.context({ runId: other.id });
  const viaTool = await app.registry.execute("models.switch", { model: "beta-9" }, context);
  assert.equal(viaTool.preset, "beta");
  assert.equal(app.runtime.models.plan("local", other.sessionId).choice.presetId, "beta");

  const back = switchModel(app.runtime.models, "local", first.sessionId, "default");
  assert.equal(back.preset, null);
  assert.equal(app.runtime.models.plan("local", first.sessionId).choice.presetId, "alpha");
  assert.throws(() => switchModel(app.runtime.models, "local", first.sessionId, "gamma"), /no connection called "gamma"/);
  assert.equal(findPreset(app.runtime.models, "ALPHA"), "alpha");
  assert.deepEqual(parseModelCommand("/model Beta"), { list: false, wanted: "Beta" });
  assert.deepEqual(parseModelCommand("/model"), { list: true });
  assert.equal(parseModelCommand("what model are you"), null);
});

/* ---------- M2: routing profiles ---------- */

test("a routing profile tries its connections in order and says which rule fired", async (t) => {
  const alpha = scripted("alpha"), beta = scripted("beta"), gamma = scripted("gamma");
  const { app } = await fixture(t, [
    { id: "alpha", name: "Alpha", provider: alpha, model: "gpt-4o" },
    { id: "beta", name: "Beta", provider: beta, model: "gpt-4o-mini" },
    { id: "gamma", name: "Gamma", provider: gamma, model: "gpt-4o-mini" },
  ]);
  const built = defaultProfiles(app.runtime.models);
  assert.deepEqual(built.map((profile) => profile.id), ["cheap-and-fast", "best-quality", "private", "long-context"]);
  assert.equal(built.find((profile) => profile.id === "cheap-and-fast").fallback.preset, "beta", "the cheapest priced model goes first");
  assert.equal(built.find((profile) => profile.id === "best-quality").fallback.preset, "alpha");
  assert.equal(built.find((profile) => profile.id === "private").fallback, undefined, "no local connection means the profile is honestly empty");

  const profile = { id: "mine", name: "Mine", description: "", routes: { chat: { preset: "alpha", fallbacks: ["beta", "gamma"] } } };
  const plain = chooseFromProfile(profile, "chat", () => true, () => false);
  assert.equal(plain.preset, "alpha");
  assert.match(plain.reason, /The "Mine" profile sends chat work to alpha/);

  const resting = chooseFromProfile(profile, "chat", () => true, (id) => id === "alpha");
  assert.equal(resting.preset, "beta");
  assert.match(resting.reason, /asked for alpha first .* it was not available, so beta took it/);

  const twoGone = chooseFromProfile(profile, "chat", () => true, (id) => id !== "gamma");
  assert.equal(twoGone.preset, "gamma");
  assert.match(twoGone.reason, /alpha, beta.*none were available/);

  const nothing = chooseFromProfile(profile, "chat", () => false, () => false);
  assert.equal(nothing.preset, null);
  assert.match(nothing.reason, /no longer set up, so your usual choice answered/);
  assert.match(chooseFromProfile(null, "chat", () => true, () => false).reason, /No routing profile is switched on/);

  // Saved as data, switched on, and the reason reaches the run's own record.
  saveProfileSettings(app.store, "local", app.runtime.models, { active: "mine", profiles: [...built, profile] });
  assert.equal(routeByProfile(app.store, app.runtime.models, "local", "chat").preset, "alpha");
  const run = await app.runtime.run({ prompt: "which model" });
  const routed = app.store.events(run.id).filter((event) => event.kind === "model.routed").map((event) => event.data);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].preset, "alpha");
  assert.match(routed[0].reason, /The "Mine" profile sends chat work to alpha/);
  assert.throws(() => saveProfileSettings(app.store, "local", app.runtime.models, { active: "nope" }), /no routing profile called nope/i);
});

/* ---------- M3: signing in with Google, honestly scoped ---------- */

test("a Google sign-in token is sent as a bearer for Gemini only when one is configured", async (t) => {
  const service = await fakeService(t, {
    "/v1beta/models/gemini-2.5-flash:generateContent": () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
  });
  const signIn = googleGeminiSignIn("client-123.apps.googleusercontent.com");
  assert.equal(signIn.id, "google-gemini");
  assert.match(signIn.authorizeUrl, /^https:\/\/accounts\.google\.com\//);
  assert.equal(signIn.extra.access_type, "offline");

  const withKey = new GeminiProvider({ endpoint: service.endpoint, model: "gemini-2.5-flash", apiKey: "plain-key" });
  await withKey.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: AbortSignal.timeout(5000), maxTokens: 16 });
  assert.equal(service.seen.at(-1).headers["x-goog-api-key"], "plain-key");
  assert.equal(service.seen.at(-1).headers.authorization, undefined, "a key is never sent as a bearer");

  const preset = geminiPresetFromToken("google-gemini", "Gemini (signed in)", "gemini-2.5-flash", "ya29.token");
  preset.provider = new GeminiProvider({ endpoint: service.endpoint, model: "gemini-2.5-flash", apiKey: "ya29.token", bearer: true });
  await preset.provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: AbortSignal.timeout(5000), maxTokens: 16 });
  assert.equal(service.seen.at(-1).headers.authorization, "Bearer ya29.token");
  assert.equal(service.seen.at(-1).headers["x-goog-api-key"], undefined);
  assert.ok(!service.seen.at(-1).url.includes("key="), "no credential goes in the address either way");
  assert.equal(preset.provider.audio().bearer, true);
});

/* ---------- M4: checking what each connection can do ---------- */

test("the connection check asks each service what it has, and reads both answer shapes", async (t) => {
  const openai = new OpenAIProvider({ endpoint: "https://api.openai.test/v1", model: "gpt-4o", apiKey: "sk-x" });
  const target = modelsUrl(openai);
  assert.equal(target.url, "https://api.openai.test/v1/models");
  assert.equal(target.headers.authorization, "Bearer sk-x");
  const gemini = modelsUrl(new GeminiProvider({ endpoint: "https://gemini.test", model: "gemini-2.5-flash", apiKey: "gk" }));
  assert.equal(gemini.url, "https://gemini.test/v1beta/models");
  assert.equal(gemini.headers["x-goog-api-key"], "gk");
  assert.equal(modelsUrl({ name: "text-only" }), null);
  assert.equal(countModels({ data: [1, 2, 3] }), 3);
  assert.equal(countModels({ models: [1] }), 1);
  assert.equal(countModels({ nothing: true }), null);

  const service = await fakeService(t, { "/models": () => ({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }) });
  const { app } = await fixture(t, [
    { id: "live", name: "Live", provider: new OpenAIProvider({ endpoint: service.endpoint, model: "gpt-4o", apiKey: "sk-test" }), model: "gpt-4o" },
  ]);
  const { probeAll } = await import("../dist/provider-probe.js");
  const [probe] = await probeAll(app.runtime.models, openPolicy(), fetch);
  assert.equal(probe.signedIn, true);
  assert.equal(probe.models, 2);
  assert.equal(probe.supportsAudio, true);
  assert.equal(probe.supportsImages, true);
  assert.equal(probe.supportsEmbeddings, true);
  assert.match(probe.summary, /Live answered with 2 model\(s\)/);
});

test("a connection whose key is refused says so and says what to do about it", async (t) => {
  const server = createServer((request, response) => { response.writeHead(401).end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const { app } = await fixture(t, [
    { id: "stale", name: "Stale", provider: new OpenAIProvider({ endpoint, model: "gpt-4o", apiKey: "sk-old" }), model: "gpt-4o" },
  ]);
  const { probeProvider } = await import("../dist/provider-probe.js");
  const probe = await probeProvider(app.runtime.models, "stale", openPolicy(), fetch);
  assert.equal(probe.signedIn, false);
  assert.match(probe.summary, /answered 401/);
  assert.match(probe.fix, /Put a fresh one in under Settings/);
});

/* ---------- V4: the settings screen's own sentences ---------- */

test("the voice plan says which service would do the work and where the sound would go", async (t) => {
  const { app } = await fixture(t);
  const { voicePlan, whereAudioGoes } = await import("../dist/voice-api.js");
  const deps = { store: app.store, models: app.runtime.models, owner: "local", voice: app.voice, policy: app.web.policy, fetch };
  const plan = voicePlan(deps);
  assert.ok(plan.prices.perMinute["whisper-1"] > 0);
  // Wave 8: a live conversation exists now, so the note says what one needs rather than that there
  // is none, and the Voice screen also reports whether this connection can hold one.
  assert.match(plan.realtimeNote, /live conversation/);
  assert.equal(plan.live.available, false, "the connection in this test cannot hold one, and the screen says so");
  assert.match(whereAudioGoes("local", "windows"), /Nothing leaves this computer/);
  assert.match(whereAudioGoes("openai", "openai"), /sent to your model provider/);
  saveVoiceSettings(app.store, "local", { ...voiceSettings(app.store, "local"), keepAudioOnThisComputer: true });
  assert.match(voicePlan(deps).whereAudioGoes, /Nothing leaves this computer/);
});
