/**
 * Settings › Saved sign-ins › Password manager › Windows: Windows Credential Manager as a place sign-ins come from.
 *
 * - The command reads one generic credential by its exact name through Windows' own CredRead, in Windows PowerShell by
 *   its full path, declared in memory (nothing compiled, no library written), with the whole script passed encoded and
 *   the name only as base64 inside a quoted literal.
 * - It follows every rule the other managers follow: off until chosen, only when ticked, read only when a sign-in is
 *   filled, remembered by the scrubber, never in the answer, the record or an error, and only on Windows.
 * - A real round trip (a throwaway credential made with cmdkey, read, then deleted) runs only on the build machine's
 *   Windows lane: this computer's own Credential Manager is never touched by these tests.
 *
 * Mutation notes (each turns this file red):
 * - credential-cli.ts windowsCredentialScript: put the name in the script as text      -> "only as base64" fails.
 * - credential-cli.ts read: drop the not-Windows refusal                               -> "only on Windows" fails.
 * - credential-cli.ts read: drop the services check (windows read without being ticked) -> "only when ticked" fails.
 * - credential-cli.ts commandFor: read a one-time code from Windows                    -> "no one-time code" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CredentialResolver, commandFor, windowsCredentialCommand, windowsCredentialScript, saveCredentialSettings,
  readCredentialSettings, spawnCli, parseCredentialReference } from "../dist/credential-cli.js";
import { VaultAutofill, saveVaultAutofillSettings } from "../dist/vault-autofill.js";
import { SecretScrubber } from "../dist/vault.js";

const OWNER = "local";
const THE_PASSWORD = "wincred-pässword-7731";
function fakeStore() {
  const rows = new Map(), audits = [];
  return { audits, get: (table, owner, id) => (rows.has(`${table}/${owner}/${id}`) ? { data: rows.get(`${table}/${owner}/${id}`) } : undefined),
    save: (table, owner, id, data) => { rows.set(`${table}/${owner}/${id}`, data); return { data }; }, atomically: (work) => work(),
    audit: { record: (owner, input) => audits.push({ owner, ...input }) }, run: () => undefined, events: () => [] };
}
const decode = (args) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
const context = { owner: OWNER, workspace: "/tmp", runId: "11111111-1111-4111-8111-111111111111", signal: new AbortController().signal, budget: {}, permissions: new Set(), depth: 0 };

test("the command: Windows PowerShell by its full path, the script encoded, the name only as base64 in a quoted literal", () => {
  const name = "My Shop@work/x";
  const { executable, args } = windowsCredentialCommand(name, "C:\\Windows");
  assert.equal(executable, join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.deepEqual(args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  const script = decode(args);
  assert.equal(script, windowsCredentialScript(name));
  assert.ok(!script.includes(name), "the name is never in the script as text");
  assert.ok(script.includes(`FromBase64String('${Buffer.from(name, "utf8").toString("base64")}')`));
  assert.match(script, /DefineMethod\('CredReadW'/, "Windows' own CredRead");
  assert.ok(script.includes("$il.Emit($op::Ldc_I4_1); $il.Emit($op::Ldc_I4_0)"), "a generic credential (type 1), read with no flags");
  assert.ok(script.includes("if ($code -eq 1168) { [Console]::Error.WriteLine('not found'); exit 44 }"), "only ERROR_NOT_FOUND is a missing name");
  assert.ok(script.includes("exit 45"), "any other failure says its Windows error");
  assert.doesNotMatch(script, /Add-Type|DefineDynamicAssembly\([^)]*Save/, "nothing is compiled and no library is written (Smart App Control)");
  assert.match(script, /AssemblyBuilderAccess\]::Run\)/, "declared in memory only");
  assert.doesNotMatch(script, /\b(New-Object|Add-Type|Import-Module|Get-[A-Z]|Set-[A-Z]|Write-[A-Z])/, "no cmdlet, so no module is loaded (a first run would spend its time preparing modules)");
  assert.doesNotMatch(script, /CredWrite|CredDelete|CredEnumerate/, "nothing is written, deleted or listed");
  assert.deepEqual(parseCredentialReference("secret://windows/My Shop"), { service: "windows", item: "My Shop" });
  assert.throws(() => commandFor({ service: "windows", item: "x", field: "totp" }, readCredentialSettings(fakeStore(), OWNER)), /one-time code from Bitwarden only/);
});

test("reading follows the same rules: off, not ticked, not Windows, a missing name; a value is scrubbed and recorded by name", async () => {
  const store = fakeStore(), scrubber = new SecretScrubber(), calls = [];
  const run = async (executable, args) => { calls.push({ executable, args }); return /Tm9uZQ==/.test(decode(args)) ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: THE_PASSWORD, stderr: "" }; };
  const windows = new CredentialResolver(store, OWNER, scrubber, run, "win32");
  const use = { runId: "r1", purpose: "filling your shop sign-in" };
  await assert.rejects(windows.read({ service: "windows", item: "Shop" }, use), /not set up to read passwords/);
  saveCredentialSettings(store, OWNER, { enabled: true, services: ["bitwarden"] });
  await assert.rejects(windows.read({ service: "windows", item: "Shop" }, use), /not allowed to read from Windows Credential Manager/);
  saveCredentialSettings(store, OWNER, { choose: "windows" });
  assert.deepEqual(readCredentialSettings(store, OWNER).services, ["windows", "bitwarden"], "choosing puts it first and keeps the other");
  const elsewhere = new CredentialResolver(store, OWNER, new SecretScrubber(), run, "linux");
  await assert.rejects(elsewhere.read({ service: "windows", item: "Shop" }, use), /part of Windows/);
  assert.equal(calls.length, 0, "nothing ran on another system, or before it was switched on and ticked");
  assert.equal(await windows.read({ service: "windows", item: "Shop" }, use), THE_PASSWORD);
  assert.equal(scrubber.text(`it was ${THE_PASSWORD}`).includes(THE_PASSWORD), false, "the scrubber takes it back out of anything written later");
  await assert.rejects(windows.read({ service: "windows", item: "None" }, use), /There is nothing called "None" in your Windows Credential Manager\./);
  const failing = new CredentialResolver(store, OWNER, new SecretScrubber(), async () => ({ code: 45, stdout: "", stderr: "windows error 1312\r\n" }), "win32");
  await assert.rejects(failing.read({ service: "windows", item: "Shop" }, use), /could not be read here \(windows error 1312\)\. Branch reads it only while running as you/,
    "a read that failed for another reason is not called missing");
  const rows = JSON.stringify(store.audits);
  assert.ok(!rows.includes(THE_PASSWORD), "never in the record");
  assert.ok(store.audits.some((row) => row.actor === "your Windows Credential Manager" && row.subject === "secret://windows/Shop" && row.outcome === "handed over"));
});

test("a saved sign-in from Windows Credential Manager is typed into the page and nowhere else", async () => {
  const store = fakeStore(), typed = [];
  saveCredentialSettings(store, OWNER, { enabled: true, services: ["windows"] });
  saveVaultAutofillSettings(store, OWNER, { mode: "when-needed", logins: [{ name: "shop", site: "example.com", service: "windows", item: "Shop" }] });
  const resolver = new CredentialResolver(store, OWNER, new SecretScrubber(), async () => ({ code: 0, stdout: THE_PASSWORD, stderr: "" }), "win32");
  const autofill = new VaultAutofill({ store, owner: OWNER, read: (reference, use) => resolver.read(reference, use), requireOwner: () => undefined,
    page: { where: async () => ({ address: "https://example.com/login", acrossSites: false, recording: false }), type: async (_c, box, _l, value) => { typed.push({ box, ok: value === THE_PASSWORD }); } } });
  const answer = await autofill.fill({ login: "shop" }, context);
  assert.deepEqual(typed, [{ box: "password", ok: true }]);
  assert.ok(!JSON.stringify(answer).includes(THE_PASSWORD));
  assert.ok(!JSON.stringify(store.audits).includes(THE_PASSWORD));
  assert.ok(store.audits.some((row) => row.actor === "your Windows Credential Manager" && row.outcome === "filled"));
  await assert.rejects(autofill.fill({ login: "shop", box: "code" }, context), /not marked as holding a one-time code/);
});

test("a real round trip on the build machine's Windows lane: a throwaway credential is read, then deleted", { skip: process.platform !== "win32" || !process.env.CI }, async (t) => {
  const target = `branch-ci-${randomBytes(6).toString("hex")}`, secret = `pw-${randomBytes(9).toString("base64url")}-é-пароль-你好`; // UTF-16 text above U+00FF too (Codex P2)
  execFileSync("cmdkey", [`/generic:${target}`, "/user:branch-ci", `/pass:${secret}`], { windowsHide: true });
  t.after(() => { try { execFileSync("cmdkey", [`/delete:${target}`], { windowsHide: true }); } catch { /* already gone */ } });
  const { executable, args } = windowsCredentialCommand(target);
  const found = await spawnCli(executable, args, 30000);
  assert.equal(found.code, 0, `exit ${found.code}: ${found.stderr.slice(0, 300)} (${found.stdout.length} characters out)`);
  assert.equal(found.stdout, secret);
  const missing = await spawnCli(...Object.values(windowsCredentialCommand(`${target}-none`)), 30000);
  assert.equal(missing.code, 44);
});
