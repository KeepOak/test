/* The composer's two chips and their menus, 1:1 with the prototype's: which model answers and how long it thinks, and how
   much it may do. A conversation's own choice is kept with it (POST /api/sessions/<id>/model, POST /api/conversation-mode);
   before a conversation exists, the choice is what new ones start with (POST /api/models, POST
   /api/conversation-mode/settings). Lockdown is the engine's own switch (POST /api/lockdown, on and off; see approvals.js). */

import { esc, applyCss } from "../core/dom.js";
import { ic, openPop, closePop, mi, toast } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";
import { setLockdown, initApprovals } from "./approvals.js";
import { t } from "../../i18n.js";
import { initLocalPick } from "../flows/localpick.js";

const PMODES = [["auto", "look.season.auto", "window.chat.mode.auto-hint", "spark"], ["ask", "mode.ask", "window.chat.mode.ask-hint", "shield"], ["plan", "mode.plan", "window.chat.mode.plan-hint", "plan"], ["full", "window.chat.mode.full", "window.chat.mode.full-hint", "unlock"]];
const M = { sid: undefined, model: null, mode: null, at: 0, pending: null };

const presets = () => E.state?.models?.presets ?? [];
function current() {
  const eff = M.model?.effective ?? E.state?.activeModel ?? {};
  const reasoning = M.model ? M.model.reasoning ?? E.state?.models?.reasoning : E.state?.models?.reasoning;
  return { id: M.model?.preset ?? eff.presetId, name: eff.model || eff.presetName || "", provider: eff.provider ?? "", reasoning };
}
/* What the engine will really do here: Lockdown; for a new conversation, the mode picked for it or what new ones start
   on; for a conversation started from outside, Ask first whatever was picked; else its own pick, or the owner's policy. */
function modeNow() {
  if (M.mode?.locked) return "lock";
  if (!S.chat) return M.pending ?? M.mode?.newConversation ?? "ask";
  if (M.mode?.outside) return "ask";
  return M.mode?.mode ?? "follow";
}
/* The mode a new conversation's first message carries (POST /api/run mode), so it starts exactly as the chip says. */
export function startMode() {
  const mode = !S.chat && !M.mode?.locked ? M.pending ?? M.mode?.newConversation ?? null : null;
  M.pending = null;
  return mode ? { mode } : {};
}

export function chips() {
  const m = current(), mode = modeNow(), p = PMODES.find(([id]) => id === mode);
  const none = !E.state?.activeModel || m.id === "none"; // no model set up: plain words, no letter tile standing in for a logo
  const model = `<button type="button" class="chip-c" data-act="modelmenu2" data-tip="${t("window.chat.mode.model-tip")}">${none ? "" : logo(m.provider, m.name, 18)}<span class="lbl">${none ? t("window.chat.mode.no-model") : esc(m.name)}${m.reasoning ? " · " + esc(String(m.reasoning).toLowerCase()) : ""}</span>${ic("down", "s")}</button>`;
  const label = mode === "lock" ? t("lockdown.label") : mode === "follow" ? M.mode?.following?.label ?? "" : p ? t(p[1]) : "";
  const modeChip = `<button type="button" class="chip-c ${mode === "full" ? "full" : ""} ${mode === "lock" ? "lockd" : ""}" data-act="modemenu2" data-tip="${t("window.chat.mode.mode-tip")}">${ic(mode === "lock" ? "lock" : p?.[3] ?? "shield")}<span class="lbl">${esc(label)}</span>${ic("down", "s")}</button>`;
  return model + modeChip;
}

/* After each draw of the conversation: read the open conversation's model and mode, and draw again only if they changed. */
export async function loadChips() {
  const sid = S.chat ?? null;
  if (sid === M.sid && Date.now() - M.at < 5000) return;
  M.at = Date.now();
  const [model, mode] = await Promise.all([
    sid ? api(`sessions/${encodeURIComponent(sid)}/model`).catch(() => null) : null,
    api("conversation-mode" + (sid ? "?sessionId=" + encodeURIComponent(sid) : "")).catch(() => null),
  ]);
  const key = (x) => JSON.stringify(x);
  if (sid === M.sid && key(model) === key(M.model) && key(mode) === key(M.mode)) return;
  Object.assign(M, { sid, model, mode, at: Date.now() });
  redrawChips();
}

/* Only the two chips change, in place, so the conversation and whatever is being typed are left alone. */
function redrawChips() {
  const old = [...document.querySelectorAll('[data-act="modelmenu2"], [data-act="modemenu2"]')];
  if (old.length !== 2) return;
  const tmp = document.createElement("template");
  tmp.innerHTML = chips();
  applyCss(tmp.content);
  old[0].replaceWith(tmp.content.children[0]);
  old[1].replaceWith(tmp.content.children[0]);
}

function modelMenu() {
  const m = current(), preset = presets().find((x) => x.id === m.id);
  const levels = preset?.thinking?.levels ?? [];
  const rows = presets().map((x) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${x.id === m.id}" data-act="pick-model" data-v="${esc(x.id)}"><span class="tick">${ic("check", "s")}</span>${logo(x.provider, x.name, 22)}<span><span class="mi-t">${esc(x.name)}</span><span class="mi-s">${esc(x.model)}</span></span></button>`).join("");
  const think = levels.length ? `<hr><div class="row-in"><span>${t("field.thinking")}</span><span class="seg">${levels.map((lv) => `<button type="button" data-act="pick-think" data-v="${esc(lv)}" aria-pressed="${m.reasoning === lv}">${esc(lv[0].toUpperCase() + lv.slice(1))}</button>`).join("")}</span></div><p class="pp" data-css="padding-top:6px">${t("window.chat.mode.thinking-hint")}</p>` : "";
  return `<div class="ph">${t("window.chat.mode.which-model")}</div>${rows}${think}${mi("lp-open", "cpu", t("glance.local"))}${mi("setgo", "users", t("window.chat.mode.accounts"), "", 'data-v="accounts"')}`;
}

/* The menu offers what the conversation's model takes now: the model is read again as it opens (it may have been changed
   from Settings or another window since the chips were last read), and the chip is redrawn with it. */
async function openModelMenu(el) {
  if (el.getAttribute("aria-expanded") === "true") return openPop(el, modelMenu()); // its own button closes it
  M.sid = undefined;
  await loadChips();
  openPop(document.querySelector('[data-act="modelmenu2"]') ?? el, modelMenu());
}

function modeMenu() {
  const cur = modeNow(), locked = !!M.mode?.locked;
  const rows = PMODES.map(([id, n, d, icon], i) => {
    const choice = M.mode?.choices?.find((c) => c.mode === id);
    const blocked = choice && !choice.available ? choice.why : "";
    return `<button class="mi pm ${id === "full" ? "dz" : ""} ${blocked ? "blocked" : ""}" type="button" role="menuitemradio" aria-checked="${!locked && cur === id}" data-act="set-mode" data-v="${id}" ${blocked || locked ? "disabled" : ""}><span class="ico">${ic(icon, "s")}</span><span><span class="mi-t">${t(n)}</span><span class="mi-s">${esc(blocked || t(d))}</span></span><span class="r">${!locked && cur === id ? ic("check", "s") : `<kbd>${i + 1}</kbd>`}</span></button>`;
  }).join("");
  return `<div class="pt">${t("mode.question")}</div>${rows}<hr><div class="row-in"><span>${t("window.chat.mode.applies")}</span><span class="seg"><button type="button" data-act="scope" data-v="here" aria-pressed="true">${t("window.chat.mode.this-conversation")}</button><button type="button" data-act="scope" data-v="everywhere" aria-pressed="false">${t("window.chat.mode.everywhere")}</button></span></div><div class="row-in"><span data-css="color:var(--bad)">${ic("lock", "s")} ${t("lockdown.label")}</span><input class="sw" type="checkbox" id="pm-lock2" data-sw="lock" ${locked ? "checked" : ""} aria-label="${t("lockdown.label")}"></div>`; // state: the mode it sets applies to this conversation
}

/* The menu is drawn again with what was just chosen only while it is still open (its rows, `row`, are showing): a menu
   the person closed while the choice was being saved stays closed. */
function reopen(act, menu, row) {
  const a = document.querySelector(`[data-act="${act}"]`);
  if (a && document.querySelector(`#app > .pop [data-act="${row}"]`)) openPop(a, menu(), { force: true });
}

async function saveModel(change) {
  try {
    if (S.chat) await api(`sessions/${encodeURIComponent(S.chat)}/model`, change);
    else await api("models", "preset" in change ? { activePreset: change.preset } : { reasoning: change.reasoning });
    await refresh();
    M.sid = undefined;
    await loadChips();
  } catch (error) { toast(error.message); }
  reopen("modelmenu2", modelMenu, "pick-model");
}

async function setMode(v) {
  try {
    // Before a conversation exists the pick is for the one about to start; it goes with its first message.
    if (S.chat) await api("conversation-mode", { sessionId: S.chat, mode: v });
    else M.pending = v;
    M.sid = undefined;
    closePop();
    await loadChips();
  } catch (error) { toast(error.message); }
}

async function switchLockdown(on) {
  await setLockdown(on);
  M.sid = undefined;
  await loadChips();
  reopen("modemenu2", modeMenu, "set-mode");
}

export function initChips() {
  initLocalPick();
  /* A model picked on this computer (flows/localpick.js) answers from now on: the chip shows it at once. */
  document.addEventListener("branch-model-picked", () => { M.sid = undefined; loadChips(); });
  markLive(["modelmenu2", "modemenu2", "pick-model", "pick-think", "set-mode", "sw:pm-lock2"]);
  on("modelmenu2", (el) => openModelMenu(el));
  on("modemenu2", (el) => openPop(el, modeMenu()));
  on("pick-model", (el) => saveModel({ preset: el.dataset.v }));
  on("pick-think", (el) => saveModel({ reasoning: el.dataset.v }));
  on("set-mode", (el) => setMode(el.dataset.v));
  initApprovals();
  document.addEventListener("change", (e) => { if (e.target.id === "pm-lock2") switchLockdown(e.target.checked); });
  /* Shift+Tab in the message box moves to the next mode it may pick, in the menu's order; the cursor stays put. */
  document.addEventListener("keydown", (e) => {
    if (e.target.id !== "prompt" || e.key !== "Tab" || !e.shiftKey || document.querySelector(".slash6")) return;
    e.preventDefault();
    const now = modeNow();
    if (now === "lock") return;
    const open = PMODES.map(([id]) => id).filter((id) => M.mode?.choices?.find((c) => c.mode === id)?.available !== false);
    const from = open.indexOf(now === "follow" ? "ask" : now);
    setMode(open[(from + 1) % open.length]);
  });
}
