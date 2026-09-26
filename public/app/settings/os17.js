/* Settings › Permissions › This Mac / This PC (prototype pass 16), from what the computer itself says:
   the engine reads the switches it can (GET /api/os-permissions: the screen, the microphone and the camera, and on a Mac
   Accessibility); where it cannot tell ("unknown", as on a Mac, which is never asked so no question pops up), the page
   asks the browser engine what this window was granted (navigator.permissions), and notifications are always this
   window's own (Notification.permission). Mac's Automation and Full Disk Access have no check anywhere, so they are not
   drawn.
   Open System Settings / Open Windows Settings opens the page the engine names for that switch, and only in the desktop
   app, which opens it by exact address (src/desktop/updater-ipc.ts); in a browser it stays greyed, since a web page
   cannot open the computer's settings. Allow… asks the computer's own question for the microphone, the camera or
   notifications (getUserMedia, Notification.requestPermission), then reads everything again; the page never draws a
   question of its own that looks like the computer's. Computer-only: not drawn on a phone. */
import { esc, render } from "../core/dom.js";
import { api, isDesktop } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, toast } from "../core/ui.js";
import { onPhone } from "./surface17.js";
import { t } from "../../i18n.js";

const O = { os: null, browser: {} };

/* [capability, icon, title key, what it is for key, how the computer grants it] */
const ROWS = {
  darwin: [["accessibility", "cursor16", "accessibility", "accessibility-sub", "settings"], ["screen", "screen16", "screen", "screen-sub", "settings"],
    ["microphone", "mic", "microphone", "microphone-sub", "prompt"], ["camera", "cam16", "camera", "camera-sub", "prompt"], ["notifications", "bell16", "notifications", "notifications-sub", "prompt"]],
  win32: [["microphone", "mic", "microphone", "microphone-sub", "settings"], ["camera", "cam16", "camera", "camera-sub", "settings"], ["notifications", "bell16", "notifications", "notifications-sub", "prompt"]],
};
const w = (k, vars) => t(`window.settings.os17.${k}`, vars);
const BROWSER = { granted: "allowed", denied: "refused", prompt: "unknown", default: "unknown" };

/** What the browser engine says this window may use, for the switches the computer cannot be asked about. */
async function readBrowser() {
  const out = { notifications: BROWSER[globalThis.Notification?.permission] ?? "unknown" };
  for (const [cap, name] of [["microphone", "microphone"], ["camera", "camera"]]) {
    try { out[cap] = BROWSER[(await navigator.permissions.query({ name })).state] ?? "unknown"; } catch (error) { out[cap] = "unknown"; }
  }
  O.browser = out;
}

export async function loadOs17() {
  const [os] = await Promise.all([api("os-permissions").catch((error) => { toast(error.message); return null; }), readBrowser()]);
  O.os = os;
  render();
}

/* One row: the engine's reading when it has one, else the window's own; the page that turns it on, when there is one. */
function rowFor([cap, icon, title, sub, how], mac) {
  const engine = O.os?.permissions?.find((x) => x.capability === cap);
  if (!engine && cap !== "notifications") return null;
  const state = engine && engine.state !== "unknown" ? engine.state : O.browser[cap] ?? "unknown";
  const link = cap === "notifications" ? (state === "refused" ? O.os?.notificationsLink ?? "" : "") : engine?.settingsLink ?? "";
  const pill = state === "allowed" ? `<span class="pill ok"><i></i>${t("window.settings.permissions.granted")}</span>`
    : state === "refused" ? `<span class="pill bad16"><i></i>${t("window.settings.permissions.turned-off")}</span>` : `<span class="pill idle"><i></i>${t("window.settings.permissions.not-yet")}</span>`;
  const ask = how === "prompt" && state === "unknown";
  const button = state === "allowed" ? "" : ask ? `<button class="btn sm" type="button" data-act="ask16" data-v="${esc(cap)}">${w("allow")}</button>`
    : link ? `<button class="btn sm" type="button" data-act="${isDesktop && globalThis.branchDesktop?.openExternal ? "sys16" : "sys16-browser"}" data-v="${esc(cap)}">${mac ? t("action.open-system-settings") : t("window.settings.permissions.open-windows-settings")}</button>` : "";
  return { state, html: `<div class="prow perm16"><span class="ico-tile">${ic(icon, "s")}</span><span class="grow"><b>${esc(w(title))}</b><small>${esc(w(sub))}</small></span>${pill}${button}</div>` };
}

export function osSection17() {
  const platform = O.os?.platform, mac = platform === "darwin";
  if (onPhone() || !ROWS[platform]) return "";
  const rows = ROWS[platform].map((r) => rowFor(r, mac)).filter(Boolean);
  if (!rows.length) return "";
  const installs = mac ? "" : `<div class="prow perm16"><span class="ico-tile">${ic("shield", "s")}</span><span class="grow"><b>${esc(w("installing"))}</b><small>${esc(w("installing-sub"))}</small></span><span class="pill idle"><i></i>${esc(w("each-time"))}</span></div>`;
  const granted = rows.filter((r) => r.state === "allowed").length;
  const hint = mac ? esc(t("window.settings.permissions.granted-of-count-granted-macos", { granted, count: rows.length })) : t("window.settings.mac-permissions.windows-asks-for-very-little-seeing");
  return `<div class="sec x15-sec"><h2>${mac ? t("window.settings.permissions.this-mac") : t("window.settings.permissions.this-pc")}</h2><p class="hint" data-css="margin:0 0 6px">${hint}</p><div class="rows">${rows.map((r) => r.html).join("")}${installs}</div></div>`;
}

/* The page that turns one on, as the engine named it; the desktop app opens it only if it is one of its exact pages. */
async function openSettings(el) {
  const cap = el.dataset.v;
  const link = cap === "notifications" ? O.os?.notificationsLink : O.os?.permissions?.find((x) => x.capability === cap)?.settingsLink;
  if (!link || !/^(ms-settings:|x-apple\.systempreferences:)/.test(link)) return;
  try { await globalThis.branchDesktop.openExternal(link); } catch (error) { toast(error.message); }
}

/* The computer's own question, then everything read again. */
async function ask(el) {
  const cap = el.dataset.v;
  let yes = false;
  try {
    if (cap === "notifications") yes = (await globalThis.Notification.requestPermission()) === "granted";
    else {
      const stream = await navigator.mediaDevices.getUserMedia(cap === "camera" ? { video: true } : { audio: true });
      stream.getTracks().forEach((track) => track.stop());
      yes = true;
    }
  } catch (error) { if (error?.name !== "NotAllowedError") toast(error.message); }
  await loadOs17();
  if (yes) toast(w("allowed"));
  else if (O.os?.platform === "darwin") toast(w("turned-off-mac"));
}

let started = false;
export function initOs17() {
  if (started) return;
  started = true;
  on("sys16", (el) => openSettings(el));
  on("ask16", (el) => ask(el));
  markLive(["sys16", "ask16"]);
}
