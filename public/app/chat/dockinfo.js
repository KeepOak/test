/* The composer's own readouts (prototype renderChat's dock, its "calmer window" pass and pass 15's cost15), from the engine:
   - the model chip's dot when the pooled account the model uses is nearly out of its plan window and the pool has another
     account to move to (GET /api/usage/glance, a measured reading of the row marked in use): the prototype's final
     form of the "nearly used up" chip, which that pass folds into the chip as .low7 with its tip;
   - "$0.28 so far": what this conversation has cost, when every task in it was priced (GET /api/sessions/<id>/cost);
   - the flags inside the box: Temporary (the + menu's switch) and Asks first (the saved ask-first setting). */

import { esc, render } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { ic, toast } from "../core/ui.js";
import { t } from "../../i18n.js";
import { lockdownOn } from "./approvals.js";

const D = { cost: new Map(), costAt: new Map(), glance: null, glanceAt: 0 };

/* ---------- nearly used up ---------- */
/** True while the account in use is under 15% of its plan window and its connection has another account to use next. */
export function accountLow() {
  const rows = D.glance?.rows ?? [];
  const row = rows.find((r) => r.inUse && r.account);
  const w = row?.windows?.find((x) => x.kind === "plan" && x.state === "measured" && x.limit && x.remaining != null);
  if (!w || !rows.some((r) => r.connection === row.connection && r.account && r.account !== row.account)) return false;
  return (w.remaining / w.limit) * 100 < 15;
}
/* Read when the conversation is drawn, at most once a minute; only the owner's window is told (the engine refuses others). */
export function loadLow() {
  if (!E.loaded || E.profiles?.isOwner === false || Date.now() - D.glanceAt < 60000) return;
  D.glanceAt = Date.now();
  api("usage/glance").then((g) => { const before = accountLow(); D.glance = g; if (accountLow() !== before) render(); }, (error) => { if (error.status && error.status !== 403) toast(error.message); });
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
/** The prototype's red banner (lockBanner), drawn while the engine's Lockdown is on (GET /api/lockdown, chat/approvals.js lockdownOn), as the places
   draw it; "Turn it off" is chat/approvals.js's `lock`. */
export const lockBanner = () => (!lockdownOn() ? "" : `<div class="lock-banner">${ic("lock", "s")}${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div>`);

/* ---------- the flags inside the box ---------- */
export const flags = (temporary, asksFirst) => `${temporary ? `<span class="flag">${t("composer.temporary")}</span>` : ""}${asksFirst ? `<span class="flag">${t("window.chat.flag-asks-first")}</span>` : ""}`;
