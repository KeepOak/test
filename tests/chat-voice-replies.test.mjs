/**
 * UP-CHAT-005 (CHAT-093, CHAT-094): spoken replies that play as voice bubbles.
 * - Telegram gets OGG/Opus through sendVoice, and sendAudio only for sound it could not convert.
 * - Gemini's raw PCM is wrapped as WAV.
 * - Markdown is stripped before speech.
 * Every service is a stand-in; nothing leaves this computer. The one real ffmpeg conversion is skipped where ffmpeg is absent.
 *
 * Mutation notes (each turns this file red):
 * - telegram.ts sendVoice: always sendAudio               -> "OGG/Opus goes out as a voice bubble" fails.
 * - voice-tts.ts gemini: drop pcmAsWav                     -> "Gemini's PCM comes back as a WAV" fails.
 * - voice-service.ts speak: pass input.text, not spokenText -> "the voice reads sentences" fails.
 * - voice-tts.ts openai: drop response_format              -> "asks OpenAI for Opus" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { TelegramAdapter } from "../dist/channels/telegram.js";
import { Speech, findOnPath } from "../dist/voice-tts.js";
import { readWav } from "../dist/media-audio.js";
import { runProgram } from "../dist/voice-stt.js";
import { spokenText, pcmAsWav, soundType, toOggOpus, oggOpusArgs } from "../dist/voice-note.js";
import { createBranch } from "../dist/index.js";

const openPolicy = { assertAllowed: async () => undefined };
const provider = { endpoint: "https://speech.example.test/v1", apiKey: "test-key" };

test("the voice reads sentences: no Markdown marks, code, links or emoji, cut at a whole sentence", () => {
  const said = spokenText("# Plan\n**Bold** and _soft_ words with `npm test`.\n- first [docs](https://example.test/x)\n- second 🎉\n```js\nconst x = 1;\n```\n> quoted\n| a | b |");
  assert.doesNotMatch(said, /[*`#>|]|https?:|const x|🎉/, said);
  assert.match(said, /Plan\. Bold and soft words with npm test\. first docs\. second\./);
  assert.equal(spokenText("snake_case_name stays, 2 * 3 * 4 stays."), "snake_case_name stays, 2 * 3 * 4 stays.");
  const long = spokenText(`${"One sentence here. ".repeat(20)}And a tail that runs past`, 100);
  assert.ok(long.length <= 100 && long.endsWith("."), long);
  assert.equal(spokenText("```\nonly code\n```"), "");
});

test("Gemini's PCM comes back as a WAV that opens, at the rate it named", async () => {
  const pcm = Buffer.alloc(4800);
  const wrapped = pcmAsWav(new Uint8Array(pcm), "audio/L16;codec=pcm;rate=24000");
  const read = readWav(Buffer.from(wrapped.bytes));
  assert.deepEqual([wrapped.mediaType, read.sampleRate, read.channels, read.bitsPerSample, read.samples.length], ["audio/wav", 24000, 1, 16, 4800]);
  assert.equal(pcmAsWav(new Uint8Array([1]), "audio/mpeg").mediaType, "audio/mpeg", "a container is left alone");
  const fetch = async () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }] });
  const spoken = await new Speech(openPolicy, fetch).speak({ text: "hello", voice: "", speed: 1 }, { kind: "gemini", provider });
  assert.equal(spoken.mediaType, "audio/wav");
  assert.equal(Buffer.from(spoken.bytes.subarray(0, 4)).toString("latin1"), "RIFF");
});

test("asks OpenAI for Opus for a voice note, and believes the bytes over the request", async () => {
  const bodies = [];
  const answer = (bytes) => async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(bytes); };
  const ogg = await new Speech(openPolicy, answer(Buffer.from("OggS\0\0\0\0\0\0\0\0rest"))).speak({ text: "hi", voice: "", speed: 1 }, { kind: "openai", provider }, { voiceNote: true });
  assert.equal(bodies.at(-1).response_format, "opus");
  assert.equal(ogg.mediaType, "audio/ogg");
  const ignored = await new Speech(openPolicy, answer(Buffer.from("ID3\u0004rest"))).speak({ text: "hi", voice: "", speed: 1 }, { kind: "openai", provider }, { voiceNote: true });
  assert.equal(ignored.mediaType, "audio/mpeg", "a server that sent MP3 anyway is read as MP3");
  await new Speech(openPolicy, answer(Buffer.from("ID3"))).speak({ text: "hi", voice: "", speed: 1 }, { kind: "openai", provider });
  assert.equal(bodies.at(-1).response_format, undefined, "reading aloud in the window keeps MP3");
  assert.equal(soundType(new Uint8Array(Buffer.from("RIFF\0\0\0\0WAVE")), "x"), "audio/wav");
});

test("Telegram: OGG/Opus goes out as a voice bubble; sound it could not convert goes as an audio file", async () => {
  const sent = [];
  const adapter = new TelegramAdapter({ id: "tg", token: "fake", pollTimeoutSeconds: 0,
    fetch: async (url, init) => { sent.push({ method: String(url).split("/").at(-1), body: init.body }); return Response.json({ ok: true, result: { message_id: 9 } }); } });
  assert.equal(adapter.voiceNoteType, "audio/ogg");
  assert.equal(await adapter.sendVoice("42", new Uint8Array([1, 2]), "audio/ogg", "17"), "9");
  await adapter.sendVoice("42", new Uint8Array([1, 2]), "audio/mpeg");
  assert.deepEqual(sent.map((s) => s.method), ["sendVoice", "sendAudio"]);
  assert.ok(sent[0].body.get("voice"), "the voice field");
  assert.equal(sent[0].body.get("voice").name, "reply.ogg");
  assert.deepEqual(JSON.parse(sent[0].body.get("reply_parameters")), { message_id: 17, allow_sending_without_reply: true });
  assert.equal(sent[1].body.get("audio").name, "reply.mp3");
});

test("conversion: ffmpeg makes OGG/Opus; with no ffmpeg or a failed run the sound is kept as it was", async () => {
  const mp3 = { bytes: new Uint8Array([7, 7]), mediaType: "audio/mpeg" };
  assert.equal(await toOggOpus(mp3, null, runProgram), mp3);
  assert.equal(await toOggOpus(mp3, "ffmpeg", async () => { throw new Error("broken"); }), mp3);
  const already = { bytes: new Uint8Array([1]), mediaType: "audio/ogg" };
  assert.equal(await toOggOpus(already, "ffmpeg", async () => { throw new Error("never run"); }), already);
  assert.ok(oggOpusArgs("in", "out.ogg").join(" ").includes("-c:a libopus"), "Opus, not ffmpeg's Vorbis default");
});

test("conversion with this computer's real ffmpeg, when it has one", async (t) => {
  const ffmpeg = findOnPath(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (!ffmpeg) return t.skip("no ffmpeg on this computer");
  const wav = pcmAsWav(new Uint8Array(Buffer.alloc(48000)), "audio/L16;codec=pcm;rate=24000");
  const note = await toOggOpus(wav, ffmpeg, runProgram);
  assert.equal(note.mediaType, "audio/ogg");
  assert.equal(Buffer.from(note.bytes.subarray(0, 4)).toString("latin1"), "OggS");
  assert.match(Buffer.from(note.bytes.subarray(0, 64)).toString("latin1"), /OpusHead/);
});

test("the router asks for the app's voice-bubble sound, with the reply's words", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-voice-reply-"));
  const model = { name: "scripted", async complete() { return { content: "**Done.** See `notes.md`.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.transcribeVoice = async () => "what is new";
  const asked = [], voices = [];
  app.channels.speakReply = async (text, type) => { asked.push([text, type]); return { bytes: new Uint8Array([1]), mediaType: "audio/ogg" }; };
  await app.channels.attach({ id: "tg", kind: "telegram", voiceNoteType: "audio/ogg", botName: () => "bot", async start() {}, async stop() {},
    async send() { return "1"; }, async sendVoice(_chat, _audio, mediaType) { voices.push(mediaType); return "2"; } }, { pairing: false, allowlist: ["ann"] });
  await app.channels.handle({ channel: "tg", chatId: "c1", chatKind: "direct", senderId: "ann", senderName: "Ann", text: "", addressed: true, messageId: "v1",
    voice: { mediaType: "audio/ogg", seconds: 2, bytes: async () => new Uint8Array([0]) } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0][1], "audio/ogg");
  assert.deepEqual(voices, ["audio/ogg"]);
});

test("every route is handed sentences: the engine the owner chose gets no Markdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-voice-words-"));
  const program = join(root, "echo.mjs");
  // Writes the words it was given as its "sound", so the test can read exactly what the voice would have read.
  await writeFile(program, 'import { copyFile } from "node:fs/promises"; const [a, b] = process.argv.slice(2); await copyFile(a, b);', "utf8");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.voice.engines.save(app.runtime.owner, { mode: "when-needed", speak: "program", program: process.execPath, programArgs: [program, "{text}", "{out}"] });
  const spoken = await app.voice.speak(app.runtime.owner, { text: "## Result\n**All 3 tests** passed, see [the log](https://ci.example.test/1).", voice: "", speed: 1 });
  assert.equal(Buffer.from(spoken.bytes).toString("utf8"), "Result. All 3 tests passed, see the log.");
  await assert.rejects(app.voice.speak(app.runtime.owner, { text: "```\ncode\n```", voice: "", speed: 1 }), /no words/);
});
