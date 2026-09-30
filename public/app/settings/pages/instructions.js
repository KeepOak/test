/* Settings › Instructions & personality: the owner's instruction files as the engine keeps them
   (GET /api/settings-kit/files and /files/<slot>), edited in the prototype's editor: Save writes the whole file
   (POST /api/settings-kit/files { slot, text }), and the engine keeps the one version before the last save made here,
   which "Put this back" writes back (POST /api/settings-kit/files/undo { slot }). Each row's "Read <file>" switch is the
   engine's own switch for that file (POST /api/context-files), drawn from the engine's list. "Write it for me" runs a tool by hand
   (POST /api/tools/try), so it stays greyed for its own review. */
import { E, refresh } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render, $ } from "../../core/dom.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { ic, toast, openDlg, closeDlg } from "../../core/ui.js";
import { t, language, plural } from "../../../i18n.js";
import { say } from "../../core/words.js";
import { gsel } from "../../core/gsel.js";

/* The prototype's line for each file, by the engine's slot. */
const ABOUT = {
  soul: "Who your assistant is: tone and boundaries", identity: "Its name and how it introduces itself", user: "Who you are and what you prefer",
  agents: "House rules for every Trunk (also reads CLAUDE.md, .hermes.md)", tools: "Notes on the tools it has", sop: "Your standing steps, read before each task",
  memory: "Notes you wrote for it", heartbeat: "What it checks on when it wakes on a schedule",
};
/* The engine's list, and each file as opened (text, lastSave, setting), by slot. */
let files = null;
const opened = {};

const lines = (text) => (text ? text.trim().split("\n").length : 0);
const nameOf = (f) => f.name ?? f.names?.[0] ?? f.slot;

async function loadFiles() {
  try {
    files = (await api("settings-kit/files")).files ?? [];
    const each = await Promise.all(files.map((f) => api(`settings-kit/files/${encodeURIComponent(f.slot)}`)));
    for (const one of each) opened[one.slot] = one;
  } catch (error) { toast(error.message); }
  render();
}

function fileRow(f) {
  const one = opened[f.slot], n = lines(one?.text), h = one?.lastSave ? 1 : 0;
  return `<div class="prow"><code class="if-name">${esc(nameOf(f))}</code><span class="grow"><b data-css="font-weight:500">${esc(say(ABOUT[f.slot]) ?? f.about)}</b><small>${n ? plural(n, { one: "window.settings.instructions.count-lines.one", other: "window.settings.instructions.count-lines" }) : t("agent-files.empty")}${h ? t("window.settings.instructions.value-earlier-version", { value: h }) : ""}</small></span><input class="sw" type="checkbox" data-sw="if-read" data-f="${esc(f.slot)}" ${f.setting === "off" ? "" : "checked"} aria-label="${esc(t("window.settings.instructions.read-name", { name: nameOf(f) }))}"><button class="btn sm" type="button" data-act="if-open" data-f="${esc(f.slot)}">${n ? t("prompts.action.edit") : t("agent-files.write")}</button></div>`;
}

/* "Whose files" (if-owner-choice): Every Trunk, or one Trunk. A Trunk has one file of its own in the engine, its SOUL (its own
   instructions, the `instructions` field of its record, which its turns carry beside the shared files); every other row
   uses the one every Trunk reads, so a Trunk's view draws those without a switch or an Edit. Saving a Trunk's SOUL is
   POST /api/trunks/<id> {instructions}; the engine keeps no earlier version of it, so its editor has no history. */
let owner = "branch";
const trunkOf = () => (owner === "branch" ? null : E.trunks.find((tr) => tr.id === owner) ?? null);
function trunkRow(f, trunk) {
  const own = f.slot === "soul", n = own ? lines(trunk.instructions) : 0;
  const small = n ? plural(n, { one: "window.settings.instructions.count-lines.one", other: "window.settings.instructions.count-lines" }) : t("window.settings.instructions.uses-the-shared-one");
  return `<div class="prow"><code class="if-name">${esc(nameOf(f))}</code><span class="grow"><b data-css="font-weight:500">${esc(say(ABOUT[f.slot]) ?? f.about)}</b><small>${small}</small></span>${own ? `<button class="btn sm" type="button" data-act="if-open" data-f="soul">${n ? t("prompts.action.edit") : t("agent-files.write")}</button>` : ""}</div>`;
}

export function draw() {
  const trunk = trunkOf();
  if (!trunk) owner = "branch";
  const owners = gsel({id:"if-owner-choice", label:t("window.settings.instructions.whose-files"), options:[["branch", t("window.settings.instructions.every-trunk")], ...E.trunks.map(tr => [tr.id, tr.name])], value:owner});
  return `<h1>${esc(t("settings.page.instructions"))}</h1><p class="lede">${t("window.settings.instructions.plain-files-every-trunk-reads-before")}</p>
  <div class="fld" data-css="margin-top:6px"><span>${t("window.settings.instructions.whose-files")}</span>${owners}</div>
  <div class="rows" data-css="margin-top:8px">${(files ?? []).map((f) => (trunk ? trunkRow(f, trunk) : fileRow(f))).join("")}</div>
  <p class="hint">${t("window.settings.instructions.a-file-cant-widen")}</p>`;
}

function openTrunkSoul(trunk) {
  const f = (files ?? []).find((x) => x.slot === "soul");
  openDlg({ title: `${f ? nameOf(f) : ""} · ${trunk.name}`, wide: true, body: `<div class="ifed"><textarea class="inp code6 ifed-t" id="if-text" rows="14" spellcheck="false" aria-label="${esc(trunk.name)}">${esc(trunk.instructions ?? "")}</textarea></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="if-save" data-f="soul">${t("action.save")}</button>` });
}
async function saveTrunkSoul(trunk) {
  const text = $("#if-text")?.value ?? "";
  try { await api(`trunks/${encodeURIComponent(trunk.id)}`, { instructions: text }); } catch (error) { toast(error.message); return; }
  closeDlg();
  await refresh().catch((error) => toast(error.message));
  render();
  toast(t("window.settings.instructions.saved-the-next-task-reads-it"));
}

function versions(one) {
  if (!one.lastSave) return `<p class="hint" data-css="margin:4px 0">${t("window.settings.instructions.none-yet-each-save-keeps-the")}</p>`;
  const when = new Date(one.lastSave).toLocaleString(language(), { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return `<div class="ifed-v"><span>${esc(when)}</span><button class="btn ghost sm" type="button" data-act="if-back" data-f="${esc(one.slot)}" data-i="0">${t("window.settings.instructions.put-this-back")}</button></div>`;
}

function openEditor(slot, text) {
  const one = opened[slot];
  if (!one) return;
  openDlg({ title: t("window.settings.instructions.name-every-trunk", { name: one.name }), wide: true, body: `<div class="ifed"><textarea class="inp code6 ifed-t" id="if-text" rows="14" spellcheck="false" aria-label="${esc(one.name)}" ${one.editable ? "" : "readonly"}>${esc(text ?? one.text)}</textarea>
    <aside class="ifed-h"><b>${t("window.settings.instructions.earlier-versions")}</b>${versions(one)}
    <button class="btn sm" type="button" data-act="if-write" data-f="${esc(slot)}">${ic("spark", "s")}${t("window.settings.instructions.write-it-for-me")}</button><p class="hint" data-css="margin:0">${t("window.settings.instructions.looks-around-this-workspace-and-writes")}</p></aside></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="if-save" data-f="${esc(slot)}">${t("action.save")}</button>` });
}

async function openFile(slot) {
  try { opened[slot] = await api(`settings-kit/files/${encodeURIComponent(slot)}`); } catch (error) { toast(error.message); return; }
  openEditor(slot);
}

async function save(slot) {
  const text = $("#if-text")?.value ?? "";
  try {
    const saved = await api("settings-kit/files", { slot, text });
    closeDlg();
    toast(saved.setting === "off" ? t("accounts.saved") : t("window.settings.instructions.saved-the-next-task-reads-it"));
  } catch (error) { toast(error.message); return; }
  await loadFiles();
}

/* The engine writes the version before the last save back at once; the editor then shows what the file holds now. */
async function putBack(slot) {
  try {
    await api("settings-kit/files/undo", { slot });
    opened[slot] = await api(`settings-kit/files/${encodeURIComponent(slot)}`);
    openEditor(slot);
  } catch (error) { toast(error.message); }
  loadFiles();
}

/* The row's switch (the prototype's "Read <file>"): on, a task carries the file; off, it is not read
   (POST /api/context-files { files: { <slot>: "on" | "off" } }, which keeps the other files' switches). The row is then
   drawn again from what the engine answers, never from the box itself. */
async function setRead(slot, read) {
  try { await api("context-files", { files: { [slot]: read ? "on" : "off" } }); } catch (error) { toast(error.message); }
  await loadFiles();
}

export function load() { return loadFiles(); }

export function init() {
  loadFiles();
  on("if-open", (el) => (trunkOf() ? openTrunkSoul(trunkOf()) : openFile(el.dataset.f)));
  on("if-save", (el) => (trunkOf() ? saveTrunkSoul(trunkOf()) : save(el.dataset.f)));
  on("if-back", (el) => putBack(el.dataset.f));
  document.addEventListener("change", (e) => {
    if (e.target.id === "if-owner-choice") { owner = e.target.value; render(); }
    else if (e.target.dataset?.sw === "if-read") setRead(e.target.dataset.f, e.target.checked);
  });
  markLive(["if-open", "if-save", "if-back", "sw:if-text", "sw:if-read", "sw:if-owner-choice"]);
}

export const live = { "if-open": true, "if-save": true, "if-back": true, "sw:if-read": true, "sw:if-owner-choice": true };
