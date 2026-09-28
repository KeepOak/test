/**
 * "Which device are you on?" (the owner's Telegram chat, 2026-09-27): the default Trunk said it could not see the
 * device. Branch knows it: the computer's name, its system, that it is the owner's PC running Branch Agent and in what,
 * where the message came from, and the local time. One line of it goes to the model with every task, and
 * `environment.about` answers more on request, from a chat too. Nothing secret and no folder path. Stand-ins only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { chatAppName, currentHost, environmentFacts, environmentLine, setWindowShown, systemName } from "../dist/environment.js";

test("the operating system is named as people know it", () => {
  assert.equal(systemName({ platform: "win32", type: "Windows_NT", release: "10.0.26200", version: "Windows 10 Home" }), "Windows 11 Home (10.0.26200)");
  assert.equal(systemName({ platform: "win32", type: "Windows_NT", release: "10.0.19045", version: "Windows 10 Pro" }), "Windows 10 Pro (10.0.19045)");
  assert.equal(systemName({ platform: "darwin", type: "Darwin", release: "24.2.0", version: "" }), "macOS (Darwin 24.2.0)");
  assert.equal(systemName({ platform: "linux", type: "Linux", release: "6.8.0", version: "" }), "Linux 6.8.0");
});

test("where Branch runs comes from the process itself", () => {
  assert.equal(currentHost({ BRANCH_GATEWAY_CHILD: "1" }, {}), "gateway");
  assert.equal(currentHost({}, { parentPort: {} }), "desktop");
  assert.equal(currentHost({}, {}), "command line");
  assert.equal(chatAppName("whatsapp"), "WhatsApp");
  assert.equal(chatAppName("kook"), "kook");
});

test("the line names the computer, the app it runs in, the window, the chat app and the local time, and no folder", () => {
  const facts = { device: "LEGION", system: "Windows 11 Home (10.0.26200)", host: "desktop", window: "hidden", channel: "Telegram",
    time: "Sun, 27 Sept 2026, 20:14", timeZone: "America/New_York" };
  const line = environmentLine(facts);
  assert.match(line, /"LEGION" \(Windows 11 Home \(10\.0\.26200\)\)/);
  assert.match(line, /desktop app, its window hidden/);
  assert.match(line, /came in on Telegram/);
  assert.match(line, /20:14 \(America\/New_York\)/);
  assert.match(environmentLine({ ...facts, host: "gateway", window: null, channel: null }), /background gateway \(no window\).*Branch's own window or API/);
  const real = environmentLine(environmentFacts("Telegram"));
  assert.ok(real.includes(hostname()), "the real computer's name");
  assert.ok(!real.includes(homedir()), "never a folder path");
  setWindowShown(true);
  assert.equal(environmentFacts().window, null, "outside the desktop app there is no window to speak of");
  setWindowShown(null);
});

test("a chat's task is told where Branch runs and which app the message came in on, and can ask for more", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-environment-"));
  const requests = [];
  const provider = { name: "stand-in", async complete(request) {
    requests.push(request);
    if (requests.length === 1) return { content: "", toolCalls: [{ id: "e1", name: "environment.about", arguments: "{}" }] };
    return { content: "I am on this PC.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const chat = { id: "tg", kind: "telegram", botName: () => "TK", async start() {}, async stop() {}, async send() { return "1"; } };
  await app.channels.attach(chat, { activation: "always", pairing: true, allowlist: ["owner"] });
  assert.equal(await app.channels.handle({ channel: "tg", chatId: "c", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text: "Which device are you on?", addressed: true, messageId: "1" }), "replied");
  const system = requests[0].messages.filter((m) => m.role === "system").map((m) => m.content);
  const line = system.at(-1);
  assert.match(line, /^Where you are running: the owner's own computer/, "the last of the system text, after what stays the same");
  assert.ok(line.includes(hostname()));
  assert.match(line, /came in on Telegram/);
  // In the settings toolbox (one line while closed), and a chat's task may call it: skills.read is on every chat's list.
  assert.equal(app.registry.groupOf("environment.about"), "settings");
  const result = requests[1].messages.find((m) => m.role === "tool");
  const about = JSON.parse(result.content).result;
  assert.equal(about.device, hostname());
  assert.equal(about.channel, "Telegram");
  assert.ok(about.cores >= 1 && about.memoryGb >= 0);
  assert.ok(!result.content.includes(homedir()), "no folder path");
  const own = await app.runtime.run({ prompt: "hello" });
  assert.equal(own.status, "completed");
  assert.match(requests.at(-1).messages.filter((m) => m.role === "system").at(-1).content, /Branch's own window or API/);
});
