/* RES-710: the password-manager handoff. Filling a saved sign-in ships off until the owner connects a vault and on once
   they have ("on because your vault is connected"); and a task's page that waits for the owner to sign in offers
   "Fill from Bitwarden" beside "Take control". Pressed, the engine reads the owner's password manager and types the
   name and password straight into the page: the model, the window and every record never see the password.

   Bitwarden itself is never run: the password manager's command line is a scripted stand-in (`credentialRunner`) that
   answers for one fixture item only. The sign-in page is served over https with a throwaway certificate made for this
   run, and the task's browser is a real headless Chromium told to accept it. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright"; // a real headless Chromium opens the sign-in page (CI installs it for this file)
import { discardTemp } from "./temp-dir.mjs";
import { newWindow } from "./new-window-places.mjs";
import { createBranch } from "../dist/index.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { savePolicy } from "../dist/policy.js";
import { saveCredentialSettings } from "../dist/credential-cli.js";
import { setLockdown } from "../dist/lockdown.js";
import { readVaultAutofillSettings, saveVaultAutofillSettings, vaultAutofillView } from "../dist/vault-autofill.js";
import { fillForOwner, ownerNoEntry } from "../dist/vault-owner-fill.js";

const PASSWORD = "FixtureVaultSecret-731", NAME = "sam@example.test";

/** Bitwarden's command line, as far as this test goes: one item, and a record of every call. */
function fakeBitwarden() {
  const calls = [];
  const run = async (executable, args) => {
    calls.push([executable, ...args]);
    const [, , , field, item] = args;
    if (item !== "Example login") return { code: 1, stdout: "", stderr: "Not found." };
    return { code: 0, stdout: field === "username" ? NAME : field === "password" ? PASSWORD : "", stderr: "" };
  };
  return { calls, run };
}
const connect = (store, owner) => saveCredentialSettings(store, owner, { enabled: true, services: ["bitwarden"] });

async function engine(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-vault-fill-"));
  const bw = fakeBitwarden();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), credentialRunner: bw.run, ...extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, bw, store: app.store, owner: app.runtime.owner };
}

test("V1 filling ships off with no vault, on once one is connected (and says why), and the owner's choice is kept", async (t) => {
  const { store, owner } = await engine(t);
  assert.equal(readVaultAutofillSettings(store, owner).mode, "off", "it touches credentials, so it ships off");
  assert.equal(vaultAutofillView(store, owner).onBecause, null);

  connect(store, owner);
  assert.equal(readVaultAutofillSettings(store, owner).mode, "on");
  assert.equal(vaultAutofillView(store, owner).onBecause, "on because your vault is connected");

  // Saving the book alone writes no "on" that would outlive the vault.
  saveVaultAutofillSettings(store, owner, { logins: [{ name: "example", site: "example.test", item: "Example login" }] });
  saveCredentialSettings(store, owner, { enabled: false });
  assert.equal(readVaultAutofillSettings(store, owner).mode, "off", "disconnecting the vault turns it back off");

  connect(store, owner);
  saveVaultAutofillSettings(store, owner, { mode: "off" });
  assert.equal(readVaultAutofillSettings(store, owner).mode, "off", "the owner switched it off, and that is kept");
  assert.equal(vaultAutofillView(store, owner).onBecause, null);
  saveVaultAutofillSettings(store, owner, { mode: "on" });
  assert.equal(vaultAutofillView(store, owner).onBecause, null, "on because the owner said so, not because of the vault");
});

/** A page a task has open, as the fill sees it; records what was typed where, and gives nothing back. */
function fakePage({ address = "https://example.test/login", recording = false, nameBox = true } = {}) {
  const typed = [];
  return { typed, page: {
    where: async () => ({ address, acrossSites: true, recording }),
    type: async (_context, box, _label, value) => { if (box === "username" && !nameBox) throw new Error("no name box"); typed.push([box, value]); },
  } };
}

test("V2 the owner's Fill keeps every rule but who started the task, and hands back no value", async (t) => {
  const { app, store, owner, bw } = await engine(t);
  const deps = (page, hasPage = true) => ({ store, owner, page, hasPage: () => hasPage,
    read: (reference, use) => app.credentials.read(reference, use), requireOwner: (what) => store.profiles.requireOwner(what) });
  const signal = new AbortController().signal, runId = "00000000-0000-4000-8000-000000000001";

  await assert.rejects(fillForOwner(deps(fakePage().page), runId, signal), /not set up to fill a saved sign-in/);
  connect(store, owner);
  await assert.rejects(fillForOwner(deps(fakePage().page), runId, signal), new RegExp(ownerNoEntry("example.test").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  saveVaultAutofillSettings(store, owner, { logins: [{ name: "example", site: "example.test", item: "Example login" }] });
  await assert.rejects(fillForOwner(deps(fakePage({ address: "http://example.test/login" }).page), runId, signal), /not on a secure address/);
  await assert.rejects(fillForOwner(deps(fakePage({ address: "https://example.test.evil.test/login" }).page), runId, signal), /No saved sign-in is set up for example\.test\.evil\.test/);
  await assert.rejects(fillForOwner(deps(fakePage({ recording: true }).page), runId, signal), /keeping a recording/);
  await assert.rejects(fillForOwner(deps(fakePage().page, false), runId, signal), /no page open/);
  setLockdown(store, owner, { on: true });
  await assert.rejects(fillForOwner(deps(fakePage().page), runId, signal), /Lockdown is on/);
  setLockdown(store, owner, { on: false });
  assert.equal(bw.calls.length, 0, "the vault was asked before every rule was met");

  // Reached from another website is fine here: the owner is looking at the page and pressed Fill.
  const { page, typed } = fakePage();
  const report = await fillForOwner(deps(page), runId, signal);
  assert.deepEqual(report, { filled: ["username", "password"], login: "example", site: "example.test" });
  assert.deepEqual(typed, [["username", NAME], ["password", PASSWORD]]);
  assert.deepEqual(bw.calls.map((call) => call.slice(3)), [["get", "username", "Example login"], ["get", "password", "Example login"]]);

  // A page with the name on an earlier step gets the password only.
  const passwordOnly = fakePage({ nameBox: false });
  assert.deepEqual((await fillForOwner(deps(passwordOnly.page), runId, signal)).filled, ["password"]);

  const rows = store.sqlite.prepare("SELECT * FROM audit").all();
  assert.ok(rows.some((row) => /sign-in \\"example\\" \(username and password\) on example\.test/.test(JSON.stringify(row))), "the fill was not written down");
  const everything = JSON.stringify([report, rows]);
  assert.equal(everything.includes(PASSWORD), false, "the password reached a report or a record");
});

/* ---------- end to end: a real task, a real page, the real window ---------- */

const LOGIN = `<!doctype html><meta charset="utf-8"><title>Sign in</title><body style="margin:0">
  <form onsubmit="event.preventDefault();document.body.innerHTML='<h1 id=done>Signed in as '+document.getElementById('user').value+'</h1>'">
  <label style="display:block;padding:20px">Email <input id="user" type="email" autocomplete="username" style="width:300px;height:40px"></label>
  <label style="display:block;padding:20px">Password <input id="pass" type="password" autocomplete="current-password" style="width:300px;height:40px"></label>
  <button id="go" style="margin:20px;width:200px;height:50px">Sign in</button></form></body>`;

/** A throwaway certificate for this run only, so the sign-in page is on https. */
async function certificate(root) {
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  return { key: await readFile(key), cert: await readFile(cert) };
}

test("V3 a task's sign-in page offers Fill from Bitwarden; pressed, the page is signed in and the password went nowhere else", async (t) => {
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const thinking = deferred(), gate = deferred(), seen = [];
  let rounds = 0, origin = "";
  const provider = { name: "scripted", async complete(request) {
    seen.push(JSON.stringify(request));
    rounds++;
    if (rounds === 1) return { content: "", toolCalls: [{ id: "open", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/login` }) }] };
    if (rounds === 2) { thinking.resolve(); await gate.promise; return { content: "", toolCalls: [{ id: "go", name: "browser.click", arguments: JSON.stringify({ role: "button", name: "Sign in" }) }] }; }
    if (rounds === 3) return { content: "", toolCalls: [{ id: "look", name: "browser.snapshot", arguments: "{}" }] };
    return { content: "Signed in.", toolCalls: [] };
  } };
  t.after(() => gate.resolve());
  const { app, root, bw, store, owner } = await engine(t, { provider });
  const site = createServer(await certificate(root), (request, response) => response.writeHead(200, { "content-type": "text/html" }).end(LOGIN));
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  origin = `https://127.0.0.1:${site.address().port}`;
  // The task's browser: a real headless Chromium that accepts this run's certificate, handed in where a sandbox would be.
  const chromiumHere = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"] });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.sandbox = { pick: () => Promise.resolve(chromiumHere), close: async () => undefined };
  browser.store = app.store; app.browser = browser;
  registerBrowser(app.registry, browser);
  t.after(async () => { await browser.close(); await chromiumHere.close(); site.close(); });
  savePolicy(store, owner, { preset: "off" });
  connect(store, owner);
  saveVaultAutofillSettings(store, owner, { logins: [{ name: "example", site: "127.0.0.1", item: "Example login" }] });
  const sid = store.createSession(owner);
  store.message(sid, { role: "user", content: "Sign in for me" });
  store.message(sid, { role: "assistant", content: "Ready." });
  const w = await newWindow(t, { app, root });
  await w.page.locator(`[data-act="chat"][data-id="${sid}"]`).first().click();

  const pending = app.runtime.run({ prompt: "Sign in for me", sessionId: sid });
  await thinking.promise;
  const card = w.page.locator("#main .card.comp7").filter({ hasText: "Waiting for you to sign in" });
  await card.waitFor({ timeout: 30000 });
  const fill = card.locator('[data-act="needs-fill"]');
  await fill.waitFor({ timeout: 30000 });
  assert.equal(await fill.innerText(), "Fill from Bitwarden");
  assert.ok(await card.locator('[data-act="stage-take-control"]').isVisible(), "Take control stays beside it");
  await fill.click();
  await w.page.getByText("Filled your example sign-in on 127.0.0.1").first().waitFor({ timeout: 30000 });
  const run = store.runs(owner).find((one) => one.sessionId === sid);
  const taskPage = () => browser.signInPage().where({ owner, runId: run.id, signal: new AbortController().signal });
  assert.match((await taskPage()).address, /\/login$/);

  gate.resolve();
  const finished = await pending;
  assert.equal(finished.status, "completed", JSON.stringify(finished).slice(0, 300));
  assert.ok(bw.calls.some((call) => call.includes("password")), "the vault was really asked");
  assert.match(seen.at(-1), /Signed in as sam@example\.test/, "the page was not signed in with the filled name and password");
  assert.ok(seen.every((sent) => !sent.includes(PASSWORD)), "the model saw the password");
  const events = JSON.stringify(store.events(run.id));
  assert.equal(events.includes(PASSWORD), false, "the task's record holds the password");
  assert.deepEqual(w.errors, []);
});
