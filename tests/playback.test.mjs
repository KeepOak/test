import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { writeWav } from "../dist/media-audio.js";
import { signIn, attachFiles } from "./new-window-places.mjs";

/** FQ-surfaces.playback: an attached sound or video file plays inline in the conversation client,
 *  instead of only being turned into words (audio) or still pictures (video) — see public/playback.js.
 *  Redesign: in the new window a file is attached from the + menu's "Attach files" and waits as a file chip in #attached
 *  (prototype.html's composer chip); once sent, a sound or video file plays in the conversation from its own card
 *  (.media15, public/app/chat/media.js), drawn beside the message that carried it. */

/** One second of silence at 8 kHz, mono, 16-bit, so nothing here depends on a real recording. */
const silentWav = () => writeWav({ channels: 1, sampleRate: 8000, bitsPerSample: 16, blockAlign: 2 }, Buffer.alloc(16000));

/** One second of a 32x32 VP8 WebM (770 bytes, made with ffmpeg's lavfi colour source). VP8 because the
 *  Chromium Playwright ships cannot play H.264, so an MP4 would never load its metadata here. */
const clipWebm = () => readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "clip.webm"));
/** A 1x1 PNG, so a message can carry a picture beside its sound. */
const dotPng = () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-playback-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Heard it.", toolCalls: [] }; } },
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

async function openWorkspace(t, page, server) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The first-run card (#323) takes every click; these tests are about playback, so first run is marked done.
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  await signIn(page, server);
  return errors;
}
const chip = (page) => page.locator("#attached .file");
/** The player card beside the user message at `index` (the card is the .u.umedia15 drawn right after that message). */
const playersAfter = (page) => page.evaluate(() => [...document.querySelectorAll("#conversation > *, #conversation .u")]
  .filter((node) => node.matches(".u")).map((node) => ({ media: node.classList.contains("umedia15"), text: node.textContent,
    kind: node.querySelector(".media15")?.classList.contains("video") ? "video" : node.querySelector(".media15") ? "audio" : "" })));

test("an attached sound file gets a playable chip on the message box, and it can be taken off again", async (t) => {
  const { app, root } = await fixture(t);
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
  const errors = await openWorkspace(t, page, server);

  await attachFiles(page, [{ name: "note.wav", mimeType: "audio/wav", buffer: silentWav() }]);
  await chip(page).first().waitFor();
  assert.equal(await chip(page).count(), 1);
  assert.match(await chip(page).innerText(), /note\.wav/);
  // Redesign: replaced by the new window (prototype.html's composer chip is the file's name and size, not a player; the
  // file plays once it is sent, below).

  await chip(page).first().click();
  assert.equal(await chip(page).count(), 0, "the chip can be taken off again, same as a picture chip");
  assert.deepEqual(errors, []);
});

test("a sound file attached to a sent message plays inline in the conversation, next to the words it was turned into", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, permissions: [] });
  const errors = await openWorkspace(t, page, server);

  await attachFiles(page, [{ name: "note.wav", mimeType: "audio/wav", buffer: silentWav() }]);
  await chip(page).first().waitFor();

  await page.fill("#prompt", "here is a note");
  await page.click("#send");
  await page.locator("#conversation .umedia15 .media15.audio").waitFor({ timeout: 30000 });
  assert.equal(await page.locator("#conversation .media15.audio").count(), 1, "the sent message carries the player");
  assert.equal(await page.locator("#conversation .media15 [data-act=\"mplay15\"]").first().getAttribute("aria-label"), "Play note.wav");
  assert.equal(await chip(page).count(), 0, "the composer chip is cleared once the file has moved into the sent message");
  assert.deepEqual(errors, []);
});

/** Sends what is in the message box and waits until the conversation has been redrawn from what the
 *  server saved: only a redrawn user message carries "Branch from here", the one drawn at send does not. */
async function sendAndAwaitRedraw(page, words, userMessages) {
  await page.fill("#prompt", words);
  await page.click("#send");
  // Redesign: a message drawn from what the server saved carries its message id (data-i15); the reply is in once the typing
  // dots are gone.
  await page.waitForFunction((count) => document.querySelectorAll("#conversation .u[data-i15]:not(.umedia15)").length === count
    && !document.querySelector("#conversation .typing"), userMessages, { timeout: 120000 });
}
async function attachSound(page) {
  await attachFiles(page, [{ name: "note.wav", mimeType: "audio/wav", buffer: silentWav() }]);
  await chip(page).filter({ hasText: "note.wav" }).waitFor();
}
async function startPage(t) {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  return { page, errors: await openWorkspace(t, page, server) };
}
/** True once a <video> has loaded its metadata and knows a real, finite length. */
const videoReady = (sel) => {
  const video = document.querySelector(sel);
  return Boolean(video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0);
};

test("an attached video file gets a working <video> player, on the message box and in the sent message after it is redrawn", async (t) => {
  const { page, errors } = await startPage(t);
  await attachFiles(page, [{ name: "clip.webm", mimeType: "video/webm", buffer: await clipWebm() }]);
  await chip(page).first().waitFor();
  // Redesign: replaced by the new window (the composer chip is not a player; the card plays once the clip is sent).

  await sendAndAwaitRedraw(page, "here is a clip", 1);
  await page.locator("#conversation .media15.video").waitFor({ timeout: 60000 });
  await page.locator('#conversation .media15.video .m-play15').click();
  await page.waitForFunction(videoReady, "#conversation .media15.video video", { timeout: 60000 });
  const duration = await page.evaluate(() => document.querySelector("#conversation .media15.video video").duration);
  assert.ok(Math.abs(duration - 1) < 0.2, `the player knows the clip is about one second long (was ${duration})`);
  assert.equal(await page.locator("#conversation .media15.audio").count(), 0, "a video gets a video player, not a sound one");
  assert.deepEqual(errors, []);
});

test("a message that carried a picture and a sound keeps its player after the conversation is redrawn from what was saved", async (t) => {
  const { page, errors } = await startPage(t);
  await attachFiles(page, [{ name: "dot.png", mimeType: "image/png", buffer: dotPng() }]);
  await chip(page).filter({ hasText: "dot.png" }).waitFor();
  await attachSound(page);

  // The server saves these words with "[attached picture: dot.png]" after them (src/runtime.ts picturesNote).
  await sendAndAwaitRedraw(page, "a picture and a note", 1);
  assert.match(await page.locator("#conversation .u[data-i15]:not(.umedia15)").first().innerText(), /attached picture/, "this is the redrawn, saved message");
  assert.equal(await page.locator("#conversation .media15.audio").count(), 1, "the redrawn message still carries its player");
  assert.deepEqual(errors, []);
});

test("a later message with the same words but no file gets no player, in the same conversation or a new one", async (t) => {
  const { page, errors } = await startPage(t);
  await attachSound(page);
  await sendAndAwaitRedraw(page, "same words", 1);
  assert.equal(await page.locator("#conversation .media15.audio").count(), 1);

  await sendAndAwaitRedraw(page, "same words", 2);
  assert.equal(await page.locator("#conversation .media15").count(), 1, "only the message that carried the file plays it");
  const order = (await playersAfter(page)).map((one) => (one.media ? "player" : "message"));
  assert.deepEqual(order, ["message", "player", "message"], "and it is the first one's");

  await page.locator('#side [data-act="newmenu"]').click();
  await page.locator('.pop [data-act="newconv"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#conversation .u").length === 0);
  await sendAndAwaitRedraw(page, "same words", 1);
  assert.equal(await page.locator("#conversation .media15").count(), 0, "another conversation never shows this one's clip");
  assert.deepEqual(errors, []);
});

test("a clip sent into a conversation whose messages were never drawn here is not handed to an older message", async (t) => {
  const { page, errors } = await startPage(t);
  // The first send's redraw fails, so this page never learns which messages that conversation already has
  // (public/app.js keeps going: "New messages will continue this saved conversation").
  let failed = false;
  await page.route(/\/api\/sessions\/[0-9a-f-]{36}$/, (route) => {
    if (failed || route.request().method() !== "GET") return route.continue();
    failed = true;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "not now" }) });
  });
  await page.fill("#prompt", "first, with no file");
  await page.click("#send");
  // Redesign: the new window says the engine's refusal in the conversation and keeps going.
  await page.waitForFunction(() => /not now/.test(document.getElementById("conversation")?.textContent ?? "")
    && !document.querySelector("#conversation .typing"), undefined, { timeout: 120000 });

  await attachSound(page);
  await sendAndAwaitRedraw(page, "second, with a note", 2);
  const drawn = await playersAfter(page);
  const first = drawn.findIndex((one) => !one.media && one.text.includes("first, with no file"));
  assert.ok(first >= 0, "the first message is drawn");
  assert.equal(drawn[first + 1]?.media ?? false, false, "the older message never takes a clip it did not carry");
  assert.equal(drawn.filter((one) => one.media).length, 1, "the clip is with the message that carried it");
  assert.deepEqual(errors, []);
});
