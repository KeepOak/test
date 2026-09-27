/* "A change to Branch itself" in the thread (prototype selfCard): where a task in this conversation suggested a change to
   the gateway's settings (the gateway.propose tool) and that suggestion still waits (GET /api/never-break proposal), the
   card shows it under the reply that made it: the assistant's reason, each setting now and after, and whether the
   engine's throwaway try started cleanly. Apply is POST /api/never-break/proposal/accept, which saves it for the next
   start and says so in its own words; Not now is POST /api/never-break/proposal/discard. A suggestion whose try did not
   start cleanly can only be put away: the engine refuses to apply it, and the card says why in the engine's words.
   Once applied, Roll back is POST /api/never-break/rollback, which puts back the timings from before it (the engine
   refuses when they have changed since, in its own words). */

import { esc, render, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const G = { view: null, asked: null };
const proposing = (m) => (m.toolCalls ?? []).some((call) => call.name === "gateway.propose");

/* The waiting suggestion is this call's own only if it carries the same reason and every setting the call asked for;
   the engine keeps one suggestion and not which conversation made it, so an older call never claims a newer one. */
function madeBy(m, p) {
  return (m.toolCalls ?? []).some((call) => {
    if (call.name !== "gateway.propose") return false;
    let args;
    try { args = JSON.parse(call.arguments || "{}"); } catch { return false; } // arguments that are not JSON asked for nothing
    const change = args?.change && typeof args.change === "object" ? args.change : {};
    return String(args?.why ?? "").trim() === p.why && Object.keys(change).every((k) => change[k] === p.config[k]);
  });
}

async function readGateway() {
  try { G.view = await api("never-break"); } catch (error) { toast(error.message); G.view = null; }
}

/* After a conversation is drawn: read the gateway only when this conversation suggested a change, once per suggestion. */
export async function loadSelfChange(sessionId, messages) {
  const last = messages.filter(proposing).at(-1);
  const key = last ? `${sessionId}:${last.messageId}` : null;
  if (!key || G.asked === key) return;
  G.asked = key;
  await readGateway();
  if (G.view?.proposal || G.view?.accepted) render();
}

function changedRows(after, before, struck) {
  return Object.keys(after).filter((k) => k !== "mode" && k !== "workerEnv" && after[k] !== before[k])
    .map((k) => `<tr><th>${esc(k)}</th><td>${struck ? `<s>${esc(before[k])}</s>` : esc(before[k])}</td><td><b>${esc(after[k])}</b></td></tr>`).join("");
}
const lastBy = (messages, m, p) => madeBy(m, p) && messages.filter((x) => madeBy(x, p)).at(-1) === m;
const cardOf = (pill, why, rows, rest, acts) => `<div class="b"><div class="gut"></div><div><div class="card self10"><div class="card-h"><b>${ic("gear", "s")}${t("window.chat.self.title")}</b>${pill}</div>${why ? `<div class="sub">${esc(why)}</div>` : ""}
    <table class="cmp6"><thead><tr><th></th><th>${t("dashboard.area.now")}</th><th>${t("window.chat.self.after")}</th></tr></thead><tbody>${rows}</tbody></table>${rest}
    <p class="hint" data-css="margin:6px 0 0">${t("window.chat.self.asks")}${acts.undoable ? ` ${t("window.chat.self.kept")}` : ""}</p>
    <div class="acts">${acts.html}</div></div></div></div>`;

/* The card, under the last reply of this conversation that made the suggestion: while it waits (Apply, Not now); once
   accepted, the engine's journal of accepted changes (GET /api/never-break `accepted`) shows it applied with Roll back,
   and rolled back after that. */
export function selfCard(m, messages) {
  const p = G.view?.proposal, a = G.view?.accepted;
  if (p && lastBy(messages, m, p)) {
    const ok = p.check?.ok === true;
    const pill = ok ? `<span class="pill ok ml"><i></i>${t("window.chat.self.tried")}</span>` : "";
    const refused = ok || !p.check?.detail ? "" : `<p class="hint">${esc(p.check.detail)}</p>`;
    const apply = ok ? `<button class="btn pri sm" type="button" data-act="self-apply">${t("flowsBoards.focus.apply")}</button>` : "";
    return cardOf(pill, p.why, changedRows(p.config, G.view.config ?? {}, false), refused, { html: `${apply}<button class="btn ghost sm" type="button" data-act="self-no">${t("updates.busy.cancel")}</button>` });
  }
  if (!a || !lastBy(messages, m, { why: a.why, config: a.after })) return "";
  const back = !!a.rolledBackAt;
  const pill = back ? `<span class="pill idle ml"><i></i>${t("window.chat.self.rolled-back")}</span>` : `<span class="pill done ml"><i></i>${t("window.chat.self.applied")}</span>`;
  const acts = back ? "" : `<button class="btn sm" type="button" data-act="self-undo">${t("window.chat.self.roll-back")}</button><button class="btn ghost sm" type="button" data-act="setgo" data-v="self">${t("window.chat.self.see-every")}</button>`;
  return cardOf(pill, a.why, changedRows(a.after, a.before, !back), "", { html: acts, undoable: true });
}

async function answer(route) {
  try {
    const done = await api(route, {});
    if (done.note) toast(done.note);
    /* Hook (PARITY.md setup-delight-031, B4's leaf bursts): an accepted change is announced as the event "branch-made". */
    if (route.endsWith("/accept")) document.dispatchEvent(new CustomEvent("branch-made", { detail: { kind: "self-change" } }));
  } catch (error) { toast(error.message); }
  await readGateway();
  renderNow();
}

export function initSelfChange() {
  markLive(["self-apply", "self-no", "self-undo"]);
  on("self-apply", () => answer("never-break/proposal/accept"));
  on("self-no", () => answer("never-break/proposal/discard"));
  /* Roll back: POST /api/never-break/rollback puts the timings from before the accepted change back, for the next start. */
  on("self-undo", () => answer("never-break/rollback"));
}
