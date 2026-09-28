/* Settings › Permissions › Downloads may come from › Ask each time: a file a page sends waits outside the workspace,
   the task asks to keep it (browser.keep_download) and stops on the ordinary approval card, and the owner's answer
   carries the task on: a yes puts the file into the workspace, a no leaves nothing there. Real headless Chromium, a
   local page, and the window's own approval route. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
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
