/* Automations, pass 17 (patch17b.js, SHOWCASE17 rows 8, 10, 14, 16, 17, 165, 167 and 168).
   - Scheduled › Standing orders and loops: the owner's standing orders (GET /api/autonomy/orders), each paused or kept
     again (POST /api/autonomy/orders/<id>/pause|resume, which the engine refuses in its own words while standing orders
     are switched off), and each conversation's /loop or /heartbeat (GET /api/autonomy/loops), stopped with POST
     /api/autonomy/loops/stop. A stopped loop only starts again from /loop in its conversation, so Start stays greyed, and
     so does "Add it": a standing order needs a start the engine can read, and nothing turns words into one yet.
   - Scheduled › Running on its own, more (Advanced): Pause all (POST /api/dashboard/automations, whose paused record is
     GET /api/dashboard/automations; neither waits on the browser dashboard's switch, and a refusal is said in the
     engine's words), then what an automation needs
     before it runs alone (GET /api/autonomy/readiness) and the ledger of what it decided (GET /api/autonomy/ledger), the
     days off schedules skip (GET /api/calendar), watches (GET /api/monitors), leads (GET /api/asks/leads) and forecasts
     (GET /api/asks/forecasts). "Export as CSV" saves the leads the engine listed as a CSV file (in a browser; the desktop
     app drops every download, so there it stays greyed), and "Save to Library" keeps the open forecasts as a Markdown
     document in Library › Documents (POST /api/documents). Adding a day off or a watch stays greyed: each needs a date or
     an address the dialog has no place for.
   - Triggers › Hooks (Advanced): addresses told when something happens (GET /api/webhooks) and the owner's hooks
     (GET /api/hooks). Sending a test reaches another computer and switching a hook on runs a program here, so both stay
     greyed for the security review; the engine has no route that runs the hook checks. */

import { esc, renderNow } from "../core/dom.js";
import { selectField } from "../core/gsel.js";
import { S, level } from "../core/state.js";
import { startConversation } from "../chat/chat.js";
import { ic, toast, openDlg, closeDlg } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { pill17, btn17 } from "./parts17.js";
import { onDemo17, demoPlace17, demoDlg17 } from "./demo17.js";
import { t, language } from "../../i18n.js";

const A = { orders: [], loops: [], paused: null, pauseKnown: false, pauseError: "" };

/* ---------- standing orders and loops ---------- */
const gap = (ms) => { const m = Math.round(Number(ms) / 60000); return m % 60 ? `${m}m` : `${m / 60}h`; };
function orderRow(o) {
  const kept = o.status === "active";
  return `<div class="prow"><span class="ico-tile">${ic("shield", "s")}</span><span class="grow"><b>${esc(o.order?.name)}</b><small>${esc(o.pausedBecause || o.order?.authority)}</small></span>${kept ? pill17("ok", t("window.places.automations17.keeping-it")) : pill17("idle", t("dashboard.standing.paused"))}${btn17("orderb17", kept ? t("autonomy.pause") : t("autonomy.resume"), `data-id="${esc(o.id)}" data-v="${kept ? "pause" : "resume"}"`, "btn ghost sm")}</div>`;
}
function loopRow(l) {
  const going = l.status !== "done";
  const button = going ? btn17("loopb17", t("action.local-stop-setup"), `data-v="${esc(l.kind)}" data-id="${esc(l.sessionId)}"`, "btn ghost sm") : btn17("loopstartb17", t("personal.tunnel.start"), "", "btn ghost sm");
  return `<div class="prow"><span class="ico-tile">${ic("retry", "s")}</span><span class="grow"><b><code class="code15">/${esc(l.kind)} ${esc(gap(l.everyMs))} ${esc(l.prompt)}</code></b><small>${esc(l.note)}</small></span>${going ? pill17("work", t("window.places.automations17.looping")) : pill17("idle", t("panels.state.stopped"))}${button}</div>`;
}
export const ordersSection = () => `<div class="sec x15-sec orders-b17"><div class="sec-h15"><h2>${t("window.places.automations17.standing-orders-and-loops")}</h2><button type="button" class="link15" data-act="ordersb17">${t("window.places.automations17.how-they-work")}</button></div><div class="rows">${A.orders.map(orderRow).join("")}${A.loops.map(loopRow).join("")}</div></div>`;

function ordersDlg() {
  const rows = A.orders.map((o) => `<div class="prow"><span class="ico-tile">${ic("shield", "s")}</span><span class="grow"><b>${esc(o.order?.name)}</b><small>${esc(o.order?.authority)}</small><small class="how-b17">${esc((o.order?.escalation ?? []).join(" · "))}</small></span></div>`).join("");
  openDlg({ title: t("window.places.automations17.standing-orders-and-loops"),
    body: `<p class="lead-b17">${t("window.places.automations17.a-standing-order-is-a-rule")}</p><div class="rows">${rows}</div><p class="lead-b17">${t("window.places.automations17.a-loop-repeats-a-prompt-on")} <code class="code15">/loop 10m check the build</code>.</p><div class="ctl"><b>${t("window.places.automations17.new-standing-order")}</b><span class="right"><input class="inp" id="order-in-b17" placeholder="${t("window.places.automations17.when-do")}" aria-label="${t("window.places.automations17.new-standing-order")}"></span><small>${t("window.places.automations17.say-it-in-words-branch-writes")}</small></div><p class="hint">${t("window.switch-on.order-why")}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("delight.ach.close")}</button><button class="btn pri" type="button" data-act="orderaddb17">${t("window.places.automations17.add-it")}</button>` });
}

/* stress test B003: "Add it" hands the words to Branch in a new conversation, in the box and not yet sent. Branch writes the
   standing order (its orders.propose tool) and it is kept only on the owner's yes. With no words, the box is focused. */
function orderInWords() {
  const box = document.getElementById("order-in-b17"), words = box?.value.trim();
  if (!words) { box?.focus(); return; }
  closeDlg();
  S.drafts.new = t("window.switch-on.order-ask", { words });
  startConversation();
}

async function changeOrder(el) {
  el.disabled = true;
  try { await api(`autonomy/orders/${encodeURIComponent(el.dataset.id)}/${el.dataset.v === "pause" ? "pause" : "resume"}`, {}); } catch (error) { toast(error.message); }
  await readKept();
  renderNow();
}
async function stopLoop(el) {
  el.disabled = true;
  try { await api("autonomy/loops/stop", { kind: el.dataset.v, sessionId: el.dataset.id }); } catch (error) { toast(error.message); }
  await readKept();
  renderNow();
}

/* ---------- running on its own, more ---------- */
function pauseRow() {
  const p = Boolean(A.paused);
  return `<div class="prow"><span class="ico-tile">${ic("pause", "s")}</span><span class="grow"><b>${p ? t("window.places.automations17.every-automation-is-paused") : t("window.places.automations17.pause-every-automation")}</b><small>${A.pauseError ? esc(A.pauseError) : p ? t("window.places.automations17.schedules-triggers-check-ins-and-standing") : t("window.places.automations17.one-switch-for-schedules-triggers-check")}</small></span>${btn17("pauseallb17", p ? t("window.places.automations17.resume-all") : t("window.places.automations17.pause-all"), `data-v="${p ? "resume" : "pause"}"`)}</div>`;
}
const DEMOS = [
  ["readiness", "check", ["Ready to run alone?", "Checks what an automation needs before it runs unattended, and keeps a ledger of what it decided alone.", "Check"]],
  ["holidays", "clock", ["Days off and holidays", "Schedules skip or move around the days you mark. Public holidays are filled in.", "See the calendar"]],
  ["watches", "eye", ["Watches", "A Trunk keeps an eye on a page, a price or a folder and speaks up when it changes.", "See"]],
  ["leads", "users", ["Leads", "A list a Trunk keeps up to date, such as suppliers to call back, and can export.", "Open the list"]],
  ["forecast", "spark", ["Forecasts", "A figure it projects from what it already knows, with how sure it is.", "See one"]],
];
export const onItsOwnSection = () => (level() >= 1 ? `<div class="sec x15-sec"><h2>${t("window.places.automations17.running-on-its-own-more")}</h2><div class="rows">${pauseRow()}${DEMOS.map(([k, i, w]) => demoPlace17(k, i, w)).join("")}</div></div>` : "");

async function pauseAll(el) {
  el.disabled = true;
  try { await api("dashboard/automations", { paused: el.dataset.v === "pause" }); } catch (error) { toast(error.message); }
  await readPaused();
  renderNow();
}

/* ---------- triggers › hooks ---------- */
const HOOKS = [
  ["outhook", "globe", ["Tell another app when something happens", "An address Branch calls when a task finishes, needs you, or fails.", "Add one"]],
  ["hooks", "term", ["Before and after each step", "A script of yours that runs when a task starts, before a tool runs, or when it ends.", "See hooks"]],
  ["turnhook", "chat", ["After each answer", "Runs something every time a Trunk finishes a reply, such as copying it to your notes.", "Set one up"]],
];
export const hooksSection = () => (level() >= 1 ? `<div class="sec x15-sec"><h2>${t("window.places.automations17.hooks")}</h2><div class="rows">${HOOKS.map(([k, i, w]) => demoPlace17(k, i, w)).join("")}</div></div>` : "");

const onOff = (on) => (on ? ["ok", t("accounts.switch.on")] : ["idle", t("accounts.switch.off")]);
const dayWords = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(language(), { weekday: "short", month: "short", day: "numeric" });

/* What the last leads and forecasts dialogs showed, so their primary acts on exactly those rows. */
const shown = { leads: [], forecasts: [] };
/* A cell that starts like a formula is written as text, so a spreadsheet never runs it (as src/asks/leads.ts leadsCsv does). */
const csvCell = (v) => { const text = String(v ?? ""), s = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function exportLeads() {
  const keys = [...new Set(shown.leads.flatMap((l) => Object.keys(l)))].filter((k) => shown.leads.some((l) => typeof l[k] !== "object"));
  const csv = [keys.join(","), ...shown.leads.map((l) => keys.map((k) => csvCell(typeof l[k] === "object" ? "" : l[k])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: "leads.csv" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function keepForecasts() {
  const title = t("asks.forecasts.title");
  const lines = shown.forecasts.map((f) => `- ${f.question} · ${Math.round(f.probability * 100)}%${f.resolveBy ? ` · ${f.resolveBy.slice(0, 10)}` : ""}`);
  await api("documents", { name: `${title}.md`, text: `# ${title}\n\n${lines.join("\n")}\n` });
  closeDlg();
  toast(t("window.shell.extras.saved-as-markdown-to-documents"));
}
function registerDemos() {
  onDemo17("readiness", { open: async () => {
    const { skills } = await api("autonomy/readiness");
    demoDlg17("readiness", { title: t("window.places.automations17.ready-to-run-alone"), go: t("window.places.automations17.open-the-ledger"),
      rows: skills.map((s) => [s.name, (s.missing ?? []).map((m) => m.fix || m.name).join(" · "), s.ready ? ["ok", t("strip.status.on")] : null]) });
  }, go: async () => {
    const { entries } = await api("autonomy/ledger?status=all");
    demoDlg17("ledger", { title: t("window.places.automations17.ready-to-run-alone"), lead: t("window.places.automations17.the-ledger-lists-every-choice-an"), rows: entries.map((e) => [e.title, e.detail, ["idle", e.status]]) });
  } });
  onDemo17("holidays", { open: () => openHolidays(), go: () => addDayOff() });
  onDemo17("watches", { open: async () => {
    const { monitors } = await api("monitors");
    demoDlg17("watches", { title: t("window.places.automations17.watches"), lead: t("window.places.automations17.what-your-trunks-are-watching"), go: t("window.places.automations17.add-a-watch"), rows: monitors.map((m) => [m.label || m.target, m.target, ["ok", t("window.places.automations17.watching")]]) });
  } });
  onDemo17("leads", { open: async () => {
    const { top } = await api("asks/leads");
    shown.leads = top;
    demoDlg17("leads", { title: t("window.places.automations17.leads"), go: t("window.places.automations17.export-as-csv"), rows: top.map((l) => [l.name, l.company, ["idle", t("ov.open")]]) });
  }, go: typeof window.branchDesktop === "object" ? undefined : () => exportLeads() });
  onDemo17("forecast", { open: async () => {
    const { open } = await api("asks/forecasts");
    shown.forecasts = open;
    demoDlg17("forecast", { title: t("asks.forecasts.title"), go: t("window.diagram.save-to-library"), rows: open.map((f) => [f.question, f.resolveBy ? dayWords(f.resolveBy.slice(0, 10)) : "", ["idle", `${Math.round(f.probability * 100)}%`]]) });
  }, go: () => keepForecasts() });
  onDemo17("outhook", { open: async () => {
    const { webhooks } = await api("webhooks");
    shown.webhooks = webhooks;
    demoDlg17("outhook", { title: t("window.places.automations17.tell-another-app-when-something-happens"), lead: t("window.places.automations17.branch-sends-a-short-message-to"), go: webhooks.length ? t("window.places.automations17.send-a-test") : "",
      rows: webhooks.map((w) => [w.name, [w.url, (w.events ?? []).join(", ")].filter(Boolean).join(" · "), onOff(w.enabled !== false)]),
      field: webhooks.length ? pickField("d17-hook", t("window.places.automations17.which-address"), webhooks.map((w) => [w.id, w.name || w.url])) : "" });
  }, go: () => sendTest() });
  onDemo17("hooks", { open: async () => {
    const { hooks } = await api("hooks");
    demoDlg17("hooks", { title: t("window.places.automations17.before-and-after-each-step"), lead: t("window.places.automations17.hooks-on-this-computer"), go: t("window.places.automations17.run-the-checks"), rows: hooks.map((h) => [h.event, h.executable, onOff(h.enabled)]) });
  } });
  onDemo17("turnhook", { open: async () => {
    const { hooks } = await api("hooks");
    demoDlg17("turnhook", { title: t("window.places.automations17.after-each-answer"), go: t("window.places.automations17.turn-it-on"), rows: hooks.filter((h) => h.event === "run.finished").map((h) => [h.executable, h.lastError ?? "", onOff(h.enabled)]) });
  } });
}

/* ---------- the two dialogs that need one thing typed or picked ---------- */
/* Days off: the owner's own list (GET /api/calendar daysOff), and Add a day off puts the date in the box on it. The
   calendar record is saved whole, as read (POST /api/calendar). */
const fieldRow = (id, label, input) => `<div class="ctl" data-css="margin-top:12px"><b>${esc(label)}</b><span class="right">${input}</span><small></small></div>`;
const pickField = (id, label, options) => fieldRow(id, label, selectField({ id, label, options }));
async function openHolidays() {
  const { settings } = await api("calendar");
  shown.calendar = settings;
  demoDlg17("holidays", { title: t("window.places.automations17.days-off-and-holidays"), lead: t("window.places.automations17.coming-up"), go: t("window.places.automations17.add-a-day-off"),
    rows: (settings?.daysOff ?? []).map((d) => [dayWords(d), "", ["idle", t("window.places.automations17.skips")]]),
    field: fieldRow("d17-day", t("window.places.automations17.which-day"), `<input class="inp" type="date" id="d17-day" aria-label="${esc(t("window.places.automations17.which-day"))}">`) });
}
async function addDayOff() {
  const day = document.getElementById("d17-day")?.value ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { toast(t("window.places.automations17.pick-a-day-first")); return; }
  const settings = shown.calendar ?? (await api("calendar")).settings;
  if (!settings.daysOff.includes(day)) await api("calendar", { ...settings, daysOff: [...settings.daysOff, day].sort() });
  await openHolidays();
}
/* Send a test: one test message to the address picked (POST /api/webhooks/<id>/test), and what it answered. */
async function sendTest() {
  const id = document.getElementById("d17-hook")?.value;
  if (!id) return;
  const answer = await api(`webhooks/${id}/test`, {});
  toast(answer.ok ? t("window.places.automations17.test-arrived") : t("window.places.automations17.test-failed", { why: answer.message ?? "" }));
}

/* ---------- reading ---------- */
async function readKept() {
  const [orders, loops] = await Promise.all([api("autonomy/orders"), api("autonomy/loops")]);
  A.orders = orders.orders ?? [];
  A.loops = loops.loops ?? [];
}
/* The paused record (GET /api/dashboard/automations), which the engine answers whether or not the browser dashboard is
   switched on. A refusal is said under the row in the engine's words, and the row keeps what it last knew. */
async function readPaused() {
  try { A.paused = (await api("dashboard/automations")).paused ?? null; A.pauseError = ""; } catch (error) { A.pauseError = error.message; }
  A.pauseKnown = true;
}

export async function readAutomations17(tab) {
  if (tab !== "scheduled") return { changed: false };
  const before = JSON.stringify(A);
  try {
    await readKept();
    if (level() >= 1) await readPaused();
  } catch (error) { return { changed: false, error }; }
  return { changed: JSON.stringify(A) !== before };
}

export function initAutomations17() {
  markLive(["ordersb17", "orderb17", "loopb17", "pauseallb17", "orderaddb17", "sw:order-in-b17", "sw:d17-day", "sw:d17-hook"]);
  on("orderaddb17", () => orderInWords());
  on("ordersb17", () => ordersDlg());
  on("orderb17", (el) => changeOrder(el));
  on("loopb17", (el) => stopLoop(el));
  on("pauseallb17", (el) => pauseAll(el));
  registerDemos();
}
