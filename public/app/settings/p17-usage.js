/* Settings › Data & usage, pass 17 (prototype patch17b), from the engine:
   Move in: GET /api/move-in?look=1 lists the five assistants and whether each was found on this computer; picking
   one reads POST /api/move-in/preview { source } (what would come, nothing changes); Bring it in is
   POST /api/move-in/import { source, items } with every item that is neither blocked nor already brought over.
   With the switch off the engine refuses the preview in its own words, which are shown.
   Take everything with you: GET /api/agent-export counts each part; Export is POST /api/agent-export { sections }
   and saves the one file (memory always leaves with personal details masked; keys never go in). Trunks and
   conversations are not parts of that file, so they are drawn and not ticked.
   Spend caps per service: one box per account that bills per use (GET /api/accounts, pools of kind "api-key"), holding
   its monthly cap in US dollars (empty = no cap); Save caps sends each changed one as POST /api/accounts/update
   { pool, account, monthlyCapUsd }; a cap raised or taken away waits for the owner's yes to the engine's words. The
   engine pauses an account at its cap. Plans have no cap here. The rows below are
   the engine's readouts (settings/demos-b5.js). */
import { esc, render } from "../core/dom.js";
import { E, S } from "../core/state.js";
import { sessionPrincipal } from "../core/session-pages.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg, dialog, $ } from "../core/ui.js";
import { demos17, row17, sec17, pill17 } from "./rows17.js";
import { t } from "../../i18n.js";

const U = { sources: [], pick: null, preview: null, moved: null, parts: null, where: null, selected: new Set(), busy: false, importing: false, serial: 0, dialog: null, who: null };

export function sections17(lv) {
  let html = sec17(t("window.settings.p17-usage.moving-in-and-out"),
    row17(t("window.settings.p17-usage.move-in-from-another-assistant"), U.moved ? esc(U.moved) : t("window.settings.p17-usage.conversations-memory-instructions-skills-and-tool"), t("window.settings.p17-usage.move-in"), "moveinb17")
    + row17(t("window.settings.p17-usage.take-everything-with-you"), t("window.settings.p17-usage.your-trunks-skills-procedures-memory-and"), t("window.settings.p17-usage.export-2"), "exportb17"));
  if (lv >= 1) html += sec17(t("window.settings.p17-usage.money-and-keeping-more"),
    row17(t("window.settings.p17-usage.spend-caps-per-service"), t("window.settings.p17-usage.a-monthly-limit-for-each-service"), t("window.settings.p17-usage.set-caps"), "capsb17")
    + demos17(["balance", "projcost", "backup", "retention", "held"]));
  return html;
}

/* ---------- move in ---------- */
const moveIdentity = () => JSON.stringify([sessionPrincipal(E.profiles), S.signedIn, token.get()]);
const currentMove = (serial) => serial === U.serial && U.dialog?.isConnected && U.who === moveIdentity() && E.profiles?.isOwner === true;
const bringable = () => (U.preview?.groups ?? []).flatMap((g) => g.items).filter((i) => !i.blocked && !i.alreadyMoved && U.selected.has(i.key)).map((i) => i.key);
function moveDlg() {
  const opts = U.sources.map((s) => `<button type="button" class="upd-o15" data-act="moveinpickb17" data-v="${esc(s.source)}" aria-pressed="${U.pick === s.source}" ${s.found && !U.busy ? "" : "disabled"}><b>${esc(s.name)}</b><small>${s.found ? t("window.settings.p17-usage.found-on-this-computer") : t("window.settings.p17-usage.not-found-here")}</small></button>`).join("");
  const progress = U.busy ? `<p role="status">${esc(U.importing ? t("memory.movein.bringing", { count: bringable().length }) : t("memory.movein.reading"))}</p>` : "";
  const rows = U.preview ? `<p>${esc(U.preview.name)} · ${esc(U.preview.from)}</p>${(U.preview.notes ?? []).map((note) => `<p class="hint">${esc(note)}</p>`).join("")}<p>${t("memory.movein.tick-then-bring")}</p><div class="rows">${U.preview.groups.map((g) => `<h3>${esc(g.name)}</h3>${g.items.map((item) => `<label class="prow"><input type="checkbox" class="chk15" data-move-item="${esc(item.key)}" ${U.selected.has(item.key) ? "checked" : ""} ${item.blocked || item.alreadyMoved || U.busy ? "disabled" : ""}><span class="grow"><b>${esc(item.title)}</b><small>${esc(item.detail)}${item.alreadyMoved ? ` ${t("memory.movein.already")}` : ""}</small></span></label>`).join("")}`).join("")}</div>`
    : `<p class="hint">${t(U.busy ? "memory.movein.reading" : "window.settings.p17-usage.pick-one-to-see-what-comes")}</p>`;
  openDlg({ title: t("window.settings.p17-usage.move-in-from-another-assistant"), body: `<p class="lead-b17">${t("window.settings.p17-usage.branch-looked-on-this-computer-everything")}</p><div class="opts-b17">${opts}</div><button class="btn ghost" type="button" data-act="moveinfileb17" ${U.busy ? "disabled" : ""}>${t("window.settings.movein-export.choose")}</button>${progress}${rows}`,
    foot: `<button class="btn ghost" type="button" data-act="moveincancelb17">${t(U.importing ? "delight.ach.close" : "updates.busy.cancel")}</button><button class="btn pri" type="button" data-act="moveingob17" ${!U.busy && bringable().length ? "" : "disabled"}>${t("window.settings.movein-export.bring")}</button>` });
  U.dialog = dialog();
  const shown = U.dialog, observer = new MutationObserver(() => {
    if (shown.isConnected) return;
    observer.disconnect();
    // Redrawing replaces the dialog; dismissing it releases the archive, including Escape and the X.
    if (U.dialog === shown) {
      ++U.serial;
      Object.assign(U, { dialog: null, where: null, preview: null, selected: new Set(), busy: false, importing: false });
    }
  });
  observer.observe(shown.parentNode, { childList: true });
  U.dialog.querySelectorAll("[data-move-item]").forEach((input) => input.addEventListener("change", () => {
    if (!currentMove(U.serial)) { cancelMove(); return; }
    if (input.checked) U.selected.add(input.dataset.moveItem); else U.selected.delete(input.dataset.moveItem);
    U.dialog.querySelector('[data-act="moveingob17"]').disabled = U.busy || !bringable().length;
  }));
}
async function openMove() {
  const serial = ++U.serial, who = moveIdentity();
  U.who = who;
  try {
    const found = await api("move-in?look=1");
    if (serial !== U.serial || who !== moveIdentity()) return;
    // Off looks at nothing; the engine says why in its own words when asked for a preview.
    if (found.mode === "off") await api("move-in/preview", { source: "claude-code" });
    if (serial !== U.serial || who !== moveIdentity()) return;
    Object.assign(U, { sources: found.sources ?? [], pick: null, preview: null, where: null, selected: new Set(), busy: false, importing: false });
  } catch (error) { if (serial === U.serial && who === moveIdentity()) toast(error.message); return; }
  if (serial === U.serial && who === moveIdentity()) moveDlg();
}
async function previewMove(where, serial = ++U.serial) {
  Object.assign(U, { pick: where.source ?? null, where, preview: null, selected: new Set(), busy: true });
  moveDlg();
  try {
    const preview = await api("move-in/preview", where);
    if (!currentMove(serial)) { if (serial === U.serial) cancelMove(); return; }
    U.preview = preview;
  } catch (error) {
    if (!currentMove(serial)) { if (serial === U.serial) cancelMove(); return; }
    U.where = null; toast(error.message);
  }
  U.busy = false;
  moveDlg();
}
async function pick(el) { if (!currentMove(U.serial)) { cancelMove(); return; } if (!U.busy) await previewMove({ source: el.dataset.v }); }
function chooseMoveFile() {
  if (!currentMove(U.serial)) { cancelMove(); return; }
  if (U.busy) return;
  const serial = ++U.serial, picker = Object.assign(document.createElement("input"), { type: "file", accept: ".zip,.tar,.tar.gz,.tgz" });
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    if (!file || !currentMove(serial)) return;
    Object.assign(U, { pick: null, where: null, preview: null, selected: new Set(), importing: false });
    if (file.size > 32 * 1024 * 1024) { toast(t("memory.movein.too-large")); moveDlg(); return; }
    U.busy = true; moveDlg();
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error(t("window.settings.movein-export.read-error")));
        reader.readAsDataURL(file);
      });
      if (!currentMove(serial)) { if (serial === U.serial) cancelMove(); return; }
      await previewMove({ archive: { name: file.name, data } }, serial);
    } catch (error) {
      if (!currentMove(serial)) { if (serial === U.serial) cancelMove(); return; }
      U.busy = false; U.importing = false; toast(error.message); moveDlg();
    }
  });
  picker.click();
}
async function bring() {
  if (!currentMove(U.serial)) { cancelMove(); return; }
  const items = bringable();
  if (U.busy || !U.where || !items.length) return;
  const serial = ++U.serial, where = U.where;
  U.busy = true; U.importing = true; moveDlg();
  try {
    const receipt = await api("move-in/import", { ...where, items });
    if (!currentMove(serial)) { if (serial === U.serial) cancelMove(); return; }
    U.moved = t("memory.movein.summary", { brought: receipt.brought.length, skipped: receipt.skipped.length });
    // Release uploaded bytes once the import settles; a retry starts with a fresh preview.
    Object.assign(U, { where: null, preview: null, selected: new Set(), busy: false, importing: false });
    openDlg({ title: t("memory.movein.brought-from", { name: receipt.name }),
      body: `<p>${esc(U.moved)}</p>${receipt.skipped.map((item) => `<p>${esc(t("memory.movein.not-brought", { title: item.title, reason: item.reason }))}</p>`).join("")}`,
      foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
    render();
  } catch (error) {
    if (!currentMove(serial)) { if (serial === U.serial) cancelMove(); return; }
    U.busy = false; U.importing = false; toast(error.message); moveDlg();
  }
}
function cancelMove() {
  ++U.serial;
  Object.assign(U, { where: null, preview: null, selected: new Set(), busy: false, importing: false });
  closeDlg();
}

/* ---------- take everything with you ---------- */
const summary = (names) => (U.parts ?? []).filter((p) => names.includes(p.name)).map((p) => p.summary).join(" · ");
/* The dialog's ticks: each names the parts of the file it stands for. */
const EXP = [["#exp-b17-skills", ["skills", "procedures"]], ["#exp-b17-memory", ["memory"]], ["#exp-b17-settings", ["routing", "permissions"]]];
function exportDlg() {
  const tick = (id, title, sub, on, live = true) => `<label class="prow"><input type="checkbox" class="chk15" ${live ? `id="${id}"` : "disabled"} ${on ? "checked" : ""}><span class="grow"><b>${esc(title)}</b><small>${esc(sub)}</small></span></label>`;
  const body = tick("", t("window.settings.p17-usage.trunks-and-their-instructions"), "", false, false)
    + tick("exp-b17-skills", t("window.settings.p17-usage.skills-and-procedures"), summary(["skills", "procedures"]), true)
    + tick("exp-b17-memory", t("memory.movein.kind.memory"), t("window.settings.p17-usage.personal-details-removed"), true)
    + tick("exp-b17-settings", t("memory.movein.kind.setting"), summary(["routing", "permissions"]), true)
    + tick("", t("people.home.list"), "", false, false);
  openDlg({ title: t("window.settings.p17-usage.take-everything-with-you"), body: `<p class="lead-b17">${t("window.settings.p17-usage.one-branch-file-another-branch-can")}</p><div class="rows">${body}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("updates.busy.cancel")}</button><button class="btn pri" type="button" data-act="exportgob17">${t("window.settings.p17-usage.export")}</button>` });
}
async function openExport() {
  try { U.parts = (await api("agent-export")).sections; } catch (error) { toast(error.message); return; }
  exportDlg();
}
async function exportNow() {
  const sections = EXP.filter(([sel]) => $(sel)?.checked).flatMap(([, parts]) => parts);
  if (!sections.length) return;
  try {
    const { data } = await api("agent-export", { sections });
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `branch-${new Date().toISOString().slice(0, 10)}.branch` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeDlg();
  } catch (error) { toast(error.message); }
}

/* ---------- spend caps per service ---------- */
let keyAccounts = [];
function capsDlg() {
  markLive(keyAccounts.map((a, i) => "sw:cap-b17-" + i)); // each box is read by saveCaps below
  const rows = keyAccounts.map((a, i) => `<div class="ctl"><b>${esc(a.name)}</b><span class="right num15"><input class="inp" id="cap-b17-${i}" value="${esc(a.cap ?? "")}" aria-label="${esc(t("window.settings.p17-usage.name-monthly-cap", { name: a.name }))}"><small>${t("window.settings.p17-usage.usd-a-month")}</small></span><small></small></div>`).join("");
  openDlg({ title: t("window.settings.p17-usage.spend-caps-per-service"), body: `<p class="lead-b17">${t("window.settings.p17-usage.when-a-service-reaches-its-cap")}</p>${rows || `<p class="empty">${esc(t("inspector.nothing"))}</p>`}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("updates.busy.cancel")}</button><button class="btn pri" type="button" data-act="capssaveb17" ${keyAccounts.length ? "" : "disabled"}>${t("window.settings.p17-usage.save-caps")}</button>` });
}
/* A cap raised or taken away is refused by the engine until the owner says yes: its words are shown in a confirm, and only
   "Yes, make it less careful" sends that one cap again with confirmLoosening. What was asked is kept for that resend, and
   the yes names that one entry (pool and account: every connection's first account is "primary"), never an id alone. */
let capsAsked = null;
let capsYes = null;
async function openCaps() {
  capsAsked = null;
  capsYes = null;
  try {
    const { pools } = await api("accounts");
    keyAccounts = (pools ?? []).filter((p) => p.kind === "api-key").flatMap((p) => p.accounts.map((a) => ({ pool: p.pool, account: a.id, name: `${p.name ?? p.pool} · ${a.label}`, cap: a.monthlyCapUsd })));
  } catch (error) { toast(error.message); return; }
  capsDlg();
}
async function saveCaps() {
  const asked = capsAsked ?? keyAccounts.map((a, i) => [a, ($("#cap-b17-" + i)?.value ?? "").trim()]);
  const yes = capsYes;
  capsAsked = null;
  capsYes = null;
  if (asked.some(([, v]) => v !== "" && !(Number(v) >= 0))) return;
  let at = null;
  try {
    for (const [a, v] of asked) {
      const cap = v === "" ? null : Number(v);
      if (cap === a.cap) continue;
      at = a;
      await api("accounts/update", { pool: a.pool, account: a.account, monthlyCapUsd: cap, ...(yes === a ? { confirmLoosening: true } : {}) });
      a.cap = cap;
    }
    closeDlg();
    toast(t("window.settings.p17-usage.caps-saved"));
  } catch (error) {
    if (at && yes !== at && error.status === 409 && /less careful/.test(error.message)) {
      capsAsked = asked;
      capsYes = at;
      openDlg({ title: t("settings-kit.loosens"), body: `<p>${esc(error.message)}</p>`,
        foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="capsloosenb17">${t("settings-kit.confirm")}</button>` });
    } else toast(error.message);
  }
}

let started = false;
export function init17() {
  if (started) return;
  started = true;
  on("capsb17", () => openCaps());
  on("capssaveb17", () => saveCaps());
  on("capsloosenb17", () => { closeDlg(); if (capsAsked) saveCaps(); });
  markLive(["capsb17", "capssaveb17", "capsloosenb17"]);
  on("moveinb17", () => openMove());
  on("moveinpickb17", (el) => pick(el));
  on("moveingob17", () => bring());
  on("moveinfileb17", () => chooseMoveFile());
  on("moveincancelb17", () => cancelMove());
  on("exportb17", () => openExport());
  on("exportgob17", () => exportNow());
  markLive(["moveinfileb17", "moveincancelb17", "moveinb17", "moveinpickb17", "moveingob17", "exportb17", "exportgob17", "sw:exp-b17-skills", "sw:exp-b17-memory", "sw:exp-b17-settings"]);
}
