// The phone app against the real server, through the paired door (src/server.ts remoteHandler):
// the pairing body the app sends is the one the server takes, the harmless file the app loads before
// opening the window needs no key, and what "Send to Branch" and the notification check send are
// accepted. No phone and no network beyond this computer.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { newAttention, pairingBody, planShare, readInvitation } from "../apps/mobile/web/rules.js";
import { discardTemp } from "./temp-dir.mjs";
import { readFile } from "node:fs/promises";
import { saveGatewayAuth } from "../dist/remote/gateway-auth.js";
import { DEVICE_STORAGE_KEY, installDeviceHeaders, keepDevice, readDevice, withDeviceHeaders } from "../public/device-headers.js";

async function pairedDoor(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mobile-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  const handle = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  // The paired door answers on the Tailscale address in use; here a spare loopback port stands in,
  // carrying a host the server accepts, because the host check comes first by design.
  const host = new URL(handle.url).host;
  const door = createServer((request, response) => { request.headers.host = host; handle.remoteHandler(request, response); });
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  t.after(async () => {
    door.closeAllConnections?.();
    await new Promise((done) => door.close(done));
    await handle.close(); await app.close(); await discardTemp(root);
  });
  return { app, handle, base: `http://127.0.0.1:${door.address().port}` };
}

async function pairPhone(handle, base) {
  const offer = handle.remote.pairing.create();
  const answer = await post(base, "/api/pair", pairingBody(offer.id, offer.code, "Pixel"));
  const session = await answer.json();
  return { authorization: `Bearer ${session.token}`, "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey };
}

const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

test("the phone pairs with the body it builds, and its key then works on the paired door", async (t) => {
  const { handle, base } = await pairedDoor(t);
  const offer = handle.remote.pairing.create();
  const invitation = readInvitation(`${base}/pair?id=${offer.id}`);
  assert.equal(invitation.origin, base);
  const wrong = await post(base, "/api/pair", pairingBody(offer.id, offer.code === "000000" ? "111111" : "000000", "Pixel"));
  assert.equal(wrong.status, 400);
  const answer = await post(base, "/api/pair", pairingBody(invitation.offerId, offer.code, "Pixel"));
  assert.equal(answer.status, 200);
  const session = await answer.json();
  assert.equal(typeof session.token, "string");
  assert.match(session.deviceId, /^[a-f0-9]{16}$/);
  assert.equal(typeof session.deviceKey, "string");

  // The harmless file the app opens first, to write the key into the paired address's own storage.
  const primer = await fetch(`${base}/tokens.css`);
  assert.equal(primer.status, 200);
  assert.match(primer.headers.get("content-type"), /text\/css/);
  assert.notEqual((await fetch(`${base}/inject.js`)).status, 200, "the phone's page script is the app's, not the server's");

  const headers = { authorization: `Bearer ${session.token}`, "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey };
  const state = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.deepEqual(newAttention(state, []), []);
  assert.equal((await fetch(`${base}/api/state`)).status, 401, "nothing without the key");
});

test("what Send to Branch sends is accepted: a message with a picture, and a document", async (t) => {
  const { handle, base } = await pairedDoor(t);
  const headers = await pairPhone(handle, base);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const { requests } = planShare([
    { kind: "url", text: "https://example.com/from-my-phone" },
    { kind: "file", name: "dot.png", type: "image/png", data: png },
    { kind: "file", name: "note.txt", type: "text/plain", data: Buffer.from("Shared from the phone").toString("base64") },
  ], "Please look");
  assert.deepEqual(requests.map((each) => each.path), ["/api/run", "/api/documents"]);
  for (const request of requests) {
    const answer = await post(base, request.path, request.body, headers);
    assert.equal(answer.status, 200, `${request.path}: ${await answer.clone().text()}`);
  }
  const documents = await (await fetch(`${base}/api/documents`, { headers })).json();
  assert.ok(documents.documents.some((each) => each.name === "note.txt"));
});

const memoryStorage = () => {
  const kept = new Map();
  return { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, String(value)) };
};

test("a phone paired in its browser sends its own secret, so 'this exact phone' does not lock it out", async (t) => {
  const { app, handle, base } = await pairedDoor(t);
  saveGatewayAuth(app.store, app.runtime.owner, { chain: ["token", "pairing", "device"] });
  const offer = handle.remote.pairing.create();
  const answer = await (await post(base, "/api/pair", { id: offer.id, code: offer.code })).json();
  const storage = memoryStorage();
  assert.equal(keepDevice(storage, answer), true);
  assert.deepEqual(readDevice(storage), { id: answer.deviceId, key: answer.deviceKey });
  const bearer = { authorization: `Bearer ${answer.token}` };
  assert.equal((await fetch(`${base}/api/state`, { headers: bearer })).status, 401, "the key alone is refused with the device step on");

  const seen = [];
  const recording = (input, init) => { seen.push({ url: String(input), headers: new Headers(init?.headers) }); return fetch(input, init); };
  const here = { href: `${base}/`, origin: base };
  const deviceFetch = withDeviceHeaders(recording, storage, here);
  assert.equal((await deviceFetch(`${base}/api/state`, { headers: bearer })).status, 200);
  assert.equal((await deviceFetch("/api/state", { headers: bearer }).catch(() => null)), null, "node needs a full address; the browser resolves it");
  assert.equal(seen.at(-1).headers.get("x-branch-device"), answer.deviceId, "a relative address counts as this window's own");
  assert.equal(seen.at(-1).headers.get("authorization"), bearer.authorization, "the key the caller set is kept");
  await deviceFetch("http://127.0.0.1:9/elsewhere").catch(() => undefined);
  assert.equal(seen.at(-1).headers.get("x-branch-device-key"), null, "another address never receives the secret");

  // Nothing is kept on the computer itself, so nothing is added there.
  const plain = memoryStorage();
  assert.equal(keepDevice(plain, { token: "t" }), false);
  await withDeviceHeaders(recording, plain, here)(`${base}/api/state`, { headers: bearer });
  assert.equal(seen.at(-1).headers.get("x-branch-device"), null);
  plain.setItem(DEVICE_STORAGE_KEY, "{broken");
  assert.equal(readDevice(plain), null);

  // Installed once, by the window's entry (public/app/main.js), and the pairing page keeps the secret under the same name.
  const scope = { fetch: recording, sessionStorage: storage, location: here };
  installDeviceHeaders(scope);
  const installed = scope.fetch;
  installDeviceHeaders(scope);
  assert.equal(scope.fetch, installed, "installing twice does not wrap twice");
  const appScript = await readFile(new URL("../public/app/main.js", import.meta.url), "utf8");
  assert.match(appScript, /import \{ installDeviceHeaders \} from "\.\.\/device-headers\.js";\ninstallDeviceHeaders\(\);/);
  const pairScript = await readFile(new URL("../public/pair.js", import.meta.url), "utf8");
  assert.ok(pairScript.includes(`sessionStorage.setItem(${JSON.stringify(DEVICE_STORAGE_KEY)}, JSON.stringify({ id: body.deviceId, key: body.deviceKey }))`));
  assert.equal((await fetch(`${base}/device-headers.js`)).status, 200, "the file is on the static allowlist");
});
