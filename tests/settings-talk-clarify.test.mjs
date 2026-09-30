/**
 * Q50: a settings request in the owner's own words is matched before anything is planned. Words that
 * fit several settings, or none, come back as one question and no plan; words that fit exactly one
 * come back as the exact before and after, with anything already as asked left out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";
import { negated } from "../dist/settings-kit/clarify.js";
import { settingsCatalogue } from "../dist/settings-kit/catalogue.js";

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-clarify-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  // The learning core ships when needed (the ship-on rule); these tests move it from off, so the owner switches it off first.
  app.learningCore.configure({ mode: "off" });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const context = () => app.runtime.context({ source: "owner" });
  const find = (input) => app.registry.execute("settings.find", input, context());
  const values = async () => Object.fromEntries((await app.registry.execute("settings.list", {}, context())).shown.map((row) => [row.setting, row.value]));
  return { app, find, values };
}

test("two ambiguous phrasings each come back as one question, with nothing planned or changed", async (t) => {
  const { find, values } = await fixture(t);
  const before = await values();
  const board = await find({ request: "turn on the board" });
  assert.equal(board.status, "ask");
  assert.equal(board.planned, false);
  assert.deepEqual(board.choices.map((one) => one.setting).sort(), ["asks-project-board.mode", "flowboards-kanban.mode"]);
  assert.match(board.question, /Project boards/);
  assert.match(board.question, /Orchard/);
  assert.equal((board.question.match(/\?/g) ?? []).length, 1, "exactly one question");
  assert.equal(board.preview, undefined);

  const voice = await find({ request: "switch on voice" });
  assert.equal(voice.status, "ask");
  assert.equal(voice.planned, false);
  assert.ok(voice.choices.length > 1);
  assert.ok(voice.choices.every((one) => one.setting.startsWith("voice.")));
  assert.equal((voice.question.match(/\?/g) ?? []).length, 1, "exactly one question");
  assert.deepEqual(await values(), before);
});

test("a request that fits no setting is handed back to the model, with no question for the owner", async (t) => {
  const { find, values } = await fixture(t);
  const before = await values();
  const none = await find({ request: "turn on the flux capacitor" });
  assert.equal(none.status, "no-match");
  assert.equal(none.planned, false);
  assert.deepEqual(none.choices, []);
  assert.equal(none.question, undefined, "never a canned \"Which setting do you mean?\"");
  assert.match(none.note, /answer their message yourself/);
  const empty = await find({ request: "turn it on" });
  assert.equal(empty.status, "no-match");
  assert.deepEqual(empty.choices, []);
  assert.deepEqual(await values(), before);
});

test("a clear request gives the exact before and after, and one already as asked gives no change", async (t) => {
  const { app, find, values } = await fixture(t);
  const clear = await find({ request: "turn on the learning" });
  assert.equal(clear.status, "ready");
  assert.equal(clear.setting, "fly-core.mode");
  assert.deepEqual(clear.preview, [{ setting: "fly-core.mode", name: "What Branch learns from experience", label: "Switch",
    from: "off", to: "on", lessCareful: false, pinned: false }]);
  assert.equal(clear.useTool, "settings.change");
  assert.equal((await values())["fly-core.mode"], "off", "finding plans; it never writes");

  const said = await find({ request: "the wall", value: "on" });
  assert.equal(said.status, "ready", "a value only one field can hold settles which field");
  assert.equal(said.setting, "os-sandbox.mode");

  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  await app.registry.execute("settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] }, app.runtime.context({ source: "owner" }));
  const again = await find({ request: "turn on the learning" });
  assert.equal(again.status, "unchanged");
  assert.equal(again.preview, undefined, "a no-op is never shown as a change");
  assert.match(again.note, /already on/);
});

test("in a conversation, an ambiguous request reaches the model as a question and never asks to change anything", async (t) => {
  let calls = 0;
  const seen = [];
  const provider = {
    name: "scripted",
    async complete(request) {
      seen.push(JSON.stringify(request.messages));
      return calls++ === 0
        ? { content: "", toolCalls: [{ id: "find-call", name: "settings.find", arguments: JSON.stringify({ request: "turn on the board" }) }] }
        : { content: "Do you mean Project boards or Orchard?", toolCalls: [] };
    },
  };
  const { app, values } = await fixture(t, provider);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const before = await values();
  const done = await app.runtime.run({ prompt: "turn on the board" });
  assert.equal(done.status, "completed", done.output);
  assert.equal(app.runtime.approvals.questionFor(done.sessionId), undefined, "no change was put to the owner");
  assert.match(seen[1], /Which one do you mean|Do you mean/);
  assert.match(seen[1], /flowboards-kanban\.mode/);
  assert.deepEqual(await values(), before);
});

async function allRows(app) {
  const rows = [];
  for (let offset = 0; offset !== null;) {
    const page = await app.registry.execute("settings.list", { offset }, app.runtime.context({ source: "owner" }));
    rows.push(...page.shown);
    offset = page.nextOffset;
  }
  return rows;
}

function assertAsksOnly(result, phrasing) {
  assert.equal(result.status, "ask", `${phrasing}: ${JSON.stringify(result)}`);
  assert.equal(result.planned, false, phrasing);
  assert.equal(result.preview, undefined, `${phrasing}: nothing is planned`);
  assert.equal(result.useTool, undefined, phrasing);
  assert.equal((result.question.match(/\?/g) ?? []).length, 1, `${phrasing}: exactly one question`);
  assert.match(result.question, /say not to/, phrasing);
}

test("a request that says not to is never planned as a change, for loosening settings too", async (t) => {
  const { find, values } = await fixture(t);
  const before = await values();
  const screen = await find({ request: "don't turn on Your screen and keyboard" });
  assertAsksOnly(screen, "don't turn on Your screen and keyboard");
  assert.deepEqual(screen.choices, [{ setting: "desktop-control.mode", name: "Your screen and keyboard", value: "off" }]);
  assert.match(screen.question, /"Your screen and keyboard" change from off/);
  const phrasings = [
    "Don’t turn on your screen and keyboard",
    "do not turn on the wake word",
    "please never switch on the model arena",
    "no longer turn on skill bundles",
    "not your screen and keyboard, turn it on",
    "doesnt need the wake word on",
    "don't turn off the learning",
    "n'active pas le mot de réveil",
    "ne mets jamais l'écran",
    "n'allume plus la caméra",
    "no wake word on please",
    "Your screen and keyboard on? No.",
    "stop your screen and keyboard on",
    "non, allume l'écran et le clavier",
    "arrête d'allumer le mot de réveil",
    "Arrêter : your screen and keyboard on",
    "STOP turning on the wake word",
    "hold on, turn on A relay that holds your chat app accounts",
    "wait, turn on the wake word",
    "hang on, your screen and keyboard on",
    "cancel that, turn on the wake word",
    "nope, turn on your screen and keyboard",
    "nah turn on the wake word",
    "never mind, turn on the wake word",
    "annule, allume l'écran",
    "attends, allume le mot de réveil",
    "pas maintenant, allume l'écran",
  ];
  for (const request of phrasings) assertAsksOnly(await find({ request }), request);
  assertAsksOnly(await find({ request: "don't turn on Your screen and keyboard", value: "on" }), "a said value does not override the not");
  assert.equal((await find({ request: "turn on notes with rewriting" })).status, "ready", "notes is not a negation");
  const label = "When to check with me A command no rule mentions";
  assert.doesNotMatch((await find({ request: `turn on ${label}` })).question ?? "", /say not to/, "a setting's own name holding no is not a negation");
  assertAsksOnly(await find({ request: `${label} on? No.` }), "a no beside that name still is");
  assert.equal((await find({ request: "turn on A relay that holds your chat app accounts" })).status, "ready", "holds is not hold");
  assert.deepEqual(await values(), before);
});

test("every setting that would loosen when asked plainly still asks when the words say don't, no or stop", async (t) => {
  const { app, find, values } = await fixture(t);
  const before = await values();
  let loosening = 0;
  for (const row of await allRows(app)) {
    const words = row.label === "Switch" ? row.name : `${row.name} ${row.label}`;
    const plain = await find({ request: `turn on ${words}` });
    if (plain.status !== "ready" || !plain.preview.some((one) => one.lessCareful)) continue;
    loosening += 1;
    assertAsksOnly(await find({ request: `don't turn on ${words}` }), `don't turn on ${words}`);
    for (const request of [`don't turn on ${words}`, `never turn on ${words}`, `no ${words} on please`, `${words} on? No.`,
      `stop ${words} on`, `turn on ${words}, stop`, `non, turn on ${words}`, `arrête : turn on ${words}`, `arreter ${words} on`,
      `hold on, turn on ${words}`, `wait, turn on ${words}`, `hang on, turn on ${words}`, `cancel: turn on ${words}`,
      `nope, turn on ${words}`, `nah, turn on ${words}`, `never mind, turn on ${words}`, `annule, turn on ${words}`,
      `attends, turn on ${words}`, `pas maintenant, turn on ${words}`])
      assertAsksOnly(await find({ request }), request);
  }
  // 41 since the ship-on rule: goal mode ships on, so "turn on" it is no change (every other loosening one still is).
  assert.ok(loosening >= 41, `found ${loosening} loosening settings: a cue word must not stop plain "turn on X"`);
  assert.deepEqual(await values(), before);
});

test("cue words match whole words only, so a name that holds or is waiting is not a hold or a wait", () => {
  for (const request of ["turn on A relay that holds your chat app accounts", "turn on the waiting room", "cancellation notes on",
    "nopes and holdings", "hanging on", "the waited list"]) assert.equal(negated(request), false, request);
  for (const request of ["hold, turn it on", "Wait. Turn it on", "hang on turn it on", "Cancel", "nope", "nah", "never mind",
    "annule", "attends", "pas maintenant"]) assert.equal(negated(request), true, request);
  // However the apostrophe is typed, hidden characters inside the word, or full-width letters: still "don't".
  for (const mark of ["'", "‘", "’", "ʼ", "´", "`", "′", "＇", "‍", "​", "­"]) {
    assert.equal(negated(`don${mark}t turn on the learning`), true, `don${mark}t (U+${mark.codePointAt(0).toString(16)})`);
  }
  assert.equal(negated("do‍n’t turn on the learning"), true, "a joiner inside the word");
  assert.equal(negated("ｄｏｎｔ turn on the learning"), true, "full-width letters");
  assert.equal(negated("n‘est plus"), true, "French n’... plus with a curly opening mark");
  // Invisible characters as the only gap between words: zero-width space and word joiner
  assert.equal(negated("don’t​turn on the learning"), true, "zero-width space between words");
  assert.equal(negated("stop⁠the learning"), true, "word joiner between words");
  // An accent typed as the apostrophe, with only an invisible character before the next word
  assert.equal(negated("don\u00B4t\u200Bturn on the learning"), true, "an acute accent, then a zero-width space");
  assert.equal(negated("don\u00B4t\u2060turn on the learning"), true, "an acute accent, then a word joiner");
  // Extra apostrophe-like marks that should also be recognized as apostrophes
  for (const mark of ["‛", "ʻ", "ʹ", "‵", "ꞌ", "՚", "｀"]) {
    assert.equal(negated(`don${mark}t turn on the learning`), true, `don${mark}t (U+${mark.codePointAt(0).toString(16)})`);
  }
  // Q102: a double or triple prime, which NFKC turns into single primes
  for (const mark of ["\u2033", "\u2034", "\u2036", "\u2037", "\u2057"]) {
    assert.equal(negated(`don${mark}t turn on the learning`), true, `don${mark}t (U+${mark.codePointAt(0).toString(16)})`);
  }
});

test("a choice or number that would loosen when named plainly still asks when the words say not to", async (t) => {
  const { find, values } = await fixture(t);
  const before = await values();
  let loosening = 0;
  for (const spec of settingsCatalogue) for (const field of spec.fields) {
    const kind = field.kind;
    if (kind.type !== "choice" && kind.type !== "number") continue;
    const words = `${spec.name} ${field.label}`;
    for (const value of kind.type === "choice" ? kind.options : [kind.min, kind.max]) {
      const plain = await find({ request: words, value });
      if (plain.status !== "ready" || !plain.preview.some((one) => one.lessCareful)) continue;
      loosening += 1;
      for (const request of [`don't set ${words}`, `never ${words}`, `no ${words} please`, `${words}? No.`, `stop ${words}`,
        `hold on, ${words}`, `wait, ${words}`, `cancel ${words}`, `nope, ${words}`, `nah, ${words}`, `never mind, ${words}`,
        `non, ${words}`, `annule ${words}`, `attends, ${words}`, `pas maintenant, ${words}`])
        assertAsksOnly(await find({ request, value }), `${request} = ${value}`);
    }
  }
  assert.ok(loosening >= 5, `found ${loosening} loosening choices and numbers`);
  assertAsksOnly(await find({ request: "don't allow unmatched commands" }), "don't allow unmatched commands");
  assertAsksOnly(await find({ request: "don't allow A command no rule mentions", value: "allow" }), "don't allow, with the value said");
  assert.deepEqual(await values(), before);
});
