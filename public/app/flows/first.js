/* The quiet setup reminder and Replay the first run. All setup entry points use setup.js,
   which reads the same saved progress and keeps the same three steps and Trunk templates. */
import { $, onRender } from "../core/dom.js";
import { app, toast, ic, closePop, closeDlg } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { openSetup } from "./setup.js";
import { t } from "../../i18n.js";

/* ---------- "New to Branch?" ---------- */
const seen = (key) => { try { return !!localStorage.getItem(key); } catch (error) { return false; } };
/* setup-resume: shown once setup has been opened (the engine's record, or this browser's older note) and not finished,
   never while "Show tips and pop-ups" is off or after "Don't show again" (both the engine's, GET /api/state
   onboarding). × only hides it until the window is opened again. */
let hiddenNow = false;
function wanted() {
  const p = E.state?.onboarding ?? {};
  const opened = p.step != null || (p.completed ?? []).length > 0 || p.skipped === true || seen("branch-setup-seen");
  return opened && !hiddenNow && !p.finishedAt && !p.welcomed && p.popups !== false && !seen("branch-welcomed");
}
function welcome() {
  if (!E.loaded || $(".welcome10") || $(".ob9") || $(".tour-layer") || !wanted()) return;
  app().insertAdjacentHTML("beforeend", `<div class="welcome10" role="region" aria-label="${t("window.flows.first.welcome")}"><span class="mark mark-face wel11" aria-hidden="true"></span><span class="grow"><b>${t("window.flows.first.new")}</b><small>${t("window.flows.first.new-hint")}</small></span><button class="btn pri sm" type="button" data-act="onboard">${t("channel-setup.row-button")}</button><button class="btn sm" type="button" data-act="tour">${t("window.flows.first.walkthrough")}</button>${E.state?.onboarding?.mine ? `<button class="link wel-never" type="button" data-act="welcome-never">${t("window.flows.first.never")}</button>` : ""}<button class="icon-btn" type="button" aria-label="${t("window.flows.first.dismiss")}" data-act="welcome-x">${ic("x", "s")}</button></div>`);
  greyOut($(".welcome10"));
  placeWelcome();
}
/* The card keeps the prototype's corner but never covers the message box: its bottom sits just above the dock (the
   composer and the lines over it) whenever one is drawn, so Send is always reachable. */
function placeWelcome() {
  const card = $(".welcome10"), dock = $("#main .dock"), root = app();
  if (!card || !root) return;
  /* It belongs to the conversation, where it keeps clear of the message box; over Settings or a place it would sit on
     their own controls (the Appearance language picker, a card's buttons), so there it waits unseen. */
  card.hidden = S.view !== "chat";
  const over = dock?.getClientRects().length ? root.getBoundingClientRect().bottom - dock.getBoundingClientRect().top + 12 : 0;
  card.style.bottom = over > 0 ? `${Math.round(over)}px` : "";
}
function dismissWelcome() {
  hiddenNow = true;
  $(".welcome10")?.remove();
}
/* "Don't show again": the engine keeps it (POST /api/onboarding { welcomed: true }), on every device. */
async function neverWelcome() {
  try { E.state.onboarding = await api("onboarding", { welcomed: true }); } catch (error) { toast(error.message); return; }
  $(".welcome10")?.remove();
}

export function init() {
  markLive(["firstrun", "welcome-x", "welcome-never"]);
  on("welcome-never", () => neverWelcome());
  on("firstrun", async () => {
    closePop();
    closeDlg();
    $(".welcome10")?.remove();
    await openSetup(1, "start");
  });
  on("welcome-x", () => dismissWelcome());
  let checked = false;
  onRender(() => { if (!checked && E.loaded) { checked = true; setTimeout(welcome, 1200); } placeWelcome(); });
  addEventListener("resize", placeWelcome);
  document.addEventListener("input", placeWelcome);
}
