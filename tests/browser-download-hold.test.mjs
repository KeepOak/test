/* Settings › Permissions › Downloads may come from › Ask each time: a file a page sends waits outside the workspace,
   the task asks to keep it (browser.keep_download) and stops on the ordinary approval card, and the owner's answer
   carries the task on: a yes puts the file into the workspace, a no leaves nothing there. Real headless Chromium, a
   local page, and the window's own approval route. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright"; // a real headless Chromium opens these pages (CI installs it for this file)
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { saveComfort } from "../dist/comfort/settings.js";

assert.equal(typeof chromium.launch, "function");

/** A model that opens the page, clicks the download, asks to keep what was held, and asks again once its yes arrives. */
function model(origin) {
  let heldId = "";
  return { name: "scripted", async complete(request) {
    const last = request.messages.at(-1), text = String(last?.content ?? "");
    const held = /"held":"([0-9a-f-]{36})"/.exec(text);
    if (held) heldId = held[1];
    if (last?.role === "user" && /^get the report/.test(text))
      return { content: "", toolCalls: [{ id: "open", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/` }) }] };
    if (last?.role === "tool" && /"title":"Reports"/.test(text))
      return { content: "", toolCalls: [{ id: "get", name: "browser.act", arguments: JSON.stringify({ action: "click", selector: "#dl" }) }] };
    const carriedOn = /The call you asked about did not run/.test(String(request.messages[0]?.content ?? ""));
    if (heldId && last?.role === "tool" && (held || (carriedOn && !/"file":"downloads/.test(text))) && !/refused|denied|did not allow|No\b/i.test(text))
      return { content: "", toolCalls: [{ id: `keep${Math.random()}`, name: "browser.keep_download", arguments: JSON.stringify({ id: heldId }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-download-hold-"));
  const site = createServer((request, response) => {
    if (request.url === "/report.csv") return response.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=report.csv" }).end("item,amount\nRent,1200\n");
    response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><title>Reports</title><a id="dl" href="/report.csv" download>Get report</a>');
  });
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const origin = `http://127.0.0.1:${site.address().port}`;
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model(origin) });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = app.store; browser.files = app.files; browser.artifacts = app.artifacts; app.browser = browser;
  browser.heldFolder = join(root, "held");
  registerBrowser(app.registry, browser);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  saveComfort(app.store, app.runtime.owner, "browser", { downloadsFrom: "ask" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await browser.close(); await app.close(); site.close(); await discardTemp(root); });
  const approve = (body) => fetch(`${server.url}/api/policy/approve`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const downloads = async () => readdir(join(root, "workspace", "downloads")).catch(() => []);
  const settled = async (check) => { for (let i = 0; i < 200; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  return { app, root, approve, downloads, settled };
}

test("Ask each time: the file waits outside the workspace, the task stops to ask, and a yes carries it on and keeps the file", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "get the report" });
  assert.equal(first.status, "needs_input", "the task stopped on the approval card");
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal(asked.tool, "browser.keep_download", "the question is about keeping the held file");
  assert.match(asked.target, /^127\.0\.0\.1:\d+$/, "naming the site it came from");
  assert.equal(asked.remember, "never", "a yes is for that one file");
  assert.deepEqual(await f.downloads(), [], "nothing reached the workspace before the yes");
  assert.equal((await readdir(join(f.root, "held"))).length, 1, "the file waits outside the workspace");
  assert.equal((await f.approve({ sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true })).status, 200);
  assert.ok(await f.settled(async () => (await f.downloads()).includes("report.csv")), "the yes carried the task on and kept the file");
  assert.equal(await readFile(join(f.root, "workspace", "downloads", "report.csv"), "utf8"), "item,amount\nRent,1200\n");
  assert.ok(await f.settled(() => f.app.store.run(first.id).status === "completed"));
  assert.deepEqual(await readdir(join(f.root, "held")), [], "nothing left waiting");
});

test("Ask each time: a no keeps nothing, and a broad allow rule never skips the question", async (t) => {
  const f = await fixture(t);
  savePolicy(f.app.store, f.app.runtime.owner, { preset: "custom", rules: [{ tool: "*", match: "*", applies: "any", decision: "allow", remember: "session" }] });
  const first = await f.app.runtime.run({ prompt: "get the report" });
  assert.equal(first.status, "needs_input", "even under allow-everything, keeping a held file asks");
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal((await f.approve({ sessionId: first.sessionId, decision: "deny", remember: "never", fingerprint: asked.fingerprint, carryOn: true })).status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(await f.downloads(), [], "a no keeps nothing");
});

/* A held file lasts an hour whether or not another download ever arrives: an hour-old one is refused and removed when
   the owner answers, the hour runs out by itself, and closing Branch removes every file still waiting. A stand-in for
   the page's download; no Chromium is needed for these. */
function sent(name = "report.csv") {
  return { suggestedFilename: () => name, url: () => "http://127.0.0.1:9/report.csv",
    createReadStream: async () => (async function* () { yield Buffer.from("item,amount\nRent,1200\n"); })() };
}
async function holding(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-download-expiry-"));
  const browser = new BranchBrowser({ allowedOrigins: ["http://127.0.0.1:9"] });
  browser.heldFolder = join(root, "held");
  browser.files = { checked: async (relative) => join(root, "workspace", relative) };
  t.after(async () => { await browser.close(); await discardTemp(root); });
  const context = { owner: "owner", runId: "run-1" };
  const hold = async () => (await browser["holdDownload"](sent(), context)).held;
  const waiting = async () => readdir(join(root, "held")).catch(() => []);
  return { root, browser, context, hold, waiting };
}

test("Ask each time: a held file older than an hour is refused and removed when the owner answers", async (t) => {
  const f = await holding(t);
  const id = await f.hold();
  assert.deepEqual(await f.waiting(), [id]);
  f.browser["heldDownloads"].get(id).at -= 3_600_001;
  assert.equal(f.browser.heldHost(id), "", "an expired file no longer names its site");
  await assert.rejects(f.browser.keepDownload({ id, keep: true }, f.context), /No file with that id/);
  assert.deepEqual(await readdir(join(f.root, "workspace", "downloads")).catch(() => []), [], "nothing reached the workspace");
  assert.deepEqual(await f.waiting(), [], "the expired file was removed");
});

test("Ask each time: a held file is removed after an hour even when no other download arrives", async (t) => {
  const f = await holding(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const id = await f.hold();
  t.mock.timers.tick(3_600_001);
  t.mock.timers.reset();
  const gone = async () => { for (let i = 0; i < 100; i++) { if (!(await f.waiting()).length) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
  assert.ok(await gone(), "the hour ran out and the file was removed");
  await assert.rejects(f.browser.keepDownload({ id, keep: true }, f.context), /No file with that id/);
});

test("Ask each time: closing Branch removes every held file, and nothing is held after that", async (t) => {
  const f = await holding(t);
  await f.hold(); await f.hold();
  assert.equal((await f.waiting()).length, 2);
  await f.browser.close();
  assert.deepEqual(await f.waiting(), [], "no held file outlives the browser");
  await assert.rejects(f.hold(), /closed|closing|shut/i, "a download arriving after close is not held");
  assert.deepEqual(await f.waiting(), []);
});

test("Ask each time: a held file left behind by an earlier launch is removed once it is an hour old", async (t) => {
  const f = await holding(t);
  await mkdir(join(f.root, "held"), { recursive: true });
  const stale = join(f.root, "held", "00000000-0000-4000-8000-000000000000"), fresh = join(f.root, "held", "11111111-1111-4111-8111-111111111111");
  await writeFile(stale, "old"); await writeFile(fresh, "new");
  const past = new Date(Date.now() - 3_600_001); await utimes(stale, past, past);
  const id = await f.hold();
  assert.deepEqual((await f.waiting()).sort(), [fresh.slice(-36), id].sort(), "only the hour-old leftover was removed");
});

test("Ask each time: a leftover younger than an hour at the first hold is removed later, once it reaches the hour", async (t) => {
  const f = await holding(t);
  await mkdir(join(f.root, "held"), { recursive: true });
  const younger = join(f.root, "held", "22222222-2222-4222-8222-222222222222"), fresh = join(f.root, "held", "33333333-3333-4333-8333-333333333333");
  await writeFile(younger, "old"); await writeFile(fresh, "new");
  // Just short of an hour when this launch first holds a file; nobody holds anything after that.
  const almost = new Date(Date.now() - 3_600_000 + 300); await utimes(younger, almost, almost);
  const id = await f.hold();
  assert.ok((await f.waiting()).includes(younger.slice(-36)), "not yet an hour old: left for now");
  const gone = async () => { for (let i = 0; i < 100; i++) { if (!(await f.waiting()).includes(younger.slice(-36))) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  assert.ok(await gone(), "removed once it reached the hour, with no other download arriving");
  assert.deepEqual((await f.waiting()).sort(), [fresh.slice(-36), id].sort(), "another launch's newer file and this launch's own are kept");
});
