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
import { reason } from "../core/why.js";
import { logo } from "../core/logos.js";
import { setLockdown, initApprovals } from "./approvals.js";
import { t } from "../../i18n.js";
import { accountLow } from "./dockinfo.js"; // parity B1
import { initLocalPick } from "../flows/localpick.js";
import { trunkCanUse, trunkModelNote } from "../places/switch-on.js"; // stress test B008

const PMODES = [["auto", "look.season.auto", "window.chat.mode.auto-hint", "spark"], ["ask", "mode.ask", "window.chat.mode.ask-hint", "shield"], ["plan", "mode.plan", "window.chat.mode.plan-hint", "plan"], ["full", "window.chat.mode.full", "window.chat.mode.full-hint", "unlock"]];
const M = { sid: undefined, model: null, mode: null, at: 0, pending: null, pendingModel: null, account: null, runKey: "", limits: [] };

const presets = () => E.state?.models?.presets ?? [];
/* The model's own name where the engine has one (GET /api/state models.presets[].modelName, "GPT-6 Sol"), else its id; and
   the level a reply really runs at: the conversation's own, else what its connection starts at (presets[].startsAt: the
   connection's own, then the workspace's Thinking, then the model's). */
function current() {
  const eff = M.model?.effective ?? E.state?.activeModel ?? {};
  // QA retest 2026-09-28 (m10): before a first message, what was picked for this conversation (M.pendingModel).
  const own = S.chat ? null : M.pendingModel;
  const id = own?.preset ?? M.model?.preset ?? eff.presetId;
  const preset = presets().find((p) => p.id === id);
  const picked = own?.preset && preset ? { provider: preset.provider, presetName: preset.name } : null;
  const reasoning = own?.reasoning ?? M.model?.reasoning ?? preset?.startsAt ?? E.state?.models?.reasoning;
  // The account this conversation now answers through, once it is not the list's first choice (GET /api/accounts/session
  // chosenHere: picked here, or moved to after a plan limit), in the engine's own words.
  const account = M.account?.chosenHere && M.account?.label ? M.account.label : "";
  return { id, name: preset?.modelName || (picked ? preset?.model : eff.model) || (picked ?? eff).presetName || "", provider: (picked ?? eff).provider ?? "", reasoning, account };
}
/* What the engine will really do here: Lockdown; for a new conversation, the mode picked for it or what new ones start
   on; for a conversation started from outside, Ask first whatever was picked; else its own pick, or the owner's policy. */
function modeNow() {
  if (M.mode?.locked) return "lock";
  if (!S.chat) return M.pending ?? M.mode?.newConversation ?? "ask";
  if (M.mode?.outside) return "ask";
  return M.mode?.mode ?? "follow";
}
/* The mode a new conversation's first message carries (POST /api/run mode), so it starts exactly as the chip says. A
   first message sent before the engine's answer arrived would carry none, and the conversation would follow the owner's
   setting, which may be looser than what new conversations start on; so that answer is read first. When it cannot be
   read, the conversation starts on Ask first rather than on the owner's setting. Under Lockdown it starts on what the
   engine says new ones start on there, else on Ask first, so it does not fall back to the owner's setting once Lockdown
   ends. `picked` is a mode chosen for this conversation before its first message (the composer's chip). */
export async function newConversationMode(picked = null) {
  if (!M.mode) {
    const read = await api("conversation-mode").catch(() => null);
    if (read && !M.mode) M.mode = read;
  }
  if (!M.mode) return { mode: "ask" };
  const askable = M.mode.choices?.some((choice) => choice.mode === "ask" && choice.available) ?? true;
  const mode = M.mode.locked ? M.mode.newConversation ?? (askable ? "ask" : null) : picked ?? M.mode.newConversation ?? null;
  return mode ? { mode } : {};
}
/* The composer's first message in a new conversation: its chip's pick, used once. */
export async function startMode() {
  if (S.chat) return {};
  const picked = M.pending, model = M.pendingModel;
  M.pending = null;
  M.pendingModel = null;
  return { ...(await newConversationMode(picked)), ...(model?.preset ? { preset: model.preset } : {}), ...(model?.reasoning ? { reasoning: model.reasoning } : {}) };
}

export function chips() {
  const m = current(), mode = modeNow(), p = PMODES.find(([id]) => id === mode);
  const none = !E.state?.activeModel || m.id === "none"; // no model set up: plain words, no letter tile standing in for a logo
  const low = accountLow(); // parity B1 (shell-042): the prototype's .low7 dot and tip
  const model = `<button type="button" class="chip-c${low ? " low7" : ""}" data-act="modelmenu2" data-tip="${t(low ? "window.chat.low.tip" : "window.chat.mode.model-tip")}">${none ? "" : logo(m.provider, m.name, 18)}<span class="lbl">${none ? t("window.chat.mode.no-model") : esc(m.name)}${!none && m.account ? " · " + esc(m.account) : ""}${m.reasoning ? " · " + esc(String(m.reasoning).toLowerCase()) : ""}</span>${ic("down", "s")}</button>`;
  const label = mode === "lock" ? t("lockdown.label") : mode === "follow" ? M.mode?.following?.label ?? "" : p ? t(p[1]) : "";
  const modeChip = `<button type="button" class="chip-c ${mode === "full" ? "full" : ""} ${mode === "lock" ? "lockd" : ""}" data-act="modemenu2" data-tip="${t("window.chat.mode.mode-tip")}">${ic(mode === "lock" ? "lock" : p?.[3] ?? "shield")}<span class="lbl">${esc(label)}</span>${ic("down", "s")}</button>`;
  return model + modeChip;
}

/* A mode's name as the chip says it (Auto, Ask first, Plan first, Full access). */
export const modeLabel = (id) => { const p = PMODES.find(([v]) => v === id); return p ? t(p[1]) : ""; };

/* The next draw reads the model and mode again (the engine came back, so what was read may be old). */
export function forgetChips() { M.sid = undefined; }

/* After each draw of the conversation: read the open conversation's model and mode, and draw again only if they changed. */
export async function loadChips() {
  const sid = S.chat ?? null;
  // Read again when a task of this conversation starts or ends, too: a plan limit may have moved it to another account.
  const newest = sid ? (E.state?.runs ?? []).filter((r) => r.sessionId === sid).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] : null;
  const runKey = newest ? `${newest.id}:${newest.status}` : "";
  if (sid === M.sid && runKey === M.runKey && Date.now() - M.at < 5000) return;
  M.at = Date.now();
  M.runKey = runKey;
  const [model, mode, account] = await Promise.all([
    sid ? api(`sessions/${encodeURIComponent(sid)}/model`).catch(() => null) : null,
    api("conversation-mode" + (sid ? "?sessionId=" + encodeURIComponent(sid) : "")).catch(() => null),
    sid ? api(`accounts/session?sessionId=${encodeURIComponent(sid)}`).catch(() => null) : null,
  ]);
  const key = (x) => JSON.stringify(x);
  if (sid === M.sid && key(model) === key(M.model) && key(mode) === key(M.mode) && key(account) === key(M.account)) return;
  Object.assign(M, { sid, model, mode, account, at: Date.now() });
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

/* Stress test B008: in a Trunk's conversation, a connection that answers through a sign-in is greyed (a Trunk never
   answers through one), with the reason and the way to add one it can use under the list (places/switch-on.js). */
function inTrunkChat() {
  const sid = S.chat, s = sid ? E.sessions.find((x) => (x.sessionId ?? x.id) === sid) : null;
  return Boolean(sid) && (Array.isArray(E.trunks) ? E.trunks : []).some((tr) => tr.id === s?.trunkId || tr.chatSessionId === sid);
}
/* True when this is a Trunk's conversation and its model is one the Trunk cannot answer through. */
export function trunkModelRefused() {
  const preset = presets().find((x) => x.id === current().id);
  return Boolean(preset) && inTrunkChat() && !trunkCanUse(preset);
}
/* The model menu, opened by the window (a message held back because its Trunk cannot use the model picked). */
export function showModelMenu() {
  const chip = document.querySelector('[data-act="modelmenu2"]');
  if (chip) openPop(chip, modelMenu(), { force: true });
}
/* chat-025: a model's sub-line is the account its connection answers through next, as the engine marks it (GET
   /api/usage/glance rows: the connection's plan or name, the account marked in use): "ChatGPT plan · Work · used next".
   A model with no such account keeps its model name. */
function via(preset) {
  const row = M.limits.find((r) => r.inUse && r.accountLabel && (r.presets ?? []).includes(preset.id));
  return row ? `${row.connectionName} · ${row.accountLabel} · ${t("glance.usedNext")}` : String(preset.model ?? "").replace(/-branch\d+k$/, "");
}
function modelMenu() {
  const m = current(), preset = presets().find((x) => x.id === m.id), trunk = inTrunkChat();
  const levels = preset?.thinking?.levels ?? [];
  const rows = presets().map((x) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${x.id === m.id}" data-act="pick-model" data-v="${esc(x.id)}"${trunk && !trunkCanUse(x) ? " disabled" : ""}><span class="tick">${ic("check", "s")}</span>${logo(x.provider, x.name, 22)}<span><span class="mi-t">${esc(x.name)}</span><span class="mi-s">${esc(via(x))}</span></span></button>`).join("");
  const think = levels.length ? `<hr><div class="row-in"><span>${t("field.thinking")}</span><span class="seg">${levels.map((lv) => `<button type="button" data-act="pick-think" data-v="${esc(lv)}" aria-pressed="${m.reasoning === lv}">${esc(lv[0].toUpperCase() + lv.slice(1))}</button>`).join("")}</span></div><p class="pp" data-css="padding-top:6px">${t("window.chat.mode.thinking-hint")}</p>` : "";
  return `<div class="ph">${t("window.chat.mode.which-model")}</div>${rows}${trunk ? trunkModelNote(E.state?.models) : ""}${think}${mi("lp-open", "cpu", t("glance.local"))}${mi("setgo", "users", t("window.chat.mode.accounts"), "", 'data-v="accounts"')}`;
}

/* The menu offers what the conversation's model takes now: the model is read again as it opens (it may have been changed
   from Settings or another window since the chips were last read), and the chip is redrawn with it. */
async function openModelMenu(el) {
  if (el.getAttribute("aria-expanded") === "true") return openPop(el, modelMenu()); // its own button closes it
  M.sid = undefined;
  const [, glance] = await Promise.all([loadChips(), E.profiles?.isOwner === false ? null : api("usage/glance").catch((error) => { toast(error.message); return null; })]);
  M.limits = Array.isArray(glance?.rows) ? glance.rows : [];
  openPop(document.querySelector('[data-act="modelmenu2"]') ?? el, modelMenu());
}

function modeMenu() {
  const cur = modeNow(), locked = !!M.mode?.locked;
  const rows = PMODES.map(([id, n, d, icon], i) => {
    const choice = M.mode?.choices?.find((c) => c.mode === id);
    const blocked = choice && !choice.available ? choice.why : "";
    return `<button class="mi pm ${id === "full" ? "dz" : ""} ${blocked ? "blocked" : ""}" type="button" role="menuitemradio" aria-checked="${!locked && cur === id}" data-act="set-mode" data-v="${id}" ${blocked || locked ? "disabled" : ""}><span class="ico">${ic(icon, "s")}</span><span><span class="mi-t">${t(n)}</span><span class="mi-s">${esc(blocked || t(d))}</span></span><span class="r">${!locked && cur === id ? ic("check", "s") : `<kbd>${i + 1}</kbd>`}</span></button>`;
  }).join("");
  return `<div class="pt">${t("mode.question")}</div>${rows}<hr><div class="row-in"><span>${t("window.chat.mode.applies")}</span><span class="fact15-v">${t("window.chat.mode.this-conversation")}</span></div><p class="mi-s scope15">${esc(reason("scope"))}</p><div class="row-in"><span class="ic-t" data-css="color:var(--bad)">${ic("lock", "s")}${t("lockdown.label")}</span><input class="sw" type="checkbox" id="pm-lock2" data-sw="lock" ${locked ? "checked" : ""} aria-label="${t("lockdown.label")}"></div>`; // the mode it sets applies to this conversation; words, not a choice (window.why.scope)
}

/* The menu is drawn again with what was just chosen only while it is still open (its rows, `row`, are showing): a menu
   the person closed while the choice was being saved stays closed. */
function reopen(act, menu, row) {
  const a = document.querySelector(`[data-act="${act}"]`);
  if (a && document.querySelector(`#app > .pop [data-act="${row}"]`)) openPop(a, menu(), { force: true });
}

async function saveModel(change) {
  try {
    /* QA retest 2026-09-28 (m10): before its first message, a new conversation's pick is its own and goes with that message
       (POST /api/run preset, reasoning); it used to become the default for every new conversation. The default is Settings › Models. */
    if (!S.chat) { M.pendingModel = { ...M.pendingModel, ...change }; redrawChips(); reopen("modelmenu2", modelMenu, "pick-model"); return; }
    await api(`sessions/${encodeURIComponent(S.chat)}/model`, change);
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
