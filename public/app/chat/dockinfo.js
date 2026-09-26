/* The composer's own readouts (prototype renderChat's dock and pass 15's cost15), each from the engine:
   - the warning chip over the box when the account the model uses next is nearly used up: its first window has less than
     15% left (GET /api/usage/glance, a measured reading of the row marked in use), with its reset time; the dismiss is
     this window's until it next opens;
   - "$0.28 so far": what this conversation has cost, when every task in it was priced (GET /api/sessions/<id>/cost);
   - the flags inside the box: Temporary (the + menu's switch) and Asks first (the saved ask-first setting). */

import { esc, render } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t, language } from "../../i18n.js";

const D = { cost: new Map(), costAt: new Map(), glance: null, glanceAt: 0, dismissed: false };

/* ---------- nearly used up ---------- */
function ring(pct, size = 16) {
  const r = 9, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  return `<svg width="${size}" height="${size}" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="${r}" fill="none" stroke="var(--line-2)" stroke-width="3"/><circle cx="11" cy="11" r="${r}" fill="none" stroke="var(--warn)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 11 11)"/></svg>`;
}
function lowNow() {
  const row = (D.glance?.rows ?? []).find((r) => r.inUse && r.state === "measured" && r.windows?.[0]?.limit && r.windows[0].remaining != null);
  if (!row) return null;
  const w = row.windows[0], pct = Math.max(0, Math.min(100, Math.round((w.remaining / w.limit) * 100)));
  return pct < 15 ? { row, w, pct } : null;
}
export function lowChip() {
  const low = !D.dismissed && lowNow();
  if (!low) return "";
  const time = low.w.resetAt ? new Date(low.w.resetAt).toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" }) : "";
  const who = low.row.accountLabel ? `${low.row.connectionName} (${low.row.accountLabel})` : low.row.connectionName;
  const words = time ? t("window.chat.low.resets", { who, time }) : t("window.chat.low.nearly", { who });
  return `<div class="warn-chip">${ring(low.pct)}<span>${esc(words)}</span><button type="button" aria-label="${t("window.chat.low.dismiss")}" data-act="low-x">${ic("x", "s")}</button></div>`;
}
/* Read when the conversation is drawn, at most once a minute; only the owner's window is told (the engine refuses others). */
export function loadLow() {
  if (!E.loaded || E.profiles?.isOwner === false || Date.now() - D.glanceAt < 60000) return;
  D.glanceAt = Date.now();
  api("usage/glance").then((g) => { const before = !!lowNow(); D.glance = g; if (!!lowNow() !== before) render(); }, (error) => { if (error.status && error.status !== 403) toast(error.message); });
}

/* ---------- what this conversation has cost ---------- */
export function costLine(sid) {
  const amount = sid ? D.cost.get(sid) : null;
  if (typeof amount !== "number") return "";
  const model = E.state?.activeModel?.model || E.state?.activeModel?.presetName || "";
  return `<span class="cost15" data-tip="${esc(t("window.chat.cost.tip", { model }))}">${esc(t("window.chat.cost.so-far", { amount: `$${amount.toFixed(2)}` }))}</span>`;
}
export function loadCost(sid, again = false) {
  if (!sid || (!again && Date.now() - (D.costAt.get(sid) ?? 0) < 15000)) return;
  D.costAt.set(sid, Date.now());
  api(`sessions/${encodeURIComponent(sid)}/cost`).then((got) => {
    const amount = typeof got.amount === "number" ? got.amount : null;
    if (D.cost.get(sid) !== amount) { D.cost.set(sid, amount); if (S.chat === sid) render(); }
  }, (error) => toast(error.message));
}

/* ---------- Lockdown ---------- */
/** The prototype's red banner (lockBanner), shown by #app.locked while the engine's Lockdown is on; "Turn it off" is
   chat/approvals.js's `lock`. Exported so Settings and any other view can draw the same banner. */
export const lockBanner = () => `<div class="lock-banner">${ic("shield", "s")}${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div>`;

/* ---------- the flags inside the box ---------- */
export const flags = (temporary, asksFirst) => `${temporary ? `<span class="flag">${t("composer.temporary")}</span>` : ""}${asksFirst ? `<span class="flag">${t("window.chat.flag-asks-first")}</span>` : ""}`;

export function initDockInfo() {
  markLive(["low-x"]);
  on("low-x", () => { D.dismissed = true; render(); });
}
