import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";
import { clipboardPaths, isPasteKeys, mayReadClipboardFiles, PasteGate, pasteGateMs, sendablePaths } from "../dist/desktop/clipboard-paths.js";
import { ownDownload } from "../dist/desktop/own-download.js";

/**
 * attach-anything, in the window: paste (long text, a picture, a list of files), drop (many kinds at once, a folder), and
 * the + menu, each file a chip with its own preview and real progress, then sent with the message by upload id.
 * Local only: a scripted model, a server on its own port, a headless browser.
 */
const SHOTS = process.env.BRANCH_SHOTS || "";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function windowWithBranch(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-anything-ui-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const seen = [];
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete(request) { seen.push(request.messages); return { content: "Read it.", toolCalls: [] }; } },
  });
  closing.push(() => app.close());
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  closing.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  return { app, page, errors, seen };
}

/* Builds files inside the page (so they are real File objects) from [name, type, how] and fires a paste or a drop with them. */
const FILES = `(specs) => specs.map(([name, type, how, size]) => {
  const bytes = how === "png" ? Uint8Array.from(atob("${png}"), (c) => c.charCodeAt(0))
    : how === "pdf" ? new TextEncoder().encode("%PDF-1.4\\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj 2 0 obj << /Type /Pages /Count 2 >> endobj 3 0 obj << /Type /Page >> endobj 4 0 obj << /Type /Page >> endobj")
    : how === "wav" ? (() => { const rate = 8000, n = rate, b = new DataView(new ArrayBuffer(44 + n * 2)); const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
        w(0, "RIFF"); b.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
        b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, "data"); b.setUint32(40, n * 2, true); return new Uint8Array(b.buffer); })()
    : how === "big" ? new Uint8Array(size)
    : new TextEncoder().encode(how);
  return new File([bytes], name, { type });
})`;
async function paste(page, { specs = [], text = "" }) {
  await page.locator("#prompt").focus();
  await page.evaluate(([make, specs, text]) => {
    const data = new DataTransfer();
    for (const file of eval(make)(specs)) data.items.add(file);
    if (text) data.setData("text/plain", text);
    document.querySelector("#prompt").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [FILES, specs, text]);
}
async function drop(page, specs, at = "#conversation, .chat-empty, main") {
  await page.evaluate(([make, specs, at]) => {
    const data = new DataTransfer();
    for (const file of eval(make)(specs)) data.items.add(file);
    const target = document.querySelector(at);
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [FILES, specs, at]);
}
const ready = (page, n) => page.waitForFunction((n) => document.querySelectorAll("#attached .att.ready").length === n, n, { timeout: 30000 });
const chipOf = (page, name) => page.locator("#attached .att", { hasText: name });

test("pasting long text makes a text file chip, and short text stays in the box", async (t) => {
  const { page, errors } = await windowWithBranch(t);
  await paste(page, { text: "short words" });
  assert.equal(await page.locator("#attached .att").count(), 0, "a short paste is not a file");
  await paste(page, { text: "line of a long log\n".repeat(400) });
  await ready(page, 1);
  const chip = chipOf(page, "Pasted text.txt");
  assert.match(await chip.innerText(), /line of a long log/, "the chip shows the first words");
  assert.equal(await chip.getAttribute("data-kind"), "text");
  assert.deepEqual(errors, []);
});

test("pasting a copied picture and a list of copied files attaches each, with its own preview", async (t) => {
  const { page, errors } = await windowWithBranch(t);
  await paste(page, { specs: [["image.png", "image/png", "png"]] });
  await paste(page, { specs: [["report.pdf", "application/pdf", "pdf"], ["archive.zip", "application/zip", "PK..."]] });
  await ready(page, 3);
  assert.equal(await chipOf(page, "Pasted text.png").locator("img.att-img").count(), 1, "a pasted screenshot shows its thumbnail");
  assert.match(await chipOf(page, "report.pdf").innerText(), /2 pages/, "a PDF says how many pages it has");
  assert.match(await chipOf(page, "archive.zip").innerText(), /zip/i, "anything else shows its kind and size");
  assert.deepEqual(errors, []);
});

test("dropping many kinds at once attaches all of them, each previewed, and sends them with the message", async (t) => {
  const { app, page, errors, seen } = await windowWithBranch(t);
  await drop(page, [
    ["photo.png", "image/png", "png"], ["voice.wav", "audio/wav", "wav"], ["report.pdf", "application/pdf", "pdf"],
    ["main.ts", "video/mp2t", "export const answer = 42;"], ["mystery.bin", "application/octet-stream", "\u0000\u0001"],
    ["../../escape.sh", "application/x-sh", "echo hi"],
  ]);
  await ready(page, 6);
  assert.equal(await chipOf(page, "photo.png").locator("img").count(), 1);
  await page.waitForFunction(() => /0:01/.test([...document.querySelectorAll("#attached .att")].find((one) => one.textContent.includes("voice.wav"))?.textContent ?? ""), null, { timeout: 10000 });
  assert.match(await chipOf(page, "main.ts").innerText(), /export const answer/, "code shows its first words, whatever the browser called it");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "attach-chips.png") });
  const posted = page.waitForRequest((request) => request.url().endsWith("/api/run") && request.method() === "POST");
  await page.locator("#prompt").fill("What did I send?");
  await page.locator("#send").click();
  const request = await posted;
  const body = request.postDataJSON();
  assert.equal(body.uploads?.length, 6, "the message names the six files it carries");
  /* The conversation is the one the engine answered with. The side list draws its row only after the window has read the
     ended task's questions and its picture, which can be after the answer shows (CI read no current row: undefined). */
  const { sessionId } = await (await request.response()).json();
  await page.locator("#conversation").getByText("Read it.").first().waitFor({ timeout: 20000 });
  const said = seen.at(-1).findLast((one) => one.role === "user").content;
  assert.match(said, /export const answer = 42/, "the model got the code's words");
  assert.match(said, /mystery\.bin.*\n.*not read/, "and was told what it could not read");
  const names = app.store.messages(sessionId).find((one) => one.role === "user").attachments.map((one) => one.name);
  assert.ok(names.includes("escape.sh") && !names.some((one) => one.includes("..")), `names are words, never a way out (${names})`);
  await page.locator('#conversation [data-act="attsave"]').first().waitFor({ timeout: 10000 });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "attach-sent.png") });
  const download = page.waitForEvent("download");
  await page.locator('#conversation [data-act="attsave"]', { hasText: "report.pdf" }).click();
  assert.equal((await download).suggestedFilename(), "report.pdf", "a file in the conversation can be saved again");
  assert.deepEqual(errors, []);
});

test("a big file shows real progress while it is sent, and a chip can be taken off", async (t) => {
  const { page, errors } = await windowWithBranch(t);
  await page.route("**/api/attachments/upload?**", async (route) => { await new Promise((done) => setTimeout(done, 400)); await route.continue(); });
  await drop(page, [["film.mp4", "video/mp4", "big", 40 * 1024 * 1024]]);
  await page.locator('#attached .att.sending [role="progressbar"]').waitFor({ timeout: 10000 });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "attach-progress.png") });
  await ready(page, 1);
  const removed = page.waitForRequest((request) => request.url().includes("/api/attachments/upload?id=") && request.method() === "DELETE");
  await chipOf(page, "film.mp4").locator('[data-act="unattach"]').click();
  await removed;
  assert.equal(await page.locator("#attached .att").count(), 0);
  assert.deepEqual(errors, []);
});

test("the + menu picks any files, and a whole folder, which comes as its files", async (t) => {
  const { page, errors } = await windowWithBranch(t);
  await page.locator('[data-act="plusmenu"]').click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator('.pop [data-act="attach"]').click();
  await (await chooser).setFiles([{ name: "a.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK") },
    { name: "tool.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") }]);
  await ready(page, 2);
  await page.locator('[data-act="plusmenu"]').click();
  assert.equal(await page.locator('.pop [data-act="add-folder"]').isDisabled(), false, "Add a folder is live");
  assert.deepEqual(errors, []);
});

test("desktop: the clipboard's own file list is read by the app, never named by the page", async () => {
  const utf16 = (paths) => Buffer.from(paths.join("\u0000") + "\u0000\u0000", "utf16le");
  assert.deepEqual(await clipboardPaths("win32", async (format) => (format === "FileNameW" ? utf16(["C:\\a\\one.png", "C:\\b\\two.mp4"]) : Buffer.alloc(0))),
    ["C:\\a\\one.png", "C:\\b\\two.mp4"]);
  assert.deepEqual(await clipboardPaths("darwin", async () => Buffer.from("file:///Users/me/Report%20Q3.pdf")), ["/Users/me/Report Q3.pdf"]);
  assert.deepEqual(await clipboardPaths("linux", async () => Buffer.from("file:///home/me/a.txt\r\nhttps://example.com/x\r\n")), ["/home/me/a.txt"]);
  assert.deepEqual(await clipboardPaths("win32", async () => Buffer.alloc(0)), []);
  const isFile = (path) => ({ isFile: () => !path.endsWith("folder") });
  assert.deepEqual(sendablePaths(["x.txt", "folder", "y.png"], 20, isFile), ["x.txt", "y.png"], "a folder is left out");
  assert.equal(sendablePaths(Array.from({ length: 30 }, (_, i) => `${i}.txt`), 20, isFile).length, 20);
  assert.equal(ownDownload("blob:http://127.0.0.1:43210/5b1c", "http://127.0.0.1:43210"), true);
  assert.equal(ownDownload("blob:https://evil.example/5b1c", "http://127.0.0.1:43210"), false);
  assert.equal(ownDownload("http://127.0.0.1:43210/api/attachments/file?session=a&id=b", "http://127.0.0.1:43210"), true);
  assert.equal(ownDownload("https://evil.example/payload.exe", "http://127.0.0.1:43210"), false);
  assert.equal(ownDownload("data:application/octet-stream;base64,TVo=", "http://127.0.0.1:43210"), false);
});

test("desktop: the clipboard's files are read only just after a paste the person made, once", () => {
  const key = (over) => ({ type: "keyDown", key: "v", code: "KeyV", control: false, meta: false, shift: false, alt: false, ...over });
  assert.equal(isPasteKeys(key({ control: true }), "win32"), true, "Ctrl+V");
  assert.equal(isPasteKeys(key({ control: true, key: "м" }), "win32"), true, "Ctrl+V on another keyboard layout");
  assert.equal(isPasteKeys(key({ control: true, shift: true }), "linux"), true, "Ctrl+Shift+V");
  assert.equal(isPasteKeys(key({ shift: true, key: "Insert", code: "Insert" }), "win32"), true, "Shift+Insert");
  assert.equal(isPasteKeys(key({ meta: true }), "darwin"), true, "Cmd+V");
  assert.equal(isPasteKeys(key({ control: true }), "darwin"), false, "Ctrl+V is not Paste on a Mac");
  assert.equal(isPasteKeys(key({ control: true, type: "keyUp" }), "win32"), false, "a key let go is not a paste");
  assert.equal(isPasteKeys(key({ control: true, alt: true }), "win32"), false);
  assert.equal(isPasteKeys(key({}), "win32"), false, "a plain v is typing");
  let now = 1000;
  const gate = new PasteGate(() => now);
  const contents = { mainFrame: { url: "http://127.0.0.1:43210/app/" } };
  const window = { webContents: contents };
  const own = { sender: contents, senderFrame: contents.mainFrame };
  const origin = "http://127.0.0.1:43210";
  assert.equal(mayReadClipboardFiles(own, window, origin, gate), false, "no paste, no files");
  gate.arm();
  assert.equal(mayReadClipboardFiles({ sender: {}, senderFrame: contents.mainFrame }, window, origin, gate), false, "another page is refused");
  assert.equal(mayReadClipboardFiles(own, window, origin, gate), true, "just after a paste");
  assert.equal(mayReadClipboardFiles(own, window, origin, gate), false, "and only once for it");
  gate.arm();
  now += pasteGateMs;
  assert.equal(mayReadClipboardFiles(own, window, origin, gate), false, "and not long after it");
});
