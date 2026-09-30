/**
 * Seasons: the Gardener (src/seasons/gardener.ts), skills that earn their place.
 *
 * Proved with a scripted model and no sleeps: a skill candidate is made only by the owner's four triggers (and never
 * by a task that merely used several tools); a draft is adopted only when replaying its tasks with and without it
 * shows a measurable gain, and discarded with the reason otherwise; a later night that finds it regressed rolls it
 * back by itself; pruning, grafting and re-rooting are in the ledger and each can be undone; nothing is deleted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { asked, lessons, recurring } from "../dist/seasons/triggers.js";
import { fileProblems } from "../dist/seasons/code-problems.js";

const say = (content) => ({ content, toolCalls: [] });
const skillFile = (name, body = "## Steps\n1. Do the thing.") => `---\nname: ${name}\ndescription: Use when the owner asks to ${name.replace(/-/g, " ")}.\n---\n# ${name}\n\n${body}\n`;
const systemText = (request) => request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
const userText = (request) => request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
const tonight = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(3, 0, 0, 0); return d; };

/* ---------- the four triggers, as pure functions ---------- */
let at = 0;
const task = (prompt, { status = "completed", sessionId = "s1", tools = [] } = {}) => {
  at++;
  return { run: { id: `r${at}`, sessionId, prompt, status, output: status === "failed" ? "it broke" : "done", createdAt: new Date(Date.UTC(2026, 8, 1, 0, at)).toISOString() }, tools };
};

test("trigger 1, recurring: the same kind of request three times makes one seed; twice, or already served by a skill, makes none", () => {
  const three = [task("export the march invoices to a spreadsheet"), task("export the april invoices to a spreadsheet"), task("export the may invoices to a spreadsheet")];
  const [seed] = recurring(three, [], () => false);
  assert.equal(seed.trigger, "recurring");
  assert.equal(seed.tasks.length, 3);
  assert.deepEqual(recurring(three.slice(0, 2), [], () => false), [], "twice is not a pattern");
  assert.deepEqual(recurring(three, [], () => true), [], "a skill already serves it");
  assert.deepEqual(recurring(three, [{ sourceRunIds: [three[0].run.id] }], () => false), [], "never seeded twice");
  assert.deepEqual(recurring([task("export invoices"), task("book a dentist"), task("water the plants")], [], () => false), [], "different requests are not one kind");
});

test("trigger 2, lesson: a failed task fixed by real work makes a seed; a retry that did nothing new makes none", () => {
  const failed = task("deploy the site", { status: "failed", sessionId: "d", tools: ["shell.run"] });
  const fixed = task("try again, build it first", { sessionId: "d", tools: ["files.read", "shell.run"] });
  const [seed] = lessons([failed, fixed], []);
  assert.equal(seed.trigger, "lesson");
  assert.deepEqual(seed.sourceRunIds, [failed.run.id, fixed.run.id]);
  assert.match(seed.evidence, /What went wrong: it broke/);
  assert.equal(seed.tasks[0].prompt, "deploy the site", "the skill is proved on the request that failed");
  const trivial = task("again", { sessionId: "d", tools: ["shell.run"] });
  assert.deepEqual(lessons([failed, trivial], []), [], "the same one step again is not a lesson");
  const elsewhere = task("deploy the site", { sessionId: "other", tools: ["files.read", "shell.run"] });
  assert.deepEqual(lessons([failed, elsewhere], []), [], "a fix in another conversation is not this lesson");
});

test("trigger 3, asked: 'remember how to do this' seeds from the requests before it; other words do not", () => {
  const first = task("rename the photos by date", { sessionId: "p", tools: ["files.list", "files.move"] });
  const ask = task("great, remember how to do this", { sessionId: "p" });
  const [seed] = asked([first, ask], []);
  assert.equal(seed.trigger, "asked");
  assert.equal(seed.tasks[0].prompt, "rename the photos by date");
  assert.deepEqual(asked([first, task("thanks, that was great", { sessionId: "p" })], []), []);
});

test("no trigger, no skill: a task that used many tools makes no seed", () => {
  const busy = [task("tidy the downloads folder", { tools: ["files.list", "files.move", "files.read", "files.write", "shell.run"] })];
  assert.deepEqual([...recurring(busy, [], () => false), ...lessons(busy, []), ...asked(busy, [])], []);
});

/* ---------- the Gardener in a real engine ---------- */
function scripted(options = {}) {
  const seen = { draft: 0, replay: 0, judge: 0, revise: 0 };
  const provider = { name: "scripted", async complete(request) {
    const system = systemText(request), user = userText(request);
    if (/You decide whether what happened is worth keeping as a skill/.test(system)) { seen.draft++; return say(options.draft?.() ?? skillFile(`skill-${seen.draft}`)); }
    if (/You revise one skill file/.test(system)) { seen.revise++; return say(options.revise?.(user) ?? skillFile("merged")); }
    if (/You read requests one person typed/.test(user)) return say('{"facts":[]}');
    if (/You grade how well an answer/.test(user)) { seen.judge++; return say(`{"score": ${/WITH-SKILL/.test(user) ? options.withScore ?? 9 : options.withoutScore ?? 4}}`); }
    if (/The skill being tried|No skill is being tried/.test(system)) { seen.replay++; return say(/The skill being tried/.test(system) ? "WITH-SKILL answer" : "plain answer"); }
    return say("done");
  } };
  return { seen, provider };
}
async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), "branch-gardener-"));
  const { seen, provider } = scripted(options);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "default", name: "Test model", provider, model: "m", endpoint: "http://127.0.0.1:11434/v1" }] });
  t.after(async () => { await app.rings.idle(); await app.close(); await discardTemp(root); });
  return { app, root, seen, preset: app.runtime.models.presets.get("default") };
}
async function served(t, app, root) {
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  return async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? String(response.status));
    return json;
  };
}
async function invoices(app) {
  for (const month of ["march", "april", "may"]) await app.runtime.run({ prompt: `export the ${month} invoices to a spreadsheet` });
}

test("a returning owner stops quiet-night maintenance before it can retire a skill", async (t) => {
  const { app, preset } = await fixture(t);
  let prunes = 0;
  app.gardener.prune = () => { prunes++; return 1; };
  const report = await app.gardener.night({ preset, now: tonight(), stillQuiet: () => false });
  assert.equal(prunes, 0);
  assert.equal(report.pruned, 0);
});

test("eval-gated adoption: a draft whose replay shows a gain is adopted, and the night records it", async (t) => {
  const { app, seen } = await fixture(t);
  await invoices(app);
  const { night } = await app.rings.night({ scope: "local", person: null }, tonight());
  assert.equal(night.data.garden.planted, 1);
  assert.equal(night.data.garden.adopted, 1);
  const [seed] = app.gardener.book.seeds();
  assert.equal(seed.status, "adopted");
  assert.equal(seed.proofs[0].tasks, 3);
  assert.equal(seed.proofs[0].gain, 0.5, "graded 9 with the skill and 4 without");
  assert.equal(seen.replay, 6, "each task replayed without and with the draft");
  assert.equal(app.store.skills.view("local", seed.skillId).activeVersion, 1);
  const [entry] = app.gardener.book.ledger();
  assert.deepEqual([entry.action, entry.proof.gain], ["adopted", 0.5]);
  const again = await app.rings.night({ scope: "local", person: null }, new Date(tonight().getTime() + 86_400_000));
  assert.equal(again.night.data.garden.planted, 0, "the same tasks never seed twice");
});

test("a skill adopted tonight is not re-proved the same night, however far the night's clock is from the computer's", async (t) => {
  const { app, seen, preset } = await fixture(t);
  await invoices(app);
  const now = new Date(Date.now() + 2 * 86_400_000); // a night clock well past the computer's (CI runs on UTC after midnight)
  const report = await app.gardener.night({ preset, now, stillQuiet: () => true });
  assert.equal(report.adopted, 1);
  const [seed] = app.gardener.book.seeds();
  assert.equal(seed.proofs.length, 1, "proved once, when it was adopted");
  assert.equal(seed.decidedAt, now.toISOString(), "the decision is dated on the night's own clock");
  assert.equal(seen.replay, 6, "each task replayed without and with the draft, once");
});

test("no measurable gain, or a replay that cannot be read, discards the draft with the reason and keeps its file", async (t) => {
  const { app, preset } = await fixture(t, { withScore: 5, withoutScore: 5 });
  await invoices(app);
  const [seed] = app.gardener.plantFromTriggers();
  const grown = await app.gardener.grow(seed, preset);
  assert.equal(grown.status, "discarded");
  assert.equal(grown.reason, "no-gain");
  assert.match(grown.document, /name: skill-1/, "the draft's file is kept in the seed");
  assert.equal(app.store.skills.list("local").length, 0, "the switched-off draft nothing used leaves the skills list");
  assert.equal(app.gardener.book.ledger()[0].action, "discarded");
  const second = app.gardener.book.plant({ trigger: "asked", evidence: "rename photos", tasks: [{ prompt: "rename the photos", runId: "" }], sourceRunIds: [] });
  app.gardener.proofParts = () => ({ replay: async () => null, grade: () => async () => 1 });
  const unread = await app.gardener.grow(second, preset);
  assert.equal(unread.reason, "unreadable: no-result", "a replay that produced nothing is not a loss for either side");
});

test("the cap is on context cost: a draft too long, or past the index budget, is discarded", async (t) => {
  let long = true;
  const { app, preset } = await fixture(t, { draft: () => (long ? skillFile("long-one", "1. Step.\n".repeat(400)) : skillFile("short-one")) });
  const plant = (words) => app.gardener.book.plant({ trigger: "asked", evidence: words, tasks: [{ prompt: words, runId: "" }], sourceRunIds: [] });
  assert.equal((await app.gardener.grow(plant("x"), preset)).reason, "too-long");
  long = false;
  app.store.save("settings", "local", "seasons", { indexBudget: 50 });
  app.gardener.indexCost = () => 45; // what the skills already adopted cost in the index
  assert.equal((await app.gardener.grow(plant("y"), preset)).reason, "over-budget");
  app.gardener.indexCost = () => 0;
  assert.equal((await app.gardener.grow(plant("z"), preset)).status, "adopted", "the same draft fits once there is room");
});

test("a later night that finds an adopted skill regressed rolls it back by itself; undo brings it back, pinned", async (t) => {
  const options = { withScore: 9, withoutScore: 4 };
  const { app, preset } = await fixture(t, options);
  await invoices(app);
  const [seed] = app.gardener.plantFromTriggers();
  const adopted = await app.gardener.grow(seed, preset);
  assert.equal(adopted.status, "adopted");
  const step = { preset, stillQuiet: () => true, now: new Date(Date.now() + 86_400_000) };
  assert.equal(await app.gardener.recheck(step), false, "still better with it: kept");
  options.withScore = 2;
  const later = { ...step, now: new Date(Date.now() + 2 * 86_400_000) };
  assert.equal(await app.gardener.recheck(later), true, "worse with it now: rolled back");
  assert.equal(app.store.skills.view("local", adopted.skillId).activeVersion, null, "switched off, still installed");
  const rollback = app.gardener.book.ledger().find((entry) => entry.action === "rolled-back");
  assert.ok(rollback.proof.gain < 0);
  app.gardener.undo(rollback.id);
  assert.equal(app.store.skills.view("local", adopted.skillId).activeVersion, 1);
  const pinned = app.gardener.book.seed(adopted.id);
  assert.deepEqual([pinned.status, pinned.pinned], ["adopted", true]);
  assert.equal(await app.gardener.recheck({ ...later, now: new Date(Date.now() + 3 * 86_400_000) }), false, "a pinned skill is never rolled back by itself");
});

test("pruning, re-rooting and undo: an unused adopted skill goes stale, then is set aside, and comes back", async (t) => {
  const { app, preset } = await fixture(t);
  await invoices(app);
  const [seed] = app.gardener.plantFromTriggers();
  const adopted = await app.gardener.grow(seed, preset);
  assert.equal(app.gardener.stateOf(adopted), "active");
  assert.equal(app.gardener.stateOf(adopted, new Date(Date.now() + 15 * 86_400_000)), "stale");
  assert.equal(app.gardener.prune(new Date(Date.now() + 15 * 86_400_000)), 0, "stale is shown, not set aside");
  assert.equal(app.gardener.prune(new Date(Date.now() + 31 * 86_400_000)), 1);
  assert.equal(app.store.skills.view("local", adopted.skillId).activeVersion, null);
  assert.equal(app.store.skills.list("local").length, 1, "never removed");
  const rerooted = app.gardener.reroot(adopted.id);
  assert.equal(rerooted.action, "re-rooted");
  assert.equal(app.store.skills.view("local", adopted.skillId).activeVersion, 1);
  assert.equal(app.gardener.prune(new Date(Date.now() + 90 * 86_400_000)), 0, "a re-rooted skill is pinned");
  app.gardener.undo(rerooted.id);
  assert.equal(app.store.skills.view("local", adopted.skillId).activeVersion, null);
  const discarded = app.gardener.book.plant({ trigger: "asked", evidence: "z", tasks: [{ prompt: "z", runId: "" }], sourceRunIds: [] });
  app.gardener.proofParts = () => ({ replay: async () => ({ answer: "a", finished: true, tokens: 1 }), grade: () => async () => 0.5 });
  const gone = await app.gardener.grow(discarded, preset);
  assert.equal(gone.status, "discarded");
  const entry = app.gardener.book.ledger().find((row) => row.action === "discarded" && row.seedId === gone.id);
  app.gardener.undo(entry.id);
  const back = app.gardener.book.seed(gone.id);
  assert.equal(back.status, "waiting");
  assert.equal(app.store.skills.view("local", back.skillId).activeVersion, null, "put back switched off, to be proved again");
});

test("grafting: two adopted skills that say the same thing become one, proved against the two; undo puts both back", async (t) => {
  const body = "## Steps\n1. Open the invoices folder.\n2. Export each invoice to the spreadsheet.\n3. Check the totals add up.";
  const { app, preset } = await fixture(t, { draft: () => skillFile(`invoice-export-${Math.random().toString(36).slice(2, 7)}`, body),
    revise: (user) => user.match(/---\nname: ([a-z0-9-]+)/) ? skillFile(user.match(/---\nname: ([a-z0-9-]+)/)[1], `${body}\n4. Save a copy.`) : "" });
  await invoices(app);
  const [first] = app.gardener.plantFromTriggers();
  await app.gardener.grow(first, preset);
  const second = app.gardener.book.plant({ trigger: "asked", evidence: "invoices", tasks: [{ prompt: "export the june invoices to a spreadsheet", runId: "" }], sourceRunIds: [] });
  await app.gardener.grow(second, preset);
  const [a, b] = app.gardener.book.seeds().filter((seed) => seed.status === "adopted");
  assert.ok(a && b, "two adopted");
  assert.equal(await app.gardener.graft(preset), true);
  const graft = app.gardener.book.ledger().find((entry) => entry.action === "grafted");
  const [keep, fold] = graft.after;
  assert.equal(app.store.skills.view("local", keep.skillId).activeVersion, 2, "the kept skill runs its merged version");
  assert.equal(app.store.skills.view("local", fold.skillId).activeVersion, null, "the other is switched off, not removed");
  app.gardener.undo(graft.id);
  assert.equal(app.store.skills.view("local", keep.skillId).activeVersion, 1);
  assert.equal(app.store.skills.view("local", fold.skillId).activeVersion, 1);
});

test("a recurring program error in the owner's tasks is filed once as a request to change Branch; filing starts nothing", async (t) => {
  const { app } = await fixture(t);
  const first = await app.runtime.run({ prompt: "sort my notes" });
  const second = await app.runtime.run({ prompt: "sort my notes again", sessionId: first.sessionId });
  const third = await app.runtime.run({ prompt: "sort my other notes" });
  for (const run of [first, second, third]) app.store.event(run.id, "tool.failed", { name: "notes.sort", error: "TypeError: Cannot read properties of undefined (reading 'title')" });
  const plain = await app.runtime.run({ prompt: "and these" });
  app.store.event(plain.id, "tool.failed", { name: "notes.sort", error: "The folder is empty" });
  assert.equal(fileProblems(app.store, "local", app.sourceRequests), 1);
  assert.equal(fileProblems(app.store, "local", app.sourceRequests), 0, "filed once");
  const [request] = app.sourceRequests.list();
  assert.equal(request.status, "waiting", "only the owner's yes in the app prepares anything");
  assert.match(request.text, /notes\.sort failed in 3 tasks, in 2 conversations/);
});

test("the garden is the owner's: a household person sees none and cannot change it", async (t) => {
  const { app, root, preset } = await fixture(t);
  const api = await served(t, app, root);
  await invoices(app);
  const [seed] = app.gardener.plantFromTriggers();
  await app.gardener.grow(seed, preset);
  const view = await api("seasons");
  assert.equal(view.garden.seeds[0].state, "active");
  assert.equal(view.garden.ledger[0].action, "adopted");
  const pinned = await api("seasons/garden/pin", { id: seed.id, pinned: true });
  assert.equal(pinned.seed.pinned, true);
  const sam = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: sam.id, pin: "4321" });
  assert.equal((await api("seasons")).garden, null);
  await assert.rejects(api("seasons/garden/undo", { id: view.garden.ledger[0].id }), /belongs to the owner/);
});

test("a household person's requests never seed the owner's skills", async (t) => {
  const { app } = await fixture(t);
  const sam = app.store.profiles.create({ name: "Sam", pin: "4321" });
  const { asPerson } = await import("../dist/people/context.js");
  await asPerson({ profileId: sam.id, keyId: "test" }, invoices.bind(null, app));
  assert.deepEqual(app.gardener.plantFromTriggers(), []);
});

test("Lockdown switched on while a draft is being written pauses the Gardener: nothing is adopted or discarded, the seed waits", async (t) => {
  const { setLockdown } = await import("../dist/lockdown.js");
  let app;
  const fixed = await fixture(t, { draft: () => { setLockdown(app.store, app.runtime.owner, { on: true }); return skillFile("paused-one"); } });
  app = fixed.app;
  await invoices(app);
  const [seed] = app.gardener.plantFromTriggers();
  const grown = await app.gardener.grow(seed, fixed.preset);
  assert.equal(grown.status, "waiting", "the seed waits for a permitted night");
  assert.equal(fixed.seen.replay, 0, "no replay runs under Lockdown");
  assert.equal(app.gardener.book.ledger().length, 0, "nothing is adopted or discarded");
  assert.equal(app.store.skills.list("local").filter((skill) => skill.active).length, 0);
});
