/**
 * mac7/wake-pins: settings the owner pinned.
 *
 * A pin is only worth having if every way of writing a setting meets it, so each way in is driven
 * here with a household profile switched on: the API the window uses, the settings screens that do
 * not go through the settings kit at all, a settings file, a whole-app preset, and a tool the model
 * calls. The owner is never refused. Nothing here opens a window or touches the machine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { settingsKitApi, SettingsKitError } from "../dist/settings-kit/api.js";
import { pinFor, pinnedIds, pins } from "../dist/settings-kit/pins.js";
import { changesFor, applyWithPins } from "../dist/settings-kit/changes.js";
import { settingsCatalogue } from "../dist/settings-kit/catalogue.js";
import { exportSettings } from "../dist/settings-kit/transfer.js";
import { saveVoiceSettings, voiceSettings } from "../dist/voice.js";
import { saveWakeWordSettings, wakeWordSettings } from "../dist/voice-wake.js";

/** A household profile with its PIN, switched on. Switching back is one call with no PIN. */
async function household(app) {
  const profile = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: profile.id, pin: "2468" });
  assert.equal(app.store.profiles.isOwner(), false);
  return profile;
}
const asOwner = (app) => { app.store.profiles.switch({ profileId: null }); };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-pinned-settings-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const deps = { store: app.store, owner: "local", workspace: join(root, "workspace"), appVersion: "test" };
  const ask = (method, path, body) => settingsKitApi(deps, method, path, async () => body);
  return { app, store: app.store, owner: "local", deps, ask };
}

/** Pins one field at whatever it is set to now, as the owner. */
const pin = (ask, key, field) => ask("POST", "/api/settings-kit/pins", { key, field, pinned: true });

test("P1 a pin fixes the setting at what it is now, and only the owner can make one", async (t) => {
  const { app, store, ask } = await fixture(t);
  saveWakeWordSettings(store, "local", { mode: "when-needed", word: "branch" });
  const { pins: made } = await pin(ask, "wake-word", "mode");
  assert.deepEqual(made.map(({ key, field, value }) => ({ key, field, value })),
    [{ key: "wake-word", field: "mode", value: "when-needed" }]);
  assert.equal(pinFor(store, "local", "wake-word", "mode").name, "A word that starts a turn");

  await household(app);
  await assert.rejects(() => ask("POST", "/api/settings-kit/pins", { key: "wake-word", field: "mode", pinned: false }),
    (error) => error instanceof SettingsKitError && error.status === 400);
  assert.equal(pins(store, "local").length, 1, "somebody else took the owner's pin off");
});

test("P2 a household person is refused through the settings screens that do not go through the kit", async (t) => {
  const { app, store } = await fixture(t);
  saveVoiceSettings(store, "local", { autoReadAloud: true });
  // The voice card writes the owner's own record with no profile check of its own (src/server.ts):
  // the pin is the only thing standing between a household person and this setting.
  const { pins: made } = await settingsKitApi({ store, owner: "local", workspace: "", appVersion: "t" },
    "POST", "/api/settings-kit/pins", async () => ({ key: "voice", field: "autoReadAloud", pinned: true }));
  assert.equal(made.length, 1);

  await household(app);
  assert.throws(() => saveVoiceSettings(store, "local", { autoReadAloud: false }), /owner pinned this setting/);
  assert.equal(voiceSettings(store, "local").autoReadAloud, true, "the pinned setting was changed anyway");
  // Everything else on the same record is still theirs to change; only the pinned field is fixed.
  saveVoiceSettings(store, "local", { speechRate: 1.5 });
  assert.equal(voiceSettings(store, "local").speechRate, 1.5);
  assert.equal(voiceSettings(store, "local").autoReadAloud, true);

  asOwner(app);
  saveVoiceSettings(store, "local", { autoReadAloud: false });
  assert.equal(voiceSettings(store, "local").autoReadAloud, false, "the owner could not change their own pinned setting");
});

test("P3 dropping the field, or flipping the older yes/no beside the switch, is refused too", async (t) => {
  const { app, store, ask } = await fixture(t);
  // "Your screen and keyboard" keeps an older yes/no beside its switch (keepsEnabled), so a write
  // that leaves `mode` out and sets `enabled` would mean "when needed" without ever naming it, and
  // a write that drops the field altogether would mean whatever it started as.
  store.save("settings", "local", "desktop-control", { mode: "on", enabled: true });
  await pin(ask, "desktop-control", "mode");
  assert.equal(pinFor(store, "local", "desktop-control", "mode").value, "on");

  await household(app);
  assert.throws(() => store.save("settings", "local", "desktop-control", { enabled: true }), /owner pinned this setting/);
  assert.throws(() => store.save("settings", "local", "desktop-control", {}), /owner pinned this setting/);
  assert.throws(() => store.save("settings", "local", "desktop-control", { mode: "off" }), /owner pinned this setting/);
  assert.equal(store.get("settings", "local", "desktop-control").data.mode, "on");
  // A write that leaves the pinned field exactly where the owner put it changes nothing about the
  // pin, so the rest of the record is still theirs.
  store.save("settings", "local", "desktop-control", { mode: "on", enabled: true, somethingElse: 1 });
  assert.equal(store.get("settings", "local", "desktop-control").data.somethingElse, 1);
});

test("P4 the list of pins is nobody else's to write, whatever they send", async (t) => {
  const { app, store, ask } = await fixture(t);
  await pin(ask, "wake-word", "mode");
  await household(app);
  assert.throws(() => store.save("settings", "local", "settings-pins", { pins: [] }), /owner's alone/);
  assert.equal(pinnedIds(store, "local").size, 1);
});

test("P5 a settings file and a whole-app preset step over a pinned setting and make all the rest", async (t) => {
  const { store, owner, ask } = await fixture(t);
  // Pinned somewhere other than where it starts, so putting everything back is a real change too.
  saveWakeWordSettings(store, owner, { mode: "when-needed" });
  await pin(ask, "wake-word", "mode");

  // A file that would turn the pinned switch up and change two other things as well.
  const file = exportSettings(store, owner, "test");
  file.settings["wake-word"].mode = "on";
  file.settings.voice.autoReadAloud = true;
  file.settings["local-models"].mode = "when-needed";
  const preview = await ask("POST", "/api/settings-kit/preview", { source: "import", file: JSON.stringify(file) });
  const pinnedChange = preview.changes.find((change) => change.id === "wake-word.mode");
  assert.equal(pinnedChange.pinned, true, "the preview did not mark the pinned setting");

  const answer = await ask("POST", "/api/settings-kit/apply", {
    plan: { source: "import", file: JSON.stringify(file) },
    accept: preview.changes.map((change) => change.id), confirmLoosening: true,
  });
  assert.deepEqual(answer.skipped.map((entry) => entry.id), ["wake-word.mode"]);
  assert.match(answer.skipped[0].why, /owner pinned this setting/);
  assert.equal(wakeWordSettings(store, owner).mode, "when-needed", "the file changed a pinned setting");
  assert.equal(voiceSettings(store, owner).autoReadAloud, true, "the rest of the file was thrown away with it");
  assert.ok(answer.applied.some((change) => change.id === "local-models.mode"));

  // A preset does the same, and so does putting everything back.
  await ask("POST", "/api/settings-kit/apply",
    { plan: { source: "preset", preset: "capable" }, accept: ["wake-word.mode"], confirmLoosening: true });
  assert.equal(wakeWordSettings(store, owner).mode, "when-needed");
  const back = await ask("POST", "/api/settings-kit/apply",
    { plan: { source: "reset" }, accept: ["wake-word.mode", "voice.autoReadAloud"], confirmLoosening: true });
  assert.deepEqual(back.skipped.map((entry) => entry.id), ["wake-word.mode"]);
});

test("P6 the owner still moves a pinned switch on purpose, one at a time", async (t) => {
  const { store, owner, ask } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "off" });
  await pin(ask, "wake-word", "mode");
  const answer = await ask("POST", "/api/settings-kit/apply", {
    plan: { source: "set", key: "wake-word", field: "mode", value: "on" },
    accept: ["wake-word.mode"], confirmLoosening: true,
  });
  assert.deepEqual(answer.skipped, []);
  assert.equal(wakeWordSettings(store, owner).mode, "on");
  const view = answer.overview.settings.find((spec) => spec.key === "wake-word");
  assert.equal(view.fields.find((field) => field.field === "mode").pinned, true, "the pin was lost by changing the value");
});

test("P7 a tool the model calls meets the same refusal, in the same words", async (t) => {
  const { app, store, ask } = await fixture(t);
  saveWakeWordSettings(store, "local", { mode: "off" });
  await pin(ask, "wake-word", "mode");
  await household(app);
  // Whatever a tool does in the end, it writes a settings record; that is where the pin sits, so a
  // tool nobody has written yet meets it too.
  let refusal = null;
  try { store.save("settings", "local", "wake-word", { mode: "on" }); }
  catch (error) { refusal = error.message; }
  assert.match(refusal ?? "", /The owner pinned this setting \(A word that starts a turn: Switch\)/);
  assert.match(refusal, /Only the owner can unpin it/);
  assert.equal(wakeWordSettings(store, "local").mode, "off");
});

test("P8 nothing is pinned on a fresh install, and pinning is refused for a setting that does not exist", async (t) => {
  const { store, ask } = await fixture(t);
  assert.deepEqual(pins(store, "local"), []);
  const { changes } = changesFor(store, "local", [{ key: "voice", field: "autoReadAloud", value: true }]);
  assert.equal(changes[0].pinned, false);
  assert.deepEqual(applyWithPins(store, "local", changes, { accept: [changes[0].id], confirmLoosening: true, why: "test" }).skipped, []);
  await assert.rejects(() => ask("POST", "/api/settings-kit/pins", { key: "made-up", field: "mode", pinned: true }),
    (error) => error instanceof SettingsKitError && error.status === 404);
});

/* ---------- over HTTP, which is what a person actually meets ---------- */

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-pinned-http-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${server.token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, call };
}

test("P9 over HTTP: somebody else is refused, and a pin that is reached answers the owner's 403", async (t) => {
  const { app, call } = await served(t);
  assert.equal((await call("POST", "/api/settings-kit/pins", { key: "voice", field: "autoReadAloud", pinned: true })).status, 200);
  await household(app);
  // Integration review: every settings screen over HTTP is the owner's outright (these routes are
  // "owner POST" in tests/short-lived-key-routes.mjs), so that is what somebody else meets first —
  // including the one that names the speech program the wake word would run.
  const refused = await call("POST", "/api/voice/settings", { autoReadAloud: true });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /belongs to the owner/);
  assert.equal(voiceSettings(app.store, "local").autoReadAloud, false);

  // The pin sits behind that, for the ways in that are not an owner-only route: the terminal, a
  // settings file, a tool the model calls. Whichever of them reaches it, the refusal is the same
  // sentence and carries the owner's 403, which src/server.ts answers with (see the widget catch).
  let stopped = null;
  try { app.store.save("settings", "local", "voice", { autoReadAloud: true }); }
  catch (error) { stopped = error; }
  assert.ok(stopped, "a pinned setting was written by somebody who is not the owner");
  assert.equal(stopped.status, 403, "a pinned setting is not refused the way the owner's own things are");
  assert.match(stopped.message, /The owner pinned this setting \(Voice: Read replies aloud automatically\)/);
  assert.match(stopped.message, /Only the owner can unpin it/);
  assert.equal(voiceSettings(app.store, "local").autoReadAloud, false);
});

test("P10 over HTTP: a household person sees the pinned setting and that it is pinned, and nothing more", async (t) => {
  const { app, call } = await served(t);
  saveWakeWordSettings(app.store, "local", { mode: "when-needed" });
  await call("POST", "/api/settings-kit/pins", { key: "wake-word", field: "mode", pinned: true });
  await household(app);

  // Q261: reading fails closed for a household person at the window, and the window never reads the pins list, so
  // it is refused in the one sentence (the owner's pinned values stay the owner's).
  const seen = await call("GET", "/api/pins");
  assert.equal(seen.status, 400);
  assert.doesNotMatch(JSON.stringify(seen.body), /when-needed/);
  // The settings list itself stays the owner's, which is how the card knows to stay read-only. It is
  // answered 400, as every other "belongs to the owner" refusal is (household-followups).
  assert.equal((await call("GET", "/api/settings-kit")).status, 400);
  // profile-audit: a change is refused at one place in src/server.ts, as requireOwner answers.
  assert.equal((await call("POST", "/api/settings-kit/pins", { key: "wake-word", field: "mode", pinned: false })).status, 400);
  assert.equal((await call("POST", "/api/voice/wake", { mode: "on" })).status, 400, "the word is the owner's");
  assert.equal(pins(app.store, "local").length, 1);
});

/* ---------- integration review (adversarial): the ways round a pin ---------- */

test("P11 a pinned setting cannot be wiped by deleting the record instead of saving it", async (t) => {
  const { app, store, ask } = await fixture(t);
  saveWakeWordSettings(store, "local", { mode: "when-needed", word: "branch" });
  await pin(ask, "wake-word", "mode");
  await household(app);
  // Deleting the record puts the field back to what it means when it is missing, which is exactly
  // the change the pin exists to refuse. The way out must be shut as firmly as the way in.
  assert.throws(() => store.delete("settings", "local", "wake-word"), /The owner pinned this setting/);
  assert.equal(wakeWordSettings(store, "local").mode, "when-needed", "a pinned setting was wiped by a delete");
  asOwner(app);
  assert.equal(store.delete("settings", "local", "wake-word"), true, "the owner may still delete their own record");
});

test("P12 the list of pins itself cannot be deleted by anybody else", async (t) => {
  const { app, store, ask } = await fixture(t);
  saveWakeWordSettings(store, "local", { mode: "when-needed" });
  await pin(ask, "wake-word", "mode");
  await household(app);
  assert.throws(() => store.delete("settings", "local", "settings-pins"), /Pinning a setting is the owner's alone/);
  assert.equal(pins(store, "local").length, 1, "every pin was taken off at once by one delete");
});

test("P13 an owner's settings write never even reads the list of pins", async (t) => {
  const { store } = await fixture(t);
  const real = store.get.bind(store);
  const read = [];
  store.get = (table, owner, id) => { read.push(id); return real(table, owner, id); };
  try { store.save("settings", "local", "preferences", { theme: "dark" }); } finally { store.get = real; }
  assert.deepEqual(read, ["preferences"], "the owner's own saves now pay for a pin lookup they can never be refused by");
});

test("P14 no setting the owner can pin is written straight to the database behind Store.save", async () => {
  // The pin is only as good as the one door it sits in: Store.save and Store.delete. A settings
  // record written with its own SQL walks past both, so every such statement in the tree is found
  // here and has to name an id that cannot be pinned. A statement whose id is a bound parameter or
  // a LIKE pattern cannot be read from the source at all, so each one is listed below with the
  // reason it is safe; a new one fails this test until somebody has looked at it.
  const { readdir, readFile } = await import("node:fs/promises");
  const keys = new Set(settingsCatalogue.map((spec) => spec.key));
  /** Statements whose id this test cannot read, each checked by hand: none can be a catalogue key. */
  const lookedAt = new Map([
    // src/memory-review.ts: `memory-snapshot:${sessionId}`, a per-conversation note, never a setting.
    ["memory-review.ts:INSERT INTO settings VALUES(?,?,?,?,?)", "memory-snapshot:<session>"],
    // src/never-break/resume.ts: tidies held channel replays, whose ids all begin "channel-replay:".
    ["never-break/resume.ts:DELETE FROM settings WHERE owner=? AND id LIKE 'channel-replay:%'", "channel-replay:<id>"],
    // src/backup.ts: a replacing restore puts the backup's whole settings table in place of this one, as its
    // `DELETE FROM ${table}` always did; only what stays on this computer (staysOnThisComputer: the sign-ins and
    // Q168 A's list) stays. The owner chose that restore.
    ["backup.ts:DELETE FROM settings WHERE id NOT IN (", "every setting but what stays on this computer, on a replacing restore"],
  ]);
  // readdir names a nested file the way the system does, so on Windows it arrives as
  // never-break\resume.ts and matched none of the entries above, which are written with slashes.
  const names = (await readdir("src", { recursive: true })).filter((name) => name.endsWith(".ts"))
    .map((name) => name.split(sep).join("/"));
  const problems = [];
  for (const name of names) {
    if (name === "store.ts") continue; // the door itself
    const text = await readFile(join("src", name), "utf8");
    for (const [statement] of text.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM) settings[^"`]*/g)) {
      const literal = /'([a-z0-9:-]+)'/.exec(statement);
      if (literal && !literal[1].endsWith(":")) {
        if (keys.has(literal[1])) problems.push(`${name}: writes the pinnable setting "${literal[1]}" with its own SQL`);
        continue;
      }
      const known = [...lookedAt.keys()].some((entry) => `${name}:${statement}`.startsWith(entry));
      if (!known) problems.push(`${name}: writes a settings record with its own SQL under an id this test cannot read `
        + `(${statement.trim().slice(0, 80)}). Write it through Store.save, or add it to lookedAt with the reason it can never be a setting the owner can pin.`);
    }
  }
  assert.deepEqual(problems, []);
});
