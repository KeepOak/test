import { controlRow } from "./row-kit.js";
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
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg, $ } from "../core/ui.js";
import { demos17, row17, sec17, pill17 } from "./rows17.js";
import { t } from "../../i18n.js";

const U = { sources: [], pick: null, preview: null, moved: null, parts: null };

export function sections17(lv) {
  let html = sec17(t("window.settings.p17-usage.moving-in-and-out"),
    row17(t("window.settings.p17-usage.move-in-from-another-assistant"), U.moved ? t("window.settings.p17-usage.brought-in-from-moved-everything-came", { moved: U.moved }) : t("window.settings.p17-usage.conversations-memory-instructions-skills-and-tool"), t("window.settings.p17-usage.move-in"), "moveinb17")
    + row17(t("window.settings.p17-usage.take-everything-with-you"), t("window.settings.p17-usage.your-trunks-skills-procedures-memory-and"), t("window.settings.p17-usage.export-2"), "exportb17"));
  if (lv >= 1) html += sec17(t("window.settings.p17-usage.money-and-keeping-more"),
    row17(t("window.settings.p17-usage.spend-caps-per-service"), t("window.settings.p17-usage.a-monthly-limit-for-each-service"), t("window.settings.p17-usage.set-caps"), "capsb17")
    + demos17(["balance", "projcost", "backup", "retention", "held"]));
  return html;
}

/* ---------- move in ---------- */
const bringable = () => (U.preview?.groups ?? []).flatMap((g) => g.items).filter((i) => !i.blocked && !i.alreadyMoved).map((i) => i.key);
function moveDlg() {
  const opts = U.sources.map((s) => `<button type="button" class="upd-o15" data-act="moveinpickb17" data-v="${esc(s.source)}" aria-pressed="${U.pick === s.source}" ${s.found ? "" : "disabled"}><b>${esc(s.name)}</b><small>${s.found ? t("window.settings.p17-usage.found-on-this-computer") : t("window.settings.p17-usage.not-found-here")}</small></button>`).join("");
  const rows = U.preview ? `<div class="rows">${U.preview.groups.map((g) => `<div class="prow"><span class="grow"><b>${esc(g.name)}</b><small>${esc(g.items.filter((i) => !i.blocked).length)}</small></span>${pill17("ok", t("window.settings.p17-usage.comes-in"))}</div>`).join("")}<div class="prow"><span class="grow"><b>${t("window.settings.p17-usage.keys-and-passwords")}</b><small>${t("window.settings.p17-usage.never-copied-you-sign-in-again")}</small></span>${pill17("idle", t("window.settings.p17-usage.left-out"))}</div></div>`
    : `<p class="hint" data-css="margin:0">${t("window.settings.p17-usage.pick-one-to-see-what-comes")}</p>`;
  openDlg({ title: t("window.settings.p17-usage.move-in-from-another-assistant"), body: `<p class="lead-b17">${t("window.settings.p17-usage.branch-looked-on-this-computer-everything")}</p><div class="opts-b17">${opts}</div>${rows}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("updates.busy.cancel")}</button><button class="btn pri" type="button" data-act="moveingob17" ${bringable().length ? "" : "disabled"}>${t("reach.git.install")}</button>` });
}
async function openMove() {
  try {
    const found = await api("move-in?look=1");
    // Off looks at nothing; the engine says why in its own words when asked for a preview.
    if (found.mode === "off") await api("move-in/preview", { source: "claude-code" });
    Object.assign(U, { sources: found.sources ?? [], pick: null, preview: null });
  } catch (error) { toast(error.message); return; }
  moveDlg();
}
async function pick(el) {
  U.pick = el.dataset.v;
  try { U.preview = await api("move-in/preview", { source: U.pick }); } catch (error) { U.preview = null; toast(error.message); }
  moveDlg();
}
async function bring() {
  const items = bringable();
  if (!U.pick || !items.length) return;
  try { U.moved = (await api("move-in/import", { source: U.pick, items })).name; } catch (error) { toast(error.message); return; }
  closeDlg();
  render();
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
  const rows = keyAccounts.map((a, i) => `${controlRow(`<b>${esc(a.name)}</b><span class="right num15"><input class="inp" id="cap-b17-${i}" value="${esc(a.cap ?? "")}" aria-label="${esc(t("window.settings.p17-usage.name-monthly-cap", { name: a.name }))}"><small>${t("window.settings.p17-usage.usd-a-month")}</small></span><small>${esc(t("settings.help.account-cap"))}</small>`)}`).join("");
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
  on("exportb17", () => openExport());
  on("exportgob17", () => exportNow());
  markLive(["moveinb17", "moveinpickb17", "moveingob17", "exportb17", "exportgob17", "sw:exp-b17-skills", "sw:exp-b17-memory", "sw:exp-b17-settings"]);
}
