import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Budget } from "../dist/contracts.js";
import { ToolRegistry } from "../dist/registry.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import {
  captionArgs, convertArgs, downloadArgs, frameArgs, locateProgram, mediaProgramsMode, mediaProgramsOff, MediaProgramsSchema,
  parseVtt, safeReaders, saveMediaProgramsSettings, scratchEnding, soundTrackArgs, webAddress,
} from "../dist/media-programs.js";
import { execFileSync } from "node:child_process";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { findOnPath } from "../dist/voice-tts.js";
import { MediaUnderstanding, registerMediaUnderstanding, mediaProgramTools } from "../dist/media-understand.js";

/**
 * Bucket 17: videos understood rather than merely listed. Nothing here starts ffmpeg or yt-dlp:
 * the programs are a function that records its arguments and writes the files the real one would.
 */
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const quietPolicy = () => new NetworkPolicy({}, async () => ["93.184.216.34"]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-b17-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}
function context(app, overrides = {}) {
  return {
    owner: "local", workspace: app.runtime.workspace, runId: "videorun", signal: AbortSignal.timeout(20000),
    budget: new Budget(), permissions: new Set(["media.read", "media.write", "web.read"]), depth: 0, ...overrides,
  };
}
/** Stands in for ffmpeg and yt-dlp: writes what each call would have written. */
function fakePrograms({ sound = true } = {}) {
  const ran = [];
  const run = async (file, args) => {
    ran.push({ file, args });
    const out = args.at(-1);
    if (args.includes("-vf")) {
      for (let at = 1; at <= Number(args[args.indexOf("-frames:v") + 1]); at += 1)
        await writeFile(join(dirname(out), `frame-0${at}.jpg`), jpeg);
    } else if (args.includes("-vn")) {
      if (!sound) throw new Error("Output file #0 does not contain any stream");
      await writeFile(out, Buffer.from("RIFF....WAVE"));
    } else if (args.includes("--skip-download")) {
      await writeFile(join(args[args.indexOf("-P") + 1], "captions.en.vtt"),
        "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello <c>there</c>\n\n00:00:02.000 --> 00:00:04.000\nhello there\nand welcome &amp; enjoy\n");
    } else if (args.includes("--no-playlist")) {
      await writeFile(join(args[args.indexOf("-P") + 1], "A_clip-abc123.mp4"), Buffer.from("fake video"));
    }
    return "";
  };
  return { ran, run };
}
/** The media tools a MediaUnderstanding leans on, with a model that can see and a voice that hears. */
function fakeMedia(app, files, seen) {
  return {
    voice: { async transcribe(owner, clip) { seen.heard.push(clip); return { text: "we are building a treehouse" }; } },
    async bytesOf(path) { if (!(path in files)) throw new Error(`${path} is missing`); return files[path]; },
    seeing() { return { name: "seeing" }; },
    async look(ctx, question, pictures) { seen.looked.push({ question, pictures }); return { model: "seeing", answer: "Two people build a treehouse." }; },
    artifactStore: () => app.artifacts,
    savePath: (owner, name) => `media/${name}`,
    async keep(owner, name, bytes) { seen.kept.push({ name, bytes }); return { path: `media/${name}`, bytes: bytes.length }; },
  };
}
function understanding(app, media, programs, policy = quietPolicy(), extra = {}) {
  return new MediaUnderstanding({ store: app.store, media, policy, run: programs.run, find: (name) => `/usr/local/bin/${name.replace(/\.exe$/, "")}`, ...extra }); // Windows asks for ffmpeg.exe
}

test("the ffmpeg and yt-dlp argument lists are exact, and no address can become an option", () => {
  const readers = ["-format_whitelist", safeReaders, "-protocol_whitelist", "file"];
  assert.deepEqual(frameArgs("/t/in.mp4", "/t", 4, 20), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...readers, "-i", "/t/in.mp4", "-vf", "fps=0.200000,scale='min(768,iw)':-2", "-frames:v", "4", "-q:v", "4", join("/t", "frame-%02d.jpg")]);
  assert.match(frameArgs("/t/in.mkv", "/t", 2, null)[12], /^fps=0\.100000,/, "an unknown length takes one picture every ten seconds");
  assert.deepEqual(soundTrackArgs("/t/in.mp4", "/t/s.wav").slice(5), [...readers, "-i", "/t/in.mp4", "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "/t/s.wav"]);
  assert.deepEqual(convertArgs("/t/a.m4a", "/t/o.mp3", "mp3").slice(12), ["-codec:a", "libmp3lame", "-q:a", "4", "-f", "mp3", "/t/o.mp3"]);
  const download = downloadArgs("https://example.com/v?id=1", "/t", { soundOnly: true, maxMb: 50, ffmpeg: "/bin/ffmpeg" });
  assert.equal(download[0], "--ignore-config", "no settings file on this computer can add a command");
  assert.deepEqual(download.slice(-2), ["--", "https://example.com/v?id=1"]);
  assert.ok(download.includes("50M") && download.includes("-x") && download.includes("/bin/ffmpeg"));
  const captions = captionArgs("https://youtu.be/abc", "/t", "fr");
  assert.ok(captions.includes("--skip-download") && captions.includes("fr.*,fr"));
  assert.deepEqual(captions.slice(-2), ["--", "https://youtu.be/abc"]);
  assert.throws(() => webAddress("file:///etc/passwd"), /Only http and https/);
  assert.throws(() => webAddress("https://me:pw@example.com/"), /name or password/);
  assert.throws(() => webAddress("--exec=rm"), /not a web address/);
});

test("integrator: ffmpeg only reads ordinary video files, and yt-dlp loads no plug-in, remote code or catch-all reader", async (t) => {
  for (const args of [frameArgs("/t/a", "/t", 1, 1), soundTrackArgs("/t/a", "/t/o.wav"), convertArgs("/t/a", "/t/o.wav", "wav")]) {
    const input = args.indexOf("-i");
    assert.deepEqual(args.slice(input - 4, input), ["-format_whitelist", safeReaders, "-protocol_whitelist", "file"]);
    assert.ok(!/hls|concat|dash|image2/.test(safeReaders), "no reader that opens other files named inside one");
  }
  assert.equal(scratchEnding("films/clip.m3u8"), ".bin", "a playlist never keeps its own ending");
  assert.equal(scratchEnding("x.MP4"), ".mp4");
  assert.equal(scratchEnding("x.vnd.apple.mpegurl"), ".bin");
  for (const args of [downloadArgs("https://e.com/v", "/t", { soundOnly: false, maxMb: 5, ffmpeg: null }), captionArgs("https://e.com/v", "/t", "en")]) {
    for (const flag of ["--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-cache-dir"]) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("--use-extractors") + 1], "default,-generic");
    assert.ok(!args.some((arg) => /^--(exec|netrc|cookies|config-location|plugin-dirs$)/.test(arg)));
  }
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  const programs = fakePrograms();
  const tools = understanding(app, fakeMedia(app, { "list.m3u8": Buffer.from("#EXTM3U\nfile:///etc/hosts\n") }, { heard: [], looked: [], kept: [] }), programs);
  await tools.keepFrames({ path: "list.m3u8", count: 1 }, context(app));
  const input = programs.ran[0].args[programs.ran[0].args.indexOf("-i") + 1];
  assert.match(input, /input\.bin$/);
});

test("integrator: a playlist dressed as a video cannot make the real ffmpeg read another file", { skip: process.platform === "win32" || !findOnPath("ffmpeg") }, async (t) => {
  const ffmpeg = findOnPath("ffmpeg");
  const root = await mkdtemp(join(tmpdir(), "branch-b17-hls-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "private"));
  const secret = join(root, "private", "secret.mp4");
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-f", "mp4", secret], { stdio: "ignore" });
  } catch {
    t.skip("this ffmpeg cannot make a test clip");
    return;
  }
  const playlist = join(root, "input.m3u8");
  await writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:1,\nfile://${secret}\n#EXT-X-ENDLIST\n`);
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", playlist, "-vn", "-f", "wav", join(root, "plain.wav")], { stdio: "ignore" });
    t.diagnostic("without the guard this ffmpeg reads the other file through the playlist");
  } catch {
    t.diagnostic("this ffmpeg already refuses the playlist on its own");
  }
  const out = join(root, "guarded.wav");
  assert.throws(() => execFileSync(ffmpeg, soundTrackArgs(playlist, out), { stdio: "pipe" }), /whitelist/i);
  assert.ok(!(await readdir(root)).includes("guarded.wav"));
  execFileSync(ffmpeg, soundTrackArgs(secret, out));
  assert.ok((await readFile(out)).length > 100, "an ordinary file still works");
});

test("captions are read line by line, with rolling repeats and tags removed", () => {
  const lines = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.500 align:start\nhello <c.color>world</c>\n\n00:00:02.500 --> 00:01:03.000\nhello world\nsecond &amp; line\n");
  assert.deepEqual(lines, [
    { start: 1, end: 2.5, text: "hello world" },
    { start: 2.5, end: 63, text: "second & line" },
  ]);
});

test("a program is found from the owner's own setting first, and a missing one is named plainly", async () => {
  const settings = MediaProgramsSchema.parse({ mode: "on" });
  assert.equal(await locateProgram("ffmpeg", settings, () => "/opt/homebrew/bin/ffmpeg", "darwin"), "/opt/homebrew/bin/ffmpeg");
  const asked = [];
  await locateProgram("yt-dlp", settings, (name) => { asked.push(name); return "C:\\tools\\yt-dlp.exe"; }, "win32");
  assert.deepEqual(asked, ["yt-dlp.exe"]);
  await assert.rejects(locateProgram("ffmpeg", settings, () => null, "linux"), /ffmpeg is not on this computer.*Install it yourself/);
  await assert.rejects(locateProgram("ffmpeg", { ...settings, ffmpeg: "/nowhere/ffmpeg" }), /cannot be started/);
});

test("the switch ships when needed; switched off, the tools refuse in one sentence and are not advertised", async (t) => {
  const { app } = await fixture(t);
  assert.equal(mediaProgramsMode(app.store, "local"), "when-needed", "it ships when needed (ship-on rule)");
  assert.deepEqual(switchedToolTiers(app.store, "local", [...mediaProgramTools]), { preload: [], hidden: [] }, "as shipped, offered when needed");
  saveMediaProgramsSettings(app.store, "local", { mode: "off" });
  assert.equal(mediaProgramsMode(app.store, "local"), "off", "switched off, the choice holds");
  const programs = fakePrograms();
  const seen = { heard: [], looked: [], kept: [] };
  const watcher = understanding(app, fakeMedia(app, { "clip.mp4": Buffer.from("x") }, seen), programs);
  await assert.rejects(watcher.watch({ path: "clip.mp4" }, context(app)), (error) => error.message === mediaProgramsOff);
  assert.equal(programs.ran.length, 0, "nothing was started");
  assert.deepEqual(switchedToolTiers(app.store, "local", [...mediaProgramTools]).hidden, [...mediaProgramTools]);
  saveMediaProgramsSettings(app.store, "local", { mode: "when-needed" });
  assert.deepEqual(switchedToolTiers(app.store, "local", [...mediaProgramTools]), { preload: [], hidden: [] });
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  assert.equal(switchedToolTiers(app.store, "local", [...mediaProgramTools]).preload.length, mediaProgramTools.length);
  assert.ok(app.registry.names().includes("media.watch"), "the app registers the tools; the switch decides whether they are offered");
  assert.throws(() => saveMediaProgramsSettings(app.store, "local", { ffmpeg: "ffmpeg" }), /full place/);
});

test("watching a video shows the model its still pictures and what is said in it", async (t) => {
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on", frames: 3 });
  const programs = fakePrograms();
  const seen = { heard: [], looked: [], kept: [] };
  const watcher = understanding(app, fakeMedia(app, { "trip/clip.mp4": Buffer.from("not really a video") }, seen), programs);
  const result = await watcher.watch({ path: "trip/clip.mp4", question: "What are they making?" }, context(app));
  assert.equal(programs.ran[0].file, "/usr/local/bin/ffmpeg");
  assert.equal(programs.ran[0].args[programs.ran[0].args.indexOf("-frames:v") + 1], "3");
  assert.ok(programs.ran[1].args.includes("-vn"), "the sound is taken out second");
  assert.equal(seen.heard[0].mediaType, "audio/wav", "the sound goes through the owner's voice settings");
  assert.equal(seen.looked[0].pictures.length, 3);
  assert.equal(seen.looked[0].pictures[0].mediaType, "image/jpeg");
  assert.match(seen.looked[0].question, /What are they making\?/);
  assert.match(seen.looked[0].question, /we are building a treehouse/);
  assert.match(seen.looked[0].question, /untrusted data/);
  assert.equal(result.answer, "Two people build a treehouse.");
  assert.equal(result.pictures, 3);
});

test("a silent video still gets its pictures seen, and a sound file skips the pictures", async (t) => {
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  const seen = { heard: [], looked: [], kept: [] };
  const silent = understanding(app, fakeMedia(app, {}, seen), fakePrograms({ sound: false }));
  const quiet = await silent.understand("local", Buffer.from("v"), "video/mp4");
  assert.equal(quiet.pictures.length, 4);
  assert.equal(quiet.transcript, "");
  assert.deepEqual(quiet.notes, ["The file has no sound."]);
  const programs = fakePrograms();
  const heard = await understanding(app, fakeMedia(app, {}, seen), programs).understand("local", Buffer.from("a"), "audio/mpeg");
  assert.equal(heard.pictures.length, 0);
  assert.equal(heard.transcript, "we are building a treehouse");
  assert.equal(programs.ran.length, 1, "only the sound was taken out");
});

test("frames, converting, saving from the web and captions each do one thing and stay inside the rules", async (t) => {
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on", maxDownloadMb: 10 });
  const programs = fakePrograms();
  const seen = { heard: [], looked: [], kept: [] };
  const tools = understanding(app, fakeMedia(app, { "clip.mov": Buffer.from("v"), "talk.m4a": Buffer.from("a") }, seen), programs);
  const frames = await tools.keepFrames({ path: "clip.mov", count: 2 }, context(app));
  assert.equal(frames.pictures.length, 2);
  assert.equal(frames.pictures[0].mediaType, "image/jpeg");
  const converted = await tools.convert({ path: "talk.m4a", save: "talk.wav" }, context(app));
  assert.equal(converted.savedAs, "media/talk.wav");
  const saved = await tools.download({ url: "https://videos.example.com/watch?v=1", soundOnly: false }, context(app));
  assert.equal(saved.savedAs, "media/A_clip-abc123.mp4");
  assert.equal(programs.ran.at(-1).file, "/usr/local/bin/yt-dlp");
  const said = await tools.captions({ url: "https://www.youtube.com/watch?v=abc", language: "en" }, context(app));
  assert.equal(said.text, "hello there and welcome & enjoy");
  const practice = await tools.download({ url: "https://videos.example.com/x", soundOnly: true }, context(app, { dryRun: true }));
  assert.equal(practice.wouldSave, "https://videos.example.com/x");

  const blocked = understanding(app, fakeMedia(app, {}, seen), programs, new NetworkPolicy({ blockedHosts: ["videos.example.com"] }, async () => ["93.184.216.34"]));
  const before = programs.ran.length;
  await assert.rejects(blocked.download({ url: "https://videos.example.com/y", soundOnly: false }, context(app)), /blocked list/);
  await assert.rejects(blocked.captions({ url: "http://127.0.0.1/secret", language: "en" }, { ...context(app) }), /private|local/);
  assert.equal(programs.ran.length, before, "a refused address never reaches yt-dlp");
});

test("the five tools are registered with permissions and targets the approval rules can match", async (t) => {
  const { app } = await fixture(t);
  const registry = new ToolRegistry();
  registerMediaUnderstanding(registry, understanding(app, fakeMedia(app, {}, { heard: [], looked: [], kept: [] }), fakePrograms()));
  for (const name of mediaProgramTools) assert.ok(registry.names().includes(name), name);
  assert.equal(registry.permissionOf("media.watch"), "media.read");
  assert.equal(registry.permissionOf("media.download"), "media.write");
  assert.equal(registry.permissionOf("media.captions"), "web.read");
  assert.equal(registry.targetOf("media.convert", { path: "a.m4a", save: "a.mp3" }, context(app)), "media/a.mp3");
  assert.equal(registry.targetOf("media.download", { url: "https://example.com/v" }, context(app)), "https://example.com/v");
});

test("a video attached in the composer comes back as pictures and words, and only when switched on", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const upload = (type = "video/mp4") => fetch(server.url + "/api/media/understand", {
    method: "POST", headers: { authorization: "Bearer " + server.token, "content-type": type }, body: Buffer.from("video bytes"),
  });
  const programsRoute = (body) => fetch(server.url + "/api/media/programs", {
    method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + server.token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await (await programsRoute()).json()).settings.mode, "when-needed", "it ships when needed (ship-on rule)");
  const switchedOff = await programsRoute({ mode: "off" });
  assert.equal(switchedOff.status, 200);
  assert.equal((await switchedOff.json()).settings.mode, "off", "switched off through its own route");
  const off = await upload();
  assert.equal(off.status, 400);
  assert.match((await off.json()).error, /switched off/);
  const seen = { heard: [], looked: [], kept: [] };
  app.understanding = understanding(app, fakeMedia(app, {}, seen), fakePrograms());
  const saved = await fetch(server.url + "/api/media/programs", {
    method: "POST", headers: { authorization: "Bearer " + server.token, "content-type": "application/json" },
    body: JSON.stringify({ mode: "on" }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).ffmpeg.path, "/usr/local/bin/ffmpeg");
  const on = await upload();
  assert.equal(on.status, 200);
  const body = await on.json();
  assert.equal(body.pictures.length, 4);
  assert.equal(body.transcript, "we are building a treehouse");
  assert.equal((await upload("text/html")).status, 400, "only video and sound are taken");
  const huge = await fetch(server.url + "/api/media/understand", {
    method: "POST", headers: { authorization: "Bearer " + server.token, "content-type": "video/mp4" },
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(33 * 1024 * 1024)); c.close(); } }), duplex: "half",
  });
  assert.equal(huge.status, 400, "a file over 32 MB sent without a length is still refused as the caller's mistake");
  assert.match((await huge.json()).error, /32 MB/);
});

/* attach-followups: a kept file's working copy for ffmpeg (a film may be gigabytes) keeps the disk's 1 GB reserve free.
   Mutation: drop the reserve check in src/media-understand.ts understandFile, and the copy is made and ffmpeg runs. */
test("a video's working copy for ffmpeg keeps the disk's reserve free, or is not made at all", async (t) => {
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  const root = await mkdtemp(join(tmpdir(), "branch-media-reserve-"));
  t.after(() => discardTemp(root));
  const film = join(root, "film");
  await writeFile(film, Buffer.alloc(8192, 1));
  const seen = { heard: [], looked: [], kept: [] };
  const tight = fakePrograms();
  const refusing = understanding(app, fakeMedia(app, {}, seen), tight, quietPolicy(), { freeBytes: async () => 1024 ** 3 + 4096 });
  await assert.rejects(refusing.understandFile("local", film, "x.mp4", "video/mp4"),
    /A working copy of this file does not fit: Branch keeps 1 GB of this computer's disk free/);
  assert.equal(tight.ran.length, 0, "ffmpeg never ran on a copy that was not made");
  const roomy = fakePrograms();
  const fits = understanding(app, fakeMedia(app, {}, seen), roomy, quietPolicy(), { freeBytes: async () => 1024 ** 3 + 8192 });
  await fits.understandFile("local", film, "x.mp4", "video/mp4");
  assert.ok(roomy.ran.length > 0, "control: with room for the copy and the reserve, ffmpeg runs");
});

/* attach-3: working copies made at the same time count each other against the reserve, and let go once each is gone.
   Mutation: in src/attachments.ts holdDisk, stop counting the bytes promised to other copies, and the second copy is made. */
test("two working copies at once: each fits alone, together they would eat into the reserve, so the second is refused", async (t) => {
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  const root = await mkdtemp(join(tmpdir(), "branch-media-reserve-2-"));
  t.after(() => discardTemp(root));
  const film = join(root, "film");
  await writeFile(film, Buffer.alloc(8192, 1));
  const seen = { heard: [], looked: [], kept: [] };
  let release, started = 0;
  const held = new Promise((done) => { release = done; });
  const programs = fakePrograms();
  const slow = { ran: programs.ran, run: async (file, args) => { started++; await held; return programs.run(file, args); } };
  // Room for the reserve and one copy and a half: one copy fits; a second beside it does not.
  const tools = understanding(app, fakeMedia(app, {}, seen), slow, quietPolicy(), { freeBytes: async () => 1024 ** 3 + 8192 + 4096 });
  const first = tools.understandFile("local", film, "x.mp4", "video/mp4");
  for (let i = 0; i < 500 && !started; i++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(started, 1, "control: the first copy is made and ffmpeg is working on it");
  // Settled or started, whichever comes first, so a second copy wrongly made fails here instead of waiting forever.
  let settled = false;
  const second = tools.understandFile("local", film, "x.mp4", "video/mp4").then(() => "made", (error) => error).finally(() => { settled = true; });
  for (let i = 0; i < 500 && !settled && started < 2; i++) await new Promise((done) => setTimeout(done, 10));
  release();
  const outcome = await second;
  assert.match(String(outcome?.message ?? outcome),
    /A working copy of this file does not fit: Branch keeps 1 GB of this computer's disk free/, "the second is refused while the first holds its room");
  await first;
  await tools.understandFile("local", film, "x.mp4", "video/mp4");
  assert.ok(started >= 2, "once the first copy is gone its room is free again");
});
