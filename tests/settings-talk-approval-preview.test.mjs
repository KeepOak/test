/**
 * Q50: when a settings change is put to the owner, the question itself carries the exact before and
 * after ("What Branch learns from experience, Switch: off → on"), not only the name and the value asked
 * for. It is worked out only for the owner in a conversation they started: a caller the settings tools
 * refuse never gets Branch to read the owner's settings into a question. The call's target, which the
 * owner's rules and kept answers match against, stays exactly what the call asked for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";
import { savePins } from "../dist/settings-kit/pins.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-preview-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  // The learning core ships when needed (the ship-on rule); these tests move it from off, so the owner switches it off first.
  app.learningCore.configure({ mode: "off" });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

const learning = { changes: [{ setting: "fly-core.mode", value: "on" }] };
const before = /What Branch learns from experience, Switch: off → on/;

test("the question for a settings change shows the exact before and after, in a conversation", async (t) => {
  let calls = 0;
  const provider = {
    name: "scripted",
    async complete() {
      return calls++ === 0
        ? { content: "", toolCalls: [{ id: "change-call", name: "settings.change", arguments: JSON.stringify(learning) }] }
        : { content: "Done.", toolCalls: [] };
    },
  };
  const app = await fixture(t, provider);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const paused = await app.runtime.run({ prompt: "turn on the learning" });
  const asked = app.runtime.approvals.questionFor(paused.sessionId);
  assert.ok(asked, `the change is put to the owner: ${paused.status} ${paused.output}`);
  assert.match(asked.label, before, "the owner sees what it is now and what it would become");
  assert.equal(asked.target, "fly-core.mode → on", "the target rules match against is unchanged");
});

test("the before and after is worked out for the owner only, and says when nothing would change", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.context({ source: "owner" });
  const mine = app.runtime.checkPolicy("settings.change", learning, owner);
  assert.match(mine.label, before);
  assert.equal(mine.target, "fly-core.mode → on");

  for (const source of ["schedule", "trigger", "api"]) {
    const other = app.runtime.checkPolicy("settings.change", learning, app.runtime.context({ source }));
    assert.doesNotMatch(other.label, /→|off/, `a ${source} never gets the owner's settings read into the question`);
  }
  const loosen = app.runtime.checkPolicy("settings.loosen", { changes: [{ setting: "desktop-control.mode", value: "on" }] }, owner);
  assert.match(loosen.label, /Your screen and keyboard, Switch: off → on/, "a loosening change shows it too");
  assert.match(loosen.label, /less careful, so it is asked about every time/, "and keeps its own reason");

  const already = app.runtime.checkPolicy("settings.change", { changes: [{ setting: "fly-core.mode", value: "off" }] }, owner);
  assert.match(already.label, /every setting is already as asked/);
  assert.doesNotMatch(already.label, /off → off/, "a no-op is never shown as a change");
  assert.doesNotMatch(app.runtime.checkPolicy("settings.list", {}, owner).label, /→/, "reading changes nothing and shows no plan");
});

test("a pinned setting is shown staying as it is, since saving the change steps over it", async (t) => {
  const app = await fixture(t);
  savePins(app.store, app.runtime.owner, [
    { key: "fly-core", field: "mode", value: "off", initial: "off", name: "The learning core", label: "Switch" },
  ]);
  const check = app.runtime.checkPolicy("settings.change", learning, app.runtime.context({ source: "owner" }));
  assert.doesNotMatch(check.label, /off → on/, "the owner is never asked about a change that will not happen");
  assert.match(check.label, /What Branch learns from experience, Switch: stays off \(pinned\)/);
});
