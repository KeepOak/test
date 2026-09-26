/**
 * Dogfood F1 review: with "update by itself" on, a release whose install failed (a Dev change that would not build,
 * a Beta whose check failed) is not tried again by itself every few minutes. The next release is, as soon as it
 * lands; the owner is told once; the Update button, which does not ask the plan, can always try it again.
 * Through the window's own route. Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, releaseChannel) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-failed-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  app.store.save("settings", app.runtime.owner, "comfort-notify", { autoUpdate: "install", releaseChannel });
  const plan = async (body) => {
    const response = await fetch(new URL("/api/comfort/update-plan", server.url), { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return { plan };
}

for (const channel of ["dev", "beta"]) {
  test(`${channel}: a release whose install failed is not tried again by itself, and the owner is told once`, async (t) => {
    const { plan } = await fixture(t, channel);
    const first = channel === "dev" ? "dev-1111111" : "v0.19.5-beta.1", next = channel === "dev" ? "dev-2222222" : "v0.19.5-beta.2";
    assert.equal((await plan({ updaterPhase: "available", updaterTag: first })).step, "install", "control: it is installed by itself");
    // Its install failed: the window says so with the updater's next status.
    const failed = await plan({ updaterPhase: "error", updaterTag: first, failedTag: first });
    assert.match(failed.failed ?? "", /will not try it again by itself/);
    assert.equal((await plan({ updaterPhase: "error", updaterTag: first, failedTag: first })).failed, undefined, "said once");
    // Five minutes on, the same release is found again: it is not installed again by itself.
    const again = await plan({ updaterPhase: "available", updaterTag: first, checked: true });
    assert.equal(again.step, "nothing");
    assert.match(again.reason, /not tried again by itself/);
    // A newer one lands: that is installed.
    assert.equal((await plan({ updaterPhase: "available", updaterTag: next })).step, "install");
  });
}

/* NAS a870cea: the window's side, through the real public/app/shell/autoupdate.js and the real route (only the desktop bridge and the
   timers are stand-ins). After one release fails, update by itself still looks again when a look is due, and the
   next release is installed as soon as a look finds it. */
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { allComfort, noteUpdateCheck } from "../dist/index.js";

/** Set by the test once the page is loaded: resolves when its update look (public/app/shell/autoupdate.js `updateAttempt`) is done. */
let settled = async () => undefined;
function clock() {
  let now = Date.parse("2026-09-24T12:00:00Z"), nextId = 0;
  const timers = new Map();
  const add = (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; };
  return {
    setTimeout: add, clear: (id) => timers.delete(id), Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        // The route is real: wait until the page's look has finished before looking at the timers (NAS 1f61d43).
        await settled();
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}

test("after one release fails, update by itself still looks when a look is due, and installs the next one (NAS a870cea)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-update-window-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  app.store.save("settings", app.runtime.owner, "comfort-notify", { autoUpdate: "install", releaseChannel: "dev" });
  const time = clock();
  let head = "dev-1111111", status = { phase: "available", release: { tag: head } };
  const installs = [], checks = [];
  const desktop = {
    updateStatus: async () => status,
    checkForUpdates: async () => { checks.push(head); status = { phase: "available", release: { tag: head } }; return status; },
    // Every install of the first change fails; the updater then says so with its next status.
    // A good install hands over and restarts (the status says so until then).
    installUpdate: async () => {
      const tag = status.release.tag;
      installs.push(tag);
      status = tag === "dev-1111111" ? { phase: "error", outcome: "failed", release: { tag } } : { phase: "ready", release: { tag } };
      return status;
    },
  };
  // Redesign: the new window's scheduler is public/app/shell/autoupdate.js; its imports (the engine helper, the toast,
  // the words, the window state) are stood in for, and its engine helper goes through the real route.
  const renderer = (await readFile(new URL("../public/app/shell/autoupdate.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  const toasts = [];
  const api = async (path, body) => {
    const response = await fetch(new URL(`/api/${path}`, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error ?? String(response.status));
    return answer;
  };
  const context = createContext({
    window: { branchDesktop: desktop }, Date: time.Date,
    setTimeout: time.setTimeout, clearTimeout: time.clear, setInterval: () => 0, clearInterval: () => undefined,
    console: { warn: () => undefined }, api, toast: (words) => toasts.push(words), t: (key) => key,
    E: { state: null }, onRender: () => undefined,
  });
  runInContext(renderer, context);
  settled = async () => {
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (runInContext("updateAttempt", context) === false) return;
    }
  };
  context.testValues = allComfort(app.store, app.runtime.owner);
  runInContext("applyComfort(testValues);", context);
  await time.advance(60_000);
  assert.deepEqual(installs, ["dev-1111111"], "control: the first change is installed by itself, and fails");
  await time.advance(10 * 60_000);
  assert.deepEqual(installs, ["dev-1111111"], "the failed change is not tried again by itself");
  head = "dev-2222222";
  // The engine judges "due" by its own clock: ten minutes have passed since it last looked.
  noteUpdateCheck(app.store, app.runtime.owner, new Date(Date.now() - 10 * 60_000));
  await time.advance(10 * 60_000);
  assert.ok(checks.includes("dev-2222222"), `update by itself looked again (checks: ${checks.join(", ")})`);
  assert.deepEqual(installs, ["dev-1111111", "dev-2222222"], "and installed the next change");
  assert.equal(toasts.filter((words) => /will not try it again by itself/.test(words)).length, 1, "the owner is told once");
});
