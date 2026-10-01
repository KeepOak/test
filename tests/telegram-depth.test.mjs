// CHAT-257: Telegram, in depth reads what the loaded Telegram connections can really do, from this computer only: no
// Telegram call, no sender ids, names, texts or secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { telegramDepth } from "../dist/channels/telegram-depth.js";

test("the readout names each Telegram connection's real abilities and nothing private", () => {
  const adapters = { tg: { maxTextLength: 4096, sendTyping() {}, react() {}, edit() {}, sendButtons() {} } };
  const router = {
    summary: () => ({ live: true, channels: [
      { id: "tg", kind: "telegram", health: { state: "ok", error: "token 123:ABC refused" }, activation: "mention", pairing: "on", allowlist: ["111", "222"] },
      { id: "sl", kind: "slack", health: { state: "ok" }, activation: "always", pairing: "off", allowlist: [] }] }),
    adapter: (id) => adapters[id],
  };
  const read = telegramDepth(router);
  assert.equal(read.connections.length, 1, "only Telegram");
  assert.deepEqual({ ...read.connections[0] }, { health: "ok", activation: "mention", pairing: "on", allowlistedSenders: 2, maxTextLength: 4096,
    typing: true, reactions: true, edits: true, buttons: true, voiceReplies: false });
  assert.doesNotMatch(JSON.stringify(read), /111|222|123:ABC/);
});

// Review 5914335463: a read still pending when the readout is dismissed or replaced by another dialog, or when Settings
// is left, never opens the readout afterwards. The dialog and view are checked after every await (core/view-fence.js).
const read = (name) => readFile(new URL(`../public/app/${name}`, import.meta.url), "utf8");
const strip = (source) => source.replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
const [ui, fence, principals] = await Promise.all([read("settings/telegram-depth.js"), read("core/view-fence.js"), read("core/session-pages.js")]);
function readout(path, change) {
  const handlers = {}, shown = [], revision = { value: 0 };
  const E = { profiles: { active: null, isOwner: true } }, S = { view: "settings", signedIn: true };
  const answers = { profiles: { active: null }, lock: { locked: false },
    "channels/telegram-depth": { connections: [], live: {} } };
  const context = { E, S, document: { getElementById: () => ({ classList: { contains: () => false } }) },
    dialogRevision: () => revision.value, t: (key) => key, token: { get: () => "token" },
    onDemo17: (key, handler) => { handlers[key] = handler; },
    api: async (asked) => { if (asked === path) change({ revision, S }); return answers[asked]; } };
  context.sessionPrincipal = runInNewContext(`(${principals.match(/export const sessionPrincipal = (.*);/)[1]})`, context);
  runInNewContext(`${strip(fence)}
${strip(ui)}
globalThis.init = initTelegramDepth;`, context);
  context.init((...args) => shown.push(args));
  return { open: () => handlers.tgdepth.open(), shown };
}
const changes = { none: () => {}, "dialog dismissed or replaced": ({ revision }) => { revision.value++; },
  "Settings left": ({ S }) => { S.view = "chat"; } };
for (const path of ["profiles", "channels/telegram-depth", "lock"]) for (const [name, change] of Object.entries(changes)) {
  test(`Telegram depth readout with ${name} while ${path} is read`, async () => {
    const f = readout(path, change);
    await f.open();
    assert.equal(f.shown.length, name === "none" ? 1 : 0);
  });
}
