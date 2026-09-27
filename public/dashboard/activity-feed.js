/* The dashboard's own copy of what was public/activity-feed.js before the old window was removed (#291), served at /dashboard/activity-feed.js. */
/**
 * The live feed on the Activity screen: what your assistant is doing, as it does it. It reads the
 * workspace's own event stream (`/api/events/stream`), which is Server-Sent Events behind the same
 * local key as everything else — so it is read with `fetch` rather than `EventSource`, because
 * `EventSource` cannot carry the key.
 *
 * It runs only while the Activity screen is open, and it stops the moment you leave it.
 */
import { t, formatDate } from "/dashboard/i18n.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
/* The kinds worth putting in front of a person; everything else is noise on this screen. */
const KINDS = ["run.started", "model.started", "model.loading", "model.completed", "tool.started", "tool.completed",
  "tool.failed", "policy.ask", "run.finished"];
/** Plain words for each kind, so nobody has to read an event name. */
const WORDS = {
  "run.started": "Started a task", "model.started": "Asked the model",
  "model.loading": "Waiting for the model on this computer to load",
  "model.completed": "The model answered", "tool.started": "Started using a tool",
  "tool.completed": "Finished using a tool", "tool.failed": "A tool did not work",
  "policy.ask": "Stopped to ask you something", "run.finished": "Finished a task",
};

let reader = null;
let rows = [];

/** One event as a line a person can read: what happened, what it touched, and when. */
function draw(event) {
  const about = event.data?.name ?? event.data?.label ?? event.data?.model ?? event.data?.question ?? "";
  const row = el("div", undefined, "feed-row");
  row.dataset.kind = event.kind;
  row.append(el("strong", [WORDS[event.kind] ?? event.kind, String(about).slice(0, 80)].filter(Boolean).join(" · ")));
  row.append(el("span", formatDate(event.createdAt, { timeStyle: "medium" }), "meta"));
  rows = [row, ...rows].slice(0, 40);
  const list = $("activity-feed");
  list.replaceChildren(...rows);
}

/** Breaks the stream into whole `event:`/`data:` blocks and hands each one on. */
export function parseEventStream(buffer, onEvent) {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let kind = "message", payload = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) kind = line.slice(6).trim();
      else if (line.startsWith("data:")) payload += line.slice(5).trim();
    }
    if (!payload) continue;
    try { onEvent(kind, JSON.parse(payload)); } catch { /* a half-written block is ignored */ }
  }
  return rest;
}

async function listen() {
  const token = sessionStorage.getItem("branch-token") || "";
  if (!token) return;
  const response = await fetch(`/api/events/stream?kind=${encodeURIComponent(KINDS.join(","))}`, {
    headers: { authorization: "Bearer " + token },
  });
  if (!response.ok || !response.body) throw new Error("The live feed could not be opened");
  reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = parseEventStream(buffer + decoder.decode(value, { stream: true }), (kind, payload) => {
      if (kind === "ready" || kind === "end") return;
      draw(payload);
    });
  }
}

/** Starts the feed when Activity is on screen, and stops it when it is not. */
export function watchActivityScreen() {
  const card = $("activity-feed-card");
  if (!card) return;
  const open = () => !$("runs").hidden;
  const start = async () => {
    if (reader || !open()) return;
    card.hidden = false;
    $("activity-feed").replaceChildren(el("p", t("activity.feedEmpty"), "meta"));
    try { await listen(); }
    catch { $("activity-feed").replaceChildren(el("p", t("activity.feedOff"), "meta")); }
    finally { reader = null; }
  };
  const stop = () => {
    reader?.cancel().catch(() => {});
    reader = null;
    rows = [];
    card.hidden = true;
  };
  new MutationObserver(() => (open() ? void start() : stop()))
    .observe($("runs"), { attributes: true, attributeFilter: ["hidden"] });
  if (open()) void start();
}

watchActivityScreen();
globalThis.branchActivityFeed = { parseEventStream };
