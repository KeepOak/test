import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn, attachFiles } from "./new-window-places.mjs";
import { MediaTools, registerMedia, kindOf } from "../dist/media.js";
import { readWav, trimWav, writeWav, transcribeFile } from "../dist/media-audio.js";
import { mediaInfo, mp4Boxes, videoLimits } from "../dist/media-video.js";
import { estimateImageCost } from "../dist/media-settings.js";
import { providerImages, noImageEndpoint, ImageRequestSchema } from "../dist/media-images.js";
import { OpenAIProvider, GeminiProvider, AnthropicProvider } from "../dist/providers.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { ToolRegistry } from "../dist/registry.js";
import { Budget } from "../dist/contracts.js";

/** A picture the size of one pixel, so nothing in these tests depends on a real encoder. */
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** One second of silence at 8 kHz, mono, 16-bit: 8000 moments of two bytes each. */
const silence = () => writeWav({ channels: 1, sampleRate: 8000, bitsPerSample: 16, blockAlign: 2 }, Buffer.alloc(16000));

async function fixture(t, options = {}) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-media-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...options });
  t.after(async () => {
    await app.close();
    await discardTemp(root);
  });
  return { app, root, workspace: join(root, "workspace") };
}
/** A fake provider service that records what it was asked and answers the way the real one does. */
async function fakeService(t, handlers) {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: request.url, method: request.method, contentType: request.headers["content-type"] ?? "", headers: request.headers, body });
      const handler = Object.entries(handlers).find(([route]) => (request.url ?? "").startsWith(route))?.[1];
      if (!handler) {
        response.writeHead(404).end("{}");
        return;
      }
      const answer = handler(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, endpoint: `http://127.0.0.1:${server.address().port}` };
}
function context(app, overrides = {}) {
  return {
    owner: "local", workspace: app.runtime.workspace, runId: "mediarun", signal: AbortSignal.timeout(20000),
    budget: new Budget(), permissions: new Set(["media.read", "media.write"]), depth: 0, ...overrides,
  };
}
/** The media tools wired to a fake service rather than a real provider. */
function toolsFor(app, provider) {
  const media = new MediaTools(app.store, app.files, app.runtime.models, new NetworkPolicy({ allowPrivateAddresses: true }), fetch);
  media.artifacts = app.artifacts;
  app.runtime.models.register({ id: "test", name: "Test connection", provider, model: "test-model" });
  app.runtime.models.configure("local", { activePreset: "test", fallbackOrder: [], cooldownMs: 0, reasoning: null });
  return media;
}


test("a picture is one of the six files a message may carry, and its bytes are part of the budget", async (t) => {
  // The message box refuses a file the server would refuse anyway, so nothing long happens for
  // nothing. A picture went round both of those rules: it never reached the count, and it was
  // pushed with no `bytes` at all, so four 5 MB pictures added up to nothing. The page would take
  // ten files and 52 MB and hand them to a server that takes six and 32.
  const { app, root } = await fixture(t, { provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  // Redesign: files go through the message box's + menu, "Attach files", and wait as chips in #attached; the new window
  // keeps six files and 32 MB for one message (public/app/chat/plus.js) and says so in a toast.
  const chips = () => page.locator("#attached .file").allInnerTexts();
  const note = (name) => ({ name, mimeType: "text/plain", buffer: Buffer.from("a note") });

  // Redesign: replaced by the new window (a film is sent as the file itself; the window takes no stills out of it through
  // /api/media/understand), so the film counts as one file of the six.
  await attachFiles(page, [{ name: "film.mp4", mimeType: "video/mp4", buffer: Buffer.from("not really a film") }]);
  await page.locator("#attached .file").first().waitFor({ timeout: 30000 });
  assert.equal((await chips()).length, 1, "the film is one file");

  // So five more files fit, and a seventh is refused.
  await attachFiles(page, [note("1.txt"), note("2.txt"), note("3.txt"), note("4.txt"), note("5.txt")]);
  await page.waitForFunction(() => document.querySelectorAll("#attached .file").length === 6, null, { timeout: 30000 })
    .catch(() => { throw new Error("a file was refused for room that was there"); });
  await attachFiles(page, [note("6.txt")]);
  await page.locator(".toast").filter({ hasText: "At most 6 files" }).waitFor({ timeout: 30000 })
    .catch(() => { throw new Error("the seventh file was not refused"); });
  assert.equal((await chips()).length, 6);

  // And what they weigh. One 20 MB document leaves 12 MB; three 5 MB pictures do not fit in it.
  while (await page.locator("#attached .file").count()) await page.locator("#attached .file").first().click();
  await attachFiles(page, [
    { name: "big.txt", mimeType: "text/plain", buffer: Buffer.alloc(20 * 1024 * 1024, 97) },
    { name: "a.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024, 1) },
    { name: "b.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024, 2) },
    { name: "c.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024, 3) },
  ]);
  // The toast from the seventh file says the same words, so the refusal is read from the chips once they are drawn.
  await page.waitForFunction(() => document.querySelectorAll("#attached .file").length > 0, null, { timeout: 60000 });
  await page.locator(".toast").filter({ hasText: "32 MB" }).waitFor({ timeout: 60000 })
    .catch(() => { throw new Error("35 MB of files was not refused"); });
  const kept = (await chips()).map((one) => one.match(/(big\.txt|[abc]\.png)/)?.[1]);
  assert.deepEqual(kept, ["big.txt", "a.png", "b.png"], "the two that fit stayed; the one that did not was left off");
  assert.deepEqual(errors, []);
});


test("a picture is asked for at /images/generations and lands as an artifact", async (t) => {
  const { app, workspace } = await fixture(t);
  const service = await fakeService(t, {
    "/images/generations": () => ({ data: [{ b64_json: onePixelPng.toString("base64") }] }),
  });
  const media = toolsFor(app, new OpenAIProvider({ endpoint: service.endpoint, model: "gpt-4o", apiKey: "sk-test" }));
  const result = await media.image({ prompt: "an oak tree", size: "512x512", save: "tree.png" }, context(app));

  const asked = JSON.parse(service.seen[0].body.toString("utf8"));
  assert.equal(service.seen[0].url, "/images/generations");
  assert.equal(asked.prompt, "an oak tree");
  assert.equal(asked.size, "512x512");
  assert.equal(asked.response_format, "b64_json");
  assert.equal(asked.model, "gpt-image-1", "the provider's usual picture model is used when none is named");
  assert.equal(result.mediaType, "image/png");
  assert.equal(result.bytes, onePixelPng.length);
  assert.match(result.path, /picture-[a-f0-9]{8}\.png$/);
  assert.equal((await readFile(result.path)).toString("base64"), onePixelPng.toString("base64"));
  assert.equal(result.savedAs, "media/tree.png", "it was also put in the person's own workspace");
  assert.equal((await readFile(join(workspace, "media", "tree.png"))).length, onePixelPng.length);
  assert.equal(result.cost.amount, null, "the built-in price is for a 1024x1024 picture, so 512x512 has none");
  assert.match(result.cost.note, /1024x1024/);

  for (const bad of ["../escape.png", "a/b.png", "notes.txt", ".hidden.png"])
    assert.equal(
      ImageRequestSchema.safeParse({ prompt: "x", save: bad }).success,
      false,
      `${bad} is refused as a save name`,
    );
});

test("changing a picture goes to /images/edits as a form with the source in it", async (t) => {
  const { app, workspace } = await fixture(t);
  await mkdir(join(workspace, "pictures"), { recursive: true });
  await writeFile(join(workspace, "pictures", "before.png"), onePixelPng);
  const service = await fakeService(t, { "/images/edits": () => ({ data: [{ b64_json: onePixelPng.toString("base64") }] }) });
  const media = toolsFor(app, new OpenAIProvider({ endpoint: service.endpoint, model: "gpt-4o", apiKey: "sk-test" }));

  const result = await media.image(
    { prompt: "make the sky pink", size: "1024x1024", edit: { source: "pictures/before.png" } },
    context(app),
  );
  const call = service.seen[0];
  assert.equal(call.url, "/images/edits");
  assert.match(call.contentType, /^multipart\/form-data/);
  const body = call.body.toString("latin1");
  for (const field of ["name=\"prompt\"", "name=\"size\"", "name=\"image\"", "make the sky pink"])
    assert.ok(body.includes(field), `the form carries ${field}`);
  assert.equal(result.mediaType, "image/png");
});

test("Gemini asks its own route for a picture, and a model with no picture service refuses plainly", async (t) => {
  const { app } = await fixture(t);
  const service = await fakeService(t, {
    "/v1beta/models": () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: onePixelPng.toString("base64") } }] } }] }),
  });
  const gemini = toolsFor(app, new GeminiProvider({ endpoint: service.endpoint, model: "gemini-2.0-flash", apiKey: "key" }));
  const made = await gemini.image({ prompt: "a river", size: "1024x1024" }, context(app));
  // The key goes in the header Google documents for keys, never in the address: an address is
  // written down in logs and history, and a key written down there stays written down.
  assert.equal(service.seen[0].url, "/v1beta/models/gemini-2.5-flash-image:generateContent");
  assert.equal(service.seen[0].headers["x-goog-api-key"], "key");
  assert.equal(service.seen[0].headers.authorization, undefined);
  assert.equal(JSON.parse(service.seen[0].body.toString("utf8")).generationConfig.responseModalities[0], "IMAGE");
  assert.equal(made.mediaType, "image/png");

  assert.equal(providerImages(new AnthropicProvider({ endpoint: "https://api.anthropic.com", model: "claude", apiKey: "k" })), null);
  const { app: second } = await fixture(t);
  const noPictures = toolsFor(second, new AnthropicProvider({ endpoint: "https://api.anthropic.com", model: "claude", apiKey: "k" }));
  await assert.rejects(noPictures.image({ prompt: "anything", size: "1024x1024" }, context(second)), new RegExp(noImageEndpoint.slice(0, 40)));
});

test("describing a picture sends it to the model as an image part, and a text-only model says so", async (t) => {
  const { app, workspace } = await fixture(t);
  await writeFile(join(workspace, "chart.png"), onePixelPng);
  const seen = [];
  const seeing = {
    name: "seeing", acceptsImages: true, supportsImages: () => true,
    async complete(request) { seen.push(request.messages); return { content: "A single grey dot.", toolCalls: [], usage: { input: 10, output: 5 } }; },
  };
  const media = toolsFor(app, seeing);
  const described = await media.describe({ path: "chart.png", mode: "text" }, context(app));
  const user = seen[0].at(-1);
  assert.equal(user.images.length, 1);
  assert.equal(user.images[0].mediaType, "image/png");
  assert.equal(user.images[0].data, onePixelPng.toString("base64"));
  assert.match(user.content, /Write out every piece of text/);
  assert.equal(described.answer, "A single grey dot.");

  const compared = await media.compare({ first: "chart.png", second: "chart.png" }, context(app));
  assert.equal(seen[1].at(-1).images.length, 2, "both pictures travel in one message");
  assert.equal(compared.first, "chart.png");

  const blind = toolsFor(await fixture(t).then((f) => f.app), { name: "blind", async complete() { return { content: "", toolCalls: [] }; } });
  await assert.rejects(blind.describe({ path: "chart.png", mode: "describe" }, context(app)), /cannot look at pictures/);
});

test("speech is written out with times, and read aloud into a file the person keeps", async (t) => {
  const { app, workspace } = await fixture(t);
  await writeFile(join(workspace, "note.wav"), silence());
  const service = await fakeService(t, {
    // Reading aloud still goes through the older browser-recording route shape, which writes /v1 itself.
    "/v1/audio/speech": () => ({ sound: "bytes" }),
    "/audio/transcriptions": () => ({ text: "hello there", segments: [{ start: 0, end: 1.2, text: "hello there" }] }),
  });
  const media = toolsFor(app, new OpenAIProvider({ endpoint: service.endpoint, model: "gpt-4o", apiKey: "sk-test" }));
  const written = await media.transcribe({ path: "note.wav", timestamps: true }, context(app));
  assert.equal(written.text, "hello there");
  assert.deepEqual(written.segments, [{ start: 0, end: 1.2, text: "hello there" }]);
  const form = service.seen[0].body.toString("latin1");
  assert.ok(form.includes("verbose_json") && form.includes("timestamp_granularities[]"), "times were asked for");

  const spoken = await media.speak({ text: "good morning", voice: "nova", save: "greeting.mp3" }, context(app));
  assert.equal(JSON.parse(service.seen[1].body.toString("utf8")).voice, "nova", "the voice that was asked for is used");
  assert.equal(spoken.mediaType, "audio/mpeg");
  assert.equal(spoken.savedAs, "media/greeting.mp3");
  assert.ok((await readFile(join(workspace, "media", "greeting.mp3"))).length > 0);

  await assert.rejects(
    transcribeFile(Buffer.alloc(4), "x.wav", "audio/wav", null, new NetworkPolicy({ allowPrivateAddresses: true }), fetch),
    /needs an OpenAI-compatible provider/,
  );
});

test("trimming a WAV gives a valid file of the right length, and other formats are turned down", async (t) => {
  const { app, workspace } = await fixture(t);
  await writeFile(join(workspace, "long.wav"), silence());
  await writeFile(join(workspace, "song.mp3"), Buffer.from([0xff, 0xfb, 0x10, 0x00, 0, 0, 0, 0]));
  const media = toolsFor(app, { name: "any", async complete() { return { content: "", toolCalls: [] }; } });

  const result = await media.trim({ path: "long.wav", from: 0.25, to: 0.75, save: "clip.wav" }, context(app));
  const cut = readWav(await readFile(join(workspace, "media", "clip.wav")));
  assert.equal(cut.sampleRate, 8000);
  assert.equal(cut.channels, 1);
  assert.equal(cut.bitsPerSample, 16);
  assert.equal(cut.samples.length, 8000, "half a second of 8 kHz 16-bit mono sound is 8000 bytes");
  assert.equal(Number(result.seconds.toFixed(2)), 0.5);
  assert.equal(Number(result.of.toFixed(2)), 1);
  assert.equal(result.mediaType, "audio/wav");

  await assert.rejects(media.trim({ path: "song.mp3", from: 0, to: 1 }, context(app)), /not a WAV sound file/);
  assert.equal(trimWav(silence(), 0, 0.1).wav.subarray(0, 4).toString("latin1"), "RIFF");
});

test("a small MP4 is read from its own headers, and the video limits are stated", async (t) => {
  const { app, workspace } = await fixture(t);
  const box = (type, body) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length, 0);
    header.write(type, 4, "latin1");
    return Buffer.concat([header, body]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(600, 12); // time scale: 600 ticks a second
  mvhd.writeUInt32BE(3600, 16); // six seconds of them
  const mp4 = Buffer.concat([
    box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), Buffer.from([0, 0, 2, 0])])),
    box("moov", Buffer.concat([box("mvhd", mvhd), box("trak", Buffer.alloc(8)), box("trak", Buffer.alloc(8))])),
    box("mdat", Buffer.alloc(16)),
  ]);
  await writeFile(join(workspace, "clip.mp4"), mp4);
  await writeFile(join(workspace, "note.wav"), silence());
  const media = toolsFor(app, { name: "any", async complete() { return { content: "", toolCalls: [] }; } });

  const info = await media.info({ path: "clip.mp4" });
  assert.equal(info.format, "mp4");
  assert.equal(info.seconds, 6);
  assert.equal(info.brand, "isom");
  assert.equal(info.tracks, 2);
  assert.equal(info.bytes, mp4.length);
  assert.ok(info.note.includes("cannot pull still frames"), "the limit is said plainly");
  assert.equal(mp4Boxes(mp4).map((b) => b.type).join(","), "ftyp,moov,mdat");

  const sound = await media.info({ path: "note.wav" });
  assert.equal(sound.format, "wav");
  assert.equal(sound.seconds, 1);
  assert.ok(videoLimits.includes("does not make videos"));
  assert.throws(() => mediaInfo(Buffer.from("not a media file at all")), /Only MP4 video and WAV sound files/);
});

test("a picture on the composer reaches the run as an image part, and the gallery route lists what was made", async (t) => {
  const seen = [];
  const { app, root } = await fixture(t, {
    provider: {
      name: "scripted", acceptsImages: true, supportsImages: () => true,
      async complete(request) { seen.push(request.messages); return { content: "I can see it.", toolCalls: [] }; },
    },
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, options = {}) => {
    const response = await fetch(server.url + path, {
      method: options.method ?? (options.body ? "POST" : "GET"),
      headers: { authorization: "Bearer " + server.token, ...(options.body ? { "content-type": "application/json" } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const run = await call("/api/run", {
    body: { prompt: "What is in this picture?", images: [{ mediaType: "image/png", data: onePixelPng.toString("base64"), name: "dot.png" }] },
  });
  assert.equal(run.status, 200);
  const carried = seen.at(-1).find((message) => message.images?.length);
  assert.ok(carried, "the picture reached the model with the message");
  assert.equal(carried.images[0].data, onePixelPng.toString("base64"));

  await app.artifacts.write(run.body.id.replace(/-/g, "").slice(0, 16), "picture-aabbccdd.png", "image/png", onePixelPng);
  const gallery = await call("/api/artifacts?type=image");
  assert.equal(gallery.status, 200);
  assert.equal(gallery.body.artifacts.length, 1);
  assert.equal(gallery.body.artifacts[0].name, "picture-aabbccdd.png");
  assert.equal(gallery.body.artifacts[0].mediaType, "image/png");

  const bytes = await fetch(server.url + "/api/artifacts/file?path=" + encodeURIComponent(gallery.body.artifacts[0].path), {
    headers: { authorization: "Bearer " + server.token },
  });
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await bytes.arrayBuffer()).length, onePixelPng.length);

  const missing = await call("/api/artifacts/file?path=" + encodeURIComponent(join(root, "data", "branch.sqlite")));
  assert.equal(missing.status, 404, "nothing outside the artifacts folder is served");
});

test("the media settings route saves a folder and a model, and prices stay honest", async (t) => {
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
  assert.equal((await call("/api/media/settings")).body.settings.folder, "media");
  const saved = await call("/api/media/settings", { imageModel: "dall-e-3", folder: "artwork", imagePrices: { "dall-e-3": 0.08 } });
  assert.equal(saved.body.settings.imageModel, "dall-e-3");
  assert.equal((await call("/api/media/settings")).body.settings.folder, "artwork");
  assert.equal((await call("/api/media/settings", { imageModel: "", folder: "../escape", imagePrices: {} })).status, 400);

  assert.equal(estimateImageCost("nothing-known", 2).amount, null);
  assert.equal(estimateImageCost("nothing-known", 2).confidence, "unknown");
  assert.equal(estimateImageCost("dall-e-3", 2).amount, 0.08, "the table price covers a standard picture");
  assert.equal(estimateImageCost("dall-e-3", 2).confidence, "table");
  assert.equal(estimateImageCost("dall-e-3", 2, {}, "1536x1024").amount, null, "a bigger picture has no price on file");
  assert.equal(estimateImageCost("dall-e-3", 3, { "dall-e-3": 0.08 }).amount, 0.24);
  assert.equal(estimateImageCost("dall-e-3", 3, { "dall-e-3": 0.08 }).confidence, "override");
  assert.equal(estimateImageCost("dall-e-3", 1, { "dall-e-3": 0.08 }, "1536x1024").amount, 0.08, "your own price is yours to mean what you like");
  assert.equal(kindOf("a/b/photo.JPEG"), "image/jpeg");
});

test("the picture button on the message box makes a chip the next message will carry", async (t) => {
  const { app, root } = await fixture(t, { provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);

  // Redesign: the new window's "Attach files" in the + menu; a picture waits as a chip in #attached.
  await attachFiles(page, [{ name: "dot.png", mimeType: "image/png", buffer: onePixelPng }]);
  await page.locator("#attached .file").first().waitFor();
  assert.equal(await page.locator("#attached .file").count(), 1);
  assert.match(await page.locator("#attached .file").innerText(), /dot\.png/);
  // That it travels once, as a file the message carries, is checked on what POST /api/run is sent in attachments-ui.test.mjs.
  await page.locator("#attached .file").first().click();
  assert.equal(await page.locator("#attached .file").count(), 0, "the chip can be taken off again");
  assert.deepEqual(errors, []);
});

test("every media tool is registered with a permission and a target the approval rules can match", async (t) => {
  const { app } = await fixture(t);
  const media = toolsFor(app, { name: "any", async complete() { return { content: "", toolCalls: [] }; } });
  const registry = new ToolRegistry();
  registerMedia(registry, media);
  const where = context(app);
  assert.equal(registry.targetOf("media.image", { prompt: "x", save: "poster.png" }, where), "media/poster.png");
  assert.equal(registry.targetOf("media.image", { prompt: "x", edit: { source: "art/old.png" } }, where), "art/old.png");
  assert.equal(registry.targetOf("media.speak", { text: "hello", save: "note.mp3" }, where), "media/note.mp3");
  assert.equal(registry.targetOf("media.trim", { path: "long.wav", from: 0, to: 1 }, where), "long.wav");
  assert.equal(registry.targetOf("media.compare", { first: "a.png", second: "b.png" }, where), "a.png");
  assert.equal(registry.targetOf("media.describe", { path: "chart.png" }, where), "chart.png");
  const names = registry.names();
  for (const tool of ["media.image", "media.describe", "media.compare", "media.transcribe", "media.speak", "media.trim", "media.info"])
    assert.ok(names.includes(tool), `${tool} is registered`);
  assert.ok(!names.includes("media.frames"), "the plain media toolbox has no frame tool; it comes with the video switch (tests/media-understand.test.mjs)");
  assert.ok(app.registry.names().includes("media.frames"), "the app registers it; the switch in Settings decides whether it is offered");
  assert.equal(registry.permissionOf("media.describe"), "media.read");
  assert.equal(registry.permissionOf("media.image"), "media.write");
});
