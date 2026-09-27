/* The owner's dashboard: the cards. Each card reads down the page the way docs/design.md says — a
   title, one sentence saying what it is for, what it shows, and at most one filled button — and says
   every word through a key in public/locales, with the English here only as the fallback while the
   language file loads. Nothing here writes a colour: states are the chips and meters of layout.css
   and dashboard.css, which read tokens. */
import { t, formatNumber, formatDate, language } from "/dashboard/i18n.js";

/* ---------- words and small builders ---------- */
const fill = (text, values) =>
  values ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : text;
/** A word from the language file, or the English given here while that file is still loading. */
export function say(key, english, values) {
  const word = t(key, values);
  return word === key ? fill(english, values) : word;
}
export function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
/** Words behind a key. A sentence with numbers in it is drawn afresh rather than re-translated in place. */
export function worded(tag, className, key, english, values) {
  const node = make(tag, className, say(key, english, values));
  if (!values) node.dataset.t = key;
  return node;
}
export function action(className, key, english, onClick) {
  const node = worded("button", className, key, english);
  node.type = "button";
  if (onClick) node.addEventListener("click", onClick);
  return node;
}
/** A way into the app window, on the page and tab that holds the thing. Same tab, so the key comes along. */
export function openLink(className, key, english, route) {
  const node = worded("a", className, key, english);
  node.href = `/#open=${route}`;
  return node;
}
export function taskLink(runId) {
  const node = worded("a", "lx-button", "place.inbox.lookInside", "Look inside");
  node.href = `/#task=${encodeURIComponent(runId)}`;
  return node;
}
export function card(id, [titleKey, titleEnglish], [purposeKey, purposeEnglish]) {
  const node = make("section", "card db-card");
  node.id = id;
  node.append(worded("h2", "", titleKey, titleEnglish), worded("p", "", purposeKey, purposeEnglish));
  return node;
}
function empty([titleKey, titleEnglish], [nextKey, nextEnglish]) {
  const box = make("div", "empty-state");
  box.append(worded("strong", "", titleKey, titleEnglish), worded("p", "", nextKey, nextEnglish));
  return box;
}
export function chip(tone, key, english) {
  return worded("span", `lx-chip lx-chip-${tone}`, key, english);
}
function row(title, meta, ...trailing) {
  const line = make("div", "lx-row");
  const words = make("div", "lx-row-words");
  words.append(make("strong", "", title));
  if (meta) words.append(make("span", "lx-row-meta", meta));
  line.append(words, ...trailing.filter(Boolean));
  return line;
}
function facts(pairs) {
  const list = make("dl", "db-facts");
  for (const [key, english, value] of pairs) list.append(worded("dt", "", key, english), make("dd", "", value));
  return list;
}

/* ---------- numbers people read ---------- */
export function ago(iso) {
  const when = Date.parse(iso ?? "");
  if (!Number.isFinite(when)) return "";
  const seconds = Math.round((when - Date.now()) / 1000);
  const steps = [[60, "second"], [3600, "minute"], [86400, "hour"], [604800, "day"], [Infinity, "week"]];
  const size = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };
  const [, unit] = steps.find(([limit]) => Math.abs(seconds) < limit);
  if (unit === "week" && Math.abs(seconds) > 4 * 604800) return formatDate(iso, { dateStyle: "medium" });
  return new Intl.RelativeTimeFormat(language(), { numeric: "auto" }).format(Math.round(seconds / size[unit]), unit);
}
function unit(value, name) {
  return formatNumber(value, { style: "unit", unit: name, unitDisplay: "short", maximumFractionDigits: name === "gigabyte" ? 1 : 0 });
}
export function span(seconds) {
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600), minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${unit(days, "day")} ${unit(hours, "hour")}`;
  if (hours) return `${unit(hours, "hour")} ${unit(minutes, "minute")}`;
  return unit(Math.max(minutes, 0), "minute");
}
export function bytes(value) {
  if (value === null || value === undefined) return "—";
  const [size, name] = value >= 1e9 ? [1e9, "gigabyte"] : value >= 1e6 ? [1e6, "megabyte"] : [1e3, "kilobyte"];
  return unit(value / size, name);
}
/** Money in words; a model with no price on file is said so, never shown as costing nothing. */
export function money(value) {
  if (value === null || value === undefined) return say("dashboard.spend.noPrice", "no price on file");
  if (value > 0 && value < 0.01) return say("dashboard.spend.lessThanCent", "less than $0.01");
  return formatNumber(value, { style: "currency", currency: "USD", maximumFractionDigits: value < 1 ? 4 : 2 });
}

/* ---------- Now ---------- */
function branchCard(summary) {
  const now = summary.now;
  const box = card("db-branch", ["dashboard.branch.title", "Branch right now"],
    ["dashboard.branch.purpose", "Whether it is running, which model answers, and where it runs."]);
  const head = make("div", "db-card-head");
  head.append(chip("ok", "dashboard.running", "Running"), make("span", "lx-row-meta", `Branch Agent ${now.version}`));
  const model = now.model.local ? `${now.model.name} · ${say("dashboard.branch.local", "on this computer")}` : now.model.name;
  box.append(head, facts([
    ["dashboard.branch.upFor", "Running for", span(now.uptimeSeconds)],
    ["dashboard.branch.where", "Runs", now.where === "background"
      ? say("dashboard.where.background", "In the background, with the window closed")
      : say("dashboard.where.window", "In the app window")],
    ["dashboard.branch.model", "Model", `${model} (${now.model.model})`],
    ["dashboard.branch.connection", "Connection", now.model.connection],
    ["lockdown.label", "Lockdown", now.lockdown ? say("dashboard.on", "On") : say("dashboard.off", "Off")],
  ]), openLink("lx-button", "dashboard.openBranch", "Open Branch", "chat"));
  return box;
}

function workingCard(summary, actions) {
  const box = card("db-working", ["dashboard.working.title", "Working now"],
    ["dashboard.working.purpose", "Tasks running at this moment. Stop ends one where it is."]);
  const list = make("div", "lx-list");
  for (const task of summary.now.working) {
    const stop = summary.access !== "read"
      ? action("lx-button", "dashboard.stop", "Stop", (event) => actions.stop(task.runId, event.currentTarget)) : null;
    const actionsBox = make("div", "lx-row-actions");
    actionsBox.append(...[stop, taskLink(task.runId)].filter(Boolean));
    list.append(row(task.prompt, say("dashboard.started", "Started {time}", { time: ago(task.startedAt) }), actionsBox));
  }
  box.append(summary.now.working.length ? list : empty(["dashboard.working.emptyTitle", "Nothing is working right now."],
    ["dashboard.working.emptyNext", "Anything your assistant starts shows here, with a way to stop it."]));
  return box;
}

function needsCard(summary) {
  const needs = summary.now.needsYou;
  const box = card("db-needs", ["dashboard.needs.title", "Needs you"],
    ["dashboard.needs.purpose", "Questions a task stopped to ask, approvals waiting for your yes, and suggested changes to what it remembers."]);
  const list = make("div", "lx-list");
  for (const item of needs.questions)
    list.append(row(item.text, say("dashboard.needs.question", "Asked you {time}", { time: ago(item.at) }), chip("warn", "dashboard.needs.answer", "Answer")));
  for (const item of needs.approvals)
    list.append(row(item.text, say("dashboard.needs.approval", "Waiting for your yes"), chip("warn", "dashboard.needs.yes", "Yes or no")));
  if (needs.memory)
    list.append(row(say("dashboard.needs.memory", "Suggested memory changes: {count}", { count: formatNumber(needs.memory) }), null));
  box.append(needs.total ? list : empty(["place.inbox.nothingWaits", "Nothing needs you right now."],
    ["dashboard.needs.emptyNext", "When a task needs an answer it waits here and in the Inbox."]));
  const review = openLink("lx-button lx-primary", "place.inbox.review", "Review what needs you", "inbox:needs");
  box.append(review);
  return box;
}

export function nowCards(summary, actions) {
  return [branchCard(summary), needsCard(summary), workingCard(summary, actions)];
}

/* ---------- Health ---------- */
const STATE = {
  connected: ["ok", "dashboard.state.connected", "Working"],
  failing: ["bad", "dashboard.state.failing", "Failing"],
  unused: ["idle", "dashboard.state.unused", "Not used yet"],
  healthy: ["ok", "dashboard.standing.healthy", "Working"],
  never: ["idle", "dashboard.standing.never", "Never run"],
  paused: ["warn", "dashboard.standing.paused", "Paused"],
  running: ["idle", "dashboard.standing.running", "Running now"],
};
const stateChip = (state) => chip(...(STATE[state] ?? STATE.unused));

function linksCard(summary) {
  const { connections, channels } = summary.health;
  const box = card("db-links", ["dashboard.links.title", "Connections and chat apps"],
    ["dashboard.links.purpose", "The model connections and chat apps that reach Branch, and whether each one is working."]);
  const models = make("div", "lx-list");
  for (const item of connections) {
    const meta = item.reason || (item.lastOkAt ? say("dashboard.links.lastUsed", "Last answered {time}", { time: ago(item.lastOkAt) }) : item.model);
    models.append(row(item.name, meta, stateChip(item.state)));
  }
  const chats = make("div", "lx-list");
  for (const item of channels) {
    const parts = [item.lastMessageAt ? say("dashboard.links.lastMessage", "Last message {time}", { time: ago(item.lastMessageAt) })
      : say("dashboard.links.noMessage", "No message yet")];
    if (item.waiting) parts.push(say("dashboard.links.waiting", "Waiting to send: {count}", { count: item.waiting }));
    if (item.gaveUp) parts.push(say("dashboard.links.gaveUp", "Gave up: {count}", { count: item.gaveUp }));
    if (item.reason) parts.push(item.reason);
    chats.append(row(`${item.name} · ${item.kind}`, parts.join(" · "), stateChip(item.state)));
  }
  box.append(worded("p", "lx-eyebrow", "dashboard.links.models", "Model connections"), models,
    worded("p", "lx-eyebrow", "dashboard.links.chats", "Chat apps"),
    channels.length ? chats : worded("p", "db-quiet", "dashboard.links.noChats", "No chat app is connected."),
    openLink("lx-button", "dashboard.links.open", "Open Channels", "customize:channels"));
  return box;
}

function automationsCard(summary) {
  const { schedules, triggers, workflows } = summary.health.automations;
  const box = card("db-automations", ["dashboard.automations.title", "Automations"],
    ["dashboard.automations.purpose", "Work that runs on its own, and whether each piece worked the last time."]);
  const all = [...schedules, ...workflows];
  const count = (standing) => all.filter((item) => item.standing === standing).length;
  if (!all.length && !triggers.length) {
    box.append(empty(["dashboard.automations.emptyTitle", "Nothing runs on its own yet."],
      ["dashboard.automations.emptyNext", "Scheduled tasks, workflows and triggers show here once you make one in Automations."]));
  } else {
    box.append(make("p", "db-quiet", say("dashboard.automations.counts",
      "{healthy} working · {failing} failing · {never} never run · {paused} paused",
      { healthy: count("healthy"), failing: count("failing"), never: count("never"), paused: count("paused") })));
    const list = make("div", "lx-list");
    for (const item of [...all].sort((a, b) => rank(a) - rank(b)).slice(0, 8)) list.append(automationRow(item));
    const on = triggers.filter((item) => item.on).length;
    box.append(list, make("p", "db-quiet", say("dashboard.automations.triggers", "Triggers: {on} on, {off} off", { on, off: triggers.length - on })));
  }
  box.append(openLink("lx-button", "dashboard.automations.open", "Open Automations", "automations:scheduled"));
  return box;
}
const rank = (item) => ["failing", "paused", "running", "never", "healthy"].indexOf(item.standing);
function automationRow(item) {
  const parts = [];
  if (item.lastRunAt) parts.push(say("dashboard.automations.last", "Last ran {time}", { time: ago(item.lastRunAt) }));
  if (item.nextAt) parts.push(say("dashboard.automations.next", "Next {time}", { time: ago(item.nextAt) }));
  if (item.reason) parts.push(item.reason);
  return row(item.name, parts.join(" · "), stateChip(item.standing));
}

const RESTART = {
  "restart.ready": "Branch works in the background and starts by itself, so it can be restarted from here.",
  "restart.windows": "On Windows, close Branch from its icon by the clock and open it again.",
  "restart.window": "Branch is running in its window here. Close the window and open Branch again to restart it.",
  "restart.by-hand": "This copy of Branch was started by hand, so nothing would start it again. Stop it and start it yourself.",
};
export const restartWords = (reason) => say(`dashboard.${reason}`, RESTART[reason] ?? RESTART["restart.window"]);

function engineCard(summary) {
  const engine = summary.health.engine;
  const box = card("db-engine", ["dashboard.engine.title", "Engine and updates"],
    ["dashboard.engine.purpose", "The part of Branch that keeps working with the window closed, and how the last update went."]);
  const update = engine.update;
  const started = update.firstStartHealthy === true ? ["dashboard.update.healthy", "This version started cleanly after its update."]
    : update.firstStartHealthy === false ? ["dashboard.update.unhealthy", "This version had trouble the first time it started. The health check under Settings → Advanced says what."]
      : ["dashboard.update.unknown", "No update has been installed since this copy was set up."];
  box.append(
    worded("p", "", ...(engine.mode === "daemon" ? ["dashboard.engine.background", "Working in the background."]
      : ["dashboard.engine.window", "Running inside the app window."])),
    make("p", "db-quiet", restartWords(engine.restart.reason)),
    worded("p", "", ...started),
    make("p", "db-quiet", say("dashboard.update.copies", "Safety copies kept before updates: {count}", { count: update.safetyCopies })),
    openLink("lx-button", "settings.page.about", "Updates & about", "settings:about"));
  return box;
}

/* The meter and its 75% / 92% steps follow OpenClaw's Control UI (MIT; see THIRD_PARTY_NOTICES.md). */
function meter(labelKey, english, used, total) {
  const wrap = make("div", "db-meter-row");
  const share = total ? Math.min(1, Math.max(0, used / total)) : 0;
  const bar = make("div", "db-meter");
  bar.setAttribute("role", "meter");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(Math.round(share * 100)));
  bar.setAttribute("aria-label", say(labelKey, english));
  bar.dataset.level = share >= 0.92 ? "bad" : share >= 0.75 ? "warn" : "ok";
  const fillBar = make("span");
  fillBar.style.width = `${Math.round(share * 100)}%`;
  bar.append(fillBar);
  wrap.append(worded("span", "db-meter-label", labelKey, english),
    make("span", "lx-row-meta", say("dashboard.computer.of", "{used} of {total}", { used: bytes(used), total: bytes(total) })), bar);
  return wrap;
}

function computerCard(summary) {
  const res = summary.health.resources;
  const box = card("db-computer", ["dashboard.computer.title", "This computer"],
    ["dashboard.computer.purpose", "How much room Branch is using, and how much is left."]);
  const memory = res.computerMemory;
  box.append(meter("dashboard.computer.memory", "Memory in use", memory.total - memory.free, memory.total));
  if (res.disk) box.append(meter("dashboard.computer.disk", "Disk in use where Branch keeps its data", res.disk.total - res.disk.free, res.disk.total));
  box.append(facts([
    ["dashboard.computer.engine", "Branch itself", bytes(res.engineMemory)],
    ["dashboard.computer.database", "Saved data", bytes(res.databaseBytes)],
  ]));
  return box;
}

const PROBLEM = {
  task: ["dashboard.errors.task", "A task stopped"],
  tool: ["dashboard.errors.tool", "A tool did not work"],
  engine: ["dashboard.errors.engine", "Branch itself hit a problem"],
};
function errorsCard(summary) {
  const box = card("db-errors", ["dashboard.errors.title", "Recent problems"],
    ["dashboard.errors.purpose", "What went wrong in the last seven days, newest first."]);
  const list = make("div", "lx-list");
  for (const item of summary.health.errors) {
    const [key, english] = PROBLEM[item.what] ?? PROBLEM.engine;
    list.append(row(item.text || say(key, english), `${say(key, english)} · ${ago(item.at)}`, item.runId ? taskLink(item.runId) : null));
  }
  box.append(summary.health.errors.length ? list : empty(["dashboard.errors.emptyTitle", "Nothing went wrong this week."],
    ["dashboard.errors.emptyNext", "Problems show here in the words they were recorded in, with a way into the task."]));
  return box;
}

export function healthCards(summary) {
  return [linksCard(summary), automationsCard(summary), engineCard(summary), computerCard(summary), errorsCard(summary)];
}

/* ---------- Spend ---------- */
function bars(rows, labelOf, costOf) {
  const list = make("div", "db-bars");
  const top = Math.max(...rows.map(costOf), 0);
  rows.slice(0, 6).forEach((item, index) => {
    const line = make("div", "db-bar-row");
    const bar = make("span", `db-bar db-bar-${(index % 8) + 1}`);
    bar.style.width = `${top > 0 ? Math.max(2, Math.round((costOf(item) / top) * 100)) : 2}%`;
    const unpriced = item.unpriced ?? item.unpricedRuns ?? 0;
    const amount = unpriced && !costOf(item) ? money(null) : money(costOf(item));
    line.append(make("span", "db-bar-name", labelOf(item)), make("span", "db-bar-amount", amount), bar);
    list.append(line);
  });
  return list;
}
function spendBody(box, period) {
  const hasAny = period.pricedRuns + period.unpricedRuns > 0 || period.byProject.length > 0;
  if (!hasAny) {
    box.append(empty(["dashboard.spend.noneTitle", "No task finished in this time."],
      ["dashboard.spend.noneNext", "Costs are worked out on this computer from your own tasks as they finish."]));
    return;
  }
  /* Nothing priced means nobody knows the figure; it is never shown as costing nothing. */
  box.append(make("p", "db-figure", period.pricedRuns || period.cost ? money(period.cost) : money(null)));
  if (period.unpricedRuns)
    box.append(make("p", "db-quiet", say("dashboard.spend.unpriced",
      "Tasks on a model with no price on file, not in this figure: {count}", { count: period.unpricedRuns })));
  box.append(worded("p", "lx-eyebrow", "dashboard.spend.byConnection", "By connection"),
    bars(period.byConnection, (item) => item.name, (item) => item.cost),
    worded("p", "lx-eyebrow", "dashboard.spend.byProject", "By project"),
    bars(period.byProject, (item) => item.name, (item) => item.cost));
}

export function spendCards(summary) {
  const today = card("db-today", ["dashboard.today.title", "Today"],
    ["dashboard.today.purpose", "What today's tasks cost, by connection and by project."]);
  spendBody(today, summary.spend.today);
  const month = card("db-month", ["dashboard.month.title", "This month"],
    ["dashboard.month.purpose", "What this month has cost so far, and what it is heading for."]);
  const forecast = summary.spend.month.forecast;
  month.append(forecast === null
    ? worded("p", "", "dashboard.spend.noForecast", "No model used this month has a price on file, so the month cannot be guessed at.")
    : make("p", "", say("dashboard.spend.forecast", "At this pace, about {amount} this month.", { amount: money(forecast) })));
  spendBody(month, summary.spend.month);
  month.append(openLink("lx-button", "settings.page.data", "Data & usage", "settings:data"));
  return [today, month];
}

/* ---------- Controls ---------- */
const PAGES = [["general", "General"], ["assistant", "Assistant"], ["appearance", "Appearance"], ["notifications", "Notifications"],
  ["models", "Models"], ["voice", "Voice"], ["permissions", "Permissions"], ["computer", "Computer & browser"],
  ["secrets", "Secrets"], ["data", "Data & usage"], ["advanced", "Advanced"], ["about", "Updates & about"]];

function controlsCard(summary, actions) {
  const box = card("db-controls", ["dashboard.controls.title", "Controls"],
    ["dashboard.controls.purpose", "The few switches worth reaching from anywhere."]);
  if (summary.access !== "full") {
    box.append(worded("p", "db-quiet", ...(summary.access === "run"
      ? ["dashboard.runOnly", "This key may stop tasks but not change anything else, so only Stop is offered."]
      : ["dashboard.readOnly", "This key may only look, so nothing here can be changed. Use the key of the computer Branch runs on."])));
    return box;
  }
  const paused = summary.paused;
  box.append(paused
    ? make("p", "", say("dashboard.controls.pausedNote", "Paused from here {time}: scheduled tasks {schedules}, triggers {triggers}. Anything you paused yourself stays paused.",
      { time: ago(paused.at), schedules: paused.schedules.length, triggers: paused.triggers.length }))
    : worded("p", "", "dashboard.controls.pauseNote", "Pausing stops every scheduled task and trigger from starting. Starting them again brings back only what was paused here."));
  box.append(paused
    ? action("", "dashboard.controls.resume", "Start the paused automations again", (event) => actions.pause(false, event.currentTarget))
    : action("", "dashboard.controls.pause", "Pause all automations", (event) => actions.pause(true, event.currentTarget)));
  const row2 = make("div", "lx-row-actions db-controls-row");
  row2.append(summary.now.lockdown
    ? action("lx-button", "dashboard.controls.lockdownOff", "Turn Lockdown off", (event) => actions.lockdown(false, event.currentTarget))
    : action("lx-button", "dashboard.controls.lockdownOn", "Turn Lockdown on", (event) => actions.lockdown(true, event.currentTarget)));
  const restart = action("lx-button", "dashboard.controls.restart", "Restart Branch", (event) => actions.restart(event.currentTarget));
  restart.disabled = !summary.health.engine.restart.possible;
  if (restart.disabled) restart.title = restartWords(summary.health.engine.restart.reason);
  row2.append(restart);
  box.append(row2, make("p", "db-quiet", say("dashboard.controls.lockdownNote",
    "While Lockdown is on, commands, programs, your screen and your other devices are refused without asking, nothing is sent out, and everything else waits for your yes.")));
  return box;
}

function pagesCard() {
  const box = card("db-pages", ["dashboard.pages.title", "Settings pages"],
    ["dashboard.pages.purpose", "Open any page of Settings in Branch."]);
  const list = make("nav", "db-pages");
  list.setAttribute("aria-label", say("nav.settings", "Settings"));
  for (const [page, english] of PAGES) list.append(openLink("lx-button", `settings.page.${page}`, english, `settings:${page}`));
  box.append(list);
  return box;
}

export function controlsCards(summary, actions) {
  return [controlsCard(summary, actions), pagesCard()];
}
