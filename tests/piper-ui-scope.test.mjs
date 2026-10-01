import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
const read = name => readFile(new URL(`../public/app/${name}`, import.meta.url), "utf8");
const strip = source => source.replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
const source = await read("settings/piper.js"), fence = await read("core/view-fence.js"), principals = await read("core/session-pages.js");
const principal = principals.match(/export const sessionPrincipal = (.*);/)[1];
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture() {
  const pending = deferred(), entered = deferred(), actions = {}, saved = [], toasts = [], posts = [];
  const E = { profiles: { active: null, isOwner: true } }, S = { view: "settings", setPage: "voice", signedIn: true };
  const nodes = Object.fromEntries(["piper-card", "piper-status", "piper-files", "piper-directory", "piper-rate", "piper-model", "piper-executable", "piper-enabled"].map(id => [id, { isConnected: true, value: id === "piper-rate" ? "1" : "/voices", textContent: "", innerHTML: "" }]));
  const el = { disabled: false, isConnected: true }, app = { locked: false, classList: { contains: () => app.locked } }, revision = { value: 0 };
  const settings = { ttsRoute: "system", speechRate: 1 };
  const context = { E, S, document: { getElementById: id => id === "app" ? app : nodes[id] }, dialogRevision: () => revision.value,
    on: (name, fn) => { actions[name] = fn; }, markLive() {}, esc: value => String(value ?? ""), t: key => key,
    toast: message => toasts.push(message), api: async (path, body) => { posts.push({ path, body }); entered.resolve(); return pending.promise; } };
  context.sessionPrincipal = runInNewContext(`(${principal})`, context);
  runInNewContext(strip(fence) + "\n" + strip(source) + "\nglobalThis.piper = { piperCard, initPiper, listFiles };", context);
  context.piper.piperCard(settings); context.piper.initPiper(() => settings, result => saved.push(result));
  return { E, S, nodes, el, app, revision, context, actions, saved, toasts, posts, pending, entered, settings,
    list: () => context.piper.listFiles(), save: () => actions["piper-save"](el) };
}
const changes = {
  current: () => {}, profile: f => { f.E.profiles = { active: { id: "sam" }, isOwner: false }; },
  lock: f => { f.app.locked = true; }, page: f => { f.S.setPage = "general"; },
  navigation: f => { f.S.view = "chat"; }, dialog: f => { f.revision.value++; },
  card: f => { f.nodes["piper-card"] = { isConnected: true }; },
  generation: f => { f.context.piper.piperCard(f.settings); },
};
for (const operation of ["list", "save"]) for (const failure of [false, true]) for (const [name, change] of Object.entries(changes)) {
  test(`Piper ${operation} ${failure ? "failure" : "success"} with ${name} scope`, async () => {
    const f = fixture(), pending = f[operation](); await f.entered.promise; change(f);
    if (failure) f.pending.reject(new Error("Request failed"));
    else f.pending.resolve(operation === "list" ? { parent: "/", entries: [{ path: "/voice.onnx", name: "voice.onnx", directory: false }] } : { speechRate: 1.2 });
    await pending;
    const current = name === "current";
    assert.equal(f.posts.length, 1);
    assert.equal(f.saved.length, operation === "save" && !failure && current ? 1 : 0);
    assert.deepEqual(f.toasts, operation === "save" && failure && current ? ["Request failed"] : []);
    assert.equal(f.nodes["piper-files"].textContent, operation === "list" && failure && current ? "Request failed" : "");
    assert.equal(f.nodes["piper-files"].innerHTML.includes("voice.onnx"), operation === "list" && !failure && current);
    assert.equal(f.nodes["piper-status"].textContent, operation === "save" && current ? failure ? "Request failed" : "window.settings.piper.applied" : "");
    if (operation === "save") assert.equal(f.el.disabled, !current, "stale completion does not change a current card's button");
  });
}
test("Piper card keeps the Voice page's section and immediate-choice contract", () => {
  const f = fixture(), html = f.context.piper.piperCard(f.settings);
  assert.doesNotMatch(html, /<h[1-6]/);
  assert.match(html, /data-act="piper-save">window.settings.piper.apply/);
});
