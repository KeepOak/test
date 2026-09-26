/**
 * mac7/phone-qr: "Get Branch on your phone" — scan a code, the app installs.
 *
 * The owner was sent the signed app once and a delivery service renamed it `.apk.zip`; the phone
 * unzipped it into 460 loose files. So the first thing checked is exactly what the phone is told
 * about the file. Then that the door hands out that file and nothing else, that it ends, that an
 * iPhone is told the truth instead of being handed an Android file, and that the code reads back as
 * the address the door is really on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { readCode } from "./qr-reader.mjs";
import { apkType, assertDoorAddress, doorHandler, doorRoute, fileHeaders, PhoneDoor } from "../dist/phone-app/door.js";
import { candidateAddresses, defaultInterface, doorAddresses, homeNetworkAddress } from "../dist/phone-app/address.js";
import { damagedReason, findPhoneApp, missingReason, phoneAppEnvName, readCheckedApp } from "../dist/phone-app/file.js";
import { isApplePhone, loadDictionaries, pickLanguage } from "../dist/phone-app/page.js";
import { noAddressRefusal, PhoneApp, phoneAppApi, phoneLockdownRefusal, pickedAddressRefusal } from "../dist/phone-app/index.js";
import { parsePhoneArgs, phoneCommand, phoneLockdownClosed } from "../dist/phone-app/cli.js";
import { encodeQr, qrTerminal } from "../dist/remote/qr.js";
import { createBranch } from "../dist/index.js";
import { offLimitsToShortLivedKeys, startServer } from "../dist/server.js";
import { setLockdown } from "../dist/lockdown.js";
import { includedInApp, stagePhoneApp } from "../scripts/package-desktop.mjs";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
const locales = fileURLToPath(new URL("../public/locales/", import.meta.url));

/** A stand-in for the signed app: random bytes that start like a zip, with the `.sha256` line beside it. */
async function fakeApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "phone"));
  const path = join(root, "phone", "Branch-Agent-android.apk");
  const bytes = Buffer.concat([Buffer.from("PK"), randomBytes(200_000)]);
  await writeFile(path, bytes);
  await writeFile(`${path}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  Branch-Agent-android.apk\n`);
  return { root, path, bytes };
}

/** The door's own handler on 127.0.0.1, so its behaviour is tested on every machine. */
async function door(t, { now = () => 1_000, expiresAt = 10_000 } = {}) {
  const app = await fakeApp(t);
  const found = await findPhoneApp(app.root, {});
  assert.ok(found.file, found.reason);
  const state = { token: "Tok3n_-abcdefghijklmnopqrs", file: found.file, bytes: app.bytes, expiresAt, dictionaries: await loadDictionaries(locales), now };
  const server = createServer(doorHandler(state));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { ...app, state, port: server.address().port };
}

function fetchRaw(port, path, { method = "GET", headers = {}, hostname = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const call = request({ hostname, port, path, method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    call.on("error", reject);
    call.end();
  });
}

/* ---------- 1. the phone is told it is an app ---------- */

test("the served file has exactly the app's content type, file name and length, and nothing that invites a guess", async (t) => {
  const { port, state, bytes } = await door(t);
  const got = await fetchRaw(port, `/get/${state.token}/Branch-Agent.apk`, { headers: { "user-agent": ANDROID, "accept-encoding": "gzip, br" } });
  assert.equal(got.status, 200);
  assert.equal(got.headers["content-type"], "application/vnd.android.package-archive");
  assert.equal(got.headers["content-disposition"], 'attachment; filename="Branch-Agent.apk"');
  assert.equal(got.headers["content-length"], String(bytes.length));
  assert.equal(got.headers["x-content-type-options"], "nosniff");
  assert.equal(got.headers["content-encoding"], undefined, "never compressed: a phone would save a compressed body under a new name");
  assert.equal(got.headers["transfer-encoding"], undefined, "a real length, not a chunked stream");
  assert.ok(got.body.equals(bytes), "the very bytes that were checked");
  assert.deepEqual(fileHeaders(5), {
    "Content-Type": apkType, "Content-Disposition": 'attachment; filename="Branch-Agent.apk"', "Content-Length": "5",
    "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
  });
  const head = await fetchRaw(port, `/get/${state.token}/Branch-Agent.apk`, { method: "HEAD", headers: { "user-agent": ANDROID } });
  assert.equal(head.headers["content-length"], String(bytes.length));
  assert.equal(head.body.length, 0);
});

test("the landing page says what to press, in the phone's language, and links to the file", async (t) => {
  const { port, state } = await door(t);
  const english = await fetchRaw(port, `/get/${state.token}`, { headers: { "user-agent": ANDROID, "accept-language": "en-GB,en;q=0.9" } });
  assert.equal(english.status, 200);
  assert.equal(english.headers["content-type"], "text/html; charset=utf-8");
  const page = english.body.toString();
  for (const words of ["Press Download.", "Allow from this source", "Press Install.", "Press Open.", "Scan the square code", `href="/get/${state.token}/Branch-Agent.apk"`])
    assert.ok(page.includes(words), words);
  assert.match(english.headers["content-security-policy"], /default-src 'none'/);
  const french = (await fetchRaw(port, `/get/${state.token}`, { headers: { "user-agent": ANDROID, "accept-language": "fr-FR,fr;q=0.9,en;q=0.5" } })).body.toString();
  assert.ok(french.includes('lang="fr"') && french.includes("Touchez Installer."), "French for a French phone");
  assert.equal(pickLanguage("de-DE,de;q=0.9", ["en", "fr"]), "en", "a language Branch does not have falls back to English");
  assert.equal(pickLanguage("de;q=0.9,fr;q=0.8", ["en", "fr"]), "fr");
  assert.ok(!page.includes("offer") && !/\b\d{6}\b/.test(page), "no pairing invitation or number on a page anyone on the network can open");
});

/* ---------- 2. the link serves only the app ---------- */

test("the link serves only the app: every other path, method and link gets the one same refusal", async (t) => {
  const { port, state } = await door(t);
  const tok = state.token;
  const refusal = await fetchRaw(port, "/");
  assert.equal(refusal.status, 404);
  const tries = [
    ["GET", "/api/listen"], ["GET", "/api/state"], ["GET", "/api/devices"], ["GET", "/pair"], ["GET", "/index.html"], ["GET", "/get/"],
    ["GET", `/get/${tok}/../../api/state`], ["GET", `/get/${tok}/%2e%2e/api/state`], ["GET", `/get/${tok}/Branch-Agent.apk/more`],
    ["GET", `/get/${tok}/branch-agent.apk`], ["GET", `/get/${tok}/Branch-Agent.apk.sha256`], ["GET", `/get/${tok}x`],
    ["GET", `/get/${tok.slice(0, -1)}A`], ["GET", `/get/${tok}/`], ["GET", `//get/${tok}`], ["GET", `/GET/${tok}`],
    ["GET", `http://127.0.0.1/get/${tok}/../x`], ["POST", `/get/${tok}`], ["PUT", `/get/${tok}/Branch-Agent.apk`],
    ["DELETE", `/get/${tok}`], ["OPTIONS", `/get/${tok}`], ["PATCH", `/get/${tok}/Branch-Agent.apk`],
  ];
  for (const [method, path] of tries) {
    const got = await fetchRaw(port, path, { method, headers: { "user-agent": ANDROID } });
    assert.equal(got.status, 404, `${method} ${path}`);
    assert.ok(got.body.equals(refusal.body), `${method} ${path} says exactly what an unknown path says`);
    assert.notEqual(got.headers["content-type"], apkType);
  }
  assert.equal(doorRoute(state, "GET", `/get/${tok}?next=/api/state`), "page", "a query string changes nothing and reaches nothing");
});

test("an expired link refuses exactly as a wrong one does, and a stopped door closes its port", async (t) => {
  let clock = 1_000;
  const { port, state } = await door(t, { now: () => clock, expiresAt: 5_000 });
  const wrong = await fetchRaw(port, "/get/nothing-here");
  assert.equal((await fetchRaw(port, `/get/${state.token}`, { headers: { "user-agent": ANDROID } })).status, 200);
  clock = 5_000;
  for (const path of [`/get/${state.token}`, `/get/${state.token}/Branch-Agent.apk`]) {
    const got = await fetchRaw(port, path, { headers: { "user-agent": ANDROID } });
    assert.equal(got.status, 404, path);
    assert.ok(got.body.equals(wrong.body), "expired and wrong are one answer");
  }
  // The real door on a real address, when this computer has one: the port itself goes away.
  const address = (await candidateAddresses())[0];
  if (!address) return t.diagnostic("no home network or Tailscale address here; the port check is skipped");
  const app = await fakeApp(t);
  const phone = new PhoneApp({ root: app.root, env: {}, addresses: async () => [address] });
  const view = await phone.share({});
  const url = new URL(view.url);
  assert.equal((await fetchRaw(Number(url.port), url.pathname, { hostname: address, headers: { "user-agent": ANDROID } })).status, 200);
  phone.stop();
  assert.equal(phone.door.view(), null);
  await assert.rejects(fetchRaw(Number(url.port), url.pathname, { hostname: address }), /ECONNREFUSED/);
});

test("a door past its time closes itself", async (t) => {
  const address = (await candidateAddresses())[0];
  if (!address) return t.diagnostic("no home network or Tailscale address here");
  const app = await fakeApp(t);
  const phone = new PhoneDoor();
  t.after(() => phone.stop());
  await phone.start({ file: (await findPhoneApp(app.root, {})).file, bytes: app.bytes, address, dictionaries: {}, lifetimeMs: 50 });
  await Promise.race([phone.closed(), new Promise((_, reject) => setTimeout(() => reject(new Error("still open")), 5000))]);
  assert.equal(phone.view(), null);
});

/* ---------- 3. an iPhone is told the truth ---------- */

test("an iPhone gets the explanation page, never the Android file, on either path", async (t) => {
  const { port, state } = await door(t);
  for (const agent of [IPHONE, IPAD]) for (const path of [`/get/${state.token}`, `/get/${state.token}/Branch-Agent.apk`]) {
    const got = await fetchRaw(port, path, { headers: { "user-agent": agent } });
    assert.equal(got.status, 200, path);
    assert.equal(got.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(got.headers["content-disposition"], undefined);
    const page = got.body.toString();
    assert.ok(page.includes("Branch for iPhone is coming") && page.includes("Xcode"), path);
    assert.ok(!page.includes("Branch-Agent.apk"), "not even a link to the Android file");
  }
  assert.equal(isApplePhone(ANDROID), false);
  assert.equal(isApplePhone("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15"), false);
});

/* ---------- 4. the code reads back as the address the door is on ---------- */

test("the code scans to the right address", async (t) => {
  const url = "http://10.146.133.246:54321/get/Tok3n_-abcdefghijklmnopqrs";
  const matrix = encodeQr(url);
  assert.equal(readCode(matrix.modules), url);
  // The terminal drawing is the same code: read it back from its half blocks.
  const lines = qrTerminal(matrix, false).split("\n");
  const size = matrix.size + 8;
  const rows = Array.from({ length: size }, (_, row) => [...lines[row >> 1].padEnd(size)].map((cell) =>
    cell === "█" || (row % 2 === 0 ? cell === "▀" : cell === "▄")));
  assert.equal(readCode(rows.slice(4, -4).map((row) => row.slice(4, -4))), url);
  assert.match(qrTerminal(matrix, true), /\[38;5;16;48;5;231m/, "black on white, even in a dark terminal");

  const address = (await candidateAddresses())[0];
  if (!address) return t.diagnostic("no home network or Tailscale address here; the live check is skipped");
  const app = await fakeApp(t);
  const phone = new PhoneApp({ root: app.root, env: {}, addresses: async () => [address] });
  t.after(() => phone.stop());
  const view = await phone.share({});
  assert.equal(readCode(view.qr.modules), view.url);
  assert.equal(new URL(view.url).hostname, address, "the address the door listens on, not 127.0.0.1 or 0.0.0.0");
  const got = await fetchRaw(view.port, new URL(view.url).pathname, { hostname: address, headers: { "user-agent": ANDROID } });
  assert.equal(got.status, 200);
  await assert.rejects(fetchRaw(view.port, new URL(view.url).pathname), /ECONNREFUSED/, "not on this computer's loopback either");
});

/* ---------- where the door may be ---------- */

test("the door only ever opens on one home network or Tailscale address, the default route's first", async () => {
  const all = [
    { name: "lo0", address: "127.0.0.1", internal: true },
    { name: "en0", address: "10.20.86.3", internal: false },
    { name: "en0", address: "203.0.113.9", internal: false },
    { name: "bridge100", address: "192.168.64.1", internal: false },
    { name: "en1", address: "10.146.133.246", internal: false },
    { name: "utun3", address: "100.118.59.45", internal: false },
    { name: "en5", address: "169.254.10.2", internal: false },
  ];
  assert.deepEqual(doorAddresses(all, "en1"), ["10.146.133.246", "10.20.86.3", "100.118.59.45"]);
  assert.deepEqual(doorAddresses(all, null), ["10.20.86.3", "10.146.133.246", "100.118.59.45"]);
  assert.deepEqual(doorAddresses([{ name: "eth0", address: "203.0.113.9", internal: false }], "eth0"), [], "a public address is never offered");
  for (const bad of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "169.254.1.1", "::", "fe80::1", "172.32.0.1"])
    await assert.rejects(() => assertDoorAddress(bad), /home network or Tailscale/, bad);
  // Home network addresses are accepted without Tailscale probing
  for (const good of ["192.168.1.20", "10.0.0.2", "172.16.4.4"])
    await assert.doesNotReject(() => assertDoorAddress(good));
  // A 100.64/10 address is accepted only when Tailscale reports it
  const tailscaleReporting = async () => ({ present: true, running: true, address: "100.100.1.1", hostname: "desk.ts.net", message: "" });
  await assert.doesNotReject(() => assertDoorAddress("100.100.1.1", tailscaleReporting));
  // An unreported 100.64/10 address is rejected
  const otherTailscale = async () => ({ present: true, running: true, address: "100.101.1.1", hostname: "desk.ts.net", message: "" });
  await assert.rejects(() => assertDoorAddress("100.100.1.1", otherTailscale), /does not report/);
  assert.equal(homeNetworkAddress("172.31.255.1"), true);
  // A work VPN carrying the default route hands out a 10.x address too; the door never goes there.
  const vpn = [{ name: "utun4", address: "10.8.0.12", internal: false }, { name: "ppp0", address: "192.168.200.3", internal: false }, ...all];
  assert.deepEqual(doorAddresses(vpn, "utun4"), ["10.20.86.3", "10.146.133.246", "100.118.59.45"]);
  assert.deepEqual(doorAddresses([{ name: "tailscale0", address: "100.101.1.2", internal: false }], "eth0"), ["100.101.1.2"]);
  const said = [];
  const run = async (file, args) => { said.push([file, ...args]); return file === "route" ? "   route to: default\n  gateway: 10.146.133.1\n  interface: en1\n" : "default via 192.168.1.1 dev wlan0 proto dhcp\n"; };
  assert.equal(await defaultInterface("darwin", run), "en1");
  assert.equal(await defaultInterface("linux", run), "wlan0");
  assert.equal(await defaultInterface("win32", run), null);
  assert.deepEqual(said, [["route", "-n", "get", "default"], ["ip", "route", "show", "default"]]);
  assert.equal(await defaultInterface("darwin", async () => { throw new Error("no route"); }), null);
});

/* ---------- where the file comes from ---------- */

test("the app comes from inside Branch and is refused unless it matches its checksum", async (t) => {
  const { root, path, bytes } = await fakeApp(t);
  const found = await findPhoneApp(root, {});
  assert.equal(found.file.size, bytes.length);
  assert.deepEqual(await findPhoneApp(join(root, "elsewhere"), {}), { file: null, reason: missingReason });
  assert.equal((await findPhoneApp(join(root, "elsewhere"), { [phoneAppEnvName]: path })).file.path, path, "a builder's own file, by name");
  await writeFile(path, Buffer.concat([bytes, Buffer.from("x")]));
  await utimes(path, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(await findPhoneApp(root, {}), { file: null, reason: damagedReason }, "a changed file is not handed to a phone");
  await writeFile(`${path}.sha256`, "not a checksum\n");
  assert.equal((await findPhoneApp(root, {})).reason, damagedReason);
});

test("a file swapped on disk after the code was made never reaches a phone, even keeping its size and time", async (t) => {
  const { port, state, path, root, bytes } = await door(t);
  const before = await stat(path);
  const swapped = Buffer.concat([Buffer.from("PK"), randomBytes(bytes.length - 2)]);
  await writeFile(path, swapped);
  await utimes(path, before.atime, before.mtime);
  const got = await fetchRaw(port, `/get/${state.token}/Branch-Agent.apk`, { headers: { "user-agent": ANDROID } });
  assert.equal(got.status, 200);
  assert.ok(got.body.equals(bytes), "the bytes checked when the code was made are the bytes sent");
  assert.ok(!got.body.equals(swapped));
  // And a new code is not made from the swapped file, although it looks unchanged from outside.
  assert.equal(await readCheckedApp(state.file), null);
  const phone = new PhoneApp({ root, env: {}, addresses: async () => ["10.0.0.5"] });
  await assert.rejects(phone.share({}), (error) => error.status === 409 && error.message === damagedReason);
  assert.equal(phone.door.view(), null);
});

test("the desktop download carries the checked phone app in phone/, and builds without it when there is none", async (t) => {
  const { root, bytes } = await fakeApp(t);
  const into = join(root, "staged");
  const warned = [];
  assert.equal(await stagePhoneApp({ from: join(root, "phone"), into, warn: (line) => warned.push(line) }), true);
  assert.ok((await readFile(join(into, "Branch-Agent-android.apk"))).equals(bytes));
  assert.match(await readFile(join(into, "Branch-Agent-android.apk.sha256"), "utf8"), /^[a-f0-9]{64} {2}Branch-Agent-android\.apk\n$/);
  assert.ok((await findPhoneApp(join(root, "x"), { [phoneAppEnvName]: join(into, "Branch-Agent-android.apk") })).file);
  await writeFile(join(root, "phone", "Branch-Agent-android.apk"), "tampered");
  assert.equal(await stagePhoneApp({ from: join(root, "phone"), into, warn: (line) => warned.push(line) }), false);
  assert.equal(warned.length, 1);
  await assert.rejects(readFile(join(into, "Branch-Agent-android.apk")), /ENOENT/, "no stale copy is left behind");
  assert.equal(includedInApp("/phone"), true);
  assert.equal(includedInApp("/phone/Branch-Agent-android.apk"), true);
  assert.equal(includedInApp("/phones"), false);
});

// mac7/android-release: the release builds and signs the Android app once, from the repository's
// secrets, and every desktop download takes that one APK. A fork without the secrets still releases,
// honestly without the phone app. The workflow is read as text, so a change to its shape fails here.
test("the release signs the Android app once and every desktop download carries it, or none does", async () => {
  const workflow = await readFile(new URL("../.github/workflows/package.yml", import.meta.url), "utf8");
  const jobs = Object.fromEntries(workflow.split(/\n(?=  [a-z-]+:\n)/).slice(1).map((block) => [/^  ([a-z-]+):/.exec(block)[1], block]));
  const android = jobs.android, build = jobs.build, publish = jobs.publish;
  assert.ok(android && build && publish, "the android, build and publish jobs are all there");
  const steps = android.split(/\n\s+- /).slice(1);
  // Gated on the secrets, step by step (a job-level if cannot see secrets), so a fork skips cleanly.
  assert.match(android, /HAS_ANDROID_KEY: \$\{\{ secrets\.ANDROID_KEYSTORE_BASE64 != '' && secrets\.ANDROID_KEYSTORE_PASSWORD != '' \}\}/);
  for (const step of steps) {
    if (/Say the downloads will not include/.test(step)) assert.match(step, /if: env\.HAS_ANDROID_KEY != 'true'/);
    else if (/Remove the Android signing key/.test(step)) assert.match(step, /if: always\(\)/);
    else if (/upload-artifact/.test(step)) assert.match(step, /if: steps\.phone-app\.outputs\.built == 'true'/);
    else assert.match(step, /if: env\.HAS_ANDROID_KEY == 'true'/, step.split("\n")[0]);
  }
  // The key goes to this run's temporary folder, closed to others, and never onto the log.
  const load = steps.find((step) => step.includes("Load the Android signing key"));
  assert.match(load, /umask 077\n\s+printf '%s' "\$KEYSTORE_BASE64" \| base64 --decode > "\$RUNNER_TEMP\/branch-agent\.jks"/);
  assert.match(steps.find((step) => step.includes("Remove the Android signing key")), /rm -f "\$RUNNER_TEMP\/branch-agent\.jks"/);
  assert.doesNotMatch(workflow, /echo[^\n]*\$(KEYSTORE_BASE64|BRANCH_ANDROID_KEYSTORE_PASSWORD)|echo[^\n]*secrets\.ANDROID/);
  // Signed with Branch's own certificate, or refused: phones only update from the same certificate.
  const sign = steps.find((step) => step.includes("Build and sign the Android app"));
  assert.match(android, /ANDROID_CERT_SHA256: 78ec3b2816557ae4df6222dd27f7abdb4746eea42464ad40ae7b34c6ef04bb76/);
  assert.match(sign, /node scripts\/package-mobile\.mjs --android\n/);
  assert.match(sign, /sha256sum --check Branch-Agent-android\.apk\.sha256/);
  assert.match(sign, /if \[ "\$digests" != "\$ANDROID_CERT_SHA256" \]; then[\s\S]*exit 1[\s\S]*echo "built=true" >> "\$GITHUB_OUTPUT"/);
  // The digests are read whatever apksigner calls the signer: every one must be Branch's, and one is.
  const rule = /digests="\$\((.+)\)"$/m.exec(sign)[1].replaceAll('"$RUNNER_TEMP/android-certs.txt"', "");
  const digests = (listing) => execFileSync("sh", ["-c", rule], { input: listing, encoding: "utf8" }).trim();
  const ours = "78ec3b2816557ae4df6222dd27f7abdb4746eea42464ad40ae7b34c6ef04bb76";
  assert.equal(digests(`Signer #1 certificate DN: CN=Branch Agent\nSigner #1 certificate SHA-256 digest: ${ours}\n`), ours);
  assert.equal(digests(`V2 Signer: certificate SHA-256 digest: ${ours}\nV3 Signer: certificate SHA-256 digest: ${ours}\n`), ours);
  assert.notEqual(digests(`V2 Signer: certificate SHA-256 digest: ${ours}\nV3 Signer: certificate SHA-256 digest: ${"0".repeat(64)}\n`), ours);
  assert.match(android, /built: \$\{\{ steps\.phone-app\.outputs\.built \}\}/);
  // Every desktop build waits for it and takes the same APK into the folder stagePhoneApp reads.
  assert.match(build, /^  build:\n    needs: \[release-gate, android\]\n/,
    "every desktop build waits for the exact-commit release gate and the one signed phone app");
  const fetch = build.split(/\n\s+- /).find((step) => step.includes("Fetch the phone app"));
  assert.match(fetch, /if: needs\.android\.outputs\.built == 'true'/, "without the key the download is built as before");
  assert.match(fetch, /name: phone-app\n\s+path: release\/mobile\n/);
  assert.ok(build.indexOf("Fetch the phone app") < build.indexOf("npm run package:desktop"));
  // Run by hand it builds the phone app only and never touches a release.
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+phone_only:/);
  assert.match(build, /if: github\.event_name == 'push' \|\| !inputs\.phone_only/);
  assert.match(publish, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

test("pull request phone builds never receive the release key and Gradle is checksum pinned", async () => {
  const validation = await readFile(new URL("../.github/workflows/mobile.yml", import.meta.url), "utf8");
  const release = await readFile(new URL("../.github/workflows/package.yml", import.meta.url), "utf8");
  const wrapper = await readFile(new URL("../apps/mobile/android/gradle/wrapper/gradle-wrapper.properties", import.meta.url), "utf8");

  assert.doesNotMatch(validation, /secrets\.ANDROID_|BRANCH_ANDROID_KEYSTORE|HAS_ANDROID_KEY/,
    "code from a pull request must never run with the Android release key");
  assert.match(validation, /Build the Android app \(unsigned\)/,
    "validation artifacts must say plainly that they are unsigned");
  assert.match(release, /secrets\.ANDROID_KEYSTORE_BASE64/,
    "release signing remains confined to the tag publication workflow");
  assert.match(wrapper, /^distributionSha256Sum=ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c$/m,
    "the Gradle bootstrap archive must be verified before it executes");
});

/* ---------- who may open it ---------- */

test("only the owner in the app window opens it, never under Lockdown or a short-lived key", async (t) => {
  const { root } = await fakeApp(t);
  let store = { get: () => undefined };
  const phone = new PhoneApp({ root, env: {}, addresses: async () => ["10.0.0.5"] });
  const deps = { store, owner: "local", method: "POST", readBody: async () => ({ address: "8.8.8.8" }) };
  await assert.rejects(phoneAppApi(phone, deps, "/api/phone-app/share"), (error) => error.status === 400 && error.message === pickedAddressRefusal);
  // No Wi-Fi and no Tailscale: nothing opens, and the owner is told why in plain words.
  const nowhere = new PhoneApp({ root, env: {}, addresses: async () => [] });
  await assert.rejects(nowhere.share({}), (error) => error.status === 409 && error.message === noAddressRefusal);
  assert.equal(nowhere.door.view(), null);
  for (const path of ["/api/phone-app", "/api/phone-app/share", "/api/phone-app/stop"])
    for (const method of ["GET", "POST"]) assert.match(offLimitsToShortLivedKeys(method, path), /short-lived key/);
  const branchRoot = await mkdtemp(join(tmpdir(), "branch-phone-lock-"));
  const app = await createBranch({ workspace: join(branchRoot, "workspace"), dataDir: join(branchRoot, "data") });
  // Closed before its folder goes: Windows will not delete a database that is still open.
  t.after(async () => { await app.close(); await discardTemp(branchRoot); });
  setLockdown(app.store, app.runtime.owner, { on: true });
  store = app.store;
  await assert.rejects(phoneAppApi(phone, { ...deps, store, owner: app.runtime.owner, readBody: async () => ({}) }, "/api/phone-app/share"),
    (error) => error.status === 403 && error.message === phoneLockdownRefusal);
  const lines = [];
  assert.equal(await phoneCommand({ store, owner: app.runtime.owner, phone, write: (line) => lines.push(line), colour: false }, []), 1);
  assert.deepEqual(lines, [phoneLockdownRefusal]);
  assert.deepEqual(parsePhoneArgs(["--address", "10.0.0.5", "--minutes", "5"]), { address: "10.0.0.5", minutes: 5 });
});

test("branch phone closes its link when Lockdown is turned on in the window meanwhile", async () => {
  let on = false;
  const store = { get: (_kind, _owner, key) => (on && key ? { data: { on: true } } : undefined) };
  const url = "http://10.0.0.5:40000/get/Tok3n_-abcdefghijklmnopqrs";
  let stopped = 0;
  const phone = {
    share: async () => ({ url, address: "10.0.0.5", port: 40000, expiresAt: new Date(Date.now() + 60_000).toISOString(), qr: encodeQr(url) }),
    addresses: async () => ["10.0.0.5"],
    door: { closed: () => new Promise(() => undefined) },
    stop: () => { stopped++; },
  };
  const lines = [];
  const running = phoneCommand({ store, owner: "local", phone, write: (line) => lines.push(line), colour: false,
    interrupted: new Promise(() => undefined), lockdownCheckMs: 10 }, []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopped, 0, "still showing while Lockdown is off");
  on = true;
  assert.equal(await running, 0);
  assert.equal(stopped, 1);
  assert.ok(lines.includes(phoneLockdownClosed));
});

test("the window's card is wired: the owner sees whether the app is here, and nothing opens until asked", async (t) => {
  const { path } = await fakeApp(t);
  const previous = process.env[phoneAppEnvName];
  process.env[phoneAppEnvName] = path;
  t.after(() => { if (previous === undefined) delete process.env[phoneAppEnvName]; else process.env[phoneAppEnvName] = previous; });
  const root = await mkdtemp(join(tmpdir(), "branch-phone-srv-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const port = Number(new URL(server.url).port);
  const view = await fetchRaw(port, "/api/phone-app", { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(view.status, 200);
  const body = JSON.parse(view.body.toString());
  assert.equal(body.available, true);
  assert.equal(body.share, null, "no link exists until the owner presses Show the code");
  assert.equal((await fetchRaw(port, "/api/phone-app")).status, 401, "not without the key");
  // Redesign: the old window's phone app card (public/phone-app.js) left with that window, and the prototype has no card
  // that shares the app file over the home network (its phones are reached through "Add a computer or phone", pair.js), so
  // no script is served for it. The route it read is still the owner's alone, checked here and below.
  assert.notEqual((await fetchRaw(port, "/phone-app.js")).status, 200, "no stray card script is served");
  const owner = (method, path, body) => new Promise((resolve, reject) => {
    const call = request({ hostname: "127.0.0.1", port, path, method, agent: false,
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || "null") }));
    });
    call.on("error", reject);
    call.end(body === undefined ? undefined : JSON.stringify(body));
  });
  // A household profile in the window is refused, reads included.
  const kid = app.store.profiles.create({ name: "Kid", pin: "2468" });
  app.store.profiles.switch({ profileId: kid.id, pin: "2468" });
  for (const [method, path] of [["GET", "/api/phone-app"], ["POST", "/api/phone-app/share"], ["POST", "/api/phone-app/stop"]]) {
    const refused = await owner(method, path, method === "POST" ? {} : undefined);
    assert.notEqual(refused.status, 200, `${method} ${path}`);
    assert.match(refused.body.error, /belongs to the owner/, `${method} ${path}`);
  }
  app.store.profiles.switch({ profileId: null });
  // Lockdown closes a link that is showing, and its port with it.
  const address = (await candidateAddresses())[0];
  if (!address) return t.diagnostic("no home network or Tailscale address here; the Lockdown close check is skipped");
  const shared = await owner("POST", "/api/phone-app/share", {});
  assert.equal(shared.status, 200);
  const link = new URL(shared.body.share.url);
  assert.equal((await fetchRaw(Number(link.port), link.pathname, { hostname: address, headers: { "user-agent": ANDROID } })).status, 200);
  setLockdown(app.store, app.runtime.owner, { on: true });
  assert.equal((await owner("GET", "/api/phone-app")).body.share, null);
  await assert.rejects(fetchRaw(Number(link.port), link.pathname, { hostname: address }), /ECONNREFUSED/);
  setLockdown(app.store, app.runtime.owner, { on: false });
});

/* ---------- updating is scanning again ---------- */

test("a newer phone app installs over the old one and keeps its pairing: same name, same key, a number that only goes up", async () => {
  // Android keeps an app's data (its pairing included) across an install only when the package name
  // and signing key are the same and the version number is not lower. The key is this computer's
  // own (scripts/package-mobile.mjs, never copied); the name and number are checked here.
  const gradle = await readFile(new URL("../apps/mobile/android/app/build.gradle", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(gradle, /applicationId "com\.keepoak\.branchagent"/);
  const [major, minor, patch] = manifest.version.split(".").map(Number);
  assert.equal(Number(/versionCode (\d+)/.exec(gradle)[1]), major * 10000 + minor * 100 + patch, "the phone app's number follows Branch's version");
  assert.equal(/versionName "([^"]+)"/.exec(gradle)[1], manifest.version);
});
