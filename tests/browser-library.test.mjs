/* SCREEN-025 (bookmarks, history) and SCREEN-163 (history read only when switched on, bounded by dates): the Branch
   browser's saved pages per Trunk or conversation. Addresses lose their query and fragment, history is off until the
   owner turns it on, and a read can be bounded to 1-30 UTC days. An in-memory store; no browser runs. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { BrowserHistoryRangeSchema, browserHistoryBetween, changeBrowserLibrary, readBrowserLibrary, saveBrowserPage } from "../dist/integrations/browser-library.js";

const scope = "conversation:c1";
async function storeOf(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-browser-library-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app.store;
}
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

test("SCREEN-025: a bookmark keeps the page without its query or fragment, and history stays off until chosen", async (t) => {
  const store = await storeOf(t);
  const saved = saveBrowserPage(store, "local", scope, { url: "https://example.com/a/b?token=abc#part", title: "Example" }, true);
  assert.deepEqual(saved.bookmarks.map((one) => one.url), ["https://example.com/a/b"]);
  saveBrowserPage(store, "local", scope, { url: "https://example.com/seen", title: "Seen" }, false);
  assert.deepEqual(readBrowserLibrary(store, "local", scope).history, [], "nothing is kept while history is off");
  assert.throws(() => saveBrowserPage(store, "local", scope, { url: "https://user:pw@example.com/", title: "x" }, true), /cannot be saved safely/);
  assert.deepEqual(readBrowserLibrary(store, "local", "conversation:other").bookmarks, [], "each conversation has its own");
});

test("SCREEN-163: history is kept only when switched on, is read within dates, and switching it off erases it", async (t) => {
  const store = await storeOf(t);
  changeBrowserLibrary(store, "local", scope, "history", true);
  saveBrowserPage(store, "local", scope, { url: "https://example.com/one", title: "One" }, false);
  saveBrowserPage(store, "local", scope, { url: "https://example.com/one", title: "One" }, false);
  saveBrowserPage(store, "local", scope, { url: "https://example.com/two", title: "Two" }, false);
  const library = readBrowserLibrary(store, "local", scope);
  assert.deepEqual(library.history.map((one) => one.url), ["https://example.com/two", "https://example.com/one"]);
  assert.equal(browserHistoryBetween(library, { from: day(-1), to: day(0) }).history.length, 2);
  assert.equal(browserHistoryBetween(library, { from: day(-10), to: day(-5) }).history.length, 0);
  for (const bad of [{ from: day(-40), to: day(0) }, { from: day(0), to: day(-1) }, { from: day(0), to: day(1) }, { from: "2026-02-30", to: "2026-03-01" }])
    assert.equal(BrowserHistoryRangeSchema.safeParse(bad).success, false, JSON.stringify(bad));
  changeBrowserLibrary(store, "local", scope, "history", false);
  const off = readBrowserLibrary(store, "local", scope);
  assert.deepEqual([off.historyEnabled, off.history], [false, []]);
});
