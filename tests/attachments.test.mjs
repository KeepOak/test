import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Attachments, attachmentForWindow, attachmentLimits, kindOf, rangeWanted, shownInPage } from "../dist/attachments.js";
import { maxAttachmentsBytesPerTurn } from "../dist/contracts.js";
import { DiagnosticLog, DiagnosticLogSettingsSchema, setDiagnosticLog } from "../dist/diagnostic-log.js";
import { ROUTES } from "./short-lived-key-routes.mjs";

/**
 * Owner item: a file a person attaches is kept, and the message keeps a reference to it.
 *
 * Until now a picture's bytes went to the model for one request and the conversation was left with
 * "[attached picture: dot.png]"; a sound became words and a video became a few stills, and both
 * originals were dropped. So a conversation could not show, afterwards, what it had been given.
 *
 * Everything here is local: a scripted model, files built in the test, and a server on a port of its
 * own.
 */

const owner = "local";
/** Everything a stream hands over, for the tests that read one. */
async function bytesOf(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
/** A real, tiny PNG (one pixel), a real WAV header with silence, and a small MP4-shaped file. */
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
function wav(seconds = 1, rate = 8000) {
  const data = Buffer.alloc(seconds * rate * 2);
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(((i * 31) % 2000) - 1000, i);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"), Buffer.alloc(8), Buffer.from("a short film")]);
const markdown = Buffer.from("# Notes\n\nThe roof was fixed on Tuesday.\n", "utf8");

const attached = (name, mediaType, bytes) => ({ name, mediaType, data: bytes.toString("base64") });
const FOUR = [
  attached("photo.png", "image/png", png),
  attached("note.wav", "audio/wav", wav()),
  attached("clip.mp4", "video/mp4", mp4),
  attached("roof.md", "text/markdown", markdown),
];

async function branch(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attachments-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: provider ?? { name: "scripted", async complete() { return { content: "Got them.", toolCalls: [] }; } },
  });
  closing.push(() => app.close());
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, host: new URL(server.url).host };
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  const fetchFile = (query, extra = {}) =>
    fetch(`${server.url}/api/attachments/file?${query}`, { headers: { ...headers, ...extra } });
  return { app, root, server, headers, post, fetchFile };
}


/** A log that is on, put in place for one test and taken away again afterwards. */
async function listening(t, scratch) {
  const log = new DiagnosticLog({ dir: join(scratch, "logs"),
    settings: () => DiagnosticLogSettingsSchema.parse({ mode: "on" }) });
  setDiagnosticLog(log);
  t.after(() => setDiagnosticLog(null));
  return log;
}




test("a conversation whose listing is gone is unmeasured, not a conversation with nothing in it", async (t) => {
  // Reading a listing that is not there answers ENOENT, and ENOENT says two different things. No
  // folder at all is a conversation that was never given a file, which is a true zero. A folder that
  // is there with no listing in it is a conversation whose files may be sitting right in it, with
  // nothing left to say what they are. Answering 0 to the second put a conversation holding a film at
  // the front of the queue to be deleted for being small.
  const { app, root, post } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const folder = join(root, "data", "attachments", sessionId.replace(/[^a-z0-9]/gi, ""));
  assert.equal(app.attachments.bytesHeld(sessionId), png.length);

  await rm(join(folder, "kept.json"));
  assert.equal((await readdir(folder)).length, 1, "the file itself is still sitting there");
  assert.equal(app.attachments.bytesHeld(sessionId), null,
    "so what it weighs is a number nobody has, not nothing");

  // And the true zero is still a zero, or every conversation that never had a file becomes unmeasured
  // and nothing can ever be swept on size again.
  assert.equal(app.attachments.bytesHeld("00000000-0000-4000-8000-000000000000"), 0,
    "a conversation that was never given a file weighs nothing, and that is measured");
});

test("retention never offers a conversation it could not measure, whichever way it failed", async (t) => {
  // The two unmeasurable shapes have to reach retention the same way: counted towards the history so
  // the total is honest, and never the one offered up on the strength of a number nobody checked.
  const { app, root, post } = await branch(t);
  const { ConversationRetention, saveRetentionSettings } = await import("../dist/retention.js");
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  await rm(join(root, "data", "attachments", sessionId.replace(/[^a-z0-9]/gi, ""), "kept.json"));

  saveRetentionSettings(app.store, "local", { enabled: true, keepDays: 0, megabytes: 1, exportBeforeDeleting: false });
  const proposal = new ConversationRetention(app.store, "local").propose();
  assert.equal(proposal.conversations.some((one) => one.sessionId === sessionId), false,
    "not offered, because what it weighs was never established");
});

test("what a conversation weighs is what its files weigh now, not what the listing remembers", async (t) => {
  // The listing records what each file weighed when it arrived and is not re-read when one changes,
  // so adding those numbers up answers for a conversation as it used to be. A seventy-byte file
  // replaced by a megabyte still reported seventy -- and said `measured`, which is the word that
  // means the number was checked.
  const { app, root, post } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  const folder = join(root, "data", "attachments", sessionId.replace(/[^a-z0-9]/gi, ""));
  assert.equal(app.attachments.bytesHeld(sessionId), png.length);

  await writeFile(join(folder, ref.id), Buffer.alloc(1048576, 7));
  assert.equal(app.attachments.bytesHeld(sessionId), 1048576, "the file that is there now is the one counted");

  // And a file the listing names that is not there at all cannot be counted as nothing.
  await rm(join(folder, ref.id));
  assert.equal(app.attachments.bytesHeld(sessionId), null, "unreadable is not the same as none");
});

test("an id that points outside the store is not a file of this conversation, whichever way it is read", async (t) => {
  // locate() checks that an id really names a file inside the store -- sixteen hex characters, and a
  // real path that stays inside after links are followed. Two other readers built the path themselves
  // and never asked: the one that reads bytes for an archive, and the one that copies them.
  const scratch = await mkdtemp(join(tmpdir(), "branch-contained-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  mkdirSync(join(root, "a-conversation"), { recursive: true });
  const store = new Attachments(root);
  const [kept] = await store.keep("a-conversation", [{ name: "one.png", mediaType: "image/png", data: png.toString("base64") }]);

  for (const wrong of ["../secret", "0123456789abcdeZ", "0123456789abcde", "", "0123456789abcdef0"]) {
    assert.throws(() => store.bytesOf("a-conversation", wrong), /not attached to this conversation/, `bytesOf(${wrong})`);
    assert.throws(() => store.copyInto("a-conversation", "elsewhere", [{ ...kept, id: wrong }]),
      /not attached to this conversation/, `copyInto(${wrong})`);
  }
  // The real one still works, so this is a gate and not a wall.
  assert.ok(store.bytesOf("a-conversation", kept.id).equals(png));
});

test("one part of a file is read as that part, not sliced out of a copy of the whole thing", async (t) => {
  // Asking for the first kilobyte of a thirty-megabyte film cost thirty megabytes: the file was read
  // whole and a slice of it was sent. A window with a few films open could spend a gigabyte
  // answering scrubs of a few kilobytes each. A test cannot watch memory without measuring this
  // machine instead of the code, so it watches the ask: what the file is opened for.
  const scratch = await mkdtemp(join(tmpdir(), "branch-range-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  const asked = [];
  const store = new Attachments(root, readdirSync, undefined, undefined, (path, part) => {
    asked.push(part);
    return createReadStream(path, part ? { start: part.start, end: part.end } : {});
  });
  const whole = Buffer.from("0123456789".repeat(400));
  const [kept] = await store.keep("a-conversation",
    [{ name: "numbers.txt", mediaType: "text/plain", data: whole.toString("base64") }]);

  const part = await store.partOf("a-conversation", kept.id);
  assert.equal(part.size, whole.length, "the size comes from the file itself");
  assert.deepEqual(asked, [], "nothing is opened until somebody says which part they want");

  assert.ok((await bytesOf(part.open({ start: 10, end: 19 }))).equals(whole.subarray(10, 20)));
  assert.deepEqual(asked, [{ start: 10, end: 19 }],
    "the file was opened for those ten bytes, not for all four thousand");

  assert.ok((await bytesOf(part.open(null))).equals(whole), "and asking for all of it still gives all of it");
  assert.deepEqual(asked, [{ start: 10, end: 19 }, null]);
});


test("a delete that fails says so instead of leaving the bytes behind in silence", async (t) => {
  // Deleting a conversation's folder can fail — something still has a file open, which on Windows is
  // an ordinary Tuesday. It was thrown away with .catch(() => undefined), so the files of a
  // conversation the owner deleted stayed on disk with nothing pointing at them and no way for
  // anyone, then or later, to discover it.
  const scratch = await mkdtemp(join(tmpdir(), "branch-forget-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  mkdirSync(root, { recursive: true });
  const log = await listening(t, scratch);

  const locked = new Attachments(root, readdirSync, undefined,
    () => Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })));
  assert.equal(await locked.forget("a-conversation"), false, "it does not claim the files went");

  const [line] = log.read({ component: "attachments" });
  assert.equal(line.level, "error");
  assert.match(line.message, /could not be deleted/);
  assert.match(String(line.fields.reason), /EBUSY/, "and says why, so it can be acted on");

  // And when the delete works, it is not reported as a problem.
  const working = new Attachments(root);
  assert.equal(await working.forget("a-conversation"), true);
  assert.equal(log.read({ component: "attachments" }).length, 1, "nothing is written about a delete that worked");
});

test("the sweep counts the folders that really went, not the ones it tried", async (t) => {
  // Returning the number it attempted made the count a promise it had not kept: temporary files
  // outliving their conversation were reported as swept away.
  const scratch = await mkdtemp(join(tmpdir(), "branch-sweep-count-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  mkdirSync(root, { recursive: true });
  for (const name of ["tmp-one", "tmp-two", "tmp-three"]) mkdirSync(join(root, name), { recursive: true });
  const log = await listening(t, scratch);

  const store = new Attachments(root, readdirSync, undefined,
    (path) => path.endsWith("tmp-two") ? Promise.reject(new Error("EBUSY")) : Promise.resolve());
  assert.equal(await store.sweepTemporary(), 2, "two went; the one that would not is not counted with them");

  const [line] = log.read({ component: "attachments" });
  assert.match(line.message, /still here after the sweep/);
  assert.equal(line.fields.left, 1);
  assert.equal(line.fields.swept, 2);
});


test("four kinds of file attach to one message, and the conversation keeps what it was given", async (t) => {
  const { app, post } = await branch(t);
  const run = await post("/api/run", { prompt: "Here is everything about the roof.", attachments: FOUR });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const sessionId = run.body.sessionId ?? app.store.sessions?.(owner)?.[0]?.id;
  assert.ok(sessionId, "the run says which conversation it is in");

  // Read back out of the store, not out of memory: this is what a reopened conversation would show.
  const message = app.store.messages(sessionId).find((one) => one.role === "user");
  assert.ok(message, "the person's own message is there");
  assert.equal(message.attachments?.length, 4, "all four files are kept with it");
  assert.deepEqual(message.attachments.map((one) => one.kind), ["picture", "sound", "video", "document"]);
  assert.deepEqual(message.attachments.map((one) => one.name), ["photo.png", "note.wav", "clip.mp4", "roof.md"]);
  assert.deepEqual(message.attachments.map((one) => one.mediaType),
    ["image/png", "audio/wav", "video/mp4", "text/markdown"], "each file's own type, as it arrived");
  assert.deepEqual(message.attachments.map((one) => one.bytes),
    [png.length, wav().length, mp4.length, markdown.length], "and its real size");
  for (const one of message.attachments) assert.match(one.id, /^[a-f0-9]{16}$/, "named by an id, never a path");
  assert.match(message.content, /roof\.md \(document\)/, "and the words say a file came with it");
});

test("each kept file comes back exactly, shown in the page or handed over as a download", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep these.", attachments: FOUR });
  const sessionId = run.body.sessionId;
  const refs = app.store.messages(sessionId).find((one) => one.role === "user").attachments;
  const sent = { "photo.png": png, "note.wav": wav(), "clip.mp4": mp4, "roof.md": markdown };

  for (const ref of refs) {
    const answer = await fetchFile(`session=${sessionId}&id=${ref.id}`);
    assert.equal(answer.status, 200, `${ref.name} comes back`);
    assert.equal(answer.headers.get("content-type"), ref.mediaType, "the type kept with the file");
    assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
    assert.match(answer.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(answer.headers.get("cache-control"), "no-store");
    assert.equal(answer.headers.get("accept-ranges"), "bytes");
    const shown = shownInPage(ref.mediaType);
    assert.match(answer.headers.get("content-disposition") ?? "", new RegExp(`^${shown ? "inline" : "attachment"};`),
      `${ref.name} is ${shown ? "shown in the page" : "handed over as a download"}`);
    assert.ok(Buffer.from(await answer.arrayBuffer()).equals(sent[ref.name]), `${ref.name} is byte for byte what was sent`);
  }
  assert.equal(shownInPage("text/markdown"), false, "a document is never shown in the page itself");
  assert.equal(shownInPage("image/svg+xml"), false, "and nor is anything that could carry script");
});

test("a player can ask for part of a sound, and is told plainly when it asks past the end", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  const run = await post("/api/run", { prompt: "Listen to this.", attachments: [FOUR[1]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  const whole = wav();

  const part = await fetchFile(`session=${sessionId}&id=${ref.id}`, { range: "bytes=100-199" });
  assert.equal(part.status, 206, "part of it, as a player asks");
  assert.equal(part.headers.get("content-range"), `bytes 100-199/${whole.length}`);
  assert.equal(part.headers.get("content-length"), "100");
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(whole.subarray(100, 200)), "and it is the right part");

  const past = await fetchFile(`session=${sessionId}&id=${ref.id}`, { range: `bytes=${whole.length + 10}-` });
  assert.equal(past.status, 416, "asking past the end is refused, not answered with the wrong bytes");
  assert.equal(past.headers.get("content-range"), `bytes */${whole.length}`);

  // The reading itself, on its own: a whole file, the last bytes, and nonsense.
  assert.deepEqual(rangeWanted("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(rangeWanted("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(rangeWanted("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(rangeWanted("bytes=200-300", 100), "outside");
  assert.equal(rangeWanted("bytes=50-10", 100), "outside");
  assert.equal(rangeWanted("rows=1-2", 100), null, "something that is not a range is answered whole");
  assert.equal(rangeWanted(undefined, 100), null);
});

test("an id that names nothing, or a conversation that is not this one, gets the same plain refusal", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];

  for (const [what, query] of [
    ["an id nobody made", `session=${sessionId}&id=${"0".repeat(16)}`],
    ["an id that is not an id", `session=${sessionId}&id=${encodeURIComponent("../../kept.json")}`],
    ["a name that climbs out", `session=${encodeURIComponent("../..")}&id=${ref.id}`],
    ["a conversation this file is not in", `session=${"1".repeat(32)}&id=${ref.id}`],
    ["nothing at all", ""],
  ]) {
    const answer = await fetchFile(query);
    assert.equal(answer.status, 404, `${what} is refused`);
  }
});

test("somebody else at this computer cannot open the owner's attached file", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  assert.equal((await fetchFile(`session=${sessionId}&id=${ref.id}`)).status, 200, "the owner can open it");

  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const refused = await fetchFile(`session=${sessionId}&id=${ref.id}`);
  assert.ok(refused.status >= 400, `a household profile is refused (${refused.status})`);
  assert.notEqual(refused.status, 200, "and never handed the bytes");

  app.store.profiles.switch({ profileId: null });
  assert.equal((await fetchFile(`session=${sessionId}&id=${ref.id}`)).status, 200, "the owner still can");
});

test("handing a file back checks who is asking, before it looks anything up", async (t) => {
  const { app, post } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  const parts = { profiles: app.store.profiles, attachments: app.attachments,
    temporaryConversation: (session) => app.store.sessionTemporary(session) };

  const handed = await attachmentForWindow(parts, { session: sessionId, id: ref.id });
  assert.equal(handed.size, png.length, "the owner is handed the file, and its real size");
  assert.ok((await bytesOf(handed.open(null))).equals(png));

  // Straight at the helper, with nothing in front of it: the guard inside it is the only thing deciding.
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  await assert.rejects(attachmentForWindow(parts, { session: sessionId, id: ref.id }),
    "somebody else at this computer is refused by the delivery itself");
  app.store.profiles.switch({ profileId: null });
});

test("four pictures that each fit are kept together; sending each of them twice is not", async (t) => {
  const { app, post } = await branch(t);

  // Each is just inside what a picture may be. Four of them are about 27 MB once base64'd, which a
  // run may carry. The page used to send every picture twice — once for the model to look at and once
  // to be kept — and four pictures that broke no stated limit came to about 53 MB and were refused by
  // the reader with a 413 no stated limit explained. What the model then does with pictures that big
  // is a separate matter, and the ordinary context budget answers it; this is about the weight of the
  // message on the wire.
  const big = (name) => {
    const bytes = Buffer.alloc(attachmentLimits.picture - 1024, 7);
    png.copy(bytes, 0);
    return attached(name, "image/png", bytes);
  };
  const four = ["one.png", "two.png", "three.png", "four.png"].map(big);

  const run = await post("/api/run", { prompt: "Look at these.", attachments: four });
  assert.equal(run.status, 200, `four pictures that each fit are not refused together (${run.status})`);
  const message = app.store.messages(run.body.sessionId).find((one) => one.role === "user");
  assert.deepEqual(message.attachments.map((one) => one.name), ["one.png", "two.png", "three.png", "four.png"],
    "each is kept once, as the file it is");
  assert.deepEqual(message.attachments.map((one) => one.bytes),
    four.map(() => attachmentLimits.picture - 1024), "whole, not a copy of a copy");

  // The old shape, measured rather than remembered: the same four sent in both places are too heavy.
  const twice = await post("/api/run", { prompt: "Look at these.", images: four, attachments: four });
  assert.equal(twice.status, 413, "sending each picture twice is past what a message may weigh");
});

test("a still taken out of a film reaches the model beside a picture that was attached", async (t) => {
  const seen = [];
  const { post } = await branch(t, {
    name: "seeing", acceptsImages: true, supportsImages: () => true,
    async complete(request) { seen.push(request.messages); return { content: "Got them.", toolCalls: [] }; },
  });
  // A still is not a file anybody attached: the page sends it only to be looked at. It must not push
  // out the photograph that came with the message, and the photograph must not push out the still.
  const still = { mediaType: "image/png", data: png.toString("base64"), name: "still-1.png" };
  const run = await post("/api/run", { prompt: "What is happening here?", images: [still], attachments: [FOUR[0]] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const shown = seen.at(-1)?.findLast((one) => one.role === "user")?.images ?? [];
  assert.deepEqual(shown.map((one) => one.name), ["still-1.png", "photo.png"],
    "both reach the model: the one to look at, and the one that was kept");
});

test("the route is written down as the owner's, so it cannot quietly become anybody's", () => {
  assert.equal(ROUTES["/api/attachments/file"], "owner GET",
    "the one place that says who may ask for an attached file");
});

test("a real file, not a token one: a picture past the old 64 KiB ceiling goes through whole", async (t) => {
  const { app, post, fetchFile } = await branch(t);
  // 300 KB of picture: far past the ordinary JSON ceiling, which is what made the stated limits
  // decoration until now, and small enough to keep the test quick.
  const big = Buffer.alloc(300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
  const sent = Buffer.concat([png, big]);

  const run = await post("/api/run", { prompt: "Keep this photo.", attachments: [attached("holiday.png", "image/png", sent)] });
  assert.equal(run.status, 200, `a 300 KB picture is accepted (${JSON.stringify(run.body).slice(0, 200)})`);
  const ref = app.store.messages(run.body.sessionId).find((one) => one.role === "user").attachments[0];
  assert.equal(ref.bytes, sent.length, "its real size is written down");

  const back = await fetchFile(`session=${run.body.sessionId}&id=${ref.id}`);
  assert.equal(back.status, 200);
  assert.ok(Buffer.from(await back.arrayBuffer()).equals(sent), "and it comes back byte for byte");
});

test("one message can only carry so much altogether, however it is divided", async (t) => {
  const { app } = await branch(t);
  // Two films: each is inside the 32 MB a film may be, and together they are past what one message may
  // carry. That is the difference between a per-kind limit and the budget for the whole turn.
  const half = Buffer.alloc(Math.ceil(maxAttachmentsBytesPerTurn / 2) + 1024);
  const twoHalves = [attached("a.mp4", "video/mp4", half), attached("b.mp4", "video/mp4", half)];

  await assert.rejects(app.attachments.keep("00000000-0000-4000-8000-00000000000a", twoHalves),
    /can add up to 32 MB/, "two files that each fit but together do not are refused");
  assert.equal(maxAttachmentsBytesPerTurn, 32 * 1024 * 1024, "the budget for one message");
});

test("a batch with one bad file in it leaves nothing behind", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-batch-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  const store = new Attachments(root);
  const session = "00000000-0000-4000-8000-00000000000b";

  await assert.rejects(store.keep(session, [
    attached("good.png", "image/png", png),
    attached("also-good.md", "text/markdown", markdown),
    attached("nope.exe", "application/x-msdownload", Buffer.from("MZ")),
  ]), /does not take application\/x-msdownload/);

  const folder = join(root, session.replace(/[^a-z0-9]/gi, ""));
  const left = await readdir(folder).catch(() => []);
  assert.deepEqual(left, [], "not one byte of the two good files was written");
  assert.deepEqual(await store.list(session), [], "and nothing is claimed to be attached");
});

test("a listing that fails to be written leaves the files already kept untouched", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-commit-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  const session = "00000000-0000-4000-8000-00000000000e";

  // The listing's own write, held by the test. Everything else is real: real folders, real bytes.
  let refuse = false;
  const wrote = [];
  const store = new Attachments(root, readdirSync, async (path, text) => {
    if (refuse) throw new Error("the disk said no");
    wrote.push(path);
    writeFileSync(path, text);
  });

  const [first] = await store.keep(session, [attached("roof.md", "text/markdown", markdown)]);
  assert.match(wrote[0], /kept\.json\.[a-f0-9]{12}\.part$/, "the listing is built beside itself, not on top of itself");

  // Now the second file's listing cannot be written. The first file must survive it untouched.
  refuse = true;
  await assert.rejects(store.keep(session, [attached("gutters.md", "text/markdown", Buffer.from("# Gutters", "utf8"))]),
    /the disk said no/);

  const listed = await store.list(session);
  assert.deepEqual(listed.map((one) => one.name), ["roof.md"], "the conversation still knows about the first file");
  assert.equal(listed[0].id, first.id, "and by the same name it had");
  const back = await store.read(session, first.id);
  assert.ok(back.bytes.equals(markdown), "whose bytes are still there, whole");

  // And nothing of the failed turn is left behind: not its bytes, not the listing it was building.
  const folder = join(root, session.replace(/[^a-z0-9]/gi, ""));
  const left = (await readdir(folder)).sort();
  assert.deepEqual(left, ["kept.json", first.id].sort(),
    `only the first file and the listing remain (${left.join(", ")})`);
});

/**
 * Waits for something the test is about to depend on, and gives up out loud rather than hanging. A
 * test that waits for ever tells you nothing when the thing it waits for stops happening.
 */
async function waitFor(ready, what, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`waited ${ms}ms in vain for ${what}`);
}

test("a conversation's turn leaves the queue when it is done, and never takes a newer one with it", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-queue-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");

  // A gate on the listing's write, so a turn can be held open for as long as the test needs.
  const gates = [];
  const store = new Attachments(root, readdirSync, async (path, text) => {
    const wait = new Promise((resolve) => gates.push(resolve));
    await wait;
    writeFileSync(path, text);
  });

  const session = "00000000-0000-4000-8000-00000000000f";
  const older = store.keep(session, [attached("one.md", "text/markdown", markdown)]);
  const newer = store.keep(session, [attached("two.md", "text/markdown", markdown)]);
  await waitFor(() => gates.length >= 1, "the first turn to reach the listing");
  assert.equal(store.queuedTurns, 1, "one conversation is being written to");

  // The older turn finishes while the newer one is still queued behind it.
  gates.shift()();
  await older;
  await waitFor(() => gates.length >= 1, "the second turn to reach the listing");
  assert.equal(store.queuedTurns, 1,
    "the older turn finishing did not take the newer turn's place in the queue away");

  gates.shift()();
  await newer;
  assert.equal(store.queuedTurns, 0, "and when the last one is done, nothing is left behind");
  assert.equal((await store.list(session)).length, 2, "both files are kept");

  // Many conversations, each one finished: the queue is a queue, not a record of everything ever done.
  for (let number = 0; number < 40; number += 1) {
    const each = `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
    const keeping = store.keep(each, [attached("note.md", "text/markdown", markdown)]);
    await waitFor(() => gates.length >= 1, `conversation ${number} to reach the listing`);
    gates.shift()();
    await keeping;
  }
  assert.equal(store.queuedTurns, 0, "forty finished conversations leave nothing in the queue");
});

test("two messages attaching at once keep both sets of files", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-race-"));
  t.after(() => discardTemp(scratch));
  const store = new Attachments(join(scratch, "attachments"));
  const session = "00000000-0000-4000-8000-00000000000c";

  const [first, second] = await Promise.all([
    store.keep(session, [attached("one.png", "image/png", png)]),
    store.keep(session, [attached("two.md", "text/markdown", markdown)]),
  ]);

  const listed = await store.list(session);
  assert.equal(listed.length, 2, "both are there, neither wrote the other out of the listing");
  assert.ok(listed.some((one) => one.id === first[0].id));
  assert.ok(listed.some((one) => one.id === second[0].id));
});

test("the sweep works from a list taken before the app is ready, so later files are safe", async (t) => {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attachments-sweep-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  // Enough leftovers that the sweep is still working when the app is handed back.
  const attachmentsRoot = join(root, "data", "attachments");
  for (let i = 0; i < 400; i++) {
    const left = join(attachmentsRoot, `tmp-old${String(i).padStart(29, "0")}`);
    await mkdir(left, { recursive: true });
    await writeFile(join(left, "kept.json"), "[]", "utf8");
  }

  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  closing.push(() => app.close());

  // The slow path, which is the one that matters: a temporary conversation started the moment the app
  // is ready, while the sweep may still be running. Its folder was not on the list, so it survives.
  const session = "00000000-0000-4000-8000-00000000000e";
  const made = await app.attachments.keep(session, [attached("now.png", "image/png", png)], { temporary: true });
  await new Promise((resolve) => setTimeout(resolve, 1500)); // let any sweep still running finish
  assert.equal((await app.attachments.list(session, { temporary: true })).length, 1,
    "a file attached after readiness is not swept away");
  assert.ok((await app.attachments.read(session, made[0].id, { temporary: true })).bytes.equals(png));

  // And the leftovers really were cleared. How long 400 folders take is the machine's (a busy runner took over 1.5 s),
  // so this waits for the sweep to finish, up to a bound, rather than guessing when it has.
  const leftovers = async () => (await readdir(attachmentsRoot).catch(() => [])).filter((one) => one.startsWith("tmp-old"));
  for (let waited = 0; waited < 30_000 && (await leftovers()).length; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(await leftovers(), [], "every folder from before is gone");
});

test("the sweep decides what to remove before it gives up the thread, proved by when it looked", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-snap-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  mkdirSync(root, { recursive: true });
  for (const name of ["tmp-old-one", "tmp-old-two", "lasting-conversation"]) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "kept.json"), "[]");
  }

  // The listing is held still by the test, so this proves *when* the decision was made rather than
  // how fast a disk happens to be.
  const looked = [];
  const store = new Attachments(root, (path) => { looked.push(path); return readdirSync(path); });

  const sweeping = store.sweepTemporary();
  // Nothing has been awaited yet: if the list were read on a later tick, this would still be 0.
  assert.equal(looked.length, 1, "it looked once, before it handed back a promise");
  assert.equal(looked[0], root);

  // A temporary conversation that begins now cannot be on a list that was taken a moment ago.
  mkdirSync(join(root, "tmp-begun-after"), { recursive: true });
  writeFileSync(join(root, "tmp-begun-after", "kept.json"), "[]");
  const swept = await sweeping;

  assert.equal(swept, 2, "only the two it had seen were removed");
  assert.equal(looked.length, 1, "and it did not look again afterwards");
  const left = readdirSync(root).sort();
  assert.deepEqual(left, ["lasting-conversation", "tmp-begun-after"],
    "the new conversation's folder and the lasting one are both untouched");
});

test("a media type that is not one is refused before it can become a header", async (t) => {
  const { app, post } = await branch(t);

  // Built rather than typed, so the characters that matter survive being written down.
  const headerSplit = "image/png" + String.fromCharCode(13, 10) + "X-Evil: 1";
  const withControl = "text/plain" + String.fromCharCode(0);
  for (const bad of [headerSplit, "image png", "image/", withControl, "  "]) {
    const answer = await post("/api/run", {
      prompt: "Keep this.",
      attachments: [{ name: "odd.png", mediaType: bad, data: png.toString("base64") }],
    });
    assert.ok(answer.status >= 400, `"${bad.replace(/[^ -~]/g, "?")}" is refused (${answer.status})`);
  }
  // And the store refuses it too, not only the route.
  await assert.rejects(app.attachments.keep("00000000-0000-4000-8000-00000000000f",
    [{ name: "odd.png", mediaType: headerSplit, data: png.toString("base64") }]));

  const good = await post("/api/run", { prompt: "This one is fine.", attachments: [attached("fine.png", "image/png", png)] });
  assert.equal(good.status, 200, "an ordinary media type still works");
});

test("a file too big for its kind, or of a kind Branch does not take, is refused by name", async (t) => {
  const { app } = await branch(t);
  const store = app.attachments;

  await assert.rejects(
    store.keep("session-one", [attached("huge.png", "image/png", Buffer.alloc(attachmentLimits.picture + 1))]),
    /Pictures up to 5 MB can be attached, so huge\.png was skipped/);
  await assert.rejects(
    store.keep("session-one", [attached("run.exe", "application/x-msdownload", Buffer.from("MZ"))]),
    /Branch does not take application\/x-msdownload files/);
  await assert.rejects(
    store.keep("session-one", [attached("empty.png", "image/png", Buffer.alloc(0))]),
    /empty\.png came through empty/);

  // The limits themselves, so the page and the server cannot drift apart silently.
  assert.equal(attachmentLimits.picture, 5 * 1024 * 1024);
  assert.equal(attachmentLimits.sound, 25 * 1024 * 1024);
  assert.equal(attachmentLimits.video, 32 * 1024 * 1024);
  assert.equal(attachmentLimits.document, 20 * 1024 * 1024, "the Documents panel's own limit, shared not copied");
  assert.equal(kindOf("image/png"), "picture");
  assert.equal(kindOf("audio/ogg; codecs=opus"), "sound");
  assert.equal(kindOf("video/webm"), "video");
  assert.equal(kindOf("application/pdf"), "document");
});

test("a follow-up in a temporary conversation puts its file where the conversation keeps them", async (t) => {
  const { app, root, post, fetchFile } = await branch(t);

  // Only the first message says "temporary" — it is what the conversation is, not what each message is.
  const first = await post("/api/run", { prompt: "Keep this for now.", temporary: true, attachments: [FOUR[0]] });
  const sessionId = first.body.sessionId;
  assert.equal(app.store.sessionTemporary(sessionId), true, "this really is a temporary conversation");

  // The follow-up says nothing about it, the way the window sends one.
  const second = await post("/api/run", { prompt: "And this one.", sessionId, attachments: [FOUR[3]] });
  assert.equal(second.status, 200, JSON.stringify(second.body));

  // Both files open. Taking the message's word for it put the second one in the lasting folder while the
  // conversation went on looking in the temporary one: on disk, and unreachable.
  const messages = app.store.messages(sessionId).filter((one) => one.role === "user");
  assert.equal(messages.length, 2);
  for (const message of messages) {
    const ref = message.attachments[0];
    const answer = await fetchFile(`session=${sessionId}&id=${ref.id}`);
    assert.equal(answer.status, 200, `${ref.name} is still reachable`);
  }

  // And they are in one folder, not two.
  const folders = await readdir(join(root, "data", "attachments")).catch(() => []);
  assert.deepEqual(folders, [`tmp-${sessionId.replace(/[^a-z0-9]/gi, "")}`],
    `one folder, the conversation's own (${folders.join(", ")})`);
});

test("a conversation's files go when the conversation does", async (t) => {
  const { app, post } = await branch(t);
  const run = await post("/api/run", { prompt: "Keep this.", attachments: [FOUR[0]] });
  const sessionId = run.body.sessionId;
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  assert.ok((await app.attachments.read(sessionId, ref.id)).bytes.equals(png), "it is there to begin with");

  app.store.forgetSession(owner, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 50)); // the folder goes just after the rows do
  await assert.rejects(app.attachments.read(sessionId, ref.id), /not attached to this conversation/,
    "and nothing is left pointing at a file that is gone");
});

test("a temporary conversation's files are marked, and swept away after a stop at the wrong moment", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-tmp-"));
  t.after(() => discardTemp(scratch));
  const store = new Attachments(join(scratch, "attachments"));

  const kept = await store.keep("00000000-0000-4000-8000-000000000001", [FOUR[0]], { temporary: true });
  const folders = await readdir(join(scratch, "attachments"));
  assert.equal(folders.length, 1);
  assert.match(folders[0], /^tmp-/, "a temporary conversation's folder says so");
  assert.ok((await store.read("00000000-0000-4000-8000-000000000001", kept[0].id, { temporary: true })).bytes.equals(png));

  // A lasting conversation beside it must survive the sweep.
  await store.keep("00000000-0000-4000-8000-000000000002", [FOUR[0]]);
  assert.equal(await store.sweepTemporary(), 1, "one temporary folder swept");
  assert.deepEqual((await readdir(join(scratch, "attachments"))).filter((one) => one.startsWith("tmp-")), []);
  assert.equal((await readdir(join(scratch, "attachments"))).length, 1, "and the lasting one is untouched");
});

test("a folder that is really a link to somewhere else is not followed", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-link-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  const outside = join(scratch, "elsewhere");
  const session = "00000000-0000-4000-8000-000000000004";
  const plain = session.replace(/[^a-z0-9]/gi, "");
  const id = "abcdef0123456789";

  // Somewhere outside the store, holding a file and a listing that names it in the ordinary way.
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, id), Buffer.from("not yours"), "utf8");
  await writeFile(join(outside, "kept.json"),
    JSON.stringify([{ id, kind: "document", mediaType: "text/plain", name: "secret.txt", bytes: 9 }]), "utf8");

  // The conversation's folder is a link to it. Nothing about the id is wrong; only where it leads is.
  await mkdir(root, { recursive: true });
  const linked = await symlink(outside, join(root, plain), "junction").then(() => true).catch(() => false);
  if (!linked) {
    t.skip("this computer does not allow making links");
    return;
  }
  await assert.rejects(new Attachments(root).read(session, id), /not attached to this conversation/,
    "the file is outside the store, so it is not opened");
});

test("a file that is not really inside the store is never opened", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "branch-attachments-out-"));
  t.after(() => discardTemp(scratch));
  const root = join(scratch, "attachments");
  const store = new Attachments(root);
  const session = "00000000-0000-4000-8000-000000000003";
  const kept = await store.keep(session, [FOUR[0]]);

  // A listing that has been tampered with to name a file outside the store is refused by the id check.
  await writeFile(join(root, session.replace(/[^a-z0-9]/gi, ""), "kept.json"),
    JSON.stringify([{ ...kept[0], id: "../../elsewhere" }]), "utf8");
  await assert.rejects(store.read(session, "../../elsewhere"), /not attached to this conversation/);
  await assert.rejects(store.read(session, kept[0].id), /not attached to this conversation/);
});

test("a refused file leaves no task running, so the conversation carries on (NAS's adversarial of #190)", async (t) => {
  const { app, post } = await branch(t);
  const first = await post("/api/run", { prompt: "Hello." });
  assert.equal(first.status, 200);
  const sessionId = first.body.sessionId;
  const refused = await post("/api/run", { prompt: "Here is an archive.", sessionId,
    attachments: [attached("bundle.zip", "application/zip", Buffer.from("PK"))] });
  assert.ok(refused.status >= 400, "the archive is refused");
  assert.match(JSON.stringify(refused.body), /does not take application\/zip/);
  const running = app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get();
  assert.equal(Number(running.n), 0, "no task is left running");
  const next = await post("/api/run", { prompt: "Carry on.", sessionId });
  assert.equal(next.status, 200, "the next message in the same conversation is answered");
});

test("an export asked for with a short-lived key carries the words and references, never the files (NAS's review of #190)", async (t) => {
  const { underShortLivedKey } = await import("../dist/key-context.js");
  const { app, post } = await branch(t);
  const sent = await post("/api/run", { prompt: "Here are my notes.", attachments: [attached("notes.md", "text/markdown", Buffer.from("# private notes"))] });
  assert.equal(sent.status, 200);
  const owners = app.store.exportSession(app.runtime.owner, sent.body.sessionId);
  assert.equal(owners.files?.length, 1, "the owner's own export carries the file");
  const keyed = underShortLivedKey(() => app.store.exportSession(app.runtime.owner, sent.body.sessionId));
  assert.equal(keyed.files, undefined, "a key's export carries no file bytes");
  assert.ok(keyed.messages.some((message) => message.attachments?.length), "the references are still there");
});
