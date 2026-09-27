/**
 * Bucket 15, integration review: the holes found in the adversarial pass, one test each. Temporary
 * folders and fake web answers only; the macOS tests start a plugin behind macOS's own sandbox, and
 * the page test opens the card headless at 400 px.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { signIn, openPlace } from "./new-window-places.mjs";
import { createBranch, zipWrite } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { inferToolGroup } from "../dist/catalog.js";
import { BranchAddOnManifestSchema, readOffer } from "../dist/add-ons/formats.js";
import { DraftSchema } from "../dist/add-ons/drafts.js";
import { AddOnLists, laterVersion, signListEntry, verifyListEntry } from "../dist/add-ons/lists.js";
import { PluginExports } from "../dist/add-ons/export.js";
import { FilterBook } from "../dist/add-ons/filters.js";
import { WalledPlugins, maxRunsAtOnce, weakWallRefusal } from "../dist/add-ons/walled-plugin.js";
import { resultMarker } from "../dist/add-ons/walled-host.js";

const mac = { skip: process.platform !== "darwin" && "macOS's own sandbox is only on macOS" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function temp(t, prefix = "branch-addons-review-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => discardTemp(root));
  return root;
}
async function writeTree(root, files) {
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return root;
}
async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-addons-review-app-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir,
    provider: provider ?? { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    return json;
  };
  return { app, call, root, dataDir, server };
}

/* ---- Signed lists ---- */

function webList(t, app, { permissions = [] } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = (key) => key.export({ format: "der", type: "spki" }).toString("base64");
  const state = { version: "1.0.0", key: der(publicKey), signer: privateKey, url: "https://lists.example/weather.zip", permissions, signed: true, bodies: {} };
  const zipFor = (version) => zipWrite([["branch-addon.json", JSON.stringify({ format: "branch-addon", id: "weather", name: "Weather", version,
    plugin: "weather.mjs", permissions: state.permissions })], ["weather.mjs", `export default { id: "weather", name: "Weather" }; // ${version}\n`]]);
  const list = () => {
    const zip = zipFor(state.version);
    const entry = { id: "weather", name: "Weather", version: state.version, url: state.url, sha256: sha(zip) };
    return { format: "branch-addon-list", version: 1, name: "Good list", ...(state.key ? { publicKey: state.key } : {}),
      addOns: [state.signed ? { ...entry, signature: signListEntry(state.signer, "Good list", entry) } : entry] };
  };
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.endsWith("list.json")) return new Response(JSON.stringify(list()));
    if (state.bodies[text]) return state.bodies[text]();
    return new Response(zipFor(state.version));
  };
  app.security.malware.vet = async () => undefined;
  const lists = new AddOnLists(app.store, app.runtime.owner, app.addOns.shelf, { assertAllowed: async () => undefined }, fetchImpl);
  return { lists, state, list, zipFor, der };
}
const address = "https://lists.example/list.json";

test("review: a list's signing key is pinned the first time it is looked at; a swapped key offers nothing", async (t) => {
  const { app } = await fixture(t);
  const { lists, state, der } = webList(t, app);
  assert.equal((await lists.browse(address)).addOns[0].signed, "checked");
  const other = generateKeyPairSync("ed25519");
  state.key = der(other.publicKey);
  state.signer = other.privateKey;
  await assert.rejects(lists.browse(address), /signing key is not the one it had/);
  await assert.rejects(lists.install(address, "weather"), /signing key is not the one it had/);
  state.key = undefined;
  state.signed = false;
  await assert.rejects(lists.browse(address), /signing key is not the one it had/, "dropping the key is a change too");
  lists.forget(address);
  assert.equal((await lists.browse(address)).addOns[0].signed, "unsigned", "forgetting the list lets the owner start again");
});

test("review: only Ed25519 signatures count, and a list with a key must sign every entry", () => {
  const entry = { id: "weather", name: "Weather", version: "1", url: "https://lists.example/w.zip", sha256: "a".repeat(64) };
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const { sign } = globalThis.process.getBuiltinModule("node:crypto");
  const payload = Buffer.from(["branch-addon-list", "L", entry.id, entry.version, entry.sha256].join("\n"));
  const rsaList = { format: "branch-addon-list", version: 1, name: "L", addOns: [],
    publicKey: rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const rsaSigned = { ...entry, signature: sign("sha256", payload, rsa.privateKey).toString("base64") };
  assert.equal(verifyListEntry(rsaList, rsaSigned), "invalid", "an RSA key is not accepted");
  const ed = generateKeyPairSync("ed25519");
  const edList = { ...rsaList, publicKey: ed.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  assert.equal(verifyListEntry(edList, { ...entry, signature: signListEntry(ed.privateKey, "L", entry) }), "checked");
  assert.equal(verifyListEntry(edList, entry), "invalid", "a signature taken off is not 'unsigned'");
  assert.equal(verifyListEntry({ ...edList, publicKey: undefined }, entry), "unsigned");
});

test("review: an older version is never offered or taken, and a signed add-on is never replaced by an unsigned one", async (t) => {
  const { app } = await fixture(t);
  const { lists, state } = webList(t, app);
  state.version = "1.10.0";
  await lists.browse(address);
  await lists.install(address, "weather");
  assert.equal(laterVersion("1.10.0", "1.9.2"), true);
  assert.equal(laterVersion("1.9.2", "1.10.0"), false);
  state.version = "1.9.2";
  assert.deepEqual(await lists.updates(), [], "a rollback is not an update");
  await assert.rejects(lists.update("weather"), /not later than 1\.10\.0/);
  assert.equal(app.addOns.shelf.record("weather").origin.version, "1.10.0");
  // The list is forgotten and comes back without its key: the signed add-on is not replaced.
  lists.forget(address);
  state.key = undefined;
  state.signed = false;
  state.version = "2.0.0";
  await lists.browse(address);
  assert.deepEqual(await lists.updates(), []);
  await assert.rejects(lists.update("weather"), /was signed and this one is not/);
});

test("review: an unsigned entry kept on another site is refused; a signed one may live elsewhere", async (t) => {
  const { app } = await fixture(t);
  const { lists, state } = webList(t, app);
  state.url = "https://cdn.elsewhere.example/weather.zip";
  assert.equal((await lists.browse(address)).addOns[0].installable, true, "signed: the fingerprint and key vouch for it");
  lists.forget(address);
  state.key = undefined;
  state.signed = false;
  const [entry] = (await lists.browse(address)).addOns;
  assert.deepEqual([entry.installable, entry.note], [false, "It is not signed and is kept on another site than the list, so it cannot be installed."]);
  await assert.rejects(lists.install(address, "weather"), /kept on another site/);
});

test("review: installing from a list names the fingerprint shown when browsing, and a list must be looked at first", async (t) => {
  const { app, call } = await fixture(t);
  const { lists, state, zipFor } = webList(t, app);
  await assert.rejects(lists.install(address, "weather"), /Look at the list first/);
  const [entry] = (await lists.browse(address)).addOns;
  assert.equal(entry.sha256, sha(zipFor("1.0.0")), "the owner is shown the package's fingerprint");
  state.version = "1.0.1"; // the list swaps the package after the owner looked
  await assert.rejects(lists.install(address, "weather", entry.sha256), /different package than the one you were shown/);
  assert.equal(app.addOns.shelf.record("weather"), null);
  await call("plugin-catalog/add-ons/settings", { modes: { lists: "on" } });
  await assert.rejects(call("plugin-catalog/add-ons/lists/install", { address, id: "weather" }), /Look at the add-on first/);
});

test("review: a list answer is cut off as soon as it is too large, before it is all read", async (t) => {
  const { app } = await fixture(t);
  const { lists, state } = webList(t, app);
  await lists.browse(address);
  let pulled = 0;
  state.bodies[state.url] = () => new Response(new ReadableStream({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(256 * 1024)); if (pulled > 64) controller.close(); },
  }));
  await assert.rejects(lists.install(address, "weather"), /larger than an add-on list may send/);
  assert.ok(pulled <= 6, `stopped after ${pulled} pieces, not 64`);
  state.bodies[state.url] = () => new Response("x", { headers: { "content-length": String(50 * 1024 * 1024) } });
  await assert.rejects(lists.install(address, "weather"), /larger than an add-on list may send/);
});

test("review: a newer version that asks for more arrives switched off and says what grew", async (t) => {
  const { app } = await fixture(t);
  const { lists, state } = webList(t, app, { permissions: ["text.read"] });
  await lists.browse(address);
  await lists.install(address, "weather");
  state.version = "1.1.0";
  state.permissions = ["text.read", "files.read"];
  const updated = await lists.update("weather");
  assert.deepEqual([updated.enabled, updated.grew, updated.plugin.permissions], [false, ["files.read"], ["text.read", "files.read"]]);
  assert.equal(app.store.get("settings", app.runtime.owner, "plugin:weather"), undefined, "no earlier yes carries over");
});

/* ---- Packages ---- */

test("review: a plugin may not be pointed at this computer, a private network or a bare number", () => {
  const base = { format: "branch-addon", id: "x", name: "X" };
  for (const host of ["localhost", "127.0.0.1", "10.0.0.8", "printer.local", "nas.lan", "db.internal", "foo.localhost", "router.home.arpa", "intranet"])
    assert.throws(() => BranchAddOnManifestSchema.parse({ ...base, hosts: [host] }), /computer or a private network|by its name/, host);
  assert.deepEqual(BranchAddOnManifestSchema.parse({ ...base, hosts: ["API.Weather.example"] }).hosts, ["api.weather.example"]);
  assert.throws(() => DraftSchema.parse({ id: "x", name: "X", code: "x", hosts: ["localhost"] }), /computer or a private network/);
});

test("review: a skill's own tool allowance is named as left out, and a manifest cannot pollute objects", () => {
  const files = new Map([
    [".claude-plugin/plugin.json", JSON.stringify({ name: "kit", mcpServers: JSON.parse('{"__proto__": {"polluted": true}, "ok": {"command": "node", "args": ["s.js"]}}') })],
    ["skills/a/SKILL.md", "---\nname: a\ndescription: A\nallowed-tools: Bash(rm:*)\n---\nDo a.\n"],
  ]);
  const offer = readOffer(files);
  assert.ok(offer.leftOut.some((line) => /tool allowance in skills\/a\/SKILL\.md was left out/.test(line)));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.ok(offer.servers.some((server) => server.id === "ok"));
});

test("review: a draft rewritten after the owner looked is not the one installed", async (t) => {
  const { app, call } = await fixture(t);
  await call("plugin-catalog/add-ons/settings", { modes: { drafts: "on", packages: "on" } });
  const draft = (code) => app.registry.execute("addon.draft", { id: "helper", name: "Helper", code }, app.runtime.context());
  await draft("export default { id: 'helper', name: 'Helper' };");
  const look = await call("plugin-catalog/add-ons/drafts/look", { id: "helper" });
  await draft("export default { id: 'helper', name: 'Helper', hooks: [{ event: 'run.finished', run: async () => 'send it away' }] };");
  await assert.rejects(call("plugin-catalog/add-ons/drafts/install", { id: "helper", sha256: look.offer.sha256 }), /not the one you were shown/);
  await assert.rejects(call("plugin-catalog/add-ons/drafts/install", { id: "helper" }), /Look at the add-on first/);
  assert.equal(app.addOns.shelf.record("helper"), null);
  assert.equal(inferToolGroup("addon.draft"), "skills");
  assert.equal(inferToolGroup("addon.search"), "skills");
});

test("review: the malware check is handed to add-ons only once the security service exists", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  const made = source.indexOf("new AddOns(");
  const security = source.indexOf("const security = new SecurityService(");
  const ready = source.indexOf("vetAddOn = (command, args) => security.malware.vet(command, args)");
  assert.ok(made > 0 && security > made && ready > security, "add-ons are made first, and the check is connected after the service");
  const addOnsBlock = source.slice(made, source.indexOf("// ── end bucket-15 ──", made));
  assert.doesNotMatch(addOnsBlock, /security\./, "nothing in the add-ons setup names the service before it exists");
  assert.match(source.slice(source.lastIndexOf("let vetAddOn", made), made), /still starting, so the malware check is not ready/);
});

/* ---- Walled plugins ---- */

const answering = (plugin, calls = []) => async (start) => {
  const request = JSON.parse(await readFile(join(start.cwd, "request.json"), "utf8"));
  calls.push(request);
  const answer = request.kind === "describe" ? { ok: true, plugin } : { ok: true, result: "done" };
  return { status: "completed", exitCode: 0, stdout: `${resultMarker}${JSON.stringify(answer)}\n`, stderr: "", truncated: false, durationMs: 1 };
};
const described = { id: "wide", name: "Wide", permissions: ["text.read", "shell.execute"], tools: [
  { name: "plugin.wide.read", permission: "text.read" }, { name: "plugin.wide.run", permission: "shell.execute" }] };

test("review: a walled plugin that describes more than its package listed is cut back to the list", { skip: process.platform === "win32" && "the macOS wall is planned around this computer's own folders, which are not POSIX paths here" }, async (t) => {
  const root = await temp(t);
  const file = join(root, "wide.mjs");
  await writeFile(file, "export default {};\n");
  const walled = new WalledPlugins({ policy: () => ({ walled: true, hosts: [], permissions: ["text.read"] }), unreadable: () => [],
    wallDeps: { platform: "darwin", exists: async () => true, realpath: async (path) => path }, spawn: answering(described) });
  const plugin = await walled.load("wide", file);
  assert.deepEqual([plugin.permissions, plugin.tools.map((tool) => tool.name)], [["text.read"], ["plugin.wide.read"]]);
  assert.ok(plugin.notes.some((line) => /plugin\.wide\.run was left out: it needs a permission the package did not list/.test(line)));
});

test("review: a hand-placed walled plugin is pinned to the code it had when it was loaded", { skip: process.platform === "win32" && "the macOS wall is planned around this computer's own folders, which are not POSIX paths here" }, async (t) => {
  const root = await temp(t);
  const file = join(root, "mine.mjs");
  await writeFile(file, "export default { id: 'mine' };\n");
  const walled = new WalledPlugins({ policy: () => ({ walled: true, hosts: [] }), unreadable: () => [],
    wallDeps: { platform: "darwin", exists: async () => true, realpath: async (path) => path },
    spawn: answering({ id: "mine", name: "Mine", permissions: ["text.read"], tools: [{ name: "plugin.mine.go", permission: "text.read" }] }) });
  const plugin = await walled.load("mine", file);
  assert.equal(await plugin.tools[0].run({}, {}), "done");
  await writeFile(file, "export default { id: 'mine' }; // swapped after loading\n");
  await assert.rejects(plugin.tools[0].run({}, {}), /not what it was when you installed it/);
});

test("review: one question to a plugin is bounded in size and in how many run at once", { skip: process.platform === "win32" && "the macOS wall is planned around this computer's own folders, which are not POSIX paths here" }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const walled = new WalledPlugins({ policy: () => ({ walled: true, hosts: [] }), unreadable: () => [],
    wallDeps: { platform: "darwin", exists: async () => true, realpath: async (path) => path },
    spawn: async (start, limits, signal) => { await gate; return answering({})(start, limits, signal); } });
  await assert.rejects(walled.ask("x", [], { kind: "call", args: { text: "x".repeat(1_100_000) } }), /more than Branch hands a plugin/);
  const going = Array.from({ length: maxRunsAtOnce }, () => walled.ask("x", [], { kind: "call" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(walled.ask("x", [], { kind: "call" }), /already going/);
  release();
  await Promise.all(going);
  assert.equal((await walled.ask("x", [], { kind: "call" })).ok, true, "a slot is free again");
});

test("review: on Windows add-on code is refused unless the owner chose to run it without the wall", async (t) => {
  let allowed = false;
  const started = [];
  const walled = new WalledPlugins({ policy: () => ({ walled: true, hosts: [] }), unreadable: () => [], weakWallAllowed: () => allowed,
    wallDeps: { platform: "win32" }, spawn: async (start, limits, signal) => { started.push(start); return answering(described)(start, limits, signal); } });
  await assert.rejects(walled.ask("x", [], { kind: "describe" }), (error) => error.message === weakWallRefusal);
  assert.equal(started.length, 0, "nothing was started");
  allowed = true;
  const root = await temp(t);
  await writeFile(join(root, "wide.mjs"), "export default {};\n");
  const plugin = await walled.load("wide", join(root, "wide.mjs"));
  assert.equal(started.length, 1);
  assert.ok(plugin.notes.some((line) => /On Windows it runs as its own program with limits, but without the wall/.test(line)));
  assert.ok(!plugin.notes.some((line) => /runs walled, with no internet/.test(line)), "it never claims a wall it does not have");
  // The owner's choice is a setting that ships off.
  const { call } = await fixture(t);
  const overview = await call("plugin-catalog/add-ons");
  assert.equal(overview.settings.windowsWithoutWall, false);
  assert.equal(overview.windows, process.platform === "win32");
  assert.equal((await call("plugin-catalog/add-ons/settings", { windowsWithoutWall: true })).windowsWithoutWall, true);
});

test("review: hand-placed plugins stay in Branch unless the owner ticks the wall; a package's plugin is walled whatever the tick says", async (t) => {
  const { app, call, root } = await fixture(t);
  await call("plugin-catalog/add-ons/settings", { modes: { packages: "on" } });
  app.security.malware.vet = async () => undefined;
  const folder = await writeTree(join(root, "pkg"), { "pkg.mjs": "export default { id: 'pkg', name: 'Pkg' };\n",
    "branch-addon.json": JSON.stringify({ format: "branch-addon", id: "pkg", name: "Pkg", plugin: "pkg.mjs" }) });
  const look = await call("plugin-catalog/add-ons/look", { source: folder });
  await call("plugin-catalog/add-ons/install", { source: folder, sha256: look.offer.sha256 });
  assert.equal(app.addOns.settings().wallEveryPlugin, false, "the tick ships off");
  assert.equal(app.addOns.walled.holds("pkg"), true);
  assert.equal(app.addOns.walled.holds("mine"), false, "a plugin file the owner placed keeps running as before");
  await call("plugin-catalog/add-ons/settings", { wallEveryPlugin: true });
  assert.equal(app.addOns.walled.holds("mine"), true);
  await call("plugin-catalog/add-ons/settings", { wallEveryPlugin: false });
  assert.equal(app.addOns.walled.holds("pkg"), true);
});

test("macOS for real: an address the package named is reached through Branch's door", mac, async (t) => {
  const root = await temp(t);
  const file = join(root, "fetcher.mjs");
  await writeFile(file, `export default { id: "fetcher", name: "Fetcher", permissions: ["web.read"], tools: [{ name: "plugin.fetcher.get", description: "x", permission: "web.read",
  run: async ({ url }) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); return r.status + " " + await r.text(); } catch (e) { return "refused"; } } }] };\n`);
  const hits = [];
  const site = createServer((request, response) => { hits.push(`${request.headers.host}${request.url}`); response.end("sunny"); });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => site.close(resolve)));
  const port = site.address().port;
  const walled = new WalledPlugins({ policy: () => ({ walled: true, hosts: ["api.weather.example"] }), unreadable: () => [], timeoutMs: 20_000,
    wallDeps: { resolve: async () => ["93.184.216.34"], upstream: () => ({ host: "127.0.0.1", port, secure: false }) } });
  const plugin = await walled.load("fetcher", file);
  assert.equal(await plugin.tools[0].run({ url: "http://api.weather.example/today" }, {}), "200 sunny");
  assert.deepEqual(hits, ["api.weather.example/today"]);
  assert.match(await plugin.tools[0].run({ url: "http://evil.example/steal" }, {}), /^403 You have not allowed programs to reach evil\.example/);
  assert.equal(hits.length, 1, "nothing else got through");
});

/* ---- Filters ---- */

test("review: while an outlet filter applies, the live preview never shows words the filter takes out", async (t) => {
  const answer = "Your card is 4111 1111 1111 1111.";
  const provider = { name: "scripted", async complete(request) {
    for (const piece of answer.split(" ")) request.onTextDelta?.(`${piece} `);
    return { content: answer, toolCalls: [] };
  } };
  const { app } = await fixture(t, provider);
  const unfiltered = [];
  await app.runtime.run({ prompt: "hi", onTextDelta: (text) => unfiltered.push(text) });
  assert.ok(unfiltered.join("").includes("4111"), "without a filter the preview streams as before");
  app.addOns.filters.save({ id: "cards", name: "Cards", stage: "outlet", match: "\\b\\d(?:[ -]?\\d){12,15}\\b", pattern: true, action: "redact", text: "[card]" });
  const shown = [];
  const run = await app.runtime.run({ prompt: "hi again", onTextDelta: (text) => shown.push(text) });
  assert.equal(shown.join(""), "", "nothing reached the page before the filter");
  assert.equal(run.output, "Your card is [card].");
  // A filter for another model leaves the preview alone.
  app.addOns.filters.save({ id: "cards", name: "Cards", stage: "outlet", match: "4111", action: "redact", models: ["some-other-model"] });
  const other = [];
  await app.runtime.run({ prompt: "third", onTextDelta: (text) => other.push(text) });
  assert.ok(other.join("").includes("4111"));
});

test("review: a filter for the connection a task falls back to holds the preview and filters that answer", async (t) => {
  const { ProviderHttpError } = await import("../dist/provider-retry.js");
  const answer = "Backup says 4111 1111 1111 1111.";
  const main = { name: "main-provider", async complete() { throw new ProviderHttpError(503); } };
  const backup = { name: "backup-provider", async complete(request) {
    for (const piece of answer.split(" ")) request.onTextDelta?.(`${piece} `);
    return { content: answer, toolCalls: [] };
  } };
  const root = await mkdtemp(join(tmpdir(), "branch-addons-fallback-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "main", name: "Main", provider: main, model: "m" }, { id: "backup", name: "Backup", provider: backup, model: "b" }],
    retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } });
  // One hook, app first: Windows will not delete a folder whose database is still open.
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.runtime.models.configure("local", { fallbackOrder: ["backup"] });
  app.addOns.filters.save({ id: "cards", name: "Cards", stage: "outlet", match: "4111", action: "redact", text: "[card]", models: ["Backup"] });
  const shown = [];
  const run = await app.runtime.run({ prompt: "go", onTextDelta: (text) => shown.push(text) });
  assert.equal(app.store.events(run.id).filter((event) => event.kind === "model.fallback").length, 1, "the task really fell back");
  assert.equal(shown.join(""), "", "the fallback's words never reached the page unfiltered");
  assert.doesNotMatch(run.output, /4111/);
});

test("review: words said beside tool calls are filtered too, and unreadable filters hold the preview back", async (t) => {
  let round = 0;
  const provider = { name: "scripted", async complete() {
    round += 1;
    return round === 1 ? { content: "Checking project falcon now.", toolCalls: [{ id: "c1", name: "tools.describe", arguments: { names: ["tools.describe"] } }] }
      : { content: "Done.", toolCalls: [] };
  } };
  const { app } = await fixture(t, provider);
  app.addOns.filters.save({ id: "falcon", name: "Falcon", stage: "outlet", match: "falcon", action: "redact", text: "[project]" });
  const run = await app.runtime.run({ prompt: "go" });
  const said = app.store.messages(run.sessionId).filter((message) => message.role === "assistant").map((message) => message.content);
  assert.ok(said.every((text) => !/falcon/i.test(text)), JSON.stringify(said));
  const book = new FilterBook({ get: () => { throw new Error("damaged"); }, save: () => undefined }, "owner");
  assert.equal(book.holdsPreview(["any"]), true, "fails closed");
  assert.equal(new FilterBook({ get: () => undefined, save: () => undefined }, "owner").holdsPreview(["any"]), false);
});

/* ---- Branch as a plugin ---- */

test("review: a record file Branch did not write cannot make it remove or overwrite the owner's files", async (t) => {
  const root = await temp(t);
  const folder = join(root, "project");
  const mine = '{"mcpServers":{"mine":{"command":"my-server"}}}\n';
  await writeTree(folder, { ".mcp.json": mine });
  await writeFile(join(folder, ".branch-export.json"), JSON.stringify({ target: "codex", version: "1", writtenAt: "now", files: { ".mcp.json": sha(mine) } }));
  const saved = new Map();
  const store = { get: (_k, _o, key) => saved.has(key) ? { data: saved.get(key) } : undefined, save: (_k, _o, key, data) => saved.set(key, data),
    list: () => [...saved].map(([id, data]) => ({ id, data })), delete: (_k, _o, key) => saved.delete(key) };
  const exports = new PluginExports(store, "owner", () => ({ command: "branch", args: ["mcp-serve"], env: {} }));
  assert.equal((await exports.status(folder)).written, false);
  await assert.rejects(exports.remove(folder), /Branch did not write that folder/);
  await assert.rejects(exports.write("codex", folder), /not empty, and Branch did not write it/);
  assert.equal(await readFile(join(folder, ".mcp.json"), "utf8"), mine);
  // A folder Branch did write, with a file the owner changed, stays Branch's to check again.
  const ours = join(root, "ours");
  await exports.write("codex", ours);
  await writeFile(join(ours, ".mcp.json"), "changed\n");
  assert.deepEqual((await exports.remove(ours)).kept, [".mcp.json"]);
  assert.equal((await exports.status(ours)).written, true);
  const text = JSON.stringify(Object.fromEntries(await Promise.all(["skills/branch-agent/SKILL.md", ".codex-plugin/plugin.json"]
    .map(async (name) => [name, await readFile(join(root, "ours", ...name.split("/")), "utf8").catch(() => "")]))));
  assert.doesNotMatch(text, /token|secret|password|Bearer/i, "no key is ever written into the plugin");
});

/* ---- The card, as a person sees it ---- */

test("review: the add-ons card opens in Customize → Plugins and fits 400 px with every part on", async (t) => {
  const { app, call, server } = await fixture(t);
  await call("plugin-catalog/add-ons/settings", { modes: Object.fromEntries(["packages", "lists", "filters", "pipelines", "drafts", "search", "export"].map((part) => [part, "on"])) });
  app.security.malware.vet = async () => undefined;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await signIn(page, server);
  // Redesign: add-ons live in Customize › Tools › Plugins (public/app/places/customize.js, prototype.html's Tools tab), with
  // "Add a plugin". The old "Add-ons other people wrote" card and its part switches are replaced by the new window.
  // WINDOW BUG (400 px): public/app/main.js:38 on("view") never takes "side-open" off #app, so the side list stays over
  // Customize after it is chosen and its tabs cannot be reached.
  const place = await openPlace(page, "customize", "tools");
  await place.locator('[data-act="t9-kind"][data-v="plugins"]').click();
  await place.locator('[data-act="t9-kind"][data-v="plugins"][aria-current="true"]').waitFor();
  assert.equal(await place.locator('[data-act="plug-add"]').innerText(), "Add a plugin");
  // Measured inside the page in one step: the place redraws itself.
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#main .place .t9")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "Customize › Tools fits inside 400 px");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(wide, false, "no sideways scrolling at 400 px");
});
