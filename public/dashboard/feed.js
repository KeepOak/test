/* The dashboard's Activity card: every step your assistant takes, newest first, narrowed down by
   what the owner picks. It starts from the steps the summary brought and, while the dashboard is on,
   carries on with the workspace's own live updates (/api/events/stream) — read with fetch, because
   EventSource cannot carry the key. The stream closes itself after a while; the card simply opens it
   again from the last step it saw, so nothing is shown twice and nothing is missed. */
import { parseEventStream } from "/dashboard/activity-feed.js";
import { ago, card, make, say, taskLink, worded } from "/dashboard/sections.js";

const KINDS = {
  "run.started": ["tasks", "Started a task"], "run.finished": ["tasks", "Finished a task"],
  "model.started": ["tasks", "Asked the model"], "model.completed": ["tasks", "The model answered"],
  "tool.started": ["tools", "Started using a tool"], "tool.completed": ["tools", "Finished using a tool"],
  "tool.failed": ["problems", "A tool did not work"], "delivery.failed": ["problems", "A message could not be sent"],
  "policy.ask": ["questions", "Stopped to ask you something"], "schedule.fired": ["tasks", "An automation ran"],
};
const FILTERS = [["all", "Everything"], ["tasks", "Tasks"], ["tools", "Tools"], ["problems", "Problems"], ["questions", "Questions"]];
const KEEP = 60;

let steps = [];
let lastId = 0;
let chosen = "all";
let reader = null;
let wanted = false;
let host = null;

const about = (event) => String(event.about ?? event.data?.name ?? event.data?.label ?? event.data?.model
  ?? event.data?.question ?? event.data?.error ?? "").slice(0, 80);

function stepRow(step) {
  const [, english] = KINDS[step.kind] ?? ["tasks", step.kind];
  const line = make("div", "lx-row db-step");
  line.dataset.kind = step.kind;
  const words = make("div", "lx-row-words");
  const title = say(`dashboard.kind.${step.kind}`, english);
  words.append(make("strong", "", step.about ? `${title} · ${step.about}` : title), make("span", "lx-row-meta", ago(step.createdAt)));
  line.append(words, taskLink(step.runId));
  return line;
}

function draw() {
  if (!host) return;
  const list = host.querySelector(".db-steps");
  const shown = steps.filter((step) => chosen === "all" || KINDS[step.kind]?.[0] === chosen).slice(0, 25);
  list.replaceChildren(...shown.map(stepRow));
  if (!shown.length) list.append(worded("p", "lx-empty", "activity.feedEmpty",
    "Nothing is happening right now. Anything your assistant does shows here as it happens."));
}

function filters() {
  const group = make("div", "seg db-filters");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", say("dashboard.filter.label", "Show"));
  for (const [id, english] of FILTERS) {
    const choice = worded("button", "segmented-option", `dashboard.filter.${id}`, english);
    choice.type = "button";
    choice.dataset.filter = id;
    choice.setAttribute("aria-pressed", String(chosen === id));
    choice.addEventListener("click", () => {
      chosen = id;
      for (const other of group.children) other.setAttribute("aria-pressed", String(other.dataset.filter === id));
      draw();
    });
    group.append(choice);
  }
  return group;
}

function setLine(key, english) {
  const line = host?.querySelector(".db-feed-state");
  if (!line) return;
  line.dataset.t = key;
  line.textContent = say(key, english);
}

/** The card, drawn afresh with each summary; the steps it has already seen are kept. */
export function activityCard(summary, live) {
  for (const step of [...summary.activity.events].reverse()) remember(step);
  lastId = Math.max(lastId, summary.activity.lastEventId);
  host = card("db-activity", ["activity.feed", "Happening now"],
    ["dashboard.activity.purpose", "Each step your assistant takes, as it takes it. Pick what to show."]);
  const state = make("p", "db-quiet db-feed-state");
  state.setAttribute("role", "status");
  host.append(filters(), state, make("div", "lx-list db-steps"));
  draw();
  if (live) setLine(reader ? "dashboard.feed.live" : "dashboard.feed.opening", reader ? "Live updates are on." : "Opening live updates…");
  else setLine("dashboard.feed.once", "Live updates are off in this mode. Press Refresh to see the latest.");
  return host;
}

function remember(step) {
  if (!KINDS[step.kind] || steps.some((known) => known.id === step.id)) return;
  steps = [{ id: step.id, runId: step.runId, kind: step.kind, createdAt: step.createdAt, about: about(step) }, ...steps].slice(0, KEEP);
}

async function listen(key) {
  const kinds = encodeURIComponent(Object.keys(KINDS).join(","));
  const response = await fetch(`/api/events/stream?kind=${kinds}&after=${lastId}`, { headers: { authorization: `Bearer ${key}` } });
  if (!response.ok || !response.body) throw new Error("no stream");
  reader = response.body.getReader();
  setLine("dashboard.feed.live", "Live updates are on.");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = parseEventStream(buffer + decoder.decode(value, { stream: true }), (kind, payload) => {
      if (kind === "ready" || kind === "end" || !payload?.id) return;
      lastId = Math.max(lastId, payload.id);
      remember(payload);
      draw();
    });
  }
}

/** Keeps live updates open while wanted, opening them again a few seconds after they close. */
export async function startLive(key) {
  if (wanted) return;
  wanted = true;
  while (wanted) {
    try { await listen(key); } catch { setLine("dashboard.feed.stopped", "Live updates stopped. Trying again…"); }
    reader = null;
    if (wanted) await new Promise((resume) => setTimeout(resume, 3000));
  }
}
export function stopLive() {
  wanted = false;
  reader?.cancel().catch(() => {});
  reader = null;
}
