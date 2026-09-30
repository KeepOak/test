/* Steer a running task (pass 17, SHOWCASE17 #1; the prototype's steerChipB17 and POPS.steerb17): while this
   conversation's task is working, a chip over the message box reads "Steer <Trunk>". Its box sends a note to the task
   through POST /api/runs/<id>/steer ({text}, 1 to 2000 characters), which the engine puts in front of the task's next
   round. The thread's "You steered …" line is drawn from the task's own record (its run.steered steps, GET
   /api/runs/<id>/steps), never from what was typed here. The prototype's example suggestions are not drawn. */

import { $, esc, renderNow, composing } from "../core/dom.js";
import { ic, toast, openPop, closePop } from "../core/ui.js";
import { S, E, ownTrunkOf } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { stepsOf, loadSteps, forgetSteps, liveRun } from "./timeline.js";
import { t } from "../../i18n.js";

const runsHere = () => (E.state?.runs ?? []).filter((r) => S.chat && r.sessionId === S.chat)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
/* Only a task that is still working can be steered (the engine refuses any other). */
const working = () => liveRun() ?? runsHere().find((r) => r.status === "running");
/* Whom the chip steers, as the prototype's "Steer ${c.name}": a Trunk's own conversation (or one it retired) is that
   Trunk's, never Branch's (Q073, the faces rule); anywhere else it is the assistant's own name. */
function name() {
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === S.chat);
  return ownTrunkOf(S.chat)?.name || E.trunks.find((tr) => tr.id === s?.trunkId || tr.id === s?.trunk?.id)?.name || E.state?.identity?.name || "";
}

/* The engine hands a steer to the model wrapped in its marker (src/steer.ts steerMessage) and keeps it in the conversation
   that way. The thread shows only the owner's own words, as the "You steered …" line, never the wrapper (dogfood D23). */
const OWNER_OPEN = "[OUT-OF-BAND MESSAGE FROM THE OWNER — ", OWNER_CLOSE = "[/OUT-OF-BAND MESSAGE FROM THE OWNER]";
export function steerWords(m) {
  const text = typeof m?.content === "string" ? m.content : "";
  if (m?.role !== "user" || !text.startsWith(OWNER_OPEN) || !text.trimEnd().endsWith(OWNER_CLOSE)) return null;
  const body = text.slice(text.indexOf("]\n") + 2, text.trimEnd().length - OWNER_CLOSE.length);
  return body.trim();
}
/* dogfood-ux-2: a note steered in from a chat app (src/steer.ts steerChatOpen): the name its sender goes by and their own
   words, never the wrapper and never as the owner's. */
const CHAT_STEER = /^\[OUT-OF-BAND MESSAGE FROM A CHAT PARTICIPANT, NOT THE OWNER \(they call themselves "([^"[\]\r\n]{1,80})"\) — [^\n]*\]\n([\s\S]*)$/;
const CHAT_CLOSE = "[/OUT-OF-BAND MESSAGE FROM A CHAT PARTICIPANT]";
export function chatSteerOf(m) {
  const found = m?.role === "user" && typeof m.content === "string" ? CHAT_STEER.exec(m.content.trimEnd()) : null;
  if (!found) return null;
  const rest = found[2];
  return { from: found[1], words: (rest.endsWith(CHAT_CLOSE) ? rest.slice(0, rest.length - CHAT_CLOSE.length) : rest).trim() };
}
export const chatSteerLine = (s) => `<div class="steered-b17" role="note">${ic("retry", "s")}<span>${esc(s.from)}: “${esc(s.words)}”</span></div>`;
/* "You steered <name>: “…”." A note that ends in its own full stop is not given a second one. */
export const steeredLine = (words) => `<div class="steered-b17" role="note">${ic("retry", "s")}<span>${t("window.chat.steer.steered", { name: esc(name()), words: esc(String(words).replace(/[.。]+$/, "")) })}</span></div>`;

/* The chip over the message box, in its own row. */
export function steerChip() {
  if (S.view !== "chat" || !working()) return "";
  return `<div class="dockrow15"><button type="button" class="bgchip15 steer-b17" data-act="steerb17" aria-haspopup="menu">${ic("retry", "s")}${t("window.chat.steer.chip", { name: esc(name()) })}</button></div>`;
}

/* "You steered …": one line for each note the newest task's record holds and the thread does not show yet (a note the
   task has taken is in the conversation itself, drawn in its place by chat.js with steeredLine). */
export function steeredNotes(messages = []) {
  const run = liveRun() ?? runsHere()[0];
  if (!run) return "";
  loadSteps(run.id);
  const taken = new Set(messages.map(steerWords).filter((w) => w !== null).map((w) => w.slice(0, 500).trim()));
  const notes = (stepsOf(run.id)?.steps ?? []).filter((s) => s.kind === "you" && !taken.has(String(s.title ?? "").trim()));
  return notes.map((s) => steeredLine(s.title)).join("");
}

const pop = () => `<div class="ph">${t("window.chat.steer.title", { name: esc(name()) })}</div><div class="steer-pop-b17"><input class="inp" id="steer-in-b17" placeholder="${t("window.chat.steer.placeholder")}" aria-label="${t("window.chat.steer.what")}" maxlength="2000"><button class="btn pri sm" type="button" data-act="steergob17">${t("window.chat.steer.now")}</button></div>`;

async function steer() {
  const text = ($("#steer-in-b17")?.value || "").trim(), run = working();
  if (!text) { toast(t("window.chat.steer.type-first")); return; }
  if (!run) { closePop(); return; }
  try { await api(`runs/${encodeURIComponent(run.id)}/steer`, { text }); } catch (error) { toast(error.message); return; }
  closePop();
  toast(t("window.chat.steer.done", { name: name() }));
  forgetSteps(run.id);
  await loadSteps(run.id);
  renderNow();
}

export function initSteer() {
  markLive(["steerb17", "steergob17", "sw:steer-in-b17"]);
  on("steerb17", (el) => openPop(el, pop()));
  on("steergob17", () => steer());
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target?.id === "steer-in-b17" && !composing(e)) { e.preventDefault(); steer(); } });
}
