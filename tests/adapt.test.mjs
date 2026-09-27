/**
 * mac7/adapt: getting what a stopped task is missing.
 *
 * Every blocker is read from a sentence Branch really says (each one is copied here from the file
 * that says it, named in a comment), so these tests fail the moment that wording drifts apart from
 * what `/adapt` can place. Nothing here touches the network, a package manager or this computer:
 * the one button is a stand-in that counts what it was asked to do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readBlocker } from "../dist/adapt/blockers.js";
import { fixFor, fixFingerprint } from "../dist/adapt/fixes.js";
import { Adapt } from "../dist/adapt/service.js";
import { adaptGuard, adaptOffRefusal, adaptLockdownRefusal, adaptMode, saveAdaptSettings } from "../dist/adapt/settings.js";
import {
  installChatRefusal, installPersonRefusal, installShortLivedRefusal, installStartedElsewhereRefusal, installTrunkRefusal,
} from "../dist/local-one-button.js";
import { continuationFor } from "../dist/adapt/host.js";
import { installPlan } from "../dist/local-install.js";
import { COMMANDS, lookup, parseLine } from "../dist/commands/catalog.js";
import { HANDLERS } from "../dist/commands/handlers.js";
import { offLimitsToShortLivedKeys } from "../dist/server.js";
import { ROUTES } from "./short-lived-key-routes.mjs";

/* ---------------------------------------------------------------- a store that is only a map */

function fakeStore(rows = {}) {
  const data = new Map(Object.entries(rows));
  return {
    get: (table, owner, key) => data.has(`${table}:${key}`)
      ? { id: key, owner, data: data.get(`${table}:${key}`), createdAt: "", updatedAt: "" } : undefined,
    save: (table, owner, key, value) => { data.set(`${table}:${key}`, value); return value; },
    events: () => [],
  };
}
const OWNER = "owner";
const on = (store, mode = "when-needed") => { store.save("settings", OWNER, "adapt", { mode }); return store; };

const mac = { platform: "darwin", arch: "arm64", home: "/Users/someone", env: {} };
const plan = () => installPlan("ollama", mac, { homebrew: null, winget: null }, "/data");

/** A one button that installs nothing: it only counts what it was asked for. */
function fakeButton(install = plan()) {
  const asked = { plans: 0, presses: [] };
  return {
    asked,
    plan: async () => { asked.plans += 1; return { install, alreadyInstalled: install === null }; },
    press: async (input) => { asked.presses.push(input); return { message: "Ollama was installed." }; },
  };
}

/* ---------------------------------------------------------------- 1. each kind is placed */

test("A1 each kind of blocker is read from the sentence Branch already says for it", () => {
  const cases = [
    // src/local-launch.ts
    ["Ollama is not installed on this computer. Free. Install it from ollama.com, then come back here.", "runner", "Ollama"],
    // src/local-oneclick.ts
    ["No program that runs models is installed yet. Install one from its official page, then try again.", "runner", "Ollama"],
    // src/voice-tts.ts
    ["Reading aloud through your provider needs a connection that offers it. Add one under Settings → Models.", "model", "speech"],
    // src/voice-stt.ts
    ["Writing out speech needs a connection that offers it. Add one under Settings → Models.", "model", "transcription"],
    // src/embeddings.ts
    ["A Gemini key is required to compare passages by meaning", "key", "Gemini"],
    // src/integrations/git-run.ts
    ["Git is not installed on this computer. Install Git, then ask me again.", "program", "Git"],
    // src/integrations/browser-container.ts
    ["Docker is not installed on this computer.", "program", "Docker"],
    // src/checkpoints.ts
    ["Snapshots need Git, which is not installed on this computer.", "program", "Git"],
    // src/voice-stt.ts — the one that already says Branch never downloads one
    ["No speech program is set up on this computer. Point Branch at whisper.cpp or faster-whisper under Settings → Voice; Branch never downloads one for you.", "program", "speech program"],
    // src/provider-factory.ts
    ["OpenAI needs a key before it can be used", "key", "OpenAI"],
    // src/local-jobs.ts
    ["Models on this computer are switched off. Turn them on at the top of this card first.", "switch", "Models on this computer"],
    // src/integrations/desktop-script-posix.ts
    ["Your Mac is not letting Branch take pictures of the screen. Open System Settings, Privacy & Security, Screen & System Audio Recording, and turn Branch Agent on.", "permission", "permission for Screen & System Audio Recording"],
    // src/local-files.ts
    ["Not enough disk space: this needs about 4 GB more and 1 GB is free (Branch keeps 2 GB spare). Free some space and try again.", "disk", "room on this disk"],
    // src/server.ts
    ["Could not reach that address. Check the URL and your connection.", "network", "a working connection to the internet"],
  ];
  for (const [said, kind, what] of cases) {
    const found = readBlocker(said);
    assert.ok(found, `nothing read from: ${said}`);
    assert.equal(found.kind, kind, said);
    assert.equal(kind === "model" ? found.modelKind : found.what, what, said);
    assert.equal(found.said, said, "the sentence Branch said is kept word for word");
  }
  assert.equal(readBlocker("The sky is a nice colour today."), null, "a sentence it cannot place is not invented into one");
  assert.equal(readBlocker(""), null);
});

test("A1 every kind of blocker produces the right offer, and an impossible one refuses in plain words", async () => {
  const offerFor = (said) => fixFor(readBlocker(said), plan());
  const runner = offerFor("Ollama is not installed on this computer.");
  assert.match(runner.what, /would install Ollama/);
  assert.equal(runner.instead, null);
  assert.ok(runner.install, "the runner offer carries the one-button plan, not one of its own");
  assert.match(runner.size, /about \d/);
  assert.match(runner.from, /ollama/i);

  const spoken = offerFor("Reading aloud through your provider needs a connection that offers it.");
  assert.match(spoken.what, /read text aloud/);
  assert.equal(spoken.instead, null);

  for (const [said, expect] of [
    ["Not enough disk space: this needs about 4 GB more and 1 GB is free.", /Free some space/],
    ["Could not reach that address. Check the URL and your connection.", /cannot reach the internet/],
    ["Your Mac is not letting Branch take pictures of the screen. Open System Settings, Privacy & Security, Screen & System Audio Recording, and turn Branch Agent on.", /cannot grant a permission on your behalf/],
    ["OpenAI needs a key before it can be used", /only you can paste in/],
    ["Git is not installed on this computer.", /no publisher, checksum and plan it trusts/],
    ["No speech program is set up on this computer. Branch never downloads one for you.", /no publisher, checksum and plan it trusts/],
  ]) {
    const fix = offerFor(said);
    assert.ok(fix.instead, `${said} must refuse rather than pretend`);
    assert.match(fix.instead, expect);
    assert.equal(fix.install, null, "a refusal carries no install plan");
    assert.equal(fix.size, "", "a refusal downloads nothing");
  }
});

test("A1 the offer's own line changes the moment the offer does", () => {
  const first = fixFor(readBlocker("Ollama is not installed on this computer."), plan());
  const again = fixFor(readBlocker("Ollama is not installed on this computer."), plan());
  assert.equal(first.fingerprint, again.fingerprint, "the same offer has the same line");
  assert.match(first.fingerprint, /^[a-f0-9]{32}$/);
  const moved = fixFingerprint({ ...first, from: "somewhere-else" });
  assert.notEqual(moved, first.fingerprint, "a changed offer cannot keep the line the owner agreed to");
});

/* ---------------------------------------------------------------- 2. nothing without a yes */

test("A2 nothing is fetched or installed without the owner's yes, and a changed offer installs nothing", async () => {
  const store = on(fakeStore());
  const button = fakeButton();
  const adapt = new Adapt({ store, owner: OWNER, oneButton: button });
  const said = "Ollama is not installed on this computer.";

  const looked = await adapt.look({ said });
  assert.equal(button.asked.presses.length, 0, "looking presses nothing");
  assert.ok(looked.fix.fingerprint);
  assert.match(looked.message, /Nothing has been fetched or changed yet/);

  const bare = await adapt.go({ said });
  assert.equal(bare.done, false);
  assert.equal(button.asked.presses.length, 0, "a go with no yes installs nothing");
  assert.ok(bare.needsAgreement, "it hands back the offer to be read");
  assert.match(bare.message, /press the button again|Read what it would install/);

  const stale = await adapt.go({ said, agreed: "0".repeat(32) });
  assert.equal(stale.done, false);
  assert.equal(button.asked.presses.length, 0, "an offer the owner never saw installs nothing");
  assert.match(stale.message, /has changed since you looked/);

  const yes = await adapt.go({ said, agreed: looked.fix.fingerprint });
  assert.equal(yes.done, true);
  assert.deepEqual(button.asked.presses, [{ agreedPlan: looked.fix.install.fingerprint }],
    "the work goes through the one button, carrying the plan's own line");
});

test("A2 an impossible blocker installs nothing, whatever the owner answers", async () => {
  const store = on(fakeStore());
  const button = fakeButton();
  const adapt = new Adapt({ store, owner: OWNER, oneButton: button });
  const said = "Git is not installed on this computer. Install Git, then ask me again.";
  const looked = await adapt.look({ said });
  assert.ok(looked.fix.instead);
  const answer = await adapt.go({ said, agreed: looked.fix.fingerprint });
  assert.equal(answer.done, false);
  assert.equal(button.asked.presses.length, 0, "nothing was installed for a blocker nothing can fix");
  assert.match(answer.message, /Install Git yourself/);
});

/* ---------------------------------------------------------------- 3. carrying on, not starting again */

test("A3 the task carries on from where it stopped and the finished steps are never done again", async () => {
  const store = on(fakeStore());
  const button = fakeButton();
  /* A stand-in task that records every step it runs, so a step run twice is impossible to miss. */
  const ran = [];
  const adapt = new Adapt({
    store, owner: OWNER, oneButton: button,
    carryOn: async (stop) => {
      for (const step of ["read the notes", "write the summary", "read it aloud"].slice(stop.done.length)) ran.push(step);
      assert.equal(stop.nextStep, "read it aloud");
      return { gained: "read the answer aloud" };
    },
  });
  const said = "Ollama is not installed on this computer.";
  const stop = adapt.record({
    runId: "run-1", what: "the summary you asked for", done: ["read the notes", "write the summary"],
    nextStep: "read it aloud", said,
  });
  assert.equal(stop.blocker.kind, "runner");
  assert.deepEqual(adapt.stops.waiting().map((one) => one.id), [stop.id]);

  const looked = await adapt.look({});
  assert.equal(looked.stop.id, stop.id, "with nothing said, it looks at what actually stopped");
  const answer = await adapt.go({ agreed: looked.fix.fingerprint });

  assert.equal(answer.done, true);
  assert.deepEqual(ran, ["read it aloud"], "only the step it stopped on ran; the finished ones ran zero times");
  assert.equal(ran.filter((step) => step === "read the notes").length, 0);
  assert.equal(ran.filter((step) => step === "write the summary").length, 0);
  assert.match(answer.message, /carried on from "read it aloud"/);
  assert.match(answer.message, /2 steps it had already done were not done again/);
  assert.match(answer.message, /read the answer aloud/, "it says what it can now do that it could not before");
  assert.equal(adapt.stops.waiting().length, 0, "the stop is no longer waiting");
  assert.equal(adapt.stops.get(stop.id).gained, "read the answer aloud");

  const carried = continuationFor(stop, "read the answer aloud");
  assert.match(carried, /must not be done again: read the notes; write the summary/);
  assert.match(carried, /Start at: read it aloud/);
});

test("A3 a stop survives Branch closing: a new Adapt over the same store finds it", async () => {
  const store = on(fakeStore());
  const first = new Adapt({ store, owner: OWNER });
  first.record({ runId: "r", what: "the report", done: [], nextStep: "fetch the figures", said: "Docker is not installed on this computer." });
  const second = new Adapt({ store, owner: OWNER });
  assert.equal(second.stops.waiting()[0].what, "the report");
  assert.equal(second.stops.waiting()[0].blocker.what, "Docker");
});

/* ---------------------------------------------------------------- 4. who may, and who may not */

test("A4 it ships off, and refuses in one sentence until the owner turns it on", async () => {
  const store = fakeStore();
  assert.equal(adaptMode(store, OWNER), "off", "it ships off");
  assert.equal(adaptGuard(store, OWNER, { source: "owner" }), adaptOffRefusal);
  const adapt = new Adapt({ store, owner: OWNER, oneButton: fakeButton() });
  await assert.rejects(adapt.go({ said: "Ollama is not installed on this computer.", agreed: "0".repeat(32) }), /not set up to get what a stopped task is missing/);
  saveAdaptSettings(store, OWNER, { mode: "when-needed" });
  assert.equal(adaptMode(store, OWNER), "when-needed");
  assert.equal(adaptGuard(store, OWNER, { source: "owner" }), null);
});

test("A4 a chat, a short-lived key, a household person, a Trunk, a schedule and Lockdown are each refused", async () => {
  const chatty = on(fakeStore());
  chatty.events = (runId) => runId === "from-chat" ? [{ kind: "run.started", data: { source: "chat", channel: "telegram" } }] : [];
  const keyed = on(fakeStore());
  keyed.events = () => [{ kind: "run.started", data: { shortLivedKey: true, source: "owner" } }];

  const refusals = [
    ["a chat app", adaptGuard(chatty, OWNER, { source: "channel", runId: "from-chat" }, null), /chat/i],
    ["a short-lived key", adaptGuard(keyed, OWNER, { source: "owner", runId: "any" }), /short-lived key/i],
    ["a household person", adaptGuard(on(fakeStore()), OWNER, { source: "owner" }, "person-7"), /owner/i],
    ["a Trunk", adaptGuard(on(fakeStore()), OWNER, { source: "owner", trunkKeys: {} }, null), /Trunk/i],
    ["a schedule", adaptGuard(on(fakeStore()), OWNER, { source: "schedule" }, null), /started yourself/i],
    ["a trigger", adaptGuard(on(fakeStore()), OWNER, { source: "trigger" }, null), /started yourself/i],
  ];
  for (const [who, refusal, shape] of refusals) {
    assert.ok(refusal, `${who} must be refused`);
    assert.match(refusal, shape, who);
    assert.doesNotMatch(refusal, /install a program on this computer/, `${who}: the sentence names /adapt, not installing`);
  }

  const locked = on(fakeStore());
  locked.save("settings", OWNER, "lockdown", { on: true, since: new Date().toISOString() });
  assert.equal(adaptGuard(locked, OWNER, { source: "owner" }, null), adaptLockdownRefusal);
  assert.equal(adaptMode(locked, OWNER), "off", "Lockdown holds it off whatever is saved");

  // And a refused caller gets nothing done, not merely a different sentence.
  const button = fakeButton();
  const adapt = new Adapt({ store: chatty, owner: OWNER, oneButton: button });
  await assert.rejects(adapt.go({ said: "Ollama is not installed on this computer.", agreed: "0".repeat(32) }, { source: "channel", runId: "from-chat" }));
  assert.equal(button.asked.presses.length, 0, "a refused caller installs nothing");
});

test("A4 the one button's refusals still carry the words /adapt rewords, so a drift cannot go quiet", () => {
  /*
   * `adaptGuard` reuses the one button's own refusals and swaps the words about installing for the
   * words about `/adapt`. If those sentences are ever reworded, the swap would quietly no-op and
   * `/adapt` would start telling the owner about installing programs. This fails at the source.
   */
  const swapped = ["install a program on this computer", "Installing a program on this computer belongs to the owner"];
  for (const refusal of [installChatRefusal, installShortLivedRefusal, installTrunkRefusal,
    installPersonRefusal, installStartedElsewhereRefusal]) {
    assert.ok(swapped.some((phrase) => refusal.includes(phrase)),
      `this refusal no longer carries a phrase /adapt rewords, so its own sentence would be wrong: ${refusal}`);
  }
});

test("A4 a plan that moved between being read and being pressed is a failure, never a quiet success", async () => {
  /*
   * `OneClick.buttonGo` answers `needsAgreement` rather than throwing when the plan changed. If
   * that answer were dropped, /adapt would report a success with nothing installed — exactly the
   * half-install-and-claim-success this feature must never do.
   */
  const store = on(fakeStore());
  const moved = {
    plan: async () => ({ install: plan(), alreadyInstalled: false }),
    press: async () => ({ message: "Branch has not installed anything.", needsAgreement: plan() }),
  };
  const adapt = new Adapt({ store, owner: OWNER, oneButton: moved });
  const said = "Ollama is not installed on this computer.";
  const looked = await adapt.look({ said });
  await assert.rejects(adapt.go({ said, agreed: looked.fix.fingerprint }), /has changed since you looked/);
});

test("A4 the install switch is the one button's to check, and /adapt never gets round it", async () => {
  // The one button is a stand-in here; in the app it is `OneClick.buttonGo`, which asks
  // `installGuard` — and so the install switch — again before it fetches anything.
  const store = on(fakeStore());
  const refusing = { plan: async () => ({ install: plan(), alreadyInstalled: false }),
    press: async () => { throw new Error("Branch is not set up to install a program that runs models."); } };
  const adapt = new Adapt({ store, owner: OWNER, oneButton: refusing });
  const said = "Ollama is not installed on this computer.";
  const looked = await adapt.look({ said });
  await assert.rejects(adapt.go({ said, agreed: looked.fix.fingerprint }), /not set up to install a program that runs models/);
});

/* ---------------------------------------------------------------- 5. the switch's three positions */

test("A5 off, only when it is needed, and on behave differently", async () => {
  const store = fakeStore();
  const adapt = new Adapt({ store, owner: OWNER, oneButton: fakeButton() });
  saveAdaptSettings(store, OWNER, { mode: "when-needed" });
  const quiet = await adapt.look({});
  assert.equal(quiet.fix, null, "with nothing stopped, when-needed says nothing to offer");
  assert.match(quiet.message, /Nothing has stopped/);

  adapt.record({ runId: "r", what: "the summary", done: [], nextStep: "read it aloud", said: "Ollama is not installed on this computer." });
  const needed = await adapt.look({});
  assert.ok(needed.fix, "with something stopped, when-needed offers a fix");

  saveAdaptSettings(store, OWNER, { mode: "on" });
  const proactive = await adapt.look({});
  assert.ok(proactive.fix, "on names what is missing and what would fix it");
  assert.equal(proactive.mode, "on");
});

/* ---------------------------------------------------------------- 6. the table every surface reads */

test("A6 /adapt is in the one command table, at the right level and only where the owner is here", () => {
  const command = lookup("adapt");
  assert.ok(command, "/adapt is in src/commands/catalog.ts");
  assert.equal(command.level, "owner", "it installs and spends the owner's disk");
  assert.equal(command.bareLooks, true, "typed on its own it only describes");
  assert.deepEqual([...command.surfaces], ["window", "terminal"],
    "not a chat app, a phone or the dashboard: each reaches Branch as another computer does, and is refused");
  assert.deepEqual([...command.legacy], [], "nothing had it before");
  assert.equal(command.key, "commands.adapt");
  assert.deepEqual(command.route, { method: "POST", path: "/api/adapt/go" });
  assert.equal(lookup("unblock").name, "adapt");
  assert.equal(parseLine("/adapt yes " + "a".repeat(32)).argument, "yes " + "a".repeat(32));
  assert.ok(HANDLERS.adapt, "the table's entry has a handler, or no surface would offer it");
  assert.equal(COMMANDS.filter((one) => one.name === "adapt").length, 1);
});

test("A6 the model has no tool for this, so it can never run it unattended", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(import.meta.dirname, "..", "src", "adapt");
  for (const name of await readdir(dir)) {
    const text = await readFile(join(dir, name), "utf8");
    assert.doesNotMatch(text, /toolFeatures|defineTool|registerTool/, `${name} must not give the model a tool`);
  }
});

test("A6 every /adapt route is the owner's, and refused to every short-lived key", () => {
  for (const path of ["/api/adapt/go", "/api/adapt/plan", "/api/adapt/switch", "/api/adapt/stopped"]) {
    assert.ok(offLimitsToShortLivedKeys("POST", path), `POST ${path} must be off limits to short-lived keys`);
    assert.equal(ROUTES[path], "owner POST", `${path} must be written down as the owner's`);
  }
  assert.equal(ROUTES["/api/adapt"], "look", "reading what is stopped is only looking");
});

/* ---------------------------------------------------------------- 7. the words the owner reads */

test("merge-queue review: recording a stop and reading an offer are the owner's, like going ahead", async () => {
  const { adaptApi } = await import("../dist/adapt/api.js");
  const refused = new Error("Only the owner can use /adapt.");
  let read = false;
  const deps = { store: null, owner: OWNER, requireOwner: () => { throw refused; } };
  const body = async () => { read = true; return {}; };
  for (const path of ["/api/adapt/stopped", "/api/adapt/plan", "/api/adapt/go", "/api/adapt/switch"])
    await assert.rejects(adaptApi(deps, "POST", path, body), refused, `${path} refuses somebody else`);
  assert.equal(read, false, "nothing somebody else sent was even read");
});

/* ---------------------------------------------------------------- p17: "Leave it stopped" */

// Mutation note: remove `&& !stop.leftAt` from AdaptStops.waiting() and the "no longer offered" assertion goes red;
// replace the update in Adapt.leave with stops.forget and the "kept, still stopped" assertions go red.
test("p17 leaving a stop keeps it, still stopped, and only takes it out of the waiting list", async () => {
  const store = fakeStore();
  const button = fakeButton();
  const adapt = new Adapt({ store, owner: OWNER, oneButton: button });
  const stop = adapt.record({ runId: "r", what: "the report", done: ["one"], nextStep: "two", said: "Ollama is not installed on this computer." });
  const left = adapt.leave({ stopId: stop.id });
  assert.ok(left.leftAt, "the time it was left is written down");
  assert.equal(adapt.stops.waiting().length, 0, "no longer offered as waiting");
  const kept = adapt.stops.get(stop.id);
  assert.ok(kept, "kept, not deleted");
  assert.equal(kept.carriedOnAt, null, "still stopped: it did not carry on");
  assert.deepEqual(kept.done, ["one"]);
  assert.equal(button.asked.plans + button.asked.presses.length, 0, "nothing was looked up, fetched or installed");
  assert.throws(() => adapt.leave({ stopId: "no-such-stop" }), /no stopped task with that id/);
  assert.throws(() => adapt.leave({}), /stopId/);
});

test("p17 /api/adapt/leave is the owner's, and refused to every short-lived key", async () => {
  const { adaptApi } = await import("../dist/adapt/api.js");
  assert.ok(offLimitsToShortLivedKeys("POST", "/api/adapt/leave"));
  assert.equal(ROUTES["/api/adapt/leave"], "owner POST");
  const refused = new Error("Only the owner can use /adapt.");
  let read = false;
  const deps = { store: null, owner: OWNER, requireOwner: () => { throw refused; } };
  await assert.rejects(adaptApi(deps, "POST", "/api/adapt/leave", async () => { read = true; return {}; }), refused);
  assert.equal(read, false, "nothing somebody else sent was even read");
});
