import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(new URL("../public/app/shell/liveupdate.js", import.meta.url), "utf8");
const keep = source.slice(source.indexOf("function openNow("), source.indexOf("const frames ="));
/* The module's own layout and scroll helpers, and stand-ins for what it imports (who is signed in, Settings pages, pane tabs). */
const helpers = source.slice(source.indexOf("const VIEWS ="), source.indexOf("/* Listens for live updates"));
const stubs = (principal = "owner") => ({ E: { profiles: null }, sessionPrincipal: () => principal, hasPage: () => true, extraTabs: [] });
function capture({ chat = null, pending = true, storageError = false } = {}) {
  let saved;
  const context = vm.createContext({ ...stubs(), S: { chat, view: "chat", tabs: {}, drafts: {} }, sendingWithoutSession: () => pending,
    $: () => null, KEY: "restore", document: { querySelectorAll: () => [], activeElement: null }, sessionStorage: { setItem: (_, value) => { if (storageError) throw new Error("QuotaExceededError"); saved = JSON.parse(value); } } });
  vm.runInContext(helpers + keep, context);
  return { keep: () => vm.runInContext(`keepOpen("${"a".repeat(40)}")`, context), saved: () => saved };
}
test("a first submission without its session cannot guess an older conversation with identical words", async () => {
  const c = capture(); await assert.rejects(c.keep(), /conversation to be confirmed/); assert.equal(c.saved(), undefined);
  assert.ok(!keep.includes("api("), "no run list or prompt matching can resolve the submission");
});
test("snapshot storage failure refuses reload instead of losing the draft", async () => {
  const c = capture({ chat: "actual-session", pending: false, storageError: true });
  await assert.rejects(c.keep(), /could not keep your draft/); assert.equal(c.saved(), undefined);
});
test("a confirmed session stores the exact commit for its painted acknowledgment", async () => {
  const c = capture({ chat: "actual-session", pending: false }); await c.keep();
  assert.equal(c.saved().chat, "actual-session"); assert.equal(c.saved().commit, "a".repeat(40));
});
const chatSource = await readFile(new URL("../public/app/chat/chat.js", import.meta.url), "utf8");
const adopt = chatSource.slice(chatSource.indexOf("function adoptDraft("), chatSource.indexOf("async function sendPlain("));
test("the first confirmed conversation adopts the pending draft and caret before redraw", () => {
  const state = { chat: null, drafts: { new: "typed while the reply works" } }, caret = [];
  let box = { selectionStart: 2, selectionEnd: 7 };
  const context = vm.createContext({ C: { sessionId: null }, S: state, $: () => box });
  vm.runInContext(adopt, context);
  const restore = vm.runInContext("adoptDraft(\"actual-session\")", context);
  assert.equal(state.drafts["actual-session"], "typed while the reply works"); assert.equal(state.drafts.new, undefined);
  state.chat = "actual-session"; box = { setSelectionRange: (...range) => caret.push(...range) }; restore();
  assert.deepEqual(caret, [2, 7]);
});
const KEPT = "0b6f6c6e-1d3a-4c55-9a51-6f2f5d8e9a10";
const restore = source.slice(source.indexOf("export async function restoreOpen(")).replace("export async", "async");
test("a late refused page acknowledgment retains the snapshot for the old-page recovery", async () => {
  let removed = false;
  const kept = { at: Date.now(), commit: "a".repeat(40), view: "chat", drafts: { new: "the draft" } };
  const context = vm.createContext({ ...stubs(), KEY: "restore", frames: async () => {}, bridge: () => ({ windowRestored: async () => false }),
    location: { href: "http://localhost:45001/" }, URL, S: { chat: null, tabs: {}, drafts: {} }, renderNow: () => {}, $: () => null,
    sessionStorage: { getItem: () => JSON.stringify(kept), removeItem: () => { removed = true; } } });
  vm.runInContext(helpers + restore, context);
  await assert.rejects(vm.runInContext("restoreOpen(async () => {})", context), /not accepted/);
  assert.equal(removed, false, "the old-page recovery still has its draft and caret snapshot");
});
test("active recovery restores a retained snapshot older than a minute before accepting its navigation acknowledgment", async () => {
  const state = { chat: null, tabs: {}, drafts: {} }, caret = []; let acknowledged, removed = false;
  const kept = { at: Date.now() - 61_000, commit: "a".repeat(40), view: "chat", chat: KEPT, drafts: { [KEPT]: "slow rollback draft" },
    caret: { start: 2, end: 7, focused: false }, scroll: { top: 12, atEnd: false } };
  const box = { value: "", setSelectionRange: (...range) => caret.push(...range) }, scroll = { scrollTop: 0 };
  const context = vm.createContext({ ...stubs(), KEY: "restore", frames: async () => {}, bridge: () => ({ windowRestored: async (nonce) => { acknowledged = nonce; return true; } }),
    location: { href: "http://localhost:45001/?_branch_live_restore=current-recovery" }, URL, history: { replaceState: () => {} }, S: state,
    renderNow: () => {}, $: (selector) => selector === "#prompt" ? box : scroll,
    sessionStorage: { getItem: () => JSON.stringify(kept), removeItem: () => { removed = true; } } });
  vm.runInContext(helpers + restore, context);
  assert.equal(await vm.runInContext("restoreOpen(async (id) => { S.chat = id; })", context), true);
  assert.equal(state.chat, KEPT); assert.equal(box.value, "slow rollback draft"); assert.deepEqual(caret, [2, 7]);
  assert.equal(scroll.scrollTop, 12); assert.equal(acknowledged, "current-recovery"); assert.equal(removed, true);
});

const framesSource = source.slice(source.indexOf("const frames ="), source.indexOf("export async function restoreOpen("));
test("a page started in the tray, never painted, finishes its first load and tells the app without waiting for a frame", async () => {
  // requestAnimationFrame never fires in an unpainted page (main.ts paintWhenInitiallyHidden: false for a tray start).
  let told = null, asked = 0;
  const context = vm.createContext({ ...stubs(), KEY: "restore", document: { visibilityState: "hidden" }, requestAnimationFrame: () => { asked++; },
    bridge: () => ({ windowRestored: async (nonce) => { told = nonce ?? "ordinary start"; return true; } }),
    location: { href: "http://localhost:45001/?desktop=1" }, URL, S: { chat: null, tabs: {}, drafts: {} }, renderNow: () => {}, $: () => null,
    sessionStorage: { getItem: () => null, removeItem: () => {} } });
  vm.runInContext(helpers + framesSource + restore, context);
  const done = await Promise.race([vm.runInContext("restoreOpen(async () => {})", context), new Promise((resolve) => setTimeout(() => resolve("stalled"), 1000))]);
  assert.equal(done, false, "the first load ended instead of waiting for the window to be shown");
  assert.equal(told, "ordinary start");
  assert.equal(asked, 0, "no frame was waited for");
  // Shown (painted), it still waits for two frames before telling the app.
  context.document.visibilityState = "visible";
  let frames = 0; context.requestAnimationFrame = (next) => { frames++; setImmediate(next); };
  await vm.runInContext("restoreOpen(async () => {})", context);
  assert.equal(frames, 2);
});
test("PLAT-045: a shell handover brings back the place, pane and layout, and never another person's workspace", async () => {
  const run = async (principal, kept) => {
    const state = { chat: null, view: "chat", tabs: { inbox: "needs" }, drafts: {} }; let removed = false;
    const context = vm.createContext({ ...stubs(principal), KEY: "restore", frames: async () => {}, bridge: () => ({ windowRestored: async () => true }),
      location: { href: "http://localhost:45001/?_branch_live_restore=handover" }, URL, history: { replaceState: () => {} }, S: state,
      renderNow: () => {}, $: () => null, document: { getElementById: () => null, querySelectorAll: () => [] },
      sessionStorage: { getItem: () => JSON.stringify(kept), removeItem: () => { removed = true; } } });
    vm.runInContext(helpers + restore, context);
    const result = await vm.runInContext("restoreOpen(async (id) => { S.chat = id; S.view = 'chat'; })", context);
    return { result, state, removed };
  };
  const kept = { at: Date.now(), commit: "a".repeat(40), principal: "owner", view: "inbox", chat: KEPT, tabs: { inbox: "history" },
    drafts: { [KEPT]: "half a thought" }, layout: { pane: "files", sideW: 300, rail: true, home19: { open: true, sid: KEPT } } };
  const mine = await run("owner", kept);
  assert.equal(mine.state.chat, KEPT);
  assert.equal(mine.state.view, "inbox", "the place the owner was in comes back after the conversation is read");
  assert.equal(mine.state.tabs.inbox, "history");
  assert.equal(mine.state.pane, "files"); assert.equal(mine.state.sideW, 300); assert.equal(mine.state.rail, true);
  assert.deepEqual({ ...mine.state.home19 }, { open: true, sid: KEPT });
  const other = await run("someone-else", kept);
  assert.equal(other.result, false);
  assert.equal(other.state.chat, null, "another person's conversation is not opened");
  assert.deepEqual({ ...other.state.drafts }, {}, "nor their draft");
  assert.equal(other.removed, true, "their snapshot is dropped");
});
