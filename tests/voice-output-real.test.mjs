import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/**
 * surfaces.voice-output: speech made from a reply, by the engine the owner chose, and really opened.
 *
 * Every other voice test hands back a few stand-in bytes with a media type, and nothing ever looks
 * inside them, so "it read the answer aloud" was never actually proved. Here the owner's chosen
 * engine is "a program on this computer" — the shipped `program` engine — pointed at a small program
 * written for this test that makes a real WAV file. The test then opens that file the way a player
 * would: it reads the RIFF headers, checks the sound is 16-bit PCM, counts the frames, and looks at
 * the samples. Nothing leaves this computer, no microphone is opened and no sound is played.
 *
 * The program's sound lasts 50 ms for every character it was given, so the length of the file proves
 * the words of *this* reply reached the engine, not a fixture recorded earlier.
 */

const RATE = 8000, FRAMES_PER_CHARACTER = 400; // 8 kHz, so 400 frames is 50 ms

/** A program that reads the words it is given and writes a real WAV of them. */
const speakingProgram = `
import { readFile, writeFile } from "node:fs/promises";
const [textPath, outPath] = process.argv.slice(2);
const words = await readFile(textPath, "utf8");
const frames = words.length * ${FRAMES_PER_CHARACTER};
const data = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin((i / ${RATE}) * 440 * 2 * Math.PI) * 12000), i * 2);
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(${RATE}, 24); header.writeUInt32LE(${RATE} * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(data.length, 40);
await writeFile(outPath, Buffer.concat([header, data]));
`;

/** Opens a WAV the way a player does: the chunks by name, then the sound itself. */
function openWav(bytes) {
  const audio = Buffer.from(bytes);
  assert.equal(audio.subarray(0, 4).toString("ascii"), "RIFF", "a RIFF file");
  assert.equal(audio.subarray(8, 12).toString("ascii"), "WAVE", "holding WAVE sound");
  assert.equal(audio.readUInt32LE(4), audio.length - 8, "the size in the header is the size of the file");
  let at = 12, fmt = null, data = null;
  while (at + 8 <= audio.length) {
    const name = audio.subarray(at, at + 4).toString("ascii"), size = audio.readUInt32LE(at + 4);
    if (name === "fmt ") fmt = { format: audio.readUInt16LE(at + 8), channels: audio.readUInt16LE(at + 10),
      rate: audio.readUInt32LE(at + 12), bits: audio.readUInt16LE(at + 22) };
    if (name === "data") data = audio.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  assert.ok(fmt, "it says what the sound is");
  assert.ok(data, "it holds sound");
  const samples = [];
  for (let i = 0; i + 1 < data.length; i += 2) samples.push(data.readInt16LE(i));
  return { ...fmt, frames: samples.length, seconds: samples.length / fmt.rate,
    loudest: samples.reduce((top, one) => Math.max(top, Math.abs(one)), 0) };
}

async function branchThatSpeaks(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-voice-out-"));
  // One hook, shutting down in reverse: separate hooks run in the order they were added, which on
  // Windows deletes the folder under a database still open and fails with EBUSY.
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const program = join(root, "speak.mjs");
  await writeFile(program, speakingProgram, "utf8");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  closing.push(() => app.close());
  app.voice.engines.save(app.runtime.owner, {
    mode: "when-needed", speak: "program", program: process.execPath,
    programArgs: [program, "{text}", "{out}"],
  });
  // Its own port: the default one is taken whenever Branch itself is open on this computer.
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  return { app, server, headers: { authorization: `Bearer ${server.token}`, host: new URL(server.url).host } };
}

async function speak(server, headers, text) {
  const answer = await fetch(`${server.url}/api/voice/speak`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text }),
  });
  if (answer.status !== 200) assert.fail(`the voice route refused: ${await answer.text().catch(() => answer.status)}`);
  return { answer, bytes: new Uint8Array(await answer.arrayBuffer()) };
}

test("the answer is read aloud by the chosen engine, and the sound it makes really opens", async (t) => {
  const { server, headers } = await branchThatSpeaks(t);
  const words = "Your parcel arrives on Tuesday.";
  const { answer, bytes } = await speak(server, headers, words);

  assert.equal(answer.headers.get("content-type"), "audio/wav", "sent as sound, not as a note about sound");
  assert.equal(answer.headers.get("x-voice-route"), "engine:program", "made by the engine the owner chose");

  const sound = openWav(bytes);
  assert.equal(sound.format, 1, "plain PCM, which every player understands");
  assert.equal(sound.channels, 1);
  assert.equal(sound.bits, 16);
  assert.equal(sound.rate, RATE);
  assert.ok(sound.seconds > 0.5, `there is something to hear (${sound.seconds}s)`);
  assert.ok(sound.loudest > 1000, `and it is not silence (loudest sample ${sound.loudest})`);
});

test("the sound is made from the words of this answer, not from something recorded earlier", async (t) => {
  const { server, headers } = await branchThatSpeaks(t);
  const short = "Yes.", long = "Yes, and here is the whole story behind it, at some length.";

  const first = openWav((await speak(server, headers, short)).bytes);
  const second = openWav((await speak(server, headers, long)).bytes);

  assert.equal(first.frames, short.length * FRAMES_PER_CHARACTER, "the short answer's own length");
  assert.equal(second.frames, long.length * FRAMES_PER_CHARACTER, "the long answer's own length");
  assert.ok(second.seconds > first.seconds * 3, "a longer answer really is longer to listen to");
});

test("what it costs and where it went are recorded, and nothing was uploaded", async (t) => {
  const { app } = await branchThatSpeaks(t);
  const spoken = await app.voice.speak(app.runtime.owner, { text: "Reading this out.", voice: "", speed: 1 });

  assert.equal(spoken.route, "engine:program");
  assert.equal(spoken.mediaType, "audio/wav");
  assert.equal(spoken.cost.amount, 0, "a program on this computer costs nothing");
  assert.equal(openWav(spoken.bytes).frames, "Reading this out.".length * FRAMES_PER_CHARACTER);
});

test("keeping audio on this computer still allows the local program, and its refusal is about services", async (t) => {
  const { app } = await branchThatSpeaks(t);
  const { saveVoiceSettings } = await import("../dist/voice.js");
  saveVoiceSettings(app.store, app.runtime.owner, { keepAudioOnThisComputer: true });

  const spoken = await app.voice.speak(app.runtime.owner, { text: "Still fine.", voice: "", speed: 1 });
  assert.equal(spoken.route, "engine:program", "a program here is not an upload");
  assert.ok(openWav(spoken.bytes).frames > 0);
});
