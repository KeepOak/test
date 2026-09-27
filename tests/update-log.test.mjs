/**
 * Owner item 19: an update that does not go through leaves Branch on the version it was, and says so
 * in one plain sentence with one button: "Download what happened". The file holds only what explains
 * the update (the hand-over's own steps, the update history, the activity log, crashes, disk, about),
 * already cleaned. The owner sends it to us themselves; nothing is sent by itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { zipRead } from "../dist/skill-package.js";
import { activationJournalName, openActivationJournal, settleActivation } from "../dist/never-break/activation.js";
import { openSettingFor } from "./places.mjs";
import { readableUpdateLog, updateFailureApi, updateLogItem, withoutControlCharacters } from "../dist/update-failure.js";
/** One newline, written by its number, because a literal one does not survive every editor. */
const newline = String.fromCharCode(10);

const secret = "sk-ant-api03-" + "x".repeat(48);
const steps = ["[10:00:01] app closed", "[10:00:02] keeping previous version", `[10:00:03] copying with ${secret}`, "[10:00:04] copy failed; putting the previous version back"];

/** A Branch whose last update did not go through: the hand-over wrote its steps, the journal says failed. */
async function failedUpdate(t, before = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-log-"));
  const dataDir = join(root, "data");
  // The hand-over writes into the system's temporary folder; this test gives Branch one of its own.
  const temp = join(root, "temp");
  await mkdir(join(temp, "branch-agent-update"), { recursive: true });
  await writeFile(join(temp, "branch-agent-update", "apply-update.log"), steps.join("\r\n") + "\r\n");
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => {
    await before();
    await server.close(); await app.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await discardTemp(root, { tries: 60, pause: 100 }); // the browser's helper can hold TEMP a while after it closes
  });
  return { app, server, dataDir, root };
}
function stageAndFail(dataDir, to = "2.0.0") {
  const { journal } = openActivationJournal(join(dataDir, activationJournalName));
  journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: to, target: join(dataDir, "..", "installed"), previous: null, candidate: null,
    launcher: null, executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] });
  journal.close();
  // The next start is still the version before: the hand-over put it back.
  assert.equal(settleActivation(join(dataDir, activationJournalName), "1.0.0"), "failed");
}
const call = (server, path, body, key = server.token) => fetch(server.url + "/api/" + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("a failed update is known after the restart, and its file holds only what explains it, cleaned", async (t) => {
  const { app, server, dataDir } = await failedUpdate(t);
  // What the file leaves out is never read: tasks, trace spans and tool servers are watched.
  const read = [];
  const watch = (target, name, label) => { const real = target[name].bind(target); target[name] = (...args) => { read.push(label); return real(...args); }; };
  watch(app.store, "recentEvents", "tasks");
  watch(app.store.spans, "recent", "spans");
  watch(app.mcpConnections, "health", "tool servers");
  assert.deepEqual(await (await call(server, "updates/failure")).json(), { failure: null }, "no update yet, nothing to say");
  stageAndFail(dataDir);
  const { failure } = await (await call(server, "updates/failure")).json();
  assert.deepEqual([failure.fromVersion, failure.toVersion], ["1.0.0", "2.0.0"]);

  const saved = await (await call(server, "updates/failure-report", {})).json();
  assert.match(saved.name, /^branch-update-report-.*\.zip$/);
  const files = zipRead(Buffer.from(saved.base64, "base64"));
  assert.deepEqual([...files.keys()].sort(), ["README.txt", "about.txt", "crashes.txt", "disk.txt", "log.txt", "update-log.txt", "updates.txt"],
    "only what explains the update: no settings, tasks, services or network");
  const log = files.get("update-log.txt");
  for (const step of ["app closed", "keeping previous version", "copy failed; putting the previous version back"]) assert.ok(log.includes(step), step);
  assert.ok(!log.includes(secret), "cleaned like every other item");
  assert.match(files.get("updates.txt"), /"state": "failed"/);
  assert.deepEqual(read, [], "nothing it leaves out was read to make it");
  // A copy is kept in Branch's own folder too, and nothing was sent anywhere.
  assert.ok((await readFile(join(dataDir, "diagnostics", saved.name))).length > 0);
});

test("a later update that worked puts the failure away", async (t) => {
  const { server, dataDir } = await failedUpdate(t);
  stageAndFail(dataDir);
  const { journal } = openActivationJournal(join(dataDir, activationJournalName));
  journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.1", target: "x", previous: null, candidate: null,
    launcher: null, executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] });
  journal.close();
  assert.equal(settleActivation(join(dataDir, activationJournalName), "2.0.1"), "activated");
  assert.deepEqual(await (await call(server, "updates/failure")).json(), { failure: null });
});

test("a household profile and a short-lived key can neither see the failure nor make its file", async (t) => {
  const { app, server, dataDir } = await failedUpdate(t);
  stageAndFail(dataDir);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "phone", scope: "run" }).token;
  assert.ok([401, 403].includes((await call(server, "updates/failure", undefined, key)).status));
  assert.ok([401, 403].includes((await call(server, "updates/failure-report", {}, key)).status));
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  assert.notEqual((await call(server, "updates/failure")).status, 200);
  assert.notEqual((await call(server, "updates/failure-report", {})).status, 200);
  // The outer table answers first over the network; the route's own guard (which names itself) is
  // what stays if that table is ever refactored, so it is asked directly.
  const ctx = { app, dataDir, installType: "test", startedAt: Date.now() };
  for (const [method, path] of [["GET", "/api/updates/failure"], ["POST", "/api/updates/failure-report"]])
    await assert.rejects(updateFailureApi(ctx, method, path), /^Error: An update's problem report belongs to the owner/);
});

async function openApp(t, { desktop }) {
  const { chromium } = await import("playwright");
  // Launched before Branch is given its own temporary folder, and closed before that folder goes.
  const browser = await chromium.launch({ headless: true });
  const branch = await failedUpdate(t, () => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The desktop bridge, with a newer version ready whose install stops with a plain sentence.
  if (desktop) await page.addInitScript(() => {
    window.branchDesktop = {
      updateStatus: async () => ({ phase: "available", message: "Version 9.9.9 is ready to install.", progress: null }),
      checkForUpdates: async () => ({ phase: "available", message: "Version 9.9.9 is ready to install.", progress: null }),
      installUpdate: async () => { throw new Error("The safety copy could not be made, so the update was stopped."); },
      modelSettings: async () => ({}), openExternal: async () => true,
    };
  });
  return { ...branch, page, errors };
}
async function connect(page, server) {
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingFor(page, "#updates-card");
}

// Redesign: Coming soon (install, in the status bar's update menu), checked at fc541c24; the prototype has no failed-update
// card to say it in, and French waits on sw:lang.
test.skip("an install that stops here says it in plain words at once, in the language chosen", async (t) => {
  const { page, server, errors } = await openApp(t, { desktop: true });
  await connect(page, server);
  assert.equal(await page.locator("#updates-failed").isHidden(), true, "nothing to say before anything failed");
  await page.locator("#updates-install").waitFor({ state: "visible" });
  await page.locator("#updates-install").click();
  const text = page.locator("#updates-failed-text");
  await text.waitFor({ state: "visible" });
  assert.match(await text.textContent(), /^The update didn't go through\. Branch stayed on .+, and nothing was lost\.$/);
  // The reason stays on the card, not only in a toast that is gone before it can be read.
  assert.equal(await page.locator("#updates-failed-why").textContent(), "What stopped it: The safety copy could not be made, so the update was stopped.");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => /n'a pas abouti/.test(document.querySelector("#updates-failed-text")?.textContent ?? ""));
  // Checking again starts over: this attempt is put away.
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await page.locator("#updates-check").click();
  await page.waitForFunction(() => document.querySelector("#updates-failed")?.hidden === true);
  assert.deepEqual(errors, []);
});

test("the update file reads nothing it leaves out: no settings, tasks, services or health, and nothing looked up", async () => {
  const { gatherReport } = await import("../dist/diagnostic-report.js");
  const { updateItemIds } = await import("../dist/update-failure.js");
  const touched = [];
  const spy = (name, answer) => (...args) => { touched.push(name); return answer; };
  const root = await mkdtemp(join(tmpdir(), "branch-update-sources-"));
  try {
    const sources = {
      version: "1.0.0", dataDir: root, installType: "test", log: null, logMode: "when-needed",
      health: spy("health", Promise.resolve({ ok: true })), settings: spy("settings", { secret: 1 }),
      services: spy("services", {}), events: spy("events", {}), resolve: spy("resolve", Promise.resolve({})),
    };
    const items = await gatherReport(sources, updateItemIds);
    assert.deepEqual(touched, [], "none of the left-out sources is asked");
    assert.deepEqual(items.map((item) => item.id).sort(), [...updateItemIds].sort(), "exactly the update items");
  } finally { await discardTemp(root); }
});

test("only the end of a long update log is read: at most 400 lines, each cut short, a huge first line dropped", async (t) => {
  const { updateLogItem } = await import("../dist/update-failure.js");
  const root = await mkdtemp(join(tmpdir(), "branch-update-tail-"));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: root, TMP: root, TMPDIR: root });
  t.after(async () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await discardTemp(root, { tries: 60, pause: 100 }); }); // the browser's helper can hold TEMP a while after it closes
  await mkdir(join(root, "branch-agent-update"), { recursive: true });
  const lines = ["x".repeat(3_000_000), ...Array.from({ length: 600 }, (_, i) => `[step ${i}] ${"y".repeat(i === 599 ? 5000 : 10)}`)];
  await writeFile(join(root, "branch-agent-update", "apply-update.log"), lines.join("\n"));
  const text = (await updateLogItem()).text;
  const kept = text.split("\n");
  assert.ok(kept.length <= 400, `${kept.length} lines`);
  assert.ok(kept.every((line) => line.length <= 2000), "every line cut short");
  assert.ok(!text.includes("x".repeat(100)), "the huge first line is never read");
  assert.match(kept.at(-1), /^\[step 599\]/, "the newest step is there");
});

test("the log is read from its end, never more than a fixed amount, however big it grew", async (t) => {
  const { tailOf } = await import("../dist/update-failure.js");
  const root = await mkdtemp(join(tmpdir(), "branch-update-ceiling-"));
  t.after(() => discardTemp(root));
  const path = join(root, "apply-update.log");
  await writeFile(path, "a".repeat(3_000_000) + "\nlast step");
  const tail = await tailOf(path);
  assert.ok(tail.length <= 256 * 1024, `${tail.length} characters read`);
  assert.equal(tail, "last step", "the cut first line is dropped");
  await writeFile(path, "small\nlog");
  assert.equal(await tailOf(path), "small\nlog", "a small log is read whole");
});

// Q135: #198's cleaning of the update log, ported onto #176's file (Legion 83b1d20).
/** A log the way the hand-over writes one: the end is what matters, so that is where the trouble is. */
async function updateLog(t, lines) {
  const dir = await mkdtemp(join(tmpdir(), "branch-update-log-"));
  t.after(() => discardTemp(dir));
  await writeFile(join(dir, "apply-update.log"), lines.join("\n"), "utf8");
  return dir;
}
const escape = String.fromCharCode(27);




test("a label on one line and its value on the next is still found", () => {
  // Splitting decides what the redactor is allowed to read, exactly as shortening does. Cleaning
  // each line on its own cannot see a label above its value -- and that is not a contrived shape,
  // it is what a failed update writes when the update server refuses it: a pretty-printed 401 with
  // "cookie": on one line and the session on the next. Cleaning each line stops a cut hiding a
  // label from the redactor; cleaning the joined result stops a newline hiding one. Both are needed,
  // and a version with only the first of them let this through whole.
  const refusal = [
    "step 8: the update server refused us (401):",
    "  {",
    '    "cookie":',
    '      "session=9f8e7d6c5b4a39281706",',
    '    "authorization":',
    '      "Bearer abcdefghijklmnop1234"',
    "  }",
    "step 9: failed to move the folder",
  ].join(newline);
  const out = readableUpdateLog(refusal);

  assert.equal(out.includes("9f8e7d6c5b4a39281706"), false, `the session is gone (${out})`);
  assert.equal(out.includes("abcdefghijklmnop1234"), false, "and so is what came after the authorization line");
  assert.match(out, /step 9: failed to move the folder/, "and the step it stopped on is still readable");
});

test("a key whose label is cut out of the middle of a line does not leave its tail behind", () => {
  // The last line of an oversized log keeps both of its ends and drops the middle. Shortening it
  // before looking for secrets let the shortening decide what the redactor was allowed to read: a
  // key whose label sat in the discarded middle arrived with nothing beside it to recognise.
  // Measured on this exact shape before the order was changed: 24 characters of the key, in plain
  // sight, at the end of the one file the owner is told to send on.
  const tail = "ZZTAILOFTHEKEY9876543210";
  const key = "sk-ant-api03-" + "Q".repeat(2500) + tail;  // not-a-real-secret
  const line = "step 9: " + "filler ".repeat(600) + "authorization: Bearer " + key;
  const last = readableUpdateLog("step 1 fine" + String.fromCharCode(10) + "" + line).split(newline).at(-1);

  assert.equal(last.includes(tail), false, `the end of the key is gone (${last.slice(-80)})`);
  assert.equal(/Q{20}/.test(last), false, "and so is the middle of it");
  assert.match(last, /authorization: .removed./, "what is left says a key was there and was taken out");
});

test("a value the line limit cuts short does not leave the front of a key in plain sight", () => {
  // Every line but the last keeps its beginning and drops the rest. Cutting before looking for
  // secrets means the redactor is handed a value that has already lost its end, so the shape it
  // knows how to recognise is not there any more and what it does not recognise it leaves alone.
  // Measured at this exact offset before the order was changed: "apiKey=sk-proj-ab" survived, at
  // the end of the line, in the file the owner is told to send on.
  const line = "step 4: " + "z".repeat(1975) + "apiKey=sk-proj-abcdefghij1234567890 and then it stopped";  // not-a-real-secret
  const first = readableUpdateLog(line + "" + newline + "step 5 done").split(newline)[0];

  assert.equal(first.includes("sk-proj-"), false, `no part of the key is left (${first.slice(-40)})`);
  assert.match(first, /apiKey=/, "the line still says a key was there");
  assert.ok(first.length <= 2000, `and the line is still bounded (${first.length})`);
});
test("a secret with an escape sequence hidden inside it is still taken out", async (t) => {
  // The order is the whole finding. Looking for secrets *before* cleaning the text means an escape in the
  // middle of a key breaks the shape the redactor looks for, so the key goes through — and then the escape
  // is helpfully removed, leaving it in plain sight in the file the owner is told to send.
  //
  // Each of these is a case where nothing else would have caught it: a key with no label beside it, a path
  // with no `authorization:` in front of it, an address the escape splits in two.
  const broken = (text, at) => text.slice(0, at) + escape + "[0m" + text.slice(at);
  const key = "sk-ant-api03-A1b2C3d4E5f6G7h8I9j0KLMNOPQRSTUVWX"; // not-a-real-secret
  const dir = await updateLog(t, [
    `step 7: using ${broken(key, 25)}`,
    `at ${broken("C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "bishi" + String.fromCharCode(92) + "Documents", 12)}`,
    `mail ${broken("someone@example.com", 4)}`,
    "step 9: failed to move the folder",
  ]);
  const item = await updateLogItem(dir);

  assert.equal(item.text.includes("KLMNOPQRSTUVWX"), false, `no part of the key survives (${item.text.slice(0, 160)})`);
  assert.equal(item.text.includes("G7h8I9j0"), false, "not even the half after the escape");
  assert.equal(item.text.includes("example.com"), false, "the address is gone whole");
  assert.equal(item.text.includes("some"), false, "including the half before the escape");
  assert.match(item.text, /step 9: failed to move the folder/, "and what went wrong is still readable");
});

test("a bare carriage return, which writes over the line before it, does not survive", async (t) => {
  // A carriage return on its own is not a newline: it sends the cursor back to the start of the line, so
  // what follows overwrites what was there. Keeping it because it looks like a line ending would let a
  // line hide another one in a file somebody opens.
  const carriageReturn = String.fromCharCode(13);
  const dir = await updateLog(t, [
    `step 4: everything is fine${carriageReturn}step 4: nothing is fine`,
    "step 9: failed to move the folder",
  ]);
  const item = await updateLogItem(dir);

  assert.equal(item.text.includes(carriageReturn), false, "no bare carriage return reaches the file");
  assert.match(item.text, /everything is fine/, "both halves are still readable, one after the other");
  assert.match(item.text, /nothing is fine/);
});

test("a log with no newlines at all keeps a real ending, not the start of a piece of the middle", async (t) => {
  // Only the last 256 KiB of a log is read. When that whole window is one line, keeping its first 2,000
  // characters hands back the beginning of a fragment cut out of the middle of a file and calls it the
  // end of the update.
  const dir = await updateLog(t, [`the start of it all ${"x".repeat(400_000)} step 9: failed to move the folder`]);
  const item = await updateLogItem(dir);

  assert.match(item.text, /step 9: failed to move the folder$/, "where it stopped is the last thing in it");
  assert.ok(item.text.length <= 2000, `and it is still bounded (${item.text.length})`);
});

test("a long last line keeps both of its ends, so the step's name and its ending both survive", () => {
  const line = `[step 599] ${"y".repeat(5000)} and then it stopped`;
  const kept = readableUpdateLog(`[step 598] fine\n${line}`).split("\n").at(-1);
  assert.match(kept, /^\[step 599\]/, "which step it was");
  assert.match(kept, /and then it stopped$/, "and where it got to");
  assert.ok(kept.includes("[...]"), "with the missing middle said out loud");
  assert.ok(kept.length <= 2000);
});


test("what a terminal would obey is taken out of the file the owner is asked to send", async (t) => {
  // The hand-over script echoes what the shell and the archive tools said, so a name inside a downloaded
  // archive can put escape sequences in here. Colour is the harmless end; moving the cursor and writing
  // over what is above it is the other end, and this is the one file the owner is told to open and pass on.
  const dir = await updateLog(t, [
    "step 1: unpacking",
    `${escape}[31mstep 2: a name from the archive${escape}[0m`,
    `a bell${String.fromCharCode(7)} and a backspace${String.fromCharCode(8)} in the middle`,
    "step 9: failed to move the folder",
  ]);
  const item = await updateLogItem(dir);

  assert.equal(item.text.includes(escape), false, "no escape sequences reach the file the owner opens");
  assert.equal(item.text.includes(String.fromCharCode(7)), false, "nor a bell");
  assert.equal(item.text.includes(String.fromCharCode(8)), false, "nor a backspace");
  assert.match(item.text, /step 2: a name from the archive/, "the words themselves are still there");
  assert.match(item.text, /step 9: failed to move the folder/, "and so is what went wrong");
  assert.match(item.text, /\n/, "newlines are not control characters for this purpose");
});

test("the end of the log is kept, because that is where an update stops", async (t) => {
  // Believing the opposite is easy: a check written against the first lines of a long log passes while
  // proving nothing, because those lines are exactly the ones that are dropped.
  const dir = await updateLog(t, [
    "the very first line, long ago",
    ...Array.from({ length: 900 }, (_unused, index) => `filler line ${index}`),
    "the last line, where it stopped",
  ]);
  const item = await updateLogItem(dir);
  const kept = item.text.split("\n");

  assert.equal(kept.length, 400, "four hundred lines, no more");
  assert.equal(kept.at(-1), "the last line, where it stopped");
  assert.equal(item.text.includes("the very first line, long ago"), false, "the beginning is what goes");
});

test("secrets, addresses and the owner's own folder do not reach the file either", async (t) => {
  const dir = await updateLog(t, [
    "authorization: Bearer sk-ant-api03-NOTAREALKEY-abcdefghijklmnop", // not-a-real-secret
    'config {"apiKey":"sk-proj-abcdef1234567890"}', // not-a-real-secret
    "owner email: someone@example.com",
    `a very long line: ${"x".repeat(6000)}`,
    "step 9: failed to move the folder",
  ]);
  const item = await updateLogItem(dir);

  assert.equal(item.text.includes("sk-ant-api03-NOTAREALKEY"), false); // not-a-real-secret
  assert.equal(item.text.includes("sk-proj-abcdef1234567890"), false); // not-a-real-secret
  assert.equal(item.text.includes("someone@example.com"), false);
  assert.ok(Math.max(...item.text.split("\n").map((line) => line.length)) <= 2000,
    "and no single line runs away with the file");
  assert.match(item.text, /step 9: failed to move the folder/);
});

test("with no log at all it says so, rather than failing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-update-none-"));
  t.after(() => discardTemp(dir));
  const item = await updateLogItem(dir);
  assert.match(item.text, /No update has written its steps/);
});

test("taking control characters out keeps everything a person reads", () => {
  assert.equal(withoutControlCharacters(`a${escape}[1mb`), "ab");
  assert.equal(withoutControlCharacters("one\ttwo\nthree"), "one\ttwo\nthree", "tabs and newlines stay");
  assert.equal(withoutControlCharacters("plain words"), "plain words");
});
