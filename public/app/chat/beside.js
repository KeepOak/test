/* Two things from the conversation's header and menu (design doc 4.3, pass 10 and 15).
   - Open another conversation beside: a second conversation read with GET /api/sessions/{id}, drawn next to this one
     on a wide window (the split closes itself below 1000px, as the prototype's does).
   - Who it knows: the Trunks this computer has (GET /api/trunks) and the Trunks on the owner's other computers
     (POST /api/reach/trunks/remote, which only looks). "Connect another agent" opens Customize › Tools at Agents. The
     per-row "may talk to" switches stay greyed: widening whom a Trunk may message is a security-reviewed change, and the
     engine keeps no per-Trunk list for it; the hops note stays greyed because the engine does not say its limit. */

import { $, esc, render } from "../core/dom.js";
import { S, E, ownName, chatFace, trunkIntro, activeId } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run, has } from "../core/actions.js";
import { ic, av, mi, openPop, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { text } from "./markdown.js";
import { mediaRows } from "./media.js";
import { sessionAttachmentTray } from "./attach.js";
import { t } from "../../i18n.js";
import { shareMenu } from "../flows/share.js";
import { initBesidePicker, openBesidePicker, rememberBesidePick, pickedBesideName } from "./beside-picker.js";

const V = { id: null, messages: [], loaded: null, version: null, scope: null, pending: null, timer: null, at: 0, dirty: false };
const sid = (s) => s.sessionId ?? s.id;
const profile = () => JSON.stringify([activeId(), E.profiles?.isOwner ?? null]);
/* A Trunk's or a room's own conversation by its name and face, as the list's rows are (core/state.js). */
const nameOf = (id) => ownName(id) || E.sessions.find((s) => sid(s) === id)?.opening || pickedBesideName(id) || "";

/* ---------- the conversation beside ---------- */
export function chatMenuTop() {
  return mi("beside15", "cols15", S.beside15 ? t("window.chat.beside.change") : t("window.chat.beside.open-another")) + shareMenu() + mi("roster10", "spark", t("window.chat.beside.who-it-knows")) + "<hr>";
}

function thread(messages, session) {
  let last = null;
  return messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.from !== "branch" && !trunkIntro(m)).map((m) => {
    const html = m.role === "user"
      ? `<div class="u">${esc(m.content)}</div>${mediaRows(m, session)}`
      : `<div class="b"><div class="gut">${last !== "assistant" ? av(chatFace(session), 28) : ""}</div><div><div class="txt">${text(m.content)}</div></div></div>`;
    last = m.role;
    return html;
  }).join("");
}

/* Only the newest pick's answer is kept: a slower read for a conversation picked earlier is dropped when it returns. */
async function load(id) {
  const who = profile(), request = new AbortController(), initial = V.id !== id;
  V.pending = request; V.at = Date.now();
  V.loaded = id;
  try {
    const got = await api("sessions/" + encodeURIComponent(id), undefined, "GET", request.signal);
    if (V.pending !== request || S.beside15 !== id || profile() !== who) return;
    const changed = V.id !== id || JSON.stringify(V.messages) !== JSON.stringify(got.messages ?? []);
    V.messages = got.messages ?? []; V.id = id;
    if (changed) render();
  } catch (error) { if (initial && V.pending === request && S.beside15 === id && profile() === who && error.name !== "AbortError") toast(error.message); }
  finally { if (V.pending === request) { V.pending = null; if (V.dirty) scheduleLoad(id); } }
}

function scheduleLoad(id) {
  V.dirty = true;
  if (V.pending || V.timer) return;
  V.timer = setTimeout(() => {
    V.timer = null;
    if (S.view !== "chat" || S.beside15 !== id || profile() !== V.scope) return;
    V.dirty = false; void load(id);
  }, Math.max(0, 1000 - (Date.now() - V.at)));
}
function clearBeside() {
  clearTimeout(V.timer); V.pending?.abort();
  Object.assign(V, { id: null, messages: [], loaded: null, version: null, scope: profile(), pending: null, timer: null, at: 0, dirty: false });
}

/* Wraps the conversation's scroll area in the split when another conversation is open beside it. */
export function besideWrap(scroll) {
  const id = S.beside15;
  if (!id || id === S.chat) { if (V.loaded || V.pending || V.timer) clearBeside(); return scroll; }
  if (V.scope !== profile() || (V.loaded && V.loaded !== id)) clearBeside();
  // main.js refreshes this snapshot after engine events; no second stream or periodic poll is needed.
  const version = E.state;
  if (V.loaded !== id || V.version !== version) { V.version = version; scheduleLoad(id); }
  const body = V.id === id ? thread(V.messages, id) : "";
  const name = esc(nameOf(id));
  return `<div class="split15">${scroll}<aside class="beside15" data-composer-tray="${esc(sessionAttachmentTray(id))}" aria-label="${t("window.chat.beside.label", { name })}"><div class="bs-h15">${av(chatFace(id), 26)}<span class="grow"><b>${name}</b><small></small></span><button class="btn ghost sm" type="button" data-act="chat" data-id="${esc(id)}">${t("ov.open")}</button><button class="icon-btn" type="button" aria-label="${t("window.chat.beside.close")}" data-act="beside15" data-v="">${ic("x", "s")}</button></div><div class="bs-body15"><div class="thread">${body}</div></div></aside></div>`;
}

function beside(el) {
  if (el.dataset.v == null) { openBesidePicker($('[data-act="chatmenu"]') || el); return; }
  S.beside15 = el.dataset.v || null;
  rememberBesidePick(S.beside15);
  clearBeside();
  closePop();
  render();
  if (S.beside15 && innerWidth < 1000) toast(t("window.chat.beside.wider"));
}

/* ---------- who it knows ---------- */
/* The Trunks on the owner's other computers (POST /api/reach/trunks/remote), asked for only while the engine's "Trunks
   on other computers" part is on (GET /api/reach modes, read at most once a minute). While it is off the window asks
   nothing, so there is no refused request and no toast; the @ list (messages.js) reads them here too. */
const REMOTE = { at: 0, on: false };
async function remoteOn() {
  if (Date.now() - REMOTE.at > 60000) {
    const mode = (await api("reach")).modes?.["remote-trunks"];
    REMOTE.on = typeof mode === "string" && mode !== "off";
    REMOTE.at = Date.now();
  }
  return REMOTE.on;
}
/** The other computers and their Trunks, or none while the part is off. */
export async function remoteTrunks() {
  return (await remoteOn()) ? (await api("reach/trunks/remote", {})).computers ?? [] : [];
}

export const rosterButton = () => `<button class="icon-btn" type="button" aria-label="${t("window.chat.beside.roster-label")}" data-tip="${t("window.chat.beside.who-it-knows")}" data-act="roster10h">${ic("users")}</button>`;

async function rosterPop() {
  const [mine, away] = await Promise.all([
    api("trunks").then((r) => ({ trunks: r.trunks ?? [] }), (error) => ({ error })),
    remoteTrunks().then((computers) => ({ computers }), (error) => ({ error })),
  ]);
  const own = (mine.trunks ?? []).find((tr) => tr.chatSessionId && tr.chatSessionId === S.chat);
  const row = (key, name, sub, face) => `<div class="mi" role="menuitem">${face}<span><span class="mi-t">${esc(name)}</span><span class="mi-s">${esc(sub)}</span></span><input type="checkbox" class="sw" data-sw="knows" data-k="${esc(key)}" aria-label="${t("window.chat.beside.may-talk", { who: esc(own?.name ?? "Branch"), name: esc(name) })}"></div>`;
  const here = (mine.trunks ?? []).filter((tr) => !tr.hidden && tr.id !== own?.id).map((tr) => row(tr.id, tr.name, tr.title ?? "", av(tr, 26))).join("")
    + (own ? row("branch", "Branch", "", `<span class="ico-tile">${ic("branch", "s")}</span>`) : "");
  const there = (away.computers ?? []).flatMap((c) => (c.trunks ?? []).map((tr) => row(tr.address ?? tr.handle, tr.name, [c.machine, tr.title].filter(Boolean).join(" · "), av({ name: tr.name }, 26)))).join("");
  const note = (r) => (r.error ? `<p class="hint" data-css="margin:4px 10px">${esc(r.error.message)}</p>` : "");
  return `<div class="ph">${t("window.chat.beside.knows", { name: esc(own?.name ?? "Branch") })}</div>${here}${note(mine)}<div class="ph">${t("window.chat.beside.other-computers")}</div>${there}${note(away)}<hr>${mi("toast", "info", t("window.chat.beside.hops"), "", 'data-why="hops"')}${mi("t9-kind-roster", "plug", t("window.chat.beside.connect-agent"), "", 'data-v="agents"')}`;
}
async function roster(anchor, force) {
  if (!anchor) return;
  openPop(anchor, await rosterPop(), { right: true, force });
}

/* Connect another agent: Customize › Tools at its Agents kind (other assistants over A2A), where one is added. */
function connectAgent() {
  closePop();
  S.view = "customize";
  S.tabs.customize = "tools";
  const kind = document.createElement("button");
  kind.dataset.v = "agents";
  if (has("t9-kind")) run("t9-kind", kind); else render();
}

export function initBeside() {
  initBesidePicker();
  markLive(["beside15", "roster10", "roster10h", "t9-kind-roster"]);
  on("t9-kind-roster", () => connectAgent());
  on("beside15", (el) => beside(el));
  on("roster10", () => roster($('[data-act="roster10h"]') || $('[data-act="chatmenu"]'), true));
  on("roster10h", (el) => roster(el, false));
}
