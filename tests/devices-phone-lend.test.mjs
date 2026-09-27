/**
 * PH-03: lending the phone app. The native side (BranchLend.java / BranchLend in BranchPhonePlugin.swift) carries the
 * device socket and proves the phone; the app's page (apps/mobile/web/phone-node.js serveLending) does each ask. Here a
 * Node stand-in plays the native side against a real Branch, so the page's half and the protocol run for real; the
 * native rules themselves are unit-tested in apps/mobile/android/app/src/test (BranchLendTest) and pinned below.
 *
 * The stand-in passes every ask straight to the page, so the page's own checks are what is proved here. Mutations:
 * drop the "never" check in answerInvoke together with the refusals taken off the offers, and the refused photo is
 * taken; make the recording's kind fixed again and the iPhone's audio/mp4 is saved as webm. (The offer filter is held
 * twice on the page, on what is switched on and on each ask, so dropping one of the two alone stays green.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { APP_OFFERS, pairPhone, phoneKey, serveLending } from "../apps/mobile/web/phone-node.js";

const scripted = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex");
const m4a = Buffer.from("000000186674797069736f6d", "hex");

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await wait(25); }
  assert.fail(`timed out waiting for ${what}`);
}

/** The native side, played in Node: dials the paired Branch, signs the hello, hands the page every ask, sends answers. */
function standIn(env, device, key, never = []) {
  const heard = { lendState: new Set(), lendInvoke: new Set() };
  const tell = (name, value) => { for (const fn of heard[name]) void fn(value); };
  const waiting = new Set();
  let socket = null;
  const signed = async (text) => Buffer.from(await env.crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(text))).toString("base64");
  return {
    asked: [],
    deviceStatus: async () => ({ paired: true, never }),
    addListener: async (name, fn) => { heard[name].add(fn); return { remove: async () => heard[name].delete(fn) }; },
    lendStart: async () => {
      const address = new URL(`/api/devices/socket?device=${device.id}`, device.hub);
      address.protocol = "ws:";
      socket = new WebSocket(address.href);
      socket.onmessage = async (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === "challenge")
          socket.send(JSON.stringify({ type: "hello", version: 1, deviceId: device.id, platform: env.platform, offers: APP_OFFERS[env.platform].filter((c) => !never.includes(c)),
            signature: await signed(`branch-node-hello-v1\n${device.id}\n${frame.nonce}`) }));
        else if (frame.type === "welcome" || frame.type === "enabled") tell("lendState", { connected: true, enabled: frame.enabled });
        else if (frame.type === "invoke") { waiting.add(frame.id); tell("lendInvoke", frame); }
      };
      socket.onclose = () => tell("lendState", { connected: false, enabled: [] });
    },
    lendStop: async () => socket?.close(),
    async lendResult(answer) {
      this.asked.push(answer);
      assert.ok(waiting.delete(answer.id), "each ask is answered once");
      const { media, ...result } = answer;
      socket.send(JSON.stringify(media ? { ...result, media: { mime: media.mime, bytes: media.bytes, name: media.name } } : result));
      if (media) socket.send(Buffer.concat([Buffer.from(answer.id, "ascii"), Buffer.from(media.data, "base64")]));
    },
  };
}

test("a lent phone app answers Branch from its own page: a photo, an iPhone recording, and nothing it does not offer", { skip: typeof WebSocket !== "function" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-lend-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const stops = [];
  t.after(async () => { for (const stop of stops) await stop(); await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  };
  const kept = new Map();
  const env = {
    crypto: globalThis.crypto, fetch, platform: "ios", offers: APP_OFFERS.ios, now: Date.now,
    store: { get: async (key) => kept.get(key) ?? null, set: async (key, value) => void kept.set(key, value) },
    say: (_key, english) => english, wait: (ms) => wait(Math.min(ms, 25)), tries: 400,
    media: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    frame: async () => jpeg, record: async () => ({ data: m4a, mime: "audio/mp4;codecs=mp4a.40.2" }), spoken: [],
    speak(text) { this.spoken.push(text); },
  };
  await call("devices/mode", { mode: "on" });
  const invite = await call("devices/invite", {});
  const pairing = pairPhone(env, invite.link, invite.code, "Sam's iPhone");
  let request;
  await until(async () => (request = (await call("devices")).requests[0]), "the phone's request");
  await call(`devices/requests/${request.id}`, { approve: true, codeMatches: true });
  const deviceId = await pairing;
  assert.deepEqual((await call("devices")).devices[0].offers, ["camera", "speak", "listen"],
    "the phone offers only what its page really does");

  const key = await phoneKey(env), device = await env.store.get("device");
  // The owner switches on everything an iPhone could do, location included, which this phone never offered.
  await call(`devices/${deviceId}/switch`, { capability: "camera", on: true });
  await call(`devices/${deviceId}/switch`, { capability: "listen", on: true });
  await call(`devices/${deviceId}/switch`, { capability: "location", on: true });
  const native = standIn(env, device, key);
  const states = [];
  stops.push(await serveLending(env, native, (state) => states.push(state)));
  await until(() => app.devices.hub.connected(deviceId), "the phone to connect");
  await until(() => states.at(-1)?.enabled.length === 2, "the switches to reach the page");
  assert.deepEqual(states.at(-1), { connected: true, enabled: ["camera", "listen"] }, "location stays off here: the phone never offered it");

  const photo = await app.runtime.executeTool("device.camera", { facing: "front" }, { mode: "owner" });
  assert.deepEqual(await readFile(join(app.runtime.workspace, photo.file.path)), jpeg);
  const heard = await app.runtime.executeTool("device.listen", { seconds: 2 }, { mode: "owner" });
  assert.equal(heard.file.mime, "audio/mp4", "the iPhone's recording keeps its own kind");
  assert.match(heard.file.path, /\.m4a$/);
  assert.deepEqual(await readFile(join(app.runtime.workspace, heard.file.path)), m4a);
  await assert.rejects(app.runtime.executeTool("device.location", {}, { mode: "owner" }), /switched off on this phone/);
  assert.equal(native.asked.at(-1).ok, false, "the page itself turned the location ask away");

  // The phone's own "never": the computer still has the camera on, and the stand-in passes the ask on; the page refuses.
  await stops.pop()();
  await until(() => !app.devices.hub.connected(deviceId), "the phone to hang up");
  const refusing = standIn(env, device, key, ["camera"]);
  stops.push(await serveLending(env, refusing));
  await until(() => app.devices.hub.connected(deviceId), "the phone to connect again");
  await assert.rejects(app.runtime.executeTool("device.camera", {}, { mode: "owner" }), /never allows that|switched off on this phone/);
  assert.equal(refusing.asked.filter((a) => a.ok).length, 0, "no photo was taken");
});

test("the native sides dial only the paired Branch, sign only the hello, and offer what the page does", () => {
  const read = (path) => readFileSync(new URL(`../apps/mobile/${path}`, import.meta.url), "utf8");
  const java = read("android/app/src/main/java/com/keepoak/branchagent/BranchLend.java");
  const socket = read("android/app/src/main/java/com/keepoak/branchagent/BranchSocket.java");
  const node = read("android/app/src/main/java/com/keepoak/branchagent/BranchNode.java");
  const plugin = read("android/app/src/main/java/com/keepoak/branchagent/BranchPhonePlugin.java");
  const swift = read("ios/App/App/BranchPhonePlugin.swift");
  // The offers are the page's own (phone-node.js APP_OFFERS), on both sides.
  assert.match(java, new RegExp(`Arrays\\.asList\\(${APP_OFFERS.android.map((c) => `"${c}"`).join(", ")}\\)`));
  assert.match(swift, new RegExp(`static let offers = \\[${APP_OFFERS.ios.map((c) => `"${c}"`).join(", ")}\\]`));
  // lendStart takes nothing from the page: the address comes from the sealed record, checked again.
  assert.match(plugin, /public void lendStart\(PluginCall call\) \{\n\s+lend\.start\(\);/);
  assert.match(swift, /@objc func lendStart\(_ call: CAPPluginCall\) \{\n\s+guard fromAppPage\(call\) else \{ return \}\n\s+lend\.start\(\)/);
  assert.match(node, /String checked = BranchRules\.checkOrigin\(hub\);\n\s+if \(checked == null \|\| !checked\.equals\(hub\)/);
  assert.match(swift, /BranchRules\.checkOrigin\(hub\) == hub/);
  // The only text signed for the socket is the hello over the challenge.
  assert.match(node, /String text = BranchLend\.helloText\(record\.getString\("nodeId"\), nonce\);/);
  assert.match(java, /"\^\[A-Za-z0-9_-\]\{43\}\$"/);
  assert.match(swift, /let text = helloText\(deviceId: id, nonce: nonce\)/);
  // An https socket checks the certificate's name; nothing but a 101 upgrade goes ahead.
  assert.match(socket, /setEndpointIdentificationAlgorithm\("HTTPS"\)/);
  assert.match(socket, /getDefaultHostnameVerifier\(\)\.verify\(bare, secure\.getSession\(\)\)/);
  assert.match(swift, /willPerformHTTPRedirection[\s\S]{0,200}completionHandler\(nil\)/);
  // Every ask is checked natively before the page sees it, and Branch's page never sees one.
  assert.match(java, /String why = refusal\(capability, deadline, System\.currentTimeMillis\(\), never, enabled, page\.showing\(\)\);/);
  assert.match(swift, /if let why = Self\.refusal\(capability, deadline: ask\["deadline"\], now: now, never: never, enabled: enabled, showing: showing\(\)\)/);
  assert.match(plugin, /public void openBranch\(PluginCall call\) \{\n\s+lend\.stop\(\);/);
  assert.match(swift, /lend\.stop\(\) \/\/ PH-03: Branch's page never sees an ask/);
});
