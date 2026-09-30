/* Adding a computer or phone (the computers popover's "Add a computer or phone…", and Settings › Computer's "Add a
   computer"), 1:1 with the prototype's two dialogs. Pairing is the engine's Devices (flows/pair.js): the "With a code"
   tab and "Another computer with Branch" make a real invitation, and the device that answers waits for the owner's
   "Let it in"; the phone tab hands over to the phone pairing dialog. Local private Linux computers have an owner setup
   dialog. What stays greyed: a cloud computer (not in the engine) and a computer over remote desktop or SSH (gives Trunks another machine to
   act on; not part of pairing).

   find-computers: the network tab lists the owner's other Branch computers the engine found (GET and POST
   /api/devices/find): Branch on the owner's Tailscale network, and computers waiting to pair on the local network. The
   engine looks only while this tab is open: opening it starts looking, each read keeps it going, and leaving the tab or
   closing the dialog stops it (a window that stops reading is stopped by the engine a little later). Finding grants
   nothing: Pair makes the usual invitation (flows/pair.js), hands the found computer its link, never the number
   (POST /api/devices/find/offer), and the person there types the number shown here; the owner still lets it in only
   after comparing the check codes. Every found name and note is the engine's, escaped. */

import { esc, paint } from "../core/dom.js";
import { openDlg, closePop, dialog, toast, ic } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { startPairing, stopPairing, pairingInvite } from "./pair.js";
import { t } from "../../i18n.js";
import { init as initComputers17 } from "./computers17.js"; // pass 17 part D §9
import { initPrivateComputers } from "./private-computers.js";

const TABS = [["network", "window.flows.comp.network"], ["code", "window.flows.comp.code"], ["phone", "studio.tab.phone"]];
/* The prototype's note under the tabs (addComputer): what pairing leads to. */
const AFTER = () => `<div class="status" data-css="margin-top:4px"><span class="sdot"></span><div><b>${t("window.flows.comp.after")}</b><p>${t("window.flows.comp.after-hint")}</p></div></div>`;

function addDialog(tab, body, foot = "") {
  const tabs = `<div class="tabs" data-css="margin:0">${TABS.map(([k, l]) => `<button class="tab" type="button" aria-selected="${tab === k}" data-act="ac-tab" data-v="${k}">${t(l)}</button>`).join("")}</div>`;
  return openDlg({ title: t("window.flows.comp.add-or-phone"), body: `${tabs}${body}${AFTER()}`, foot });
}

/* find-computers: the looking behind the network tab. `dlg` is the dialog it belongs to; `shown` the rows drawn last. */
const F = { dlg: null, timer: null, busy: false, shown: "", pairing: false, ask: false };

function foundRow(found) {
  return `<div class="prow"><span class="ico-tile">${ic("monitor", "s")}</span><span class="grow"><b>${esc(found.name)}</b><small>${esc(t("window.flows.comp.found"))}</small></span><button class="btn pri sm" type="button" data-act="ac-pair" data-v="${esc(found.id)}">${esc(t("window.flows.comp.pair-one"))}</button></div>`;
}
function showFound(view) {
  const notes = [view.tailnet, view.network].filter(Boolean).map((note) => `<p class="hint" data-css="margin:0">${esc(note)}</p>`).join("");
  const html = (view.found ?? []).map(foundRow).join("") + notes;
  if (html === F.shown) return; // unchanged: nothing is redrawn under the pointer
  F.shown = html;
  paint(F.dlg?.querySelector("#ac-found"), html);
}

/* Stops reading the list; with `off`, the engine stops looking too. */
function stopLooking(off = true) {
  clearInterval(F.timer);
  const was = F.dlg;
  Object.assign(F, { dlg: null, timer: null, busy: false, shown: "" });
  if (off && was) api("devices/find", { on: false }).catch((error) => toast(error.message));
}
/* Each read keeps the engine looking; one that finds it stopped (the computer slept past its idle time) starts it again. */
async function read() {
  if (dialog() !== F.dlg || !F.dlg) return stopLooking();
  if (F.busy) return;
  F.busy = true;
  const dlg = F.dlg;
  try {
    const view = await (F.ask ? api("devices/find", { on: true }) : api("devices/find"));
    if (F.dlg !== dlg) return;
    F.ask = !view.looking;
    showFound(view);
  } catch (error) {
    // The engine's refusal (Lockdown, or a Branch that does not look) is said in the tab, verbatim, and not asked again.
    if (F.dlg === dlg) { paint(dlg.querySelector("#ac-found"), `<p class="hint" data-css="margin:0" role="status">${esc(error.message)}</p>`); stopLooking(false); }
  } finally { if (F.dlg === dlg) F.busy = false; }
}
function startLooking(dlg) {
  stopLooking(false);
  Object.assign(F, { dlg, ask: true });
  F.timer = setInterval(read, 2500);
  read();
}

/* Pair on a found computer: the usual "Pair another computer" invitation, then that computer is handed its link. */
async function pairFound(id) {
  if (F.pairing || !F.dlg) return;
  F.pairing = true;
  clearInterval(F.timer); // the found list stays in the engine until the link is handed over
  F.timer = null;
  try {
    await startPairing("computer");
    // The other computer says in its own words when it will not take this link (one only this computer can reach).
    if (pairingInvite()) await api("devices/find/offer", { id }).catch((error) => toast(error.message));
  } finally {
    F.pairing = false;
    stopLooking();
  }
}

function addComputer(tab) {
  closePop();
  if (tab !== "network") stopLooking();
  if (tab === "code") return startPairing("code", ({ body, foot }) => addDialog("code", body, foot));
  stopPairing();
  if (tab === "network") return startLooking(addDialog("network", `<div class="rows" id="ac-found"></div>`));
  const body = tab === "phone" ? `<p data-css="margin:0">${t("window.flows.comp.scan")}</p><button class="btn" type="button" data-act="pair">${t("window.flows.comp.show-code")}</button>` : "";
  addDialog(tab, body);
}

const KINDS = [["sandbox", "shield", "window.flows.comp.sandbox", "window.flows.comp.sandbox-hint"], ["pair", "monitor", "window.flows.comp.pair", "window.flows.comp.pair-hint"], ["cloud", "cloud17d", "window.flows.comp.cloud", "window.flows.comp.cloud-hint"], ["remote", "key", "window.flows.comp.remote", "window.flows.comp.remote-hint"]];
/* Pairing and local private computers have owner flows; the remaining kinds are greyed with their own reason.
   A cloud computer needs keepoak.com, and adding a computer over SSH (the engine's /api/remotes)
   gives Trunks another machine, which waits for a separate safety review. Their action has no handler, so core/features.js
   greys them and shows the reason. */
const WHY = { sandbox: "comp-sandbox", cloud: "cloudnew17d", remote: "comp-remote" };

function addKind() {
  closePop();
  openDlg({ title: t("window.flows.comp.add"),
    body: `<div class="provs">${KINDS.map(([v, i, n, s]) => `<button class="prov" type="button" data-act="${v === "pair" ? "comp-add-go" : v === "sandbox" ? "comp-private" : "comp-kind"}" data-v="${v}"${["pair", "sandbox"].includes(v) ? "" : ` data-why="${WHY[v]}"`}><span class="ico-tile">${ic(i, "s")}</span><b>${t(n)}</b><small>${t(s)}</small></button>`).join("")}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button>` });
}

export function init() {
  markLive(["addcomp", "ac-tab", "comp-add", "comp-add-go", "ac-pair"]);
  initComputers17();
  initPrivateComputers();
  on("addcomp", () => addComputer("network"));
  on("ac-tab", (el) => addComputer(el.dataset.v));
  on("ac-pair", (el) => pairFound(el.dataset.v));
  on("comp-add", () => addKind());
  on("comp-add-go", (el) => { if (el.dataset.v === "pair") startPairing("computer"); });
}
