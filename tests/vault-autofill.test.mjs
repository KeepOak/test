/**
 * mac7/vault-autofill (R17-068): filling one of the owner's saved sign-ins into the page they are on.
 *
 * Nothing here calls a real password manager, a real Keychain or a real browser. The manager is a
 * fake runner that records the exact argument array it was handed; the page is a stand-in that
 * records which box it was asked to type into. Every fixture points the Bitwarden command at a name
 * inside a temporary folder that does not exist, so a stray code path could only ever fail to find
 * it — the owner's own vault is never asked anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  VaultAutofill, addressRefusal, autofillChatRefusal, autofillGuard, autofillLockdownRefusal, autofillOffRefusal,
  autofillNoMatchRefusal, autofillRecordingRefusal,
  autofillShortLivedRefusal, autofillStartedElsewhereRefusal, autofillTrunkRefusal, readVaultAutofillSettings,
  saveVaultAutofillSettings, hostAllowed, vaultAutofillKey, vaultAutofillTools,
} from "../dist/vault-autofill.js";
import { CredentialResolver, commandFor, saveCredentialSettings } from "../dist/credential-cli.js";
import { SecretScrubber } from "../dist/vault.js";
import { signInFillTools, switchedToolTiers } from "../dist/feature-switches.js";
import { classify, specFor } from "../dist/settings-kit/catalogue.js";
import { applyChanges, changesFor } from "../dist/settings-kit/changes.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { ownerOnlyRead } from "../dist/short-lived-keys.js";
import { offLimitsToShortLivedKeys } from "../dist/server.js";
import { ToolRegistry } from "../dist/registry.js";
import { registerVaultAutofill } from "../dist/vault-autofill.js";
import { findLeaks, redactLeaksIn } from "../dist/leak-guard.js";
import { createBranch } from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";

/** The one value in these tests. It must never turn up anywhere but the page's password box. */
const THE_PASSWORD = "correct-horse-battery-staple-42";
const THE_CODE = "907142";
const OWNER = "local";

/** Just the tables this feature touches, with everything written down so a test can search it. */
function fakeStore() {
  const rows = new Map();
  const audits = [];
  const events = new Map();
  return {
    audits, eventRows: events,
    get: (table, owner, id) => rows.has(`${table}/${owner}/${id}`) ? { data: rows.get(`${table}/${owner}/${id}`) } : undefined,
    save: (table, owner, id, data) => { rows.set(`${table}/${owner}/${id}`, data); return { data }; },
    atomically: (work) => work(), // Q48: a change and its record are saved together; a map has nothing to roll back
    audit: { record: (owner, input) => audits.push({ owner, ...input }) },
    run: (runId) => (events.has(runId) ? { id: runId } : undefined),
    events: (runId) => events.get(runId) ?? [],
  };
}

/** A password manager that is not there: the command is a name inside a temporary folder. */
function fakeManager(root, answers = { password: THE_PASSWORD, totp: THE_CODE }) {
  const calls = [];
  const run = async (executable, args, timeoutMs) => {
    calls.push({ executable, args, timeoutMs });
    const field = args.includes("totp") ? "totp" : "password";
    return { code: 0, stdout: `${answers[field]}\n`, stderr: "" };
  };
  return { calls, run, command: join(root, "no-such-bw") };
}

/** A page that records which box it was asked to type into, and nothing about what went into it. */
function fakePage(url, { acrossSites = false, boxes = ["password", "code"], recording = false } = {}) {
  const typed = [];
  return {
    typed,
    where: async () => ({ address: url, acrossSites, recording }),
    type: async (_context, box, label, value) => {
      if (!boxes.includes(box)) throw new Error(`the page has no ${box} box; it was asked for "${label}"`);
      typed.push({ box, label, length: value.length, matched: value === THE_PASSWORD || value === THE_CODE });
    },
  };
}

const context = (extra = {}) => ({
  owner: OWNER, workspace: "/tmp", runId: "11111111-1111-4111-8111-111111111111",
  signal: new AbortController().signal, budget: {}, permissions: new Set(), depth: 0, ...extra,
});

/** A whole feature, switched on, with one sign-in in the owner's book. */
async function fixture(t, { url = "https://example.com/login", page: pageOptions = {}, entry = {}, mode = "when-needed" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-vault-autofill-"));
  t.after(async () => { await discardTemp(root); });
  const store = fakeStore();
  const manager = fakeManager(root);
  saveCredentialSettings(store, OWNER, { enabled: true, services: ["bitwarden"], bitwardenCommand: manager.command });
  saveVaultAutofillSettings(store, OWNER, {
    mode, logins: [{ name: "shop", site: "example.com", service: "bitwarden", item: "My Shop", ...entry }],
  });
  const resolver = new CredentialResolver(store, OWNER, new SecretScrubber(), manager.run);
  const page = fakePage(url, pageOptions);
  const owners = [];
  const autofill = new VaultAutofill({
    store, owner: OWNER, page, read: (reference, use) => resolver.read(reference, use),
    requireOwner: (what) => { owners.push(what); },
  });
  return { root, store, manager, page, autofill, owners };
}

/** Everything this feature could have written the value into, as one string to search. */
const everythingWritten = (store, extra = []) =>
  JSON.stringify({ audits: store.audits, extra });

/* ───────────────────────────── the value goes nowhere but the page ───────────────────────────── */

test("the password reaches the page and nothing else: not the answer, an audit row, an event or a log", async (t) => {
  const { store, autofill, page, manager } = await fixture(t);
  const answer = await autofill.fill({ login: "shop" }, context());

  assert.deepEqual(page.typed, [{ box: "password", label: undefined, length: THE_PASSWORD.length, matched: true }],
    "the page was asked to type the password once");
  const said = JSON.stringify(answer);
  assert.ok(!said.includes(THE_PASSWORD), `the answer to the model carried the password: ${said}`);
  assert.deepEqual(Object.keys(answer).sort(), ["filled", "login", "note", "site", "url"]);
  assert.equal(answer.filled, "password");
  assert.equal(answer.site, "example.com");

  const written = everythingWritten(store, manager.calls);
  assert.ok(!written.includes(THE_PASSWORD), `the password was written down somewhere: ${written}`);
  assert.ok(store.audits.some((row) => row.action === "secret.used" && row.outcome === "filled"),
    "the moment was written into the record of what the assistant was allowed to do");
  assert.ok(store.audits.some((row) => String(row.subject).includes("example.com")), "the record names the site");
});

test("a box that is not there fails with a sentence of Branch's own, never the page's own message", async (t) => {
  const { autofill, store } = await fixture(t, { page: { boxes: [] } });
  await assert.rejects(() => autofill.fill({ login: "shop", label: "Mot de passe" }, context()), (error) => {
    assert.ok(!error.message.includes(THE_PASSWORD), "the refusal carried the password");
    // The stand-in's own message quotes the label it was given; that message must not be passed on.
    assert.ok(!error.message.includes("the page has no password box"), `the page's own words were passed on: ${error.message}`);
    assert.match(error.message, /could not find that box on example\.com/);
    return true;
  });
  assert.ok(!everythingWritten(store).includes(THE_PASSWORD));
});

test("the tool takes no value of its own, so nothing the model writes can be typed into a page", async (t) => {
  const { autofill } = await fixture(t);
  const registry = new ToolRegistry();
  registerVaultAutofill(registry, autofill);
  const [definition] = registry.descriptions(new Set(registry.permissions()), { diet: false });
  assert.equal(definition.name, "signin.fill");
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ["box", "label", "login"]);
  assert.deepEqual([...vaultAutofillTools], [...signInFillTools]);
  // No field the model could write a value into. "password" appears only as the name of a box to
  // fill and in the description; there is nothing it could put a value in.
  const fields = Object.keys(definition.parameters.properties);
  assert.ok(!fields.some((name) => /value|password|secret|code$/i.test(name)), `the tool offers a way in: ${fields}`);
  assert.equal(definition.parameters.additionalProperties, false, "anything else the model writes is refused");
  // Nothing the model can write reaches the page: the one word it may send is a name from the book.
  await assert.rejects(() => registry.execute("signin.fill", { login: "shop", value: THE_PASSWORD },
    context({ permissions: new Set(registry.permissions()), budget: { step: () => undefined } })), /nrecognized/);
});

test("the tool runs through the registry, with the permission an owner's own task really holds", async (t) => {
  const { autofill, page } = await fixture(t);
  const registry = new ToolRegistry();
  registerVaultAutofill(registry, autofill);
  assert.ok(registry.permissions().includes("signin.fill"), "the permission is one the registry hands to a task");
  const budget = { step: () => undefined };
  const answer = await registry.execute("signin.fill", { login: "shop" },
    context({ permissions: new Set(registry.permissions()), budget }));
  assert.equal(answer.filled, "password");
  assert.deepEqual(page.typed.map((one) => one.box), ["password"]);
  assert.ok(!JSON.stringify(answer).includes(THE_PASSWORD));
  // A task that was not given it is refused by the registry itself, before the tool runs at all.
  await assert.rejects(() => registry.execute("signin.fill", { login: "shop" },
    context({ permissions: new Set(), budget })), /Permission denied: signin\.fill/);
});

test("the leak guard finds nothing to hide in what the model is told, because there is nothing there", async (t) => {
  const { autofill } = await fixture(t);
  const answer = await autofill.fill({ login: "shop" }, context());
  assert.deepEqual(findLeaks(JSON.stringify(answer)), [], "the answer has nothing key-shaped in it");
  const guarded = redactLeaksIn(answer);
  assert.equal(guarded.kinds.size, 0, "the leak guard had nothing to hide");
  assert.deepEqual(guarded.value, answer, "the leak guard changed nothing, because nothing was there");
});

/* ───────────────────────────── the site has to be the saved item's own ───────────────────────────── */

test("a site is the website itself and the names the owner added, never one Branch worked out", () => {
  const entry = { site: "example.com", alsoHosts: ["accounts.example.com"] };
  assert.equal(hostAllowed(entry, "example.com"), true);
  assert.equal(hostAllowed(entry, "EXAMPLE.COM."), true);
  assert.equal(hostAllowed(entry, "accounts.example.com"), true, "the owner's own extra name");
  for (const host of ["evil-example.com", "example.com.attacker.net", "notexample.com", "example.co",
    "attacker.example.com", "pages.example.com", "a.accounts.example.com"])
    assert.equal(hostAllowed(entry, host), false, `${host} must not count as example.com`);
  // A look-alike written in another alphabet never arrives as itself: an address hands back punycode.
  assert.equal(hostAllowed(entry, new URL("https://\u0435xample.com/").hostname), false, "a look-alike host was allowed");
  assert.equal(hostAllowed(entry, "xn--xample-9uf.com"), false);
  assert.equal(hostAllowed({ site: "example.com" }, "accounts.example.com"), false, "no extra names means the site alone");
});

test("a page on another site, an insecure page, and an address carrying a name and password are all refused", async (t) => {
  const entry = { name: "shop", site: "example.com", alsoHosts: [], service: "bitwarden", item: "My Shop", code: false, note: "" };
  assert.equal(addressRefusal(entry, "https://evil.test/login", false), autofillNoMatchRefusal);
  assert.match(addressRefusal(entry, "http://example.com/login", false), /not on a secure address/);
  assert.match(addressRefusal(entry, "https://someone:pw@example.com/login", false), /name and password of its own/);
  // None of these name the entry or the site it is saved for.
  for (const said of [addressRefusal(entry, "http://example.com/login", false),
    addressRefusal(entry, "https://someone:pw@example.com/login", false)])
    assert.ok(!said.includes("shop") && !said.includes("example.com"), `a refusal named the owner's book: ${said}`);

  const { autofill, page, manager } = await fixture(t, { url: "https://evil.test/login" });
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), /no saved sign-in by that name/);
  assert.deepEqual(page.typed, [], "nothing was typed");
  assert.deepEqual(manager.calls, [], "the password manager was never even asked");
});

test("Branch never chooses the sign-in itself: an unknown name is refused without reading anything", async (t) => {
  const { autofill, manager, store } = await fixture(t);
  await assert.rejects(() => autofill.fill({ login: "bank" }, context()), /no saved sign-in by that name/);
  assert.deepEqual(manager.calls, []);
  assert.ok(store.audits.some((row) => String(row.subject).includes("bank") && row.outcome === "refused"),
    "the owner's own record does not show what the assistant asked for");
});

test("a page the task was taken to from another website is filled only at the address the owner wrote down", async (t) => {
  const hop = { page: { acrossSites: true } };
  const { autofill: strayed } = await fixture(t, { url: "https://example.com/somewhere", ...hop });
  await assert.rejects(() => strayed.fill({ login: "shop" }, context()), /taken to this page from another website/);

  const written = await fixture(t, {
    url: "https://example.com/login", ...hop, entry: { address: "https://example.com/login" },
  });
  assert.equal((await written.autofill.fill({ login: "shop" }, context())).filled, "password");

  const elsewhere = await fixture(t, {
    url: "https://example.com/other", ...hop, entry: { address: "https://example.com/login" },
  });
  await assert.rejects(() => elsewhere.autofill.fill({ login: "shop" }, context()), /taken to this page from another website/);
});

test("pressing Sign in on the site whose address was opened is not a hop, so the one-time code still fills", async (t) => {
  // The only sequence in which a code box exists: open the address, fill the password, press Sign in,
  // and the code box appears on a page of the same website. Pressing there is not untrusted content.
  const { autofill, page } = await fixture(t, { url: "https://example.com/two-factor", entry: { code: true } });
  await autofill.fill({ login: "shop" }, context());
  assert.equal((await autofill.fill({ login: "shop", box: "code" }, context())).filled, "code");
  assert.deepEqual(page.typed.map((one) => one.box), ["password", "code"]);
  assert.ok(page.typed.every((one) => one.matched));
});

test("the browser decides that hop by the website, not by the press, so a sign-in flow is not broken", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "integrations", "browser.ts"), "utf8");
  assert.match(source, /acrossSites: entry\.pressed && \(!host \|\| host !== entry\.typedHost\)/,
    "a press within the website whose address was opened is not counted as a hop");
  assert.match(source, /entry\.typedHost = hostOf\(page\.url\(\)\) \|\| hostOf\(url\)/,
    "the website is read from where the page really ended up, so an open redirect cannot lie about it");
});

/* ───────────────────────────── who may ask ───────────────────────────── */

test("it ships off, and refuses plainly until the owner turns it on", async (t) => {
  const store = fakeStore();
  const settings = readVaultAutofillSettings(store, OWNER);
  assert.equal(settings.mode, "off");
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.logins, []);
  assert.equal(autofillGuard(store, OWNER, context()), autofillOffRefusal);

  const { autofill, manager } = await fixture(t, { mode: "off" });
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), new RegExp("not set up to fill"));
  assert.deepEqual(manager.calls, []);
});

test("a chat task, a short-lived key, a Trunk, a schedule and Lockdown are each refused", async (t) => {
  const { store, autofill, manager } = await fixture(t);
  const runId = context().runId;

  store.eventRows.set(runId, [{ kind: "run.started", data: { source: "channel" } }]);
  assert.equal(autofillGuard(store, OWNER, context()), autofillChatRefusal);
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), new RegExp("chat app cannot"));
  store.eventRows.delete(runId);

  store.eventRows.set(runId, [{ kind: "run.started", data: { source: "owner", shortLivedKey: true } }]);
  assert.equal(autofillGuard(store, OWNER, context()), autofillShortLivedRefusal);
  store.eventRows.delete(runId);
  // The same refusal, reached the other way: another computer's request is marked as it arrives.
  assert.equal(underShortLivedKey(() => autofillGuard(store, OWNER, context())), autofillShortLivedRefusal);

  assert.equal(autofillGuard(store, OWNER, context({ trunkKeys: { copyFromOwner: false, accounts: {} } })), autofillTrunkRefusal);
  assert.equal(autofillGuard(store, OWNER, context({ source: "schedule" })), autofillStartedElsewhereRefusal);
  store.eventRows.set(runId, [{ kind: "run.started", data: { source: "trigger" } }]);
  assert.equal(autofillGuard(store, OWNER, context()), autofillStartedElsewhereRefusal);
  store.eventRows.delete(runId);

  // Integration review: every way a task can be started that is not the owner's own, taken from the
  // list of sources a task may record (src/contracts.ts, ToolContext.source). One left out here is
  // one that could ask for a password, so the list is written out rather than sampled.
  for (const source of ["trigger", "schedule", "mcp", "a2a", "acp"]) {
    assert.equal(autofillGuard(store, OWNER, context({ source })), autofillStartedElsewhereRefusal,
      `a task started by ${source} was allowed to fill a sign-in`);
    store.eventRows.set(runId, [{ kind: "run.started", data: { source } }]);
    assert.equal(autofillGuard(store, OWNER, context()), autofillStartedElsewhereRefusal,
      `a task whose record says ${source} was allowed to fill a sign-in, even with no source on the context`);
    await assert.rejects(() => autofill.fill({ login: "shop" }, context()), /Only work you started yourself/);
    store.eventRows.delete(runId);
  }
  // "channel" is the chat refusal, which is its own sentence; the two together cover the whole list.
  assert.equal(autofillGuard(store, OWNER, context({ source: "channel" })), autofillChatRefusal);

  store.save("settings", OWNER, "lockdown", { on: true, since: null, before: {} });
  assert.equal(autofillGuard(store, OWNER, context()), autofillLockdownRefusal);
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), new RegExp("Lockdown is on"));
  assert.deepEqual(manager.calls, [], "not one of those refusals asked the password manager anything");
});

test("a household person is refused before anything is read", async (t) => {
  const { store, manager, page } = await fixture(t);
  const resolver = new CredentialResolver(store, OWNER, new SecretScrubber(), manager.run);
  const autofill = new VaultAutofill({
    store, owner: OWNER, page, read: (reference, use) => resolver.read(reference, use),
    requireOwner: (what) => { throw new Error(`${what} is for the owner only.`); },
  });
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), /Filling a saved sign-in is for the owner only/);
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(page.typed, []);
});

/* ───────────────────────────── the password manager itself ───────────────────────────── */

test("Bitwarden is asked with an argument array, never a line for a shell, and never for the real vault", async (t) => {
  const { autofill, manager } = await fixture(t, { entry: { item: "My Shop 2" } });
  await autofill.fill({ login: "shop" }, context());
  assert.equal(manager.calls.length, 1);
  const [call] = manager.calls;
  assert.ok(Array.isArray(call.args), "the arguments are an array, never a line a shell takes apart");
  assert.deepEqual(call.args, ["--nointeraction", "--raw", "get", "password", "My Shop 2"],
    "an item name with a space in it is still one argument");
  assert.ok(call.executable.includes("no-such-bw"), `the fixture must not name a real command: ${call.executable}`);
  assert.ok(!["bw", "bws", "op", "security"].includes(call.executable), "no real password manager is ever named here");
  // And a name a shell would read as more than a name never gets as far as a command at all.
  const store = fakeStore();
  for (const item of ["My Shop; rm -rf /", "$(bw list items)", "`id`", "a|b", "a&b"])
    assert.throws(() => saveVaultAutofillSettings(store, OWNER, { logins: [{ name: "shop", site: "a.test", item }] }),
      /item name/, `${item} was accepted as an item name`);
});

test("the same item's one-time code is read the same way, and only when the owner said it holds one", async (t) => {
  const without = await fixture(t);
  await assert.rejects(() => without.autofill.fill({ login: "shop", box: "code" }, context()), /not marked as holding a one-time code/);
  assert.deepEqual(without.manager.calls, []);

  const { autofill, manager, page, store } = await fixture(t, { entry: { code: true } });
  const answer = await autofill.fill({ login: "shop", box: "code" }, context());
  assert.deepEqual(manager.calls[0].args, ["--nointeraction", "--raw", "get", "totp", "My Shop"]);
  assert.equal(answer.filled, "code");
  assert.deepEqual(page.typed, [{ box: "code", label: undefined, length: THE_CODE.length, matched: true }]);
  assert.ok(!everythingWritten(store, manager.calls).includes(THE_CODE), "the code was written down somewhere");

  const onePassword = await fixture(t, { entry: { code: true, service: "1password", item: "Private/Shop/password" } });
  await assert.rejects(() => onePassword.autofill.fill({ login: "shop", box: "code" }, context()), /Bitwarden only/);
});

test("commandFor still answers exactly as it did for a password, and adds only the one-time code", () => {
  const settings = { bitwardenCommand: "bw", onePasswordCommand: "op", enabled: true, services: [], timeoutMs: 10000 };
  assert.deepEqual(commandFor({ service: "bitwarden", item: "GitHub" }, settings),
    { executable: "bw", args: ["--nointeraction", "--raw", "get", "password", "GitHub"] });
  assert.deepEqual(commandFor({ service: "bitwarden", item: "GitHub", field: "totp" }, settings),
    { executable: "bw", args: ["--nointeraction", "--raw", "get", "totp", "GitHub"] });
  assert.deepEqual(commandFor({ service: "1password", item: "Private/GitHub/password" }, settings),
    { executable: "op", args: ["read", "--no-newline", "op://Private/GitHub/password"] });
  // The fourth case is refused rather than quietly read as a password: a caller that asked for a
  // code and got a password would type the wrong secret into the wrong box.
  assert.throws(() => commandFor({ service: "1password", item: "Private/GitHub", field: "totp" }, settings),
    /one-time code from Bitwarden only/);
});

test("the real wiring registers the tool: a launch with a browser really has signin.fill", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-vault-autofill-boot-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.ok(!app.registry.names().includes("signin.fill"), "with no browser there is nothing to fill");
  const configPath = join(root, "integrations.json");
  // A browser is made but never started: BranchBrowser opens Chromium only when a page is asked for.
  await writeFile(configPath, JSON.stringify({ browser: { allowedOrigins: ["https://example.com"] } }));
  const loaded = await loadIntegrations(app.registry, configPath, {}, app.secretsFor, app.channelHost);
  t.after(() => loaded.close());
  assert.ok(app.registry.names().includes("signin.fill"), "the tool is registered beside the browser tools");
  assert.equal(app.registry.permissionOf("signin.fill"), "signin.fill");
  // Still off, so a task is never offered it until the owner switches it on.
  assert.deepEqual(switchedToolTiers(app.store, app.runtime.owner, app.registry.names()).hidden.includes("signin.fill"), true);
});

/* ───────────────────────────── the switch, the settings and the words ───────────────────────────── */

test("the switch hides the tool while it is off and loads it when it is on", () => {
  const store = fakeStore();
  const available = ["signin.fill", "browser.fill"];
  assert.deepEqual(switchedToolTiers(store, OWNER, available).hidden, ["signin.fill"]);
  saveVaultAutofillSettings(store, OWNER, { mode: "when-needed" });
  assert.deepEqual(switchedToolTiers(store, OWNER, available).hidden, []);
  assert.deepEqual(switchedToolTiers(store, OWNER, available).preload, []);
  saveVaultAutofillSettings(store, OWNER, { mode: "on" });
  assert.deepEqual(switchedToolTiers(store, OWNER, available).preload.map((one) => one.name), ["signin.fill"]);
  // Lockdown wins over whatever was saved.
  store.save("settings", OWNER, "lockdown", { on: true, since: null, before: {} });
  assert.deepEqual(switchedToolTiers(store, OWNER, available).hidden, ["signin.fill"]);
});

test("the settings screen counts as reaching further, and two sign-ins cannot share a name", () => {
  assert.equal(classify(vaultAutofillKey, "mode"), "less-careful-when-raised");
  assert.ok(specFor(vaultAutofillKey), "the setting is in the catalogue");
  const store = fakeStore();
  assert.throws(() => saveVaultAutofillSettings(store, OWNER, {
    mode: "when-needed",
    logins: [{ name: "shop", site: "a.test", item: "A" }, { name: "shop", site: "b.test", item: "B" }],
  }), /same name/);
  // A site with a scheme or a path in it is not a site.
  assert.throws(() => saveVaultAutofillSettings(store, OWNER, { logins: [{ name: "shop", site: "https://a.test/x", item: "A" }] }));
});

test("the book of sign-ins is the owner's alone: a short-lived key may neither read it nor change it", () => {
  assert.ok(ownerOnlyRead("/api/vault-autofill/settings"), "a short-lived key may not read the book");
  assert.ok(offLimitsToShortLivedKeys("GET", "/api/vault-autofill/settings"));
  assert.match(offLimitsToShortLivedKeys("POST", "/api/vault-autofill/settings"), /cannot change which saved sign-ins/);
});

test("every word on the card has real French, and the reference explains the setting in plain words", async () => {
  const here = join(import.meta.dirname, "..", "public");
  // Redesign: the card is the new window's Settings › Saved sign-ins page (public/app/settings/pages/secrets.js); its
  // words are t() keys, with the two password managers still named by their vault-autofill keys.
  const card = await readFile(join(here, "app", "settings", "pages", "secrets.js"), "utf8");
  const en = JSON.parse(await readFile(join(here, "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(here, "locales", "fr.json"), "utf8"));
  const keys = [...card.matchAll(/\bt\("([a-z0-9.-]+)"/g), ...card.matchAll(/"(vault-autofill\.[a-z0-9.-]+)"/g)].map((hit) => hit[1]);
  assert.ok(new Set(keys).size >= 8, "the card says what it means through keys");
  // The two password managers are called what they are called; every other word is really translated.
  const brands = ["vault-autofill.service.bitwarden", "vault-autofill.service.1password"];
  assert.deepEqual([...new Set(keys)].filter((key) => !en[key] || !fr[key] || (en[key] === fr[key] && !brands.includes(key))), []);
  for (const key of ["settings-kit.name.vault-autofill"])
    assert.ok(en[key] && fr[key] && en[key] !== fr[key], `${key} needs English and real French`);

  const reference = await readFile(join(import.meta.dirname, "..", "docs", "configuration.md"), "utf8");
  assert.ok(!/Credential vault \(R17-068\): awaiting owner/.test(reference), "the design note is still there");
  for (const field of ["`enabled`", "`mode`", "`logins`", "`timeoutMs`"])
    assert.ok(reference.includes(field), `the reference never names ${field}`);
  assert.match(reference, /Filling a saved sign-in/);
});

/* ───────────────────────────── the old refusals stay ───────────────────────────── */

test("the browser's own typing tool still refuses a password box outright", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "integrations", "browser.ts"), "utf8");
  const refusals = source.match(/Password fields require a dedicated credential integration/g) ?? [];
  assert.equal(refusals.length, 2, "browser.fill and browser.act both still refuse a password box");
  assert.match(source, /kind === 'password' \? null : 'That is not a password box/,
    "a password only ever goes into a real password box");
});

/* ─────────────── integration review (integrate/mac7-vault-autofill): the holes found and closed ─────────────── */

/**
 * A recording writes down the arguments of every step it records, and typing a value into a box is
 * a step whose argument IS the value. Proven against the real Playwright in the integration review:
 * `{"method":"fill","params":{...,"value":"…"}}` lands in `trace.trace` even with snapshots and
 * sources off, and the file is then kept beside the task's other files. Emptying password boxes
 * before each step (src/integrations/browser-trace.ts) clears the page, not the step's own argument.
 * So a sign-in is not filled at all while a recording is being kept, and the value is never read.
 */
test("a sign-in is refused while a recording is being kept, before the vault is asked anything", async (t) => {
  const { autofill, manager, page, store } = await fixture(t, { page: { recording: true } });
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), (error) => {
    assert.match(error.message, /recording/i);
    assert.ok(!error.message.includes(THE_PASSWORD));
    return true;
  });
  assert.deepEqual(manager.calls, [], "the password manager was asked nothing at all");
  assert.deepEqual(page.typed, [], "nothing was typed");
  assert.ok(!everythingWritten(store, manager.calls).includes(THE_PASSWORD));
});

/**
 * The site rule. "example.com and anything under it" hands the owner's password to whoever controls
 * one sub-address: a user page, a hosted sub-address, or an open redirect on the saved site that
 * lands on `attacker.example.com`. The address is the host itself, exactly, plus any other host the
 * owner wrote down for that entry themselves.
 */
test("only the exact website the owner saved is filled: a sub-address of it is refused", () => {
  const entry = { name: "shop", site: "example.com", service: "bitwarden", item: "My Shop", alsoHosts: [], code: false, note: "" };
  assert.equal(addressRefusal(entry, "https://example.com/login", false), null);
  assert.ok(addressRefusal(entry, "https://attacker.example.com/login", false),
    "a sub-address somebody else controls was filled");
  assert.ok(addressRefusal(entry, "https://accounts.example.com/login", false),
    "a sub-address the owner never wrote down was filled");
  assert.ok(addressRefusal(entry, "https://example.com.evil.test/login", false), "a look-alike was filled");
  // The owner's own extra host, and nothing else, is added by hand.
  const wider = { ...entry, alsoHosts: ["accounts.example.com"] };
  assert.equal(addressRefusal(wider, "https://accounts.example.com/login", false), null);
  assert.ok(addressRefusal(wider, "https://other.example.com/login", false));
});

test("an open redirect on the saved site cannot carry the sign-in to a sub-address", async (t) => {
  // The task opened https://example.com/r?u=… by address, so nothing was pressed; the page it
  // landed on is under example.com, which the old rule allowed.
  const { autofill, manager } = await fixture(t, { url: "https://attacker.example.com/steal", page: { acrossSites: false } });
  await assert.rejects(() => autofill.fill({ login: "shop" }, context()), /no saved sign-in by that name/i);
  assert.deepEqual(manager.calls, [], "the password manager was asked for a value on a page it was never meant for");
});

/**
 * The model must not be able to read the owner's book out of the refusals. Asking for a name on a
 * page it chose told it whether that name exists and which website it is saved for; that is a map
 * of where the owner's passwords are. Every "no" now says the same thing, and the real reason is
 * written into the record only the owner reads.
 */
test("a refusal tells the model nothing about the owner's book: the same words for a wrong name and a wrong site", async (t) => {
  const { autofill, store } = await fixture(t, { url: "https://somewhere-else.test/login" });
  const wrongSite = await autofill.fill({ login: "shop" }, context()).then(() => null, (error) => error.message);
  const noSuchName = await autofill.fill({ login: "bank" }, context()).then(() => null, (error) => error.message);
  assert.equal(wrongSite, noSuchName, "the two refusals differ, so the model can walk the owner's book");
  assert.ok(!wrongSite.includes("example.com"), `the refusal named the site the entry is saved for: ${wrongSite}`);
  // The owner, who reads the record, still gets the real reason.
  assert.ok(store.audits.some((row) => String(row.reason).includes("example.com")),
    "the owner's own record lost the reason as well");
});

test("a code box must be a real box on the page, whatever the page calls it", async () => {
  const { signInBoxFor } = await import("../dist/integrations/browser.js");
  assert.equal(typeof signInBoxFor, "function", "the box check is not reachable to be proven");
  // A label pointed at something that is not an input at all is refused for a code as for a password.
  const div = { tag: "DIV", type: null };
  const text = { tag: "INPUT", type: "text" };
  const password = { tag: "INPUT", type: "password" };
  assert.ok(signInBoxFor("code", div.tag, div.type), "a code was typed into something that is not a box");
  assert.ok(signInBoxFor("code", password.tag, password.type), "a code was typed into a password box");
  assert.equal(signInBoxFor("code", text.tag, text.type), null);
  assert.ok(signInBoxFor("password", text.tag, text.type), "a password was typed into a plain text box");
  assert.equal(signInBoxFor("password", password.tag, password.type), null);
});

test("the tool files under the browser box, not one of its own", async (t) => {
  const { autofill } = await fixture(t);
  const registry = new ToolRegistry();
  registerVaultAutofill(registry, autofill);
  const { inferToolGroup } = await import("../dist/catalog.js");
  assert.equal(registry.groupOf("signin.fill"), "browser");
  assert.equal(inferToolGroup("signin.fill"), "browser", "the name alone does not file under the browser box");
});

/**
 * Integration review. The card's own line in the settings catalogue hands the whole patch to
 * `saveVaultAutofillSettings`, and the comment beside it claims nothing brought in from a settings
 * file or a preset can write a line of the owner's book. If that claim were wrong the assistant
 * would have a way to read a vault: write a line pointing a real item at a website it controls,
 * open that website, ask for the sign-in by name — and the exact-website rule would pass, because
 * the website is one the book now names. This proves the claim instead of believing it.
 */
test("nothing but the owner's own route may write a line of the book: a settings file cannot", () => {
  const store = fakeStore();
  saveVaultAutofillSettings(store, OWNER, {
    mode: "when-needed", logins: [{ name: "shop", site: "example.com", item: "My Shop" }],
  });
  // Everything a settings file, a preset or a reset can propose goes through this one door.
  const proposals = [
    { key: vaultAutofillKey, field: "logins", value: [{ name: "bank", site: "attacker.test", item: "My Bank" }] },
    { key: vaultAutofillKey, field: "logins.0.site", value: "attacker.test" },
    { key: vaultAutofillKey, field: "logins.0.alsoHosts", value: ["attacker.test"] },
    { key: vaultAutofillKey, field: "alsoHosts", value: ["attacker.test"] },
    { key: vaultAutofillKey, field: "timeoutMs", value: 30000 },
    { key: vaultAutofillKey, field: "enabled", value: true },
    { key: vaultAutofillKey, field: "mode", value: "on" },
  ];
  const { changes, refused } = changesFor(store, OWNER, proposals);
  assert.deepEqual(changes.map((one) => one.field), ["mode"], `something other than the switch got through: ${refused}`);
  applyChanges(store, OWNER, changes, { accept: changes.map((one) => one.id), confirmLoosening: true, why: "a settings file" });

  const after = readVaultAutofillSettings(store, OWNER);
  assert.equal(after.mode, "on", "the switch itself is still the owner's to move from a settings file");
  assert.deepEqual(after.logins.map((one) => one.site), ["example.com"], "the book was rewritten from outside");
  assert.deepEqual(after.logins.map((one) => one.name), ["shop"]);
  assert.deepEqual(after.logins[0].alsoHosts, [], "an extra website name was added from outside");
  assert.equal(after.timeoutMs, 10000, "something other than the switch was written");
});
