/* Settings › Chat apps › Drive a task's browser from your phone (src/miniapp/phone-access.ts). Telegram only opens its
   Mini App from an HTTPS address, which the owner's Tailscale gives this computer when it forwards one path to the
   Mini App's own door. "Turn on phone access" shows the exact command first and runs it only on the owner's yes;
   "Turn off" does the same with the command that removes that path again. Greyed, with the reason, until an App lock
   PIN is set (the phone asks for it every time) or while the door isn't open. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { S, ownerHere, activeId } from "../core/state.js";

const P = { view: null };
/* Dialogs the owner closed (Cancel, the close button or Escape): a run still waiting must not close a dialog opened since. */
let dialogsClosed = 0;
const quoted = (command) => command.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `"${part}"`)).join(" ");

/* A late answer is kept, drawn or its error shown only for the newest read, by the same owner on the same page, with the
   window unlocked: nothing lands behind the lock or for another person. */
let reading = 0;
function fence() {
  const mine = ++reading, profile = activeId(), view = S.view;
  return () => mine === reading && ownerHere() && activeId() === profile && S.view === view
    && !document.getElementById("app")?.classList.contains("locked-b17");
}
export async function loadPhoneAccess() {
  const still = fence();
  try { const read = (await api("miniapp/phone-access")).phoneAccess; if (still()) P.view = read; } catch { if (still()) P.view = null; }
}
export function phoneAccessCard() {
  const view = P.view;
  if (!view) return "";
  // Greyed with its reason (core/why.js): a control with no handler behind it is never marked live.
  const why = view.url ? "" : !view.pinSet ? "phone-access-needs-pin" : !view.on ? "phone-access-no-door" : "";
  const line = view.url ? t("window.phone-access.on", { url: view.url }) : t("window.phone-access.off");
  const act = view.url ? "phone-access-off" : why || "phone-access-on";
  const button = `<button class="btn sm" type="button" data-act="${act}"${why ? ` data-why="${why}"` : ""}>${esc(t(view.url ? "window.phone-access.turn-off" : "window.phone-access.turn-on"))}</button>`;
  return `<div class="rows"><div class="ctl" data-phone-access="${view.url ? "on" : "off"}"><b>${esc(t("window.phone-access.title"))}</b><span class="right">${button}</span><small>${esc(line)}</small></div></div>`;
}
function ask(turn) {
  const command = P.view?.[turn];
  if (!command) return;
  openDlg({ title: t(turn === "on" ? "window.phone-access.ask-on" : "window.phone-access.ask-off"),
    body: `<p>${esc(t(turn === "on" ? "window.phone-access.explain-on" : "window.phone-access.explain-off"))}</p><pre class="code" id="phone-access-command">${esc(quoted(command))}</pre>
      <div class="acts"><button class="btn ghost" type="button" data-act="phone-access-cancel">${esc(t("window.phone-access.cancel"))}</button><button class="btn pri" type="button" data-act="phone-access-run" data-v="${turn}">${esc(t("window.phone-access.run"))}</button></div>` });
}
export function initPhoneAccess(reload) {
  markLive(["phone-access-on", "phone-access-off", "phone-access-run", "phone-access-cancel"]);
  on("phone-access-on", () => ask("on"));
  on("phone-access-off", () => ask("off"));
  on("phone-access-cancel", () => { dialogsClosed += 1; closeDlg(); });
  document.addEventListener("click", (e) => { if (e.target.closest?.('[data-act="dlg-close"]')) dialogsClosed += 1; }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dialog()) dialogsClosed += 1; }, true); // main.js closes it on Escape
  /* The command runs on the owner's yes. What the engine answers is kept and the page read again for the owner who asked
     (the result is recorded whatever the dialog did); the asking dialog is closed, or its button given back, only if that
     same dialog is still the one open, never a dialog opened since. */
  on("phone-access-run", async (el) => {
    const turn = el.dataset.v, command = P.view?.[turn];
    if (!command) return;
    el.disabled = true;
    const still = fence(), opened = dialog(), closed = dialogsClosed;
    const sameDialog = () => dialog() === opened && dialogsClosed === closed;
    try {
      const done = (await api("miniapp/phone-access", { turn, command })).phoneAccess;
      if (still()) P.view = done;
      if (still() && sameDialog()) closeDlg();
    } catch (error) { if (still()) toast(error.message); if (sameDialog()) el.disabled = false; }
    if (still()) await reload();
  });
}
