/**
 * R17-S-C integration review: the holes the adversarial pass found in the comfort settings, each
 * held shut. Nothing here installs an update, changes this computer's proxy or certificates, or
 * opens a window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, evaluatePolicy, withBrowserConfirmation, ComfortKeysSchema, ComfortFilesSchema, Budget, ToolRegistry,
} from "../dist/index.js";
import { WorkspaceFiles } from "../dist/files.js";
import { WorkspaceSearch } from "../dist/code-search.js";
import { startServer } from "../dist/server.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { switchComfort } from "../dist/comfort/terminal.js";
import { loadWords } from "../dist/terminal-words.js";
import { classify, specFor } from "../dist/settings-kit/catalogue.js";
import { chromium } from "playwright";

const english = loadWords("en");
const memoryStore = (records = {}) => ({ get: (_kind, _owner, key) => (key in records ? { data: records[key] } : undefined) });

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-comfort-review-"));
  const branch = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(branch, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await branch.close(); await discardTemp(root); });
  const call = (path, body) => fetch(server.url + path, {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  return { root, branch, call };
}


test("this test needs a real browser, and says so", () => {
  // It drives one through Branch's own browser tool rather than importing Playwright to steer it, so
  // without this the file looks like a test that needs nothing and the lane that runs it installs no
  // browser. The import above is what the test selector reads; this asserts it is really there.
  assert.equal(chromium.name(), "chromium", "this test declares the browser engine it requires");
});

test("review: pressing or typing on the page through the computer tools is a sensitive browser step too", () => {
  const policy = { preset: "custom", unmatchedCommands: "ask", limits: {}, rules: [{ tool: "*", match: "*", applies: "any", decision: "allow", remember: "always" }] };
  const on = withBrowserConfirmation(policy, memoryStore({ "comfort-browser": { confirmSensitive: true } }), "local");
  for (const tool of ["computer.press", "computer.type", "browser.profile"])
    assert.equal(evaluatePolicy(on, { tool, target: "shop.example.com", readOnly: false, resource: null }).decision, "ask", tool);
  assert.equal(evaluatePolicy(on, { tool: "computer.look", target: "", readOnly: true, resource: null }).decision, "allow");
});

test("review: with confirming on, a yes can only be for this once, and no earlier yes stands in", async (t) => {
  const { branch } = await served(t);
  saveBrowser(branch, { confirmSensitive: true });
  const runtime = branch.runtime;
  const context = runtime.context({ runId: "comfort-review" });
  const args = { role: "button", name: "Buy" };
  // A yes kept for the conversation after the switch was turned on (by any route) is not used.
  runtime.approvals.remember(context.runId, "browser.click", "", "allow", { fingerprint: "fp-1" });
  const check = runtime.checkPolicy("browser.click", args, context, "fp-1");
  assert.equal(check.decision, "ask", "every time means every time");
  assert.equal(check.remember, "never");
  runtime.approvals.ask({ runId: context.runId, sessionId: context.runId, tool: "browser.click", target: "", label: "Click Buy",
    question: "Click Buy?", source: "owner", remember: "never", askedAt: new Date().toISOString(), fingerprint: "fp-1" });
  assert.throws(() => runtime.approve(context.runId, "allow", "session", "fp-1"), /just now/i, "no yes for the whole conversation");
  // Refused either as once-only or because the click names no target a standing yes could be kept for (Q76).
  assert.throws(() => runtime.approve(context.runId, "allow", "always", "fp-1"), /just now|does not say what it is targeting/i, "no standing yes either");
  runtime.approve(context.runId, "allow", "never", "fp-1");
});

function saveBrowser(branch, values) {
  branch.store.save("settings", branch.runtime.owner, "comfort-browser", values);
}

test("review: automatic installing is the owner's alone, in the window and in the terminal", async (t) => {
  const { branch, call } = await served(t);
  assert.equal((await call("/api/comfort", { card: "notify", values: { autoUpdate: "check" } })).status, 200);
  const person = branch.store.profiles.create({ name: "Sam", pin: "4321" });
  branch.store.profiles.switch({ profileId: person.id, pin: "4321" });
  const raised = await call("/api/comfort", { card: "notify", values: { autoUpdate: "install" } });
  // profile-audit: the window switched to a household profile is that person, and every settings
  // route is the owner's, answered at one place in src/server.ts before the card's own checks.
  assert.equal(raised.status, 400, JSON.stringify(raised.body));
  assert.match(raised.body.error, /belongs to the owner/);
  assert.equal((await call("/api/comfort", { card: "notify", reset: true })).status, 400, "nor put back by someone else");
  assert.equal((await call("/api/comfort", { card: "notify", values: { sound: "chime" } })).status, 400, "the owner's sound too");
  assert.equal((await call("/api/comfort", { card: "notify", values: { autoUpdate: "check" } })).status, 400, "even the same value is the owner's to send");
  assert.equal((await call("/api/comfort/update-plan", {})).status, 400, "a household profile cannot ask for an install");
  assert.throws(() => switchComfort(branch.store, branch.runtime.owner, "autoUpdate", "install", english));
  assert.equal(branch.store.get("settings", branch.runtime.owner, "comfort-notify").data.autoUpdate, "check", "nothing was changed");
  branch.store.profiles.switch({ profileId: null });
  assert.equal((await call("/api/comfort", { card: "notify", values: { autoUpdate: "install" } })).status, 200);
});

test("review: an install waits for every task in the house, including one waiting for an answer", async (t) => {
  const { branch, call } = await served(t);
  assert.equal((await call("/api/comfort", { card: "notify", values: { autoUpdate: "install" } })).status, 200);
  const plan = async () => (await call("/api/comfort/update-plan", { updaterPhase: "available" })).body.step;
  assert.equal(await plan(), "install");
  const someone = branch.store.createRun("person:sam", "tidy the photos");
  assert.equal(await plan(), "nothing", "a household member's task is still a task");
  branch.store.finish(someone.id, "completed", "done");
  const waiting = branch.store.createRun(branch.runtime.owner, "send the report");
  branch.store.finish(waiting.id, "needs_input", "May I send it?");
  assert.equal(await plan(), "nothing", "a task paused on a question is mid-task");
  branch.store.finish(waiting.id, "completed", "sent");
  const old = branch.store.createRun(branch.runtime.owner, "the long one");
  for (let index = 0; index < 101; index++) branch.store.finish(branch.store.createRun(branch.runtime.owner, `quick ${index}`).id, "completed", "");
  assert.equal(await plan(), "nothing", "a long task is not hidden behind a hundred newer ones");
  branch.store.finish(old.id, "completed", "");
  assert.equal(await plan(), "install");
});

test("review: the proxy, certificates and browser care can never come from a preset or a file; the plain cards are classified", () => {
  for (const [key, field] of [["comfort-network", "proxy"], ["comfort-network", "caCertificates"], ["comfort-browser", "confirmSensitive"],
    ["comfort-browser", "dialogs"], ["comfort-notify", "autoUpdate"], ["comfort-update-last", "at"]])
    assert.equal(classify(key, field), "blocked", `${key}.${field}`);
  assert.equal(specFor("comfort-network"), undefined);
  assert.equal(specFor("comfort-browser"), undefined);
  assert.equal(classify("comfort-display", "timestamps"), "plain");
  assert.equal(classify("comfort-keys", "vim"), "plain");
  assert.equal(classify("comfort-notify", "sound"), "plain");
  assert.equal(classify("comfort-mcp", "startupTimeoutSeconds"), "plain");
  assert.equal(classify("comfort-files", "respectGitignore"), "less-careful-when-lowered");
});

// Redesign: the old comfort card's network fields and their warnings (public/comfort.js) are not in prototype.html,
// which has no proxy or added-certificate setting anywhere in Settings; the new window (public/app/**) draws neither,
// so nothing shows these words. The engine's own handling of both is still checked by tests/comfort.test.mjs.
test.skip("review: the owner is told plainly what a proxy and an added certificate can see", async () => {
  for (const language of ["en", "fr"]) {
    const words = JSON.parse(await readFile(new URL(`../public/locales/${language}.json`, import.meta.url), "utf8"));
    assert.ok(words["comfort.warn.proxy"], `${language}: proxy warning`);
    assert.ok(words["comfort.warn.certificates"], `${language}: certificate warning`);
  }
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  assert.match(english["comfort.warn.proxy"], /key/i);
  assert.match(english["comfort.warn.certificates"], /read and change/i);
  const script = await readFile(new URL("../public/comfort.js", import.meta.url), "utf8");
  assert.match(script, /comfort\.warn\.proxy/);
  assert.match(script, /comfort\.warn\.certificates/);
});

test("review: leaving .gitignore out never shows a secret file, and an ignore file cannot be a secret file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-comfort-secret-"));
  t.after(() => discardTemp(root));
  await writeFile(join(root, ".gitignore"), ".env\n");
  await writeFile(join(root, ".env"), "OPENAI_API_KEY=sk-test-never-shown\n");
  await writeFile(join(root, "app.js"), "1");
  const files = new WorkspaceFiles(root);
  const search = new WorkspaceSearch(files);
  search.ignoreChoice = () => ({ respectGitignore: false, extraIgnoreFiles: [] });
  const listed = (await search.walk()).entries.map((entry) => entry.path);
  assert.ok(listed.includes("app.js"));
  assert.ok(!listed.includes(".env"), "a secret file stays out of every search");
  assert.ok(!JSON.stringify(await search.grep?.({ pattern: "sk-test" }).catch(() => "")).includes("never-shown"));
  assert.throws(() => ComfortFilesSchema.parse({ extraIgnoreFiles: [".env"] }), /secret/i);
});

test("review: a shortcut always needs a modifier, so no single key can answer a question", () => {
  for (const key of ["Y", "N", "Enter", "Space", "A"])
    assert.throws(() => ComfortKeysSchema.parse({ palette: key }), undefined, key);
  assert.equal(ComfortKeysSchema.parse({ palette: "F8" }).palette, "F8");
});

test("review: accepting message boxes never answers a box that asks for typing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-comfort-prompt-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>p</title><button onclick="const v = prompt('Your password?', 'default'); document.querySelector('p').textContent = v === null ? 'Prompt dismissed' : 'Prompt answered'">Ask</button><p>Waiting</p>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = memoryStore({ "comfort-browser": { dialogs: "accept" } });
  browser.files = new WorkspaceFiles(root);
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  t.after(async () => { await browser.close(); server.close(); await discardTemp(root); });
  const run = { owner: "local", workspace: root, runId: "prompt", signal: new AbortController().signal, budget: new Budget(),
    permissions: new Set(["browser.read", "browser.interact"]), depth: 0 };
  await registry.execute("browser.navigate", { url: `${origin}/` }, run);
  await registry.execute("browser.click", { role: "button", name: "Ask" }, run);
  assert.match(JSON.stringify(await registry.execute("browser.snapshot", {}, run)), /Prompt dismissed/);
  await registry.finishRun(run);
});
