import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { deflateSync, inflateSync } from "node:zlib";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { MediaTools } from "../dist/media.js";
import { mediaInfo, mp4Boxes } from "../dist/media-video.js";
import { makeVideo, saveVideoSettings } from "../dist/reach/video.js";
import { saveReachMode } from "../dist/reach/settings.js";
import { OpenAIProvider } from "../dist/providers.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { Budget } from "../dist/contracts.js";

/**
 * surfaces.generation: a picture and a video that were made are real files, and this test opens both.
 *
 * The row stayed partial for a plain reason: the picture fixture was a single pixel nobody ever
 * decoded, and the video fixture was twenty-six bytes beginning with "ftypisom" — enough to look like
 * an MP4 to a check that only reads the first box. Neither proved a person could open what Branch
 * saved.
 *
 * So the stand-in services answer with files that really are what they claim. The picture is built
 * here and compressed properly. The video is a VP9 film kept at `tests/fixtures/two-colours-vp9.mp4` —
 * a red second and a blue second — encoded once, away from this test; nothing here needs ffmpeg on the
 * computer running it.
 *
 * **That paragraph used to vouch for the film itself** — "genuinely encoded", "two seconds", "1,256
 * bytes" — which is prose, and prose goes on being reassuring about whatever bytes are at that path.
 * The claims are checked now instead: its digest and size are pinned, and its container is read back
 * field by field, in the test named for it below. Nothing here describes the fixture that is not also
 * asserted about it.
 *
 * What Branch saved is then opened: the PNG back to its exact pixels, and the video **played by a real
 * browser**, which decodes two frames and hands back their colours. Branch's own reader is asked as
 * well, so the file is readable by the app and not only by this test.
 *
 * Nothing leaves this computer, and no window opens.
 */

const owner = "local";
const here = dirname(fileURLToPath(import.meta.url));
const videoFixture = join(here, "fixtures", "two-colours-vp9.mp4");
/** What the film shows, and where to look: red for the first second, blue for the second. */
const RED_AT = 0.2, BLUE_AT = 1.5;

/* ---------- a real PNG, made here ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Eight-bit colour, three bytes a pixel, every row written plainly (filter 0). */
function realPng(width, height, colourAt) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // the leading 0 is "this row is stored as it is"
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colourAt(x, y);
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([PNG_MAGIC, chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
/** Opens a PNG: the chunks with their check numbers, then the pixels themselves. */
function openPng(file) {
  const bytes = Buffer.from(file);
  assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC), "it begins the way a PNG begins");
  let at = 8, header = null, previous = null;
  const pressed = [];
  while (at + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(at), type = bytes.subarray(at + 4, at + 8).toString("ascii");
    const data = bytes.subarray(at + 8, at + 8 + size);
    assert.equal(bytes.readUInt32BE(at + 8 + size), crc32(bytes.subarray(at + 4, at + 8 + size)),
      `the ${type} part's check number is right`);
    /* The order is part of being a PNG, not decoration: the size has to come first, and nothing at all
       may come after the end. Walking the parts without asking either question accepted a file whose
       IHDR was second and one that carried a second IEND — both of which a half-written save looks
       like, and both of which this test would then have called a real picture. */
    if (previous === null) assert.equal(type, "IHDR", "the first part says how big it is");
    else assert.notEqual(previous, "IEND", `a ${type} part follows the end of the picture`);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4),
      depth: data[8], colour: data[9], interlace: data[12] };
    if (type === "IDAT") pressed.push(data);
    previous = type;
    at += 12 + size;
  }
  /* And it has to be finished. The walk used to stop wherever it ran out, so a file with its ending cut
     off, or with anything appended to it, was opened as happily as a whole one. */
  assert.equal(previous, "IEND", "it ends where a finished picture ends");
  assert.equal(at, bytes.length, "and nothing follows the end of it");
  assert.ok(header, "it says how big it is");
  assert.equal(header.depth, 8); assert.equal(header.colour, 2); assert.equal(header.interlace, 0);
  const flat = inflateSync(Buffer.concat(pressed));
  const stride = 1 + header.width * 3;
  assert.equal(flat.length, stride * header.height, "every row is there once uncompressed");
  const pixel = (x, y) => {
    assert.equal(flat[y * stride], 0, "the row is stored as it is");
    const at = y * stride + 1 + x * 3;
    return [flat[at], flat[at + 1], flat[at + 2]];
  };
  return { ...header, pixel };
}

/* ---------- reading the film's own description of itself ---------- */

const inside = (box) => mp4Boxes(box.body);
const find = (boxes, type) => boxes.find((one) => one.type === type);
/** What the file says it holds: the track, what kind of pictures, how big and how long. */
function describeMp4(file) {
  const top = mp4Boxes(Buffer.from(file));
  const moov = find(top, "moov"), mdat = find(top, "mdat");
  assert.ok(moov && mdat, "it has a movie and some data");
  assert.ok(mdat.body.length > 0, "and the data is not empty");
  const inMoov = inside(moov);
  const trak = find(inMoov, "trak");
  const mdia = inside(find(inside(trak), "mdia"));
  const mdhd = find(mdia, "mdhd").body;
  const stbl = inside(find(inside(find(mdia, "minf")), "stbl"));
  const entry = mp4Boxes(find(stbl, "stsd").body.subarray(8))[0];
  return {
    tracks: inMoov.filter((one) => one.type === "trak").length,
    handler: find(mdia, "hdlr").body.subarray(8, 12).toString("ascii"),
    codec: entry.type, width: entry.body.readUInt16BE(24), height: entry.body.readUInt16BE(26),
    seconds: mdhd.readUInt32BE(16) / mdhd.readUInt32BE(12),
    mediaBytes: mdat.body.length,
  };
}

/** Plays the film in a real browser and hands back the colour in the middle of two frames. */
async function coloursWhilePlaying(t, file) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body><video id=v muted></video><canvas id=c></canvas>");
  return page.evaluate(async ({ source, times }) => {
    const video = document.getElementById("v"), canvas = document.getElementById("c");
    video.src = source;
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error(`the browser could not open it: ${video.error?.message ?? video.error?.code}`));
      setTimeout(() => reject(new Error("the browser never opened it")), 15000);
    });
    const middleAt = async (time) => {
      // The frame is read once the browser has shown it: `seeked` can come before the decoded frame is on the element,
      // and a frame drawn then is black. A paused video still calls requestVideoFrameCallback for the frame a seek shows.
      const shown = new Promise((resolve) => { video.requestVideoFrameCallback(() => resolve()); setTimeout(resolve, 5000); });
      await new Promise((resolve) => { video.onseeked = resolve; video.currentTime = time; setTimeout(resolve, 5000); });
      await shown;
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0);
      const dot = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return [dot[0], dot[1], dot[2]];
    };
    const colours = [];
    for (const time of times) colours.push(await middleAt(time));
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, colours };
  }, { source: `data:video/mp4;base64,${Buffer.from(file).toString("base64")}`, times: [RED_AT, BLUE_AT] });
}

/* ---------- the two services, and Branch ---------- */

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-generation-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}
async function pictureService(t, png) {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
/** A stand-in video service that hands back the encoded film, and Branch saving it. */
async function videoMade(t, app, root, name = "video_1") {
  const film = await readFile(videoFixture);
  saveReachMode(app.store, owner, "video", { mode: "on" });
  saveVideoSettings(app.store, owner, { service: "openai" });
  const states = ["queued", "completed"];
  const deps = {
    fetcher: async (url) => {
      if (String(url).endsWith("/v1/videos")) return Response.json({ id: name, status: "queued" });
      if (String(url).endsWith("/content")) return new Response(film);
      return Response.json({ id: name, status: states.shift() ?? "completed" });
    },
    secret: async () => "sk-test-123", files: app.files, sleep: async () => undefined,
    now: () => new Date("2026-09-22T10:00:00Z"),
  };
  const made = await makeVideo(app.store, owner, deps, { prompt: "an oak in the wind", seconds: 4 }, AbortSignal.timeout(20000));
  return { film, made, saved: await readFile(join(root, "workspace", made.path)) };
}

test("a picture that was made is a real picture, opened down to its pixels", async (t) => {
  const { app, workspace } = await fixture(t);
  // Four by three, a red corner and a green stripe, so the pixels can be told apart.
  const sent = realPng(4, 3, (x, y) => (y === 1 ? [0, 200, 0] : x === 0 ? [200, 0, 0] : [10, 20, 30]));
  const endpoint = await pictureService(t, sent);
  const media = new MediaTools(app.store, app.files, app.runtime.models,
    new NetworkPolicy({ allowPrivateAddresses: true }), fetch);
  media.artifacts = app.artifacts;
  app.runtime.models.register({ id: "test", name: "Test connection",
    provider: new OpenAIProvider({ endpoint, model: "gpt-4o", apiKey: "sk-test" }), model: "test-model" });
  app.runtime.models.configure(owner, { activePreset: "test", fallbackOrder: [], cooldownMs: 0, reasoning: null });

  const made = await media.image({ prompt: "an oak tree", size: "512x512", save: "tree.png" }, {
    owner, workspace: app.runtime.workspace, runId: "genrun", signal: AbortSignal.timeout(20000),
    budget: new Budget(), permissions: new Set(["media.read", "media.write"]), depth: 0,
  });

  assert.equal(made.mediaType, "image/png");
  for (const file of [made.path, join(workspace, "media", "tree.png")]) {
    const picture = openPng(await readFile(file));
    assert.equal(picture.width, 4, `${file} is four pixels across`);
    assert.equal(picture.height, 3);
    assert.deepEqual(picture.pixel(0, 0), [200, 0, 0], "the red corner survived");
    assert.deepEqual(picture.pixel(2, 1), [0, 200, 0], "and the green stripe");
    assert.deepEqual(picture.pixel(3, 2), [10, 20, 30]);
  }
});

test("a video that was made really plays: a browser decodes its frames to the colours that were filmed", async (t) => {
  const { app, root } = await fixture(t);
  const { film, saved } = await videoMade(t, app, root);

  assert.ok(saved.equals(film), "what was saved is byte for byte what the service sent");
  const played = await coloursWhilePlaying(t, saved);
  assert.equal(played.width, 32, "the browser reports the film's own size");
  assert.equal(played.height, 32);
  assert.ok(Math.abs(played.duration - 2) < 0.2, `two seconds long (${played.duration})`);

  const [red, blue] = played.colours;
  assert.ok(red[0] > 150 && red[1] < 80 && red[2] < 80, `the first second is red, decoded (${red})`);
  assert.ok(blue[2] > 150 && blue[0] < 80 && blue[1] < 80, `the second second is blue, decoded (${blue})`);
});

test("the saved film's own description matches what plays", async (t) => {
  const { app, root } = await fixture(t);
  const { saved } = await videoMade(t, app, root, "video_2");

  const film = describeMp4(saved);
  assert.equal(film.tracks, 1);
  assert.equal(film.handler, "vide", "the track holds pictures");
  assert.equal(film.codec, "vp09", "and says which decoder opens them");
  assert.equal(film.width, 32);
  assert.equal(film.height, 32);
  assert.ok(Math.abs(film.seconds - 2) < 0.05, `two seconds (${film.seconds})`);
  assert.ok(film.mediaBytes > 100, `with real encoded frames in it (${film.mediaBytes} bytes)`);
});

test("Branch's own reader opens the saved video, and says what it is", async (t) => {
  const { app, root } = await fixture(t);
  const { saved } = await videoMade(t, app, root, "video_3");

  const read = mediaInfo(saved);
  assert.equal(read.format, "mp4");
  assert.equal(read.brand, "isom");
  assert.ok(Math.abs(read.seconds - 2) < 0.05, "the length Branch shows is the film's own");
  assert.equal(read.tracks, 1, "and it found the track");
});

test("the stand-in bytes the old fixtures used would not open", () => {
  const pretend = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom"), Buffer.alloc(4), Buffer.from("more video")]);
  assert.throws(() => describeMp4(pretend), /a movie and some data/);
  const info = mediaInfo(pretend);
  assert.equal(info.seconds, null, "Branch cannot say how long it is");
  assert.equal(info.tracks, 0, "because there is no track in it");
});

/*
 * What "a real picture" has to mean, held one shape at a time.
 *
 * The reader walked the parts and stopped wherever it ran out, asking nothing about the order they
 * came in or whether anything followed the last one. Four files that are not finished PNGs were opened
 * without complaint, and every one of them is what a half-written or tampered save looks like. The
 * first two were named in review; the second two were found while fixing them.
 */
test("a file that is not a finished PNG is refused, four ways", () => {
  const good = realPng(2, 1, () => [255, 0, 0]);
  openPng(good); // the control: a whole one still opens

  const broken = {
    "anything appended after the end": Buffer.concat([good, Buffer.from("junk!")]),
    "the ending cut off": good.subarray(0, good.length - 12),
    "a part before the one that says how big it is":
      Buffer.concat([PNG_MAGIC, chunk("tEXt", Buffer.from("x")), good.subarray(8)]),
    "a second ending after the first": Buffer.concat([good, chunk("IEND", Buffer.alloc(0))]),
  };
  for (const [what, bytes] of Object.entries(broken))
    assert.throws(() => openPng(bytes), /IEND|follows|first part|ends where/,
      `opened a picture with ${what} (${bytes.length} bytes)`);

  /* The two that a byte count alone cannot tell apart: appended rubbish leaves the walk short of the
     end, while an appended *part* consumes it exactly — so one is caught by where the walk stopped and
     the other only by what the last part was. Both assertions are load-bearing. */
  assert.throws(() => openPng(Buffer.concat([good, Buffer.from("j")])), /nothing follows/);
  assert.throws(() => openPng(Buffer.concat([good, chunk("IEND", Buffer.alloc(0))])), /follows the end/);
});

/*
 * The film's provenance, checked instead of asserted.
 *
 * The header of this file used to say the fixture was "genuinely encoded", "two seconds", "1,256
 * bytes" — prose that went on vouching for whatever bytes happened to be at that path. The digest is
 * pinned here, so replacing the file fails rather than quietly passing, and nothing about this needs an
 * encoder on the machine running it: the decoded-content evidence is the browser test above.
 */
test("the film fixture is the one that was encoded, by digest and not by description", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(join(import.meta.dirname, "fixtures", "two-colours-vp9.mp4"));
  assert.equal(bytes.length, 1256, "the size it was encoded at");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "b5a7f22f5b3481289aa72fc14dfc6264845724ceff54fe77f7625e8d3d8ff0aa",
    "a different film is in this file; re-record the digest deliberately or put the encoded one back");

  // And it really is the film it claims to be, read out of the container itself.
  /* And it really is the film it claims to be, read out of the container rather than out of the prose:
     one video track of VP9 at 32x32, two seconds long, with 345 bytes of encoded picture in it. */
  assert.deepEqual(describeMp4(bytes),
    { tracks: 1, handler: "vide", codec: "vp09", width: 32, height: 32, seconds: 2, mediaBytes: 345 },
    "the container no longer describes the film the digest pins");
});
