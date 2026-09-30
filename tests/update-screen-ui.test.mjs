/**
 * The update screen (public/app/shell/updating.js) and Settings › Updates' status card (public/app/settings/pages/updates.js),
 * through the real modules with their imports stood in for, as tests/update-by-itself-honest.test.mjs loads the window.
 * The owner: a Beta update "said Updating to 0.19.4-dev…g0ff7d55d711b", the version already installed, and gave no idea
 * what it was doing for 30 minutes. The screen names the version being installed and the one it replaces, lists the
 * updater's real steps with their times, never draws a bar it cannot back, and a failure says why and that the running
 * version was kept. The card says one thing at a time, with the one button for that moment. Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const source = async (path) => (await readFile(new URL(`../public/app/${path}`, import.meta.url), "utf8"))
  .replace(/^import [\s\S]*?;\r?\n/gm, "").replace(/^export (\{[^}]*\};?)?/gm, "");
const words = (key, params) => (params ? `${key}[${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")}]` : key);
const esc = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NEW = "a".repeat(40), INSTALLED = "0.19.4-dev.1790475733-g0ff7d55d711b", BUILT = "0.19.4-dev.1790477481-g3da16f3597a3";
const at = (s) => new Date(Date.parse("2026-09-27T03:00:00Z") + s * 1000).toISOString();
const stage = (id, state, from = null, to = null) => ({ id, state, startedAt: from === null ? null : at(from), endedAt: to === null ? null : at(to) });
const building = (overrides = {}) => ({
  phase: "downloading", message: "Building Branch on this computer…", installed: { version: INSTALLED, commit: "b".repeat(40) }, outcome: null,
  progress: null, bytes: null, updatedAt: at(40), release: { channel: "beta", commit: NEW, available: true, latestVersion: BUILT },
  stages: [stage("fetching", "done", 0, 6), stage("installing", "skipped", 6, 6), stage("building", "running", 6), stage("checking", "waiting"),
    stage("copying", "waiting"), stage("swapping", "waiting"), stage("restarting", "waiting")],
  target: { version: BUILT, commit: NEW }, failure: null, ...overrides,
});

/** A layer element and just enough of a document for the screen to draw into. */
function page() {
  const layer = { hidden: false, replaceChildren() { this.innerHTML = ""; }, querySelector: () => null, className: "", innerHTML: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    querySelectorAll: () => [] };
  const document = { documentElement: { dataset: { theme: "dark" } }, createElement: () => layer, body: { append: () => undefined }, querySelectorAll: () => [], querySelector: () => null };
  return { layer, document };
}

async function screen(first = null) {
  const { layer, document } = page(), acts = new Map(), live = [], renders = [];
  let listener = null;
  const desktop = { onUpdateStatus: (fn) => { listener = fn; }, updateStatus: async () => first };
  const context = createContext({
    window: { branchDesktop: desktop }, document, t: words, esc, S: {}, applyCss: () => undefined, render: () => renders.push(1),
    on: (name, fn) => acts.set(name, fn), markLive: (names) => live.push(...names), matchMedia: () => ({ matches: false }),
    media17: (still, loop, cls) => `<span class="m17" data-m17="${still}" data-m17-loop="${loop}" data-m17-cls="${cls}"></span>`,
    setInterval: () => 1, clearInterval: () => undefined, console, Date, JSON, Math, String, Boolean, Number,
  });
  runInContext(await source("shell/updating.js"), context);
  runInContext("initUpdating()", context);
  await new Promise((r) => setTimeout(r, 0));
  return { layer, acts, live, renders, context, hear: (s) => listener(s), run: (code) => runInContext(code, context) };
}

test("the screen names the version being installed and the one it replaces, never the installed one as the target", async () => {
  const s = await screen(building());
  assert.equal(s.layer.hidden, false, "an install under way opens the screen, even in a window opened during it");
  // A Beta build is named by its change (QA Q055); its whole version is in the tooltip.
  assert.ok(s.layer.innerHTML.includes(`<h2 id="upd18-title" data-tip="${BUILT}">window.updates.screen.to-change[commit=3da16f3]</h2>`), s.layer.innerHTML);
  assert.ok(s.layer.innerHTML.includes(`<p data-tip="${INSTALLED}">window.updates.screen.from[version=window.updates.screen.beta[commit=0ff7d55]]`));
  assert.ok(!s.layer.innerHTML.includes(`>window.updates.screen.to[version=${BUILT}]`), "no long version string as the title");
  s.hear(building({ target: { version: null, commit: NEW } }));
  assert.ok(s.layer.innerHTML.includes("window.updates.screen.to-change[commit=aaaaaaa]"), "before its version is known, the change is named");
  assert.ok(!s.layer.innerHTML.includes(`screen.to[version=${INSTALLED}]`));
  assert.match(s.layer.innerHTML, /\/assets\/icon-192\.png/, "Branch appears as its static logo");
  assert.doesNotMatch(s.layer.innerHTML, /building-(dark|light)|\.webm/, "no decorative mascot loop");
  s.hear(building({ installed: { version: "0.19.3", commit: null }, release: { channel: "stable", latestVersion: "0.20.0", available: true }, target: { version: "0.20.0", commit: null } }));
  assert.ok(s.layer.innerHTML.includes('<h2 id="upd18-title">window.updates.screen.to[version=0.20.0]</h2><p>window.updates.screen.from[version=0.19.3]'),
    "a release's version reads as it is");
});

test("the steps are the updater's, in order, each with its own time; the running one counts up; nothing is a made-up bar", async () => {
  const s = await screen(building());
  const html = s.layer.innerHTML;
  const order = [...html.matchAll(/<li class="st-(\w+)">.*?<span>([^<]*)<\/span>/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(order, [["window.updates.stage.fetching", "done"], ["window.updates.stage.installing-skipped", "skipped"],
    ["window.updates.stage.building", "running"], ["window.updates.stage.checking", "waiting"], ["window.updates.stage.copying", "waiting"],
    ["window.updates.stage.swapping", "waiting"], ["window.updates.stage.restarting", "waiting"]]);
  assert.match(html, /<span>window.updates.stage.fetching<\/span><time>0:06<\/time>/, "a step that ended shows how long it took");
  assert.match(html, new RegExp(`<span>window.updates.stage.building</span><time data-upd-since="${at(6)}">`), "the running step counts up from when it started");
  assert.doesNotMatch(html, /<span>window.updates.stage.installing-skipped<\/span><time/, "a skipped step has no time of its own");
  assert.doesNotMatch(html, /progress|%/, "no bar and no percentage for a build");
  s.hear(building({ phase: "downloading", release: { channel: "stable", latestVersion: "0.20.0", available: true }, target: { version: "0.20.0", commit: null },
    bytes: { received: 50 * 1048576, total: 200 * 1048576 }, stages: [stage("downloading", "running", 0), stage("checking", "waiting"), stage("copying", "waiting"), stage("swapping", "waiting"), stage("restarting", "waiting")] }));
  assert.match(s.layer.innerHTML, /window.updates.screen.bytes\[received=50,total=200\]/, "a download counts its real bytes");
});

test("a failed install says where and why in plain words, with the log's key line, and that the running version was kept", async () => {
  const s = await screen(building());
  const failed = building({ phase: "error", message: "node scripts/package-desktop.mjs did not finish: ENOENT", outcome: { kept: INSTALLED, backgroundStopped: false },
    stages: building().stages.map((one) => (one.id === "building" ? { ...one, state: "failed", endedAt: at(70) } : one)),
    failure: { stage: "building", line: "ENOENT: no such file or directory, copyfile 'electron.exe'" }, updatedAt: at(70) });
  s.hear(failed);
  const html = s.layer.innerHTML;
  // QA Q054: the first line is plain words by the step it stopped at; the raw words and the build's line are under Details, once each.
  assert.match(html, /<h2 id="upd18-title">window.updates.why.build<\/h2>/);
  assert.match(html, /<details class="upd18-why"><summary>window.updates.screen.details<\/summary><p>node scripts\/package-desktop.mjs did not finish: ENOENT<\/p><code>ENOENT: no such file or directory, copyfile 'electron.exe'<\/code><\/details>/);
  assert.equal(html.split("ENOENT: no such file").length - 1, 1, "the build's line is said once");
  assert.ok(html.includes("window.updates.screen.kept[version=window.updates.screen.beta[commit=0ff7d55]]"));
  s.hear({ ...failed, message: "node scripts/package-desktop.mjs did not finish: ENOENT: no such file or directory, copyfile 'electron.exe'", updatedAt: at(71) });
  assert.equal(s.layer.innerHTML.split("ENOENT: no such file").length - 1, 1, "not again when the message already holds it");
  for (const [where, key] of [["fetching", "fetch"], ["installing", "build"], ["checking", "check"], ["copying", "copy"], ["swapping", null], [null, null]]) {
    s.hear({ ...failed, failure: { stage: where, line: null }, updatedAt: at(80) });
    assert.match(s.layer.innerHTML, new RegExp(`<h2 id="upd18-title">window.updates.${key ? `why.${key}` : "failed"}</h2>`), String(where));
  }
  s.hear(failed);
  assert.match(html, /<li class="st-failed">.*?window.updates.stage.building<\/span><time>1:04<\/time>/);
  assert.ok(s.acts.has("upd18-close") && s.live.includes("upd18-close"));
  s.acts.get("upd18-close")();
  assert.equal(s.layer.hidden, true, "closed until the next install");
  s.hear(building());
  assert.equal(s.layer.hidden, false, "the next install opens it again");
});

test("Keep working folds it into the install strip, filled by the steps done, never by time", async () => {
  const s = await screen(building());
  s.acts.get("upd18-fold")();
  assert.match(s.layer.className, /folded/);
  assert.match(s.layer.innerHTML, /window.updates.screen.steps\[done=2,total=7\]/);
  assert.match(s.layer.innerHTML, /data-css="width:29%"/, "2 of 7 steps");
  s.acts.get("upd18-open")();
  assert.doesNotMatch(s.layer.className, /folded/);
});

/* The owner's call: update by itself builds in the background while the owner works; the screen is only for the swap. */
test("an automatic install stays in the status bar while it builds, and the screen comes up only for the swap", async () => {
  const auto = building({ automatic: true });
  const s = await screen(auto);
  assert.equal(s.layer.hidden, true, "no screen over the owner's work while it fetches, installs and builds");
  const item = s.run("statusItem()");
  assert.match(item, /data-act="upd18-bg"/);
  assert.match(item, /window.updates.bar\[step=window.updates.stage.building\] <time data-upd-since=/, "the step and its live time");
  assert.ok(s.live.includes("upd18-bg"));
  s.acts.get("upd18-bg")();
  assert.deepEqual({ ...s.context.S }, { view: "settings", setPage: "updates" }, "it opens Settings › Updates, with the steps");
  const swap = { ...auto, stages: auto.stages.map((one) => ({ ...one, state: one.id === "swapping" ? "running" : one.state === "waiting" && one.id === "restarting" ? "waiting" : one.state === "running" || one.state === "waiting" ? "done" : one.state })) };
  s.hear(swap);
  assert.equal(s.layer.hidden, false, "the swap and the restart show the screen");
  assert.equal(s.run("statusItem()"), "");
  const failed = { ...auto, phase: "error", message: "npm ci did not finish.", outcome: { kept: INSTALLED, backgroundStopped: false }, failure: { stage: "installing", line: null } };
  s.hear(building({ automatic: true, updatedAt: at(1) }));
  s.hear(failed);
  assert.equal(s.layer.hidden, true, "a background failure is said by update by itself and in Settings, not over the owner's work");
});

test("an install the owner pressed shows the screen from the start; Show progress brings a background one up", async () => {
  const s = await screen(building({ automatic: false }));
  assert.equal(s.layer.hidden, false);
  assert.equal(s.run("statusItem()"), "");
  const b = await screen(building({ automatic: true }));
  assert.equal(b.layer.hidden, true);
  b.run("openUpdateScreen()");
  assert.equal(b.layer.hidden, false, "Show progress in Settings › Updates opens it");
  assert.equal(b.run("statusItem()"), "");
});

test("with no install under way, nothing is shown", async () => {
  for (const phase of ["idle", "current", "available", "checking"]) {
    const s = await screen({ ...building(), phase, stages: null, target: null });
    assert.equal(s.layer.hidden, true, phase);
  }
  const s = await screen(null);
  assert.equal(s.layer.hidden, true);
});

test("the once-a-second ticker sleeps when nothing counts any more, also when the page redraws after the install ended", async () => {
  const s = await screen(null);
  let tick = null, cleared = 0;
  Object.assign(s.context, { setInterval: (fn) => { tick = fn; return 7; }, clearInterval: () => { cleared++; } });
  s.hear(building());
  assert.ok(tick, "a running step counts up");
  s.context.document.querySelector = () => ({}); // Settings' card still shows the running time when the install ends
  s.hear({ ...building(), phase: "current", stages: null, target: null });
  s.context.document.querySelector = () => null; // then the page redraws without it
  tick();
  assert.equal(cleared, 1, "the ticker stops at its next beat");
});

test("times read as m:ss, and h:mm:ss past an hour", async () => {
  const s = await screen(null);
  assert.equal(s.run("clock(65_000)"), "1:05");
  assert.equal(s.run("clock(3_725_000)"), "1:02:05");
  assert.equal(s.run("clock(-5)"), "0:00");
});

/* ---------- Settings › Updates: one status card, one button for the moment ---------- */

async function settings({ status, autoUpdate = "install", channel = "beta", plan = null, problem = null, wait = null, holding = [] }) {
  const s = await screen(status);
  const context = s.context;
  Object.assign(context, {
    E: { state: { version: INSTALLED }, profiles: { isOwner: true }, sessions: [{ sessionId: "s1", title: "Invoice run" }], trunks: [] },
    level: () => 0, api: async () => ({}), toast: () => undefined, updates17: () => "", channelSection: () => "<channel/>", ic: () => "", isDesktop: true, waiting: async () => null,
    initChannel: () => undefined, loadChannel: async () => undefined, channelStatus: () => status,
    lastLook: { plan, problem, wait, status }, holdingTasks: () => holding, waitingLine: () => (plan?.until ? `window.updates.ready-installs-when[until=${plan.until}]` : wait),
  });
  runInContext(await source("settings/pages/updates.js"), context);
  runInContext(`comfortData = ${JSON.stringify({ notify: { autoUpdate, releaseChannel: channel } })};`, context);
  const html = runInContext("draw()", context);
  const cards = html.match(/class="status upd18-status"/g) ?? [], primaries = html.match(/class="btn pri sm"/g) ?? [];
  return { html, cards: cards.length, primaries: primaries.length };
}
const ready = () => ({ ...building(), phase: "available", message: "A newer Beta build (change aaaaaaa) can be built and installed.", stages: null, target: null });

test("a ready update says so once, installs by itself, and offers Update now for sooner", async () => {
  const on = await settings({ status: ready() });
  assert.match(on.html, /window.updates.card.next-ready\[what=aaaaaaa\]/);
  assert.match(on.html, /window.updates.card.installs-by-itself/);
  assert.match(on.html, /data-act="u-now">window.updates.card.update-now/);
  assert.equal(on.cards, 1, "one status card");
  assert.equal(on.primaries, 1, "one primary button");
  assert.doesNotMatch(on.html, /install-when-nothing-is-running/, "the old always-there Install button is gone");
  const off = await settings({ status: ready(), autoUpdate: "off" });
  assert.match(off.html, /window.updates.card.ready\[what=aaaaaaa\]/);
  assert.doesNotMatch(off.html, /installs-by-itself/, "nothing says it installs by itself when that is off");
});

test("while an update installs, the card names its step and time, and opens the screen", async () => {
  const card = await settings({ status: building() });
  assert.match(card.html, /window.updates.stage.building… <time data-upd-since=/);
  assert.match(card.html, /data-act="upd18-open">window.updates.card.show-progress/);
  assert.doesNotMatch(card.html, /u-now|next-ready|up-to-date/, "nothing contradicts it");
  assert.equal(card.cards, 1);
});

test("a failure says why, with the build's key line and the kept version, and Try again when it is still offered", async () => {
  const failed = { ...building(), phase: "error", message: "The Beta build came out incomplete.", outcome: { kept: INSTALLED, backgroundStopped: false },
    failure: { stage: "building", line: "error TS2304: Cannot find name 'x'." } };
  const card = await settings({ status: failed });
  assert.match(card.html, /<b>window.updates.why.build<\/b><p>window.updates.screen.kept\[version=window.updates.screen.beta\[commit=0ff7d55\]\]<\/p>/, "plain words first (QA Q054)");
  assert.match(card.html, /<summary>window.updates.screen.details<\/summary><p>The Beta build came out incomplete.<\/p><code>error TS2304: Cannot find name 'x'.<\/code>/);
  assert.doesNotMatch(card.html, /window.updates.card.failed/);
  const look = await settings({ status: { ...ready(), phase: "error", message: "GitHub could not be reached.", outcome: null, failure: null } });
  assert.match(look.html, /window.updates.card.failed\[reason=GitHub could not be reached.\]/, "a look that failed, with no install, says so in the updater's words");
  assert.match(card.html, /data-act="u-now">window.updates.card.try-again/);
  assert.doesNotMatch(card.html, /up-to-date|next-ready/);
});

test("waiting for tasks says what it waits for and names them; no Update now then, and Move only for a diverged line", async () => {
  const plan = { until: "no task is working", reason: "A newer version is ready; it installs once no task is working." };
  const card = await settings({ status: ready(), plan, holding: [{ sessionId: "s1", name: "Invoice run" }] });
  assert.match(card.html, /window.updates.ready-installs-when\[until=no task is working\]/);
  assert.match(card.html, /data-act="chat" data-id="s1">Invoice run/);
  assert.doesNotMatch(card.html, /u-now/, "Update now would only wait for the same tasks");
  const apart = await settings({ status: { ...ready(), phase: "current", release: { channel: "beta", commit: NEW, available: false, otherLine: true, standing: "apart" } }, wait: "The newest Beta change … different line of work" });
  assert.match(apart.html, new RegExp(`data-act="u-other" data-commit="${NEW}"`));
  const ahead = await settings({ status: { ...ready(), phase: "current", release: { channel: "beta", commit: NEW, available: false, otherLine: true, standing: "ahead" } }, wait: "ahead" });
  assert.doesNotMatch(ahead.html, /u-other/, "a copy ahead of Beta is never offered a move back (#441)");
});

test("a diverged line is offered from the updater's own look, with update by itself off (nothing waits for it)", async () => {
  const message = "The newest Beta change (aaaaaaa) does not include this copy's change. It is installed only if you confirm it in Settings › Updates.";
  const apart = { ...ready(), phase: "current", message, release: { channel: "beta", commit: NEW, available: false, otherLine: true, standing: "apart" } };
  const off = await settings({ status: apart, autoUpdate: "off" });
  assert.match(off.html, new RegExp(`data-act="u-other" data-commit="${NEW}"`), "the confirmation the updater's words point to is there");
  assert.doesNotMatch(off.html, /window.updates.card.up-to-date/, "a different line is not called up to date");
  const ahead = await settings({ status: { ...apart, release: { ...apart.release, standing: "ahead" } }, autoUpdate: "off" });
  assert.doesNotMatch(ahead.html, /u-other/, "still never to a copy ahead of Beta (#441)");
});

test("up to date says so, with Check now; the switch says how often it really looks", async () => {
  const beta = await settings({ status: { ...ready(), phase: "current", message: "You have the newest Beta build (change aaaaaaa).", release: null } });
  assert.match(beta.html, /window.updates.card.up-to-date/);
  assert.match(beta.html, /data-act="u-check"/);
  assert.equal(beta.primaries, 0, "nothing to press when there is nothing to do");
  assert.match(beta.html, /window.updates.card.checks-every-few-minutes/, "Beta looks every five minutes");
  assert.doesNotMatch(beta.html, /checks-every-day/);
  const stable = await settings({ status: { ...ready(), phase: "current", release: null }, channel: "stable" });
  assert.match(stable.html, /window.settings.updates.checks-every-day/, "Stable looks once a day");
  assert.match(beta.html, /<details class="adv upd18-more" id="u-more"><summary>window.updates.card.more<\/summary>.*<channel\/>.*<\/details>/s, "the channel and the rest sit under More");
});

/* ---------- quiet background builds (the owner: "everything is slow and my computer is crying") ---------- */

test("while it waits for the owner, the status bar keeps the step's real time and says why it waits", async () => {
  const s = await screen(building({ automatic: true, paused: "typing" }));
  assert.match(s.run("statusItem()"), /window.updates.bar\[step=window.updates.stage.building\] <time data-upd-since="[^"]+">[\d:]+<\/time> · window.updates.paused.typing<\/button>/);
  const renders = s.renders.length;
  s.hear(building({ automatic: true, paused: "task" }));
  assert.ok(s.renders.length > renders, "a pause starting or ending redraws the status bar at once");
  assert.match(s.run("statusItem()"), /· window.updates.paused.task</);
  s.hear(building({ automatic: true, paused: null }));
  assert.doesNotMatch(s.run("statusItem()"), /paused/, "going on again, it says nothing more");
});

test("the card says plainly why a build takes longer: it is gentle, or it waits for the owner", async () => {
  const gentle = await settings({ status: building() });
  assert.match(gentle.html, /<p>window.updates.card.gentle<\/p>/, "low priority, in plain words");
  const typing = await settings({ status: building({ paused: "typing" }) });
  assert.match(typing.html, /<p>window.updates.card.paused-typing<\/p>/);
  assert.doesNotMatch(typing.html, /card.gentle/, "one reason at a time");
  const task = await settings({ status: building({ paused: "task" }) });
  assert.match(task.html, /<p>window.updates.card.paused-task<\/p>/);
  const swapping = building();
  swapping.stages = swapping.stages.map((one) => ({ ...one, state: one.id === "swapping" ? "running" : one.id === "restarting" ? "waiting" : "done" }));
  assert.doesNotMatch((await settings({ status: swapping })).html, /card.gentle|card.paused/, "the swap is not slowed, so nothing says it is");
  // A Stable install downloads, and builds nothing: nothing says it builds at low priority.
  const stable = building({ release: { channel: "stable", available: true, latestVersion: "0.20.0" }, target: { version: "0.20.0", commit: null },
    stages: [stage("downloading", "running", 0), stage("checking", "waiting"), stage("copying", "waiting"), stage("swapping", "waiting"), stage("restarting", "waiting")] });
  assert.doesNotMatch((await settings({ status: stable })).html, /card.gentle/, "a download is not a build");
  const stableWaits = await settings({ status: { ...stable, paused: "typing" } });
  assert.match(stableWaits.html, /<p>window.updates.card.paused-typing<\/p>/, "but it does hold back for the owner, and says so");
});
