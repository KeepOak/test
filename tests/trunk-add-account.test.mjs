/* RES-706: "Add my Claude account", done by the assistant or a Trunk with the owner there.

   Nothing real signs in and nothing real is installed. `claude` is tests/fixtures/fake-claude/claude-fixture.mjs, put
   first on this process's search path (as claude.cmd on Windows, a shell script elsewhere), and the test checks that
   is what "claude" resolves to before anything starts. The maker's sign-in pages are served over https by this test,
   and the task's real headless Chromium is told those two website names are this computer; the product's own rules for
   which sign-in pages Branch trusts are untouched. npm is never run: the installer is a stand-in that checks the exact
   command. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { chromium } from "playwright"; // a real headless Chromium opens the sign-in page (CI installs it for this file)
import { discardTemp } from "./temp-dir.mjs";
import { newWindow } from "./new-window-places.mjs";
import { createBranch } from "../dist/index.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { savePolicy } from "../dist/policy.js";
import { startCall } from "../dist/windows-command.js";
import { addSignIn, installTool, returnAddress } from "../dist/accounts/trunk-sign-in.js";
import { ApprovalRequiredError } from "../dist/approvals.js";
import { accountsServiceFor } from "../dist/accounts/service.js";

const fixtures = join(import.meta.dirname, "fixtures", "fake-claude");
const PASSWORD = "FixtureOnlyClaudePassword-5";

/** A folder holding only the fake `claude`, first on this process's search path for the rest of the file. */
async function fakeClaudeOnPath(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const install = (name = "claude") => {
    copyFileSync(join(fixtures, `${name}-fixture.mjs`), join(bin, `${name}-fixture.mjs`));
    if (process.platform === "win32") copyFileSync(join(fixtures, `${name}.cmd.txt`), join(bin, `${name}.cmd`));
    else { copyFileSync(join(fixtures, `${name}.sh.txt`), join(bin, name)); chmodSync(join(bin, name), 0o755); }
  };
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before}`;
  return { bin, install, restore: () => { process.env.PATH = before; },
    starts: () => { try { return readFileSync(join(bin, "claude-log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } } };
}
/** Whatever else happens, the real Claude Code on this computer is never what "claude" starts. */
function assertFixtureResolves(bin, name = "claude") {
  if (process.platform === "win32") {
    const start = startCall(name, ["x"], process.env);
    assert.equal(start.args[0], join(bin, `${name}-fixture.mjs`), `"${name}" would start ${JSON.stringify(start)}`);
  } else assert.equal(process.env.PATH.split(delimiter)[0], bin);
}

async function engine(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-add-account-"));
  const fake = await fakeClaudeOnPath(root);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...extra });
  t.after(async () => { fake.restore(); await app.close(); await discardTemp(root); });
  return { app, root, fake, store: app.store, owner: app.runtime.owner };
}

test("A1 a missing program is installed only after the owner's yes, with the maker's package, and a failed sign-in takes the account back out", async (t) => {
  const installs = [];
  const { app, fake } = await engine(t);
  const answers = { yes: false };
  // Only the test's own folder counts as "on this computer" for claude, so the real one is never taken for installed.
  const launcher = () => join(fake.bin, process.platform === "win32" ? "claude.cmd" : "claude");
  const deps = { service: accountsServiceFor(app.runtime.models), sessionOf: () => "s", browser: () => null, pollMs: 50,
    approvals: { answer: () => undefined, takeOnce: (_s, tool, target) => answers.yes && tool === installTool && target === "@anthropic-ai/claude-code" },
    present: async (command) => command === "npm" || (command === "claude" && existsSync(launcher())),
    // After the stand-in "installs" it, "claude" must be the fixture before anything is started.
    install: async (command, args) => { installs.push([command, ...args]); fake.install(); assertFixtureResolves(fake.bin); return { code: 0, missing: false }; } };
  const context = { owner: app.runtime.owner, runId: "r", signal: new AbortController().signal, askable: true, source: "owner",
    workspace: "", permissions: new Set(), depth: 0 };

  // Asked, in the moment, every time: nothing is installed before the yes.
  await assert.rejects(addSignIn(deps, { program: "claude-code" }, context), (error) => error instanceof ApprovalRequiredError
    && /npm install -g @anthropic-ai\/claude-code/.test(error.message) && error.remember === "never");
  assert.deepEqual(installs, []);
  // Nobody there to say yes: refused in words, still nothing installed.
  await assert.rejects(addSignIn(deps, { program: "claude-code" }, { ...context, askable: false }), /needs your yes/);

  answers.yes = true;
  // With no browser of Branch's, the sign-in page cannot be finished here: said so, and the account is taken back out.
  await assert.rejects(addSignIn(deps, { program: "claude-code" }, context), (error) => { assert.match(error.message, /Branch's browser is not set up/, JSON.stringify(fake.starts())); return true; });
  assert.deepEqual(installs, [["npm", "install", "-g", "@anthropic-ai/claude-code"]]);
  assertFixtureResolves(fake.bin);
  assert.deepEqual((accountsServiceFor(app.runtime.models).pool("cli-claude-code")?.accounts ?? []).filter((one) => one.id !== "primary"), [], "the half-added account stayed");
  assert.equal(app.runtime.models.presets.has("cli-claude-code"), false, "the connection made for it stayed");
  assert.ok(fake.starts().every((start) => start.dir), "the program was started without its own folder");
});

/* ---------- end to end: the real window, a real task, the owner signs in ---------- */

const LOGIN = `<!doctype html><meta charset="utf-8"><title>Sign in to Claude</title><body style="margin:0">
  <form onsubmit="event.preventDefault();const q=new URLSearchParams(location.search);location.href=q.get('redirect_uri')+'?code=FIXTURECODE&state='+q.get('state')">
  <label style="display:block;padding:20px">Password <input id="pass" type="password" style="width:300px;height:40px"></label>
  <button id="go" style="margin:20px;width:200px;height:50px">Continue</button></form></body>`;

async function certificate(root) {
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=claude.com"], { stdio: "ignore" });
  return { key: await readFile(key), cert: await readFile(cert) };
}
const framed = (page) => page.locator('#stage7 .owner-browser7-img[src^="data:image/jpeg"]:not([hidden])').waitFor({ timeout: 30000 });
async function onFrame(page, enginePage, selector) {
  let img = null;
  for (let i = 0; i < 50 && !img; i++) {
    await framed(page);
    img = await page.locator('#stage7 .owner-browser7-img[src^="data:image/jpeg"]:not([hidden])').boundingBox({ timeout: 1000 }).catch(() => null);
  }
  const box = await enginePage.locator(selector).boundingBox(), size = enginePage.viewportSize();
  const scale = Math.min(img.width / size.width, img.height / size.height), left = img.x + (img.width - size.width * scale) / 2;
  return { x: left + (box.x + box.width / 2) * scale, y: img.y + (box.y + box.height / 2) * scale };
}

test("A2 a task adds the owner's Claude account: its page opens in Branch's browser, the owner signs in, the code goes to the program, and the account shows its email", async (t) => {
  const seen = [];
  let rounds = 0;
  const provider = { name: "scripted", async complete(request) {
    seen.push(JSON.stringify(request));
    rounds++;
    if (rounds === 1) return { content: "", toolCalls: [{ id: "add", name: "accounts.add_signin", arguments: JSON.stringify({ program: "claude-code" }) }] };
    return { content: "Added.", toolCalls: [] };
  } };
  const { app, root, fake, store, owner } = await engine(t, { provider, trunkSignIn: { pollMs: 100 } });
  fake.install();
  assertFixtureResolves(fake.bin);
  const hits = [];
  const site = createServer(await certificate(root), (request, response) => {
    hits.push(request.url);
    response.writeHead(200, { "content-type": "text/html" }).end(request.url.startsWith("/cai/oauth/authorize") ? LOGIN : "<p id=code>FIXTURECODE</p>");
  });
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const port = site.address().port;
  // claude.com and platform.claude.com are this computer for this Chromium only.
  const chromiumHere = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors",
    `--host-resolver-rules=MAP claude.com:443 127.0.0.1:${port}, MAP platform.claude.com:443 127.0.0.1:${port}`] });
  const browser = new BranchBrowser({ allowedOrigins: ["https://claude.com", "https://platform.claude.com"] });
  browser.sandbox = { pick: () => Promise.resolve(chromiumHere), close: async () => undefined };
  browser.store = store; app.browser = browser;
  registerBrowser(app.registry, browser);
  t.after(async () => { await browser.close(); await chromiumHere.close(); site.close(); });
  savePolicy(store, owner, { preset: "off" });
  const sid = store.createSession(owner);
  store.message(sid, { role: "user", content: "Add my Claude account" });
  store.message(sid, { role: "assistant", content: "Ready." });
  const w = await newWindow(t, { app, root });
  await w.page.locator(`[data-act="chat"][data-id="${sid}"]`).first().click();

  const pending = app.runtime.run({ prompt: "Add my Claude account", sessionId: sid });
  const card = w.page.locator("#main .card.comp7").filter({ hasText: "Waiting for you to sign in" });
  await card.waitFor({ timeout: 60000 }).catch((error) => {
    const run = store.runs(owner).find((one) => one.sessionId === sid);
    throw new Error(`${error.message}
starts: ${JSON.stringify(fake.starts())}
events: ${JSON.stringify(run && store.events(run.id).map((e) => [e.kind, JSON.stringify(e.data).slice(0, 300)]).slice(6))}`);
  });
  await card.locator('[data-act="stage-take-control"]').click();
  await w.page.locator("#stage7 .tb7").waitFor({ timeout: 30000 });
  const run = store.runs(owner).find((one) => one.sessionId === sid);
  const control = () => browser.controls.forConversation(owner, sid);
  const enginePage = () => browser.controlledPageTarget(control().binding, control().id, control().view().tabs[0])?.page;
  await framed(w.page);
  const pass = await onFrame(w.page, enginePage(), "#pass");
  await w.page.mouse.click(pass.x, pass.y);
  await w.page.keyboard.type(PASSWORD);
  const go = await onFrame(w.page, enginePage(), "#go");
  await w.page.mouse.click(go.x, go.y);

  const finished = await pending;
  assert.equal(finished.status, "completed", JSON.stringify(finished).slice(0, 400));
  const told = store.events(finished.id ?? finished.runId ?? run.id).filter((event) => /^tool./.test(event.kind)).map((event) => [event.kind, event.data]);
  assert.ok(told.some(([kind]) => kind === "tool.completed" || kind === "tool.finished"), JSON.stringify(told).slice(0, 1500) + JSON.stringify(fake.starts()));
  const pool = accountsServiceFor(app.runtime.models).pool("cli-claude-code");
  const added = (pool?.accounts ?? []).filter((one) => one.id !== "primary");
  assert.equal(added.length, 1, "the account was not kept");
  const view = await (await fetch(`${w.server.url}/api/accounts`, { headers: { authorization: `Bearer ${w.server.token}` } })).json();
  const listed = JSON.stringify(view);
  assert.match(listed, /owner@example\.test/, "the account is not shown by its verified email");
  // The code never reached the maker's return page, the tab, the model or the record; the password never left the page.
  assert.equal(hits.some((hit) => hit.startsWith("/oauth/code/callback")), false, "the return page was loaded, with the code in it");
  assert.equal(enginePage().url().includes("FIXTURECODE"), false, "the tab's address still holds the code");
  for (const secret of [PASSWORD, "FIXTURECODE"]) {
    assert.ok(seen.every((sent) => !sent.includes(secret)), `the model saw ${secret}`);
    assert.equal(JSON.stringify(store.events(run.id)).includes(secret), false, `the task's record holds ${secret}`);
  }
  // The sign-in and the one real request ran in the new account's own folder. (A status read of the connection's usual
  // sign-in has no folder; the fixture refuses those, so nothing reaches a real one.)
  const starts = fake.starts(), home = accountsServiceFor(app.runtime.models).homeOf("cli-claude-code", added[0].id);
  assert.ok(starts.some((start) => start.args[0] === "-p" && start.dir === home), "no real one-turn request was made through the new account");
  assert.ok(starts.filter((start) => start.args[0] !== "auth" || start.args[1] !== "status").every((start) => start.dir === home), JSON.stringify(starts));
  assert.deepEqual(w.errors, []);
});

test("A3 Codex: its own sign-in finishes, the one real request passes, and the account is kept without a made-up email", async (t) => {
  const { app, fake } = await engine(t);
  fake.install("codex");
  assertFixtureResolves(fake.bin, "codex");
  const service = accountsServiceFor(app.runtime.models);
  const deps = { service, sessionOf: () => "s", browser: () => null, pollMs: 50,
    approvals: { answer: () => undefined, takeOnce: () => false } };
  const context = { owner: app.runtime.owner, runId: "r", signal: new AbortController().signal, askable: true, source: "owner",
    workspace: "", permissions: new Set(), depth: 0 };
  const done = await addSignIn(deps, { program: "codex" }, context);
  assert.equal(done.verified, true);
  assert.equal(done.email, null, "Codex does not say which account, so none is invented");
  assert.match(done.note, /does not say which account/);
  const added = service.pool("cli-codex").accounts.filter((one) => one.id !== "primary");
  assert.equal(added.length, 1);
  const log = readFileSync(join(fake.bin, "codex-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const home = service.homeOf("cli-codex", added[0].id);
  assert.ok(log.some((start) => start.args[0] === "exec" && start.dir === home), JSON.stringify(log));
  assert.ok(log.filter((start) => start.args[1] !== "status").every((start) => start.dir === home), JSON.stringify(log));
});

test("A4 attack: a return address the task opens itself, with somebody else's code, is never handed to the program", async (t) => {
  const { app, root, store, owner } = await engine(t);
  const hits = [];
  const site = createServer(await certificate(root), (request, response) => {
    hits.push(request.url);
    response.writeHead(200, { "content-type": "text/html" }).end(request.url.startsWith("/cai/oauth/authorize") ? LOGIN : "<p>return page</p>");
  });
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const port = site.address().port;
  const chromiumHere = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors",
    `--host-resolver-rules=MAP claude.com:443 127.0.0.1:${port}, MAP platform.claude.com:443 127.0.0.1:${port}`] });
  const browser = new BranchBrowser({ allowedOrigins: ["https://claude.com", "https://platform.claude.com"] });
  browser.sandbox = { pick: () => Promise.resolve(chromiumHere), close: async () => undefined };
  browser.store = store;
  t.after(async () => { await browser.close(); await chromiumHere.close(); site.close(); });
  const authorize = "https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&redirect_uri=" + encodeURIComponent("https://platform.claude.com/oauth/code/callback") + "&state=FIXTURESTATE";
  const taken = [];
  const stop = browser.relaySignIn({ owner, program: "Claude Code", match: returnAddress(authorize).match, take: (url) => taken.push(url.searchParams.get("code")) });
  t.after(stop);
  const run = store.createRun(owner, "sign in");
  const context = { owner, runId: run.id, signal: new AbortController().signal, workspace: "", permissions: new Set(), depth: 0 };

  // The task (so, the model) opens the return address itself: it has no page it came from, so it is sent as usual.
  await browser.navigate("https://platform.claude.com/oauth/code/callback?code=ATTACKERCODE&state=FIXTURESTATE", context);
  assert.deepEqual(taken, [], "a code the task typed into the address bar reached the program");
  assert.ok(hits.some((hit) => hit.includes("ATTACKERCODE")));
  // The maker's own page sends the browser there: that one is taken, and never sent.
  await browser.navigate(authorize, context);
  await browser.click("button", "Continue", context);
  for (let i = 0; i < 50 && !taken.length; i++) await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(taken, ["FIXTURECODE"]);
  assert.equal(hits.some((hit) => hit.includes("FIXTURECODE")), false, "the maker's return page was loaded with the code");
});
