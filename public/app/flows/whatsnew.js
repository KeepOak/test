/* What's new (Guide › What's new, and Settings › Updates › What's new): the notes the engine ships for the installed
   version (GET /api/release-notes), each a row that opens where it lives. A row runs its action only when that control
   is live in this window; otherwise it is greyed out, so a note can never open something that is not ready.
   Release notes (the version menu's "Read the release notes", the Settings › Updates row, What's new's own row), 1:1 with
   the prototype's notesDlg: the installed version's notes from the same engine route, under New, Better and Fixed (each
   note's group), each with "Show me" where its place is live. In the desktop app, a version the updater has found and not
   installed yet (window.branchDesktop.updateStatus release) is its second tab, with the words the release was published
   with; installing it stays greyed here (the desktop's updater, shell/usage.js). No version is written in: each is the
   engine's or the updater's. */

import { esc } from "../core/dom.js";
import { openDlg, closeDlg, closePop, toast, ic } from "../core/ui.js";
import { api } from "../core/api.js";
import { on, run, has } from "../core/actions.js";
import { markLive, isLive } from "../core/features.js";
import { showTool } from "../places/customize.js";
import { renderNow } from "../core/dom.js";
import { t } from "../../i18n.js";

const dataAttrs = (data) => Object.entries(data ?? {}).map(([k, v]) => `data-${esc(k)}="${esc(v)}"`).join(" ");
/* A note whose place is not live yet carries its own action, so it is greyed out like that control. */
const ready = (act) => isLive(act) && has(act);
const row = (n) => `<button type="button" class="new-row13" data-act="${ready(n.act) ? "new13-go" : esc(n.act)}" data-a="${esc(n.act)}" ${dataAttrs(n.data)}><span class="ico-tile">${ic(n.icon, "s")}</span><span class="grow"><b>${esc(n.title)}</b><small>${esc(n.text)}</small></span>${ic("chev", "s")}</button>`;

async function openWhatsNew() {
  closePop();
  let notes;
  try { notes = await api("release-notes"); } catch (error) { toast(error.message); return; }
  /* The notes are this build's, or the newest release it already contains (src/release-notes.ts notesFor); a way out is
     always in reach, not only the corner's X (dogfood D26). */
  openDlg({ title: t("window.settings.updates.whats-new"), wide: true,
    body: `<p class="hint" data-css="margin:0 0 10px">${t("window.flows.whatsnew.lede")}</p><div class="new13">${(notes.items ?? []).map(row).join("")}</div>`,
    foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}

function go(el) {
  const act = el.dataset.a;
  closeDlg();
  if (ready(act)) run(act, el);
}

/* ---------- the version the desktop's updater has found ---------- */
/** The release waiting to be installed: { version, lines } from the desktop's updater, or null (in a browser, or when
    nothing newer was found). Its words are the published release's, one line each, bullets taken off. */
export async function waiting() {
  const status = await window.branchDesktop?.updateStatus?.();
  const release = status?.release;
  if (!release?.available || !release.latestVersion) return null;
  const lines = String(release.notes ?? "").split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").replace(/^#+\s*/, "").trim()).filter(Boolean);
  return { version: String(release.latestVersion), lines };
}

/* ---------- Release notes ---------- */
const RN = { tab: "installed" };
const GROUPS = [["new", "window.flows.whatsnew.new"], ["better", "window.flows.whatsnew.better"], ["fixed", "window.flows.whatsnew.fixed"]];
const note = (n) => `<li><span>${esc(n.title)}</span>${ready(n.act) ? `<button class="link" type="button" data-act="rngo17d" data-a="${esc(n.act)}" ${dataAttrs(n.data)}>${t("window.flows.whatsnew.show-me")}</button>` : ""}</li>`;
const installedVersion = (notes) => notes.installedVersion ?? notes.version;
function installedBody(notes) {
  const groups = GROUPS.map(([g, key]) => [key, (notes.items ?? []).filter((n) => (n.group ?? "new") === g)]).filter(([, items]) => items.length);
  const edition = installedVersion(notes) === notes.version ? "" : `<p class="hint">${esc(t("release-notes.edition", { version: notes.version }))}</p>`;
  return `<p class="hint" data-css="margin:10px 0 4px">${esc(t("release-notes.installed-build", { version: installedVersion(notes) }))}</p>${edition}${groups.map(([key, items]) => `<div class="rn-g17d"><h3>${t(key)}</h3><ul>${items.map(note).join("")}</ul></div>`).join("")}`;
}
const readyBody = (next) => `<p class="hint" data-css="margin:10px 0 4px">${esc(t("window.flows.whatsnew.is-ready", { version: next.version }))}</p><div class="rn-g17d"><ul>${next.lines.map((l) => `<li><span>${esc(l)}</span></li>`).join("")}</ul></div>`;

async function openNotes(tab) {
  closePop();
  let notes, next = null;
  try { notes = await api("release-notes"); } catch (error) { toast(error.message); return; }
  try { next = await waiting(); } catch (error) { toast(error.message); }
  RN.tab = tab === "ready" && next ? "ready" : "installed";
  const seg = next ? `<span class="seg" role="group" aria-label="${t("window.flows.whatsnew.version")}"><button type="button" data-act="relnotes17d" data-v="installed" aria-pressed="${RN.tab === "installed"}">${esc(t("window.flows.whatsnew.installed", { version: installedVersion(notes) }))}</button><button type="button" data-act="relnotes17d" data-v="ready" aria-pressed="${RN.tab === "ready"}">${esc(t("window.flows.whatsnew.ready", { version: next.version }))}</button></span>` : "";
  const foot = RN.tab === "ready"
    ? `<button class="btn ghost" type="button" data-act="dlg-close">${t("window.flows.first.later")}</button><button class="btn pri" type="button" data-act="rninstall17d">${t("window.settings.updates.install-when-nothing-is-running")}</button>`
    : `<button class="btn pri" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>`;
  openDlg({ title: t("window.flows.whatsnew.release-notes"), wide: true, body: `<div class="rn17d">${seg}${RN.tab === "ready" ? readyBody(next) : installedBody(notes)}</div>`, foot });
}

/* The prototype's wb-open17d: Customize › Tools › Skills with learn-this open (places/customize.js showTool). */
function openLearn() {
  closeDlg();
  showTool("skills", "learn17d");
  renderNow();
}

export function init() {
  markLive(["whatsnew13", "new13-go", "relnotes17d", "rngo17d", "wb-open17d"]);
  on("whatsnew13", () => openWhatsNew());
  on("new13-go", (el) => go(el));
  on("relnotes17d", (el) => openNotes(el?.dataset?.v));
  on("rngo17d", (el) => go(el));
  on("wb-open17d", () => openLearn());
}
