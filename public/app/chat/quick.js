/* Quick ask (pass 17, design/redesign/pass17/FEATURES17C.md §5), 1:1 with patch17c: a small box near the top with the
   keys, a field, "To" chips for Branch and each Trunk, and Start. Enter sends, Esc closes, the keys toggle it and a click
   outside closes it; switching the Trunk keeps what was typed and an empty box sends nothing. Sending starts a new
   conversation with the words (Branch: POST /api/run as the message box does; a Trunk: POST /api/trunks/conversations,
   then the words in it). The keys are the engine's keys card (quickAsk; ⌥ Space on a Mac); the desktop app registers them
   in every app and opens the box from there (src/desktop/quick-ask.ts, window.branchDesktop.onQuickAsk). */

import { $, esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, mi, toast, closePop, closeDlg, app } from "../core/ui.js";
import { ICONS } from "../core/icons.js";
import { markLive, greyOut } from "../core/features.js";
import { binding, defaultOf, comboOf, pressed, spoken } from "../shell/keys.js";
import { startWith } from "./chat.js";
import { t } from "../../i18n.js";

Object.assign(ICONS, { quick17c: '<path d="M13 3.5L5.5 13.5H12l-1 7 7.5-10H12z"/>' });

const MAC = /Mac/.test(navigator.platform);
const Q = { open: false, to: "branch", text: "" };
const desktop = () => window.branchDesktop;

/* On a Mac the card's default keys are ⌥ Space, as the desktop app registers them. */
const macDefault = () => MAC && binding("quickAsk") === defaultOf("quickAsk");
const keysWords = () => (macDefault() ? "⌥ Space" : spoken(binding("quickAsk")));
const keysKbd = () => keysWords().split(" ").filter(Boolean).map((k) => `<kbd>${esc(k)}</kbd>`).join(" ");
const pressedQuick = (e) => (macDefault() ? comboOf(e) === "Alt+Space" : pressed(e, "quickAsk"));

export const quickItem = () => mi("qa17c", "quick17c", t("window.chat.quick.title"), binding("quickAsk") ? `<kbd>${esc(keysWords())}</kbd>` : "");

const who = () => [{ id: "branch", name: "Branch", kind: "main" }, ...E.trunks.filter((tr) => !tr.hidden)];
/* A new conversation with a Trunk needs the engine's "Choosing a Trunk to answer in any conversation" part switched on;
   until then its chip stays drawn and greyed. */
const canPick = (c) => c.id === "branch" || (E.trunkModes?.conversations ?? "off") !== "off";
function boxHTML() {
  if (!canPick({ id: Q.to })) Q.to = "branch";
  const chips = who().map((c) => `<button type="button" role="radio" aria-checked="${Q.to === c.id}" data-act="${canPick(c) ? "qato17c" : "qato17c-off"}" data-v="${esc(c.id)}">${av(c, 18)}<span>${esc(c.name)}</span></button>`).join("");
  const anywhere = desktop()?.onQuickAsk ? `<small>${t("window.chat.quick.anywhere")}</small>` : "<small></small>";
  return `<div class="qa17c" role="dialog" aria-label="${t("window.chat.quick.title")}"><div class="qah17c">${ic("quick17c", "s")}<b>${t("window.chat.quick.title")}</b><span class="qak17c">${keysKbd()}</span>${anywhere}<button class="icon-btn" type="button" data-act="qaclose17c" aria-label="${t("window.chat.quick.close")}">${ic("x", "s")}</button></div>
    <input id="qa-in17c" class="inp" placeholder="${t("window.chat.quick.placeholder")}" autocomplete="off" spellcheck="false" value="${esc(Q.text)}" aria-label="${t("window.chat.quick.question")}">
    <div class="qato17c" role="radiogroup" aria-label="${t("window.chat.quick.send-to")}"><span>${t("reach.trunks.to")}</span>${chips}</div>
    <div class="qaf17c"><small>${t("window.chat.quick.hint")}</small><button class="btn pri sm" type="button" data-act="qasend17c">${t("personal.tunnel.start")}</button></div></div>`;
}

/* The box is drawn when it opens and taken away when it closes, like a dialog. */
function drawBox() {
  $(".qawrap17c")?.remove();
  if (!Q.open) return;
  const wrap = Object.assign(document.createElement("div"), { className: "qawrap17c", innerHTML: boxHTML() });
  greyOut(wrap);
  app().appendChild(wrap);
  const box = $("#qa-in17c");
  box?.focus({ preventScroll: true });
  if (box) box.selectionStart = box.selectionEnd = box.value.length;
}
const openBox = () => { closePop(); closeDlg(); Object.assign(Q, { open: true, text: "" }); drawBox(); };
const closeBox = () => { Q.open = false; drawBox(); };
const toggle = () => (Q.open ? closeBox() : openBox());

function pickTo(el) {
  Q.text = $("#qa-in17c")?.value ?? "";
  Q.to = el.dataset.v;
  drawBox();
}

async function sendBox() {
  const words = ($("#qa-in17c")?.value ?? "").trim(), to = Q.to;
  if (!words) { toast(t("window.chat.quick.type-first")); $("#qa-in17c")?.focus(); return; }
  const trunk = to === "branch" ? null : E.trunks.find((tr) => tr.id === to);
  let sessionId = null;
  if (trunk) {
    try { sessionId = (await api("trunks/conversations", { trunkId: trunk.id })).sessionId; } catch (error) { toast(error.message); return; }
  }
  closeBox();
  toast(trunk ? t("window.chat.quick.started-with", { name: trunk.name }) : t("window.chat.quick.started"));
  await startWith(words, sessionId);
}

export function initQuick() {
  markLive(["qa17c", "qaclose17c", "qato17c", "qasend17c", "sw:qa-in17c"]);
  on("qa17c", () => openBox());
  on("qaclose17c", () => closeBox());
  on("qato17c", (el) => pickTo(el));
  on("qasend17c", () => sendBox());
  document.addEventListener("keydown", (e) => {
    if (pressedQuick(e)) { e.preventDefault(); e.stopImmediatePropagation(); toggle(); return; }
    if (!Q.open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeBox(); }
    else if (e.key === "Enter" && e.target.id === "qa-in17c") { e.preventDefault(); e.stopImmediatePropagation(); sendBox(); }
  }, true);
  document.addEventListener("click", (e) => { if (Q.open && e.target.classList?.contains("qawrap17c")) closeBox(); });
  desktop()?.onQuickAsk?.(() => toggle());
}
