/* The theme gallery and "Make your own", 1:1 with the prototype's: tabs by group, a search, Daylight or Moonlight
   previews, every theme as a swatch card; the colour editor with contrast checked as you go; your themes' Edit, Copy,
   Code and Delete, and pasting a theme code. The engine's themes are worn through POST /api/look (look.js); the
   themes you make and your own accent stay in this window, as the audit says the engine cannot hold them. */

import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { E, S, ownName } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, dialog, ic, toast } from "../core/ui.js";
import { greyOut } from "../core/features.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";
import { L, BASE, EF, looks, lookOf, lookEF, wornId, withAccent, effMode, deriveEF, varsFromEF, contrastC, isHex,
  applyLook, setVars, saveLocal, wear, setContrast, swatch } from "./look.js";

export const ACCENTS = ["#D8612A", "#E0A526", "#2F8F5B", "#2F8C86", "#4F6FA8", "#8A5AA8", "#C0467A", "#16212A"];
const G = { f: "All", q: "", prev: null, ced: null };
const newId = () => Date.now().toString(36);

/* ---------- the gallery ---------- */
function card([id, name, group, mine], mode) {
  const acts = mine ? `<span class="my-acts"><button type="button" data-act="my-edit" data-v="${esc(mine.id)}">${t("prompts.action.edit")}</button><button type="button" data-act="my-dup" data-v="${esc(mine.id)}">${t("asks.examples.copy")}</button><button type="button" data-act="my-code" data-v="${esc(mine.id)}">${t("window.settings.computer.code")}</button><button type="button" data-act="my-del" data-v="${esc(mine.id)}">${t("window.shell.themes.delete")}</button></span>` : "";
  const on = wornId() === id;
  return `<div class="theme6" aria-current="${on}"><button class="theme6-b" type="button" data-act="skin" data-v="${esc(id)}" aria-pressed="${on}" aria-label="${esc(name)}">${swatch(lookEF(id, mode))}<b>${esc(name)}</b><small>${esc(mine ? t("people.home.own") : say(group))}</small></button>${acts}</div>`;
}

function galleryBody() {
  const mode = G.prev || effMode(), q = G.q.trim().toLowerCase(), all = looks();
  const groups = ["All", "Branch", "KeepOak", "Editors & terminals", "Yours"];
  const list = all.filter((x) => (G.f === "All" || x[2] === G.f) && (!q || x[1].toLowerCase().includes(q)));
  const tabs = groups.map((g) => `<button class="tab" type="button" aria-selected="${g === G.f}" data-act="skinf" data-v="${g}">${esc(say(g))}${g === "Yours" ? `<span class="n">${L.my.length}</span>` : ""}</button>`).join("");
  const make = G.f === "Yours" || G.f === "All" ? `<button class="theme6 make" type="button" data-act="ce-new">${ic("palette")}<b>${t("window.settings.appearance.make-your-own")}</b><small>${t("window.shell.themes.pick-every-colour")}</small></button>` : "";
  const shown = (L.cat?.THEMES ?? []).length;
  return `<div class="gal-top"><span class="tabs" data-css="margin:0">${tabs}</span></div>
    <div class="gal-bar"><label class="set-search" data-css="flex:1;margin:0">${ic("search", "s")}<input id="skin-q" placeholder="${t("look.search", { count: all.length })}" value="${esc(G.q)}" aria-label="${t("look.search.label")}"></label>
      <span class="seg" role="group" aria-label="${t("window.shell.themes.show-the-themes-in")}">${[["light", t("appearance.daylight")], ["dark", t("look.moonlight")]].map(([v, l]) => `<button type="button" data-act="skinprev" data-v="${v}" aria-pressed="${mode === v}">${l}</button>`).join("")}</span></div>
    <div class="themes6">${list.map((x) => card(x, mode)).join("") || `<p class="hint">${t("window.shell.themes.no-theme-has-that-name")}</p>`}${make}</div>
    <div class="gal-foot"><label class="chk"><input type="checkbox" id="g-contrast" data-sw="contrast"> ${t("window.settings.appearance.more-contrast")}</label><span class="grow"></span><button class="btn sm" type="button" data-act="my-paste">${t("window.shell.themes.paste-a-theme-code")}</button><button class="btn pri sm" type="button" data-act="ce-new">${ic("palette", "s")}${t("window.settings.appearance.make-your-own")}</button></div>
    ${shown ? `<p class="hint" data-css="margin:0">${t("window.shell.themes.the-shown-themes-are-the-same", { shown })}</p>` : ""}`;
}

/* Opens the gallery, or redraws it in place keeping its scroll and the search box's caret. */
export function skinGallery(filter) {
  if (filter) G.f = filter;
  const open = dialog()?.querySelector(".themes6");
  if (!open) { openDlg({ title: t("window.shell.themes.themes"), wide: true, body: galleryBody() }); paintContrast(); return; }
  const body = dialog().querySelector(".dlg-b"), top = open.scrollTop, typing = document.activeElement?.id === "skin-q";
  body.innerHTML = galleryBody();
  applyCss(body);
  greyOut(body);
  body.querySelector(".themes6").scrollTop = top;
  paintContrast();
  if (typing) { const box = $("#skin-q"); box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
}
const paintContrast = () => { for (const id of ["g-contrast", "a-contrast"]) { const box = document.getElementById(id); if (box) box.checked = L.look?.contrast === "more"; } };

/* ---------- make your own ---------- */
function startCed(fromId, editId) {
  const mine = editId ? L.my.find((x) => x.id === editId) : null;
  const base = mine ? mine.base || BASE : fromId || wornId();
  const name = mine ? mine.name : base === BASE ? t("window.shell.themes.my-theme") : t("window.shell.themes.my-name", { name: lookOf(base)[1] });
  G.ced = { id: mine?.id ?? null, name, base, light: mine ? { ...mine.light } : withAccent(lookEF(base, "light"), "light"),
    dark: mine ? { ...mine.dark } : withAccent(lookEF(base, "dark"), "dark"), edit: effMode(), was: { mine: L.mine, accent: L.accent } };
  L.accent = null;
  openCed();
}

function ratings(c) {
  const r = (a, b, need) => { const x = contrastC(a, b); return [x, x >= need + 2.5 ? t("window.shell.themes.easy-to-read") : x >= need ? t("window.shell.themes.readable") : t("window.shell.themes.hard-to-read"), x >= need]; };
  return [[t("window.shell.themes.text-on-the-background"), ...r(c.ink, c.bg, 4.5)], [t("window.shell.themes.softer-text-on-the-background"), ...r(c.ink2, c.bg, 4.5)], [t("window.shell.themes.text-on-cards"), ...r(c.ink, c.raise, 4.5)],
    [t("window.shell.themes.button-text-on-buttons"), ...r(c.onBtn, c.btn, 4.5)], [t("window.shell.themes.accent-against-the-background"), ...r(c.accent, c.bg, 3)]];
}

/* The small window it shows: your Trunks' names and the open conversation's own words, nothing made up. */
function preview(c) {
  const css = Object.entries(varsFromEF(c, G.ced.edit)).map(([k, x]) => `${k}:${x}`).join(";");
  const rows = E.trunks.slice(0, 3).map((t, i) => `<span class="cp-row ${i ? "" : "cp-on"}"><i></i>${esc(t.name)}${i ? "" : "<em></em>"}</span>`).join("");
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === S.chat) ?? E.sessions[0];
  const talk = s ? `<span class="cp-u">${esc(ownName(s.sessionId ?? s.id) || s.opening || s.title || "")}</span><span class="cp-b">${esc((s.lastMessage ?? "").slice(0, 90))}</span>` : "";
  return `<div class="cprev" data-css="${css}"><div class="cp-side"><b>Branch</b>${rows}</div>
    <div class="cp-main">${talk}<span class="cp-chips"><i class="c-ok">${t("first-run-steps.done")}</i><i class="c-warn">${t("glance.estimate")}</i><i class="c-bad">${t("panels.state.stopped")}</i></span></div></div>
    <div class="ratings">${ratings(c).map(([t, x, w, ok]) => `<div class="rate ${ok ? "" : "poor"}"><span>${t}</span><b>${x.toFixed(1)}:1</b><small>${w}</small></div>`).join("")}</div>`;
}

function openCed() {
  const d = G.ced, c = d[d.edit];
  const rows = EF.map(([k, l]) => `<label class="crow"><input type="color" id="ce-${k}" value="${c[k]}" aria-label="${esc(say(l))}"><span>${esc(say(l))}</span><input class="inp hexin" id="ceh-${k}" value="${c[k]}" maxlength="7" aria-label="${t("window.shell.themes.value-as-a-hex-code", { value: esc(l) })}" spellcheck="false"></label>`).join("");
  const bases = looks().filter((x) => !x[3]).map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join("");
  const dlg = openDlg({ title: d.id ? t("trunks.editing", { name: d.name }) : t("window.shell.themes.make-your-own-theme"), wide: true, body: `<div class="ced">
    <div class="ced-l"><label class="fld"><span>${t("accounts.field.name")}</span><input class="inp" id="ce-name" value="${esc(d.name)}" maxlength="40"></label>
      <label class="fld"><span>${t("people.admin.provider.preset")}</span><select class="inp" id="ce-base">${bases}</select></label>
      <div class="fld"><span>${t("window.shell.themes.you-are-colouring")}</span><span class="seg" role="group" aria-label="${t("window.shell.themes.which-mode-you-are-colouring")}">${[["light", t("appearance.daylight")], ["dark", t("look.moonlight")]].map(([v, l]) => `<button type="button" data-act="ce-mode" data-v="${v}" aria-pressed="${d.edit === v}">${l}</button>`).join("")}</span></div>
      <div class="fld"><span>${t("window.shell.themes.accent")}</span><span class="accs">${ACCENTS.map((a) => `<button type="button" class="acc" data-css="--c:${a}" data-act="ce-acc" data-v="${a}" aria-label="${t("window.settings.appearance.accent-value", { value: a })}" aria-pressed="${c.accent.toUpperCase() === a}"></button>`).join("")}</span></div>
      <div class="crows">${rows}</div>
      <button class="btn sm" type="button" data-act="ce-fill">${ic("spark", "s")}${t("window.shell.themes.fill-in-the-rest-from-background")}</button></div>
    <div class="ced-r"><p class="hint" data-css="margin:0 0 8px">${t("window.shell.themes.changes-show-on-the-whole-window")}</p><div id="ce-prev">${preview(c)}</div></div></div>`,
  foot: `<button class="btn ghost" type="button" data-act="ce-cancel">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="ce-save">${d.id ? t("trunks.save") : t("window.shell.themes.save-theme")}</button>` });
  dlg.querySelector("#ce-base").value = d.base;
  cedLive();
}
function cedLive() { const d = G.ced; if (d) setVars(d[effMode()], effMode()); }
function cedField(k, v) {
  const d = G.ced;
  if (!d || !isHex(v)) return false;
  d[d.edit][k] = v.toUpperCase();
  const a = $("#ce-" + k), b = $("#ceh-" + k);
  if (a && a.value.toUpperCase() !== v.toUpperCase()) a.value = v;
  if (b && document.activeElement !== b) b.value = v.toUpperCase();
  const p = $("#ce-prev");
  if (p) { p.innerHTML = preview(d[d.edit]); applyCss(p); }
  cedLive();
  return true;
}
function cedEnd(keep) {
  const d = G.ced;
  if (!d) return;
  G.ced = null;
  L.mine = d.was.mine;
  L.accent = d.was.accent;
  if (!keep) { closeDlg(); applyLook(); renderNow(); return; }
  const name = ($("#ce-name")?.value || d.name).trim().slice(0, 40) || t("window.shell.themes.my-theme");
  let x = d.id && L.my.find((y) => y.id === d.id);
  if (!x) { x = { id: newId() }; L.my.push(x); }
  Object.assign(x, { name, base: d.base, light: d.light, dark: d.dark });
  L.mine = x.id;
  saveLocal();
  closeDlg();
  applyLook();
  renderNow();
  toast(t("window.shell.themes.name-is-saved-and-on-find", { name }));
}

/* ---------- theme codes ---------- */
const themeCode = (x) => JSON.stringify({ branchTheme: 1, name: x.name, light: x.light, dark: x.dark });
function readThemeCode(text) {
  let o = null;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || o.branchTheme !== 1 || !o.light || !o.dark) return null;
  const clean = (m) => Object.fromEntries(EF.map(([k]) => [k, isHex(m[k]) ? m[k].toUpperCase() : null]));
  const light = clean(o.light), dark = clean(o.dark);
  if (Object.values(light).some((v) => !v) || Object.values(dark).some((v) => !v)) return null;
  return { name: String(o.name || "Pasted theme").slice(0, 40), light, dark };
}
function showCode(id) {
  const x = L.my.find((y) => y.id === id);
  if (!x) return;
  const code = themeCode(x);
  openDlg({ title: t("window.shell.themes.name-theme-code", { name: x.name }), body: `<p data-css="margin:0 0 8px" id="code6-say">${t("window.shell.themes.select-the-code-below-to-copy")}</p><textarea class="inp code6" readonly rows="6">${esc(code)}</textarea>`, foot: `<button class="btn pri" type="button" data-act="skins">${t("first-run-steps.done")}</button>` });
  navigator.clipboard?.writeText(code).then(() => { const s = $("#code6-say"); if (s) s.textContent = t("window.themes.copied"); }, (error) => toast(error.message));
}
function pasteGo() {
  const theme = readThemeCode($("#paste6")?.value || "");
  if (!theme) { $("#paste6-why").textContent = t("window.themes.not-a-code"); return; }
  L.my.push({ id: newId(), base: BASE, ...theme });
  saveLocal();
  skinGallery("Yours");
  toast(t("window.shell.themes.added-name", { name: theme.name }));
}
function duplicate(id) {
  const x = L.my.find((y) => y.id === id);
  if (!x) return;
  const n = { id: newId(), name: `${x.name} copy`.slice(0, 40), base: x.base, light: { ...x.light }, dark: { ...x.dark } };
  L.my.push(n);
  saveLocal();
  skinGallery("Yours");
  toast(t("window.shell.themes.made-name", { name: n.name }));
}
function askDelete(id) {
  const x = L.my.find((y) => y.id === id);
  if (x) openDlg({ title: t("window.shell.themes.delete-name", { name: x.name }), body: `<p data-css="margin:0">${t("window.shell.themes.it-is-taken-off-this-computer")}</p>`, foot: `<button class="btn ghost" type="button" data-act="skins">${t("window.core.keep-it")}</button><button class="btn dz" type="button" data-act="my-del-yes" data-v="${esc(x.id)}">${t("window.shell.themes.delete")}</button>` });
}
/* Deleting the theme being worn puts Branch Slate on, as the dialog says, through the engine. */
async function deleteMine(id) {
  const worn = L.mine === id;
  L.my = L.my.filter((y) => y.id !== id);
  if (worn) L.mine = null;
  saveLocal();
  if (worn) await wear(BASE);
  applyLook();
  renderNow();
  skinGallery("Yours");
  toast(t("window.shell.themes.deleted"));
}

function setAccent(v) {
  L.accent = v === "theme" || !isHex(v) ? null : v.toUpperCase();
  saveLocal();
  applyLook();
  renderNow();
}
const startFromWorn = () => startCed(wornId().startsWith("my-") ? BASE : wornId());

export function initThemes() {
  markLive(["sw:skin-q", "sw:ce-name", "sw:ce-base", "sw:paste6", "sw:acc-pick", ...EF.flatMap(([k]) => ["sw:ce-" + k, "sw:ceh-" + k]), "skins", "skin", "skinf", "skinprev", "ce-new", "ce-mode", "ce-acc", "ce-fill", "ce-cancel", "ce-save", "my-edit", "my-dup", "my-code",
    "my-del", "my-del-yes", "my-paste", "my-paste-go", "acc-set", "acc-save", "sw:g-contrast", "sw:a-contrast"]);
  on("skins", () => skinGallery());
  on("skin", async (el) => { await wear(el.dataset.v); renderNow(); skinGallery(); });
  on("skinf", (el) => skinGallery(el.dataset.v));
  on("skinprev", (el) => { G.prev = el.dataset.v; skinGallery(); });
  on("ce-new", () => startFromWorn());
  on("acc-save", () => startFromWorn());
  on("ce-mode", (el) => { G.ced.name = $("#ce-name")?.value || G.ced.name; G.ced.edit = el.dataset.v; openCed(); });
  on("ce-acc", (el) => { cedField("accent", el.dataset.v); dialog()?.querySelectorAll('[data-act="ce-acc"]').forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === el.dataset.v)); });
  on("ce-fill", () => { const d = G.ced; d.name = $("#ce-name")?.value || d.name; d[d.edit] = deriveEF(d[d.edit], d.edit); openCed(); });
  on("ce-cancel", () => cedEnd(false));
  on("ce-save", () => cedEnd(true));
  on("my-edit", (el) => startCed(null, el.dataset.v));
  on("my-dup", (el) => duplicate(el.dataset.v));
  on("my-code", (el) => showCode(el.dataset.v));
  on("my-del", (el) => askDelete(el.dataset.v));
  on("my-del-yes", (el) => deleteMine(el.dataset.v));
  on("my-paste", () => openDlg({ title: t("window.shell.themes.paste-a-theme-code"), body: `<textarea class="inp code6" id="paste6" rows="6" placeholder=\'{"branchTheme":1,"name":…}\' aria-label="${t("window.shell.themes.theme-code")}"></textarea><p class="hint" id="paste6-why" data-css="margin:6px 0 0"></p>`, foot: `<button class="btn ghost" type="button" data-act="skins">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="my-paste-go">${t("window.shell.themes.add-theme")}</button>` }));
  on("my-paste-go", () => pasteGo());
  on("acc-set", (el) => setAccent(el.dataset.v));
  listen();
}

/* The editor's fields, the gallery's search and contrast, and the any-colour accent. Closing the editor any way other
   than Save counts as Cancel: the X, Escape or a click outside. */
function listen() {
  document.addEventListener("input", (e) => {
    const t = e.target, id = t.id || "";
    if (id === "skin-q") { G.q = t.value; skinGallery(); }
    else if (id.startsWith("ce-") && t.type === "color") cedField(id.slice(3), t.value);
    else if (id.startsWith("ceh-")) t.toggleAttribute("aria-invalid", !cedField(id.slice(4), t.value.startsWith("#") ? t.value : "#" + t.value));
    else if (id === "ce-name" && G.ced) G.ced.name = t.value;
    else if (id === "acc-pick" && isHex(t.value)) { L.accent = t.value.toUpperCase(); applyLook(); }
  });
  document.addEventListener("change", (e) => {
    const t = e.target, id = t.id || "";
    if (id === "ce-base" && G.ced) { const d = G.ced; d.name = $("#ce-name")?.value || d.name; d.base = t.value; d.light = lookEF(t.value, "light"); d.dark = lookEF(t.value, "dark"); openCed(); }
    else if (id === "g-contrast" || id === "a-contrast") setContrast(t.checked).then(() => { renderNow(); if (id === "g-contrast") skinGallery(); else paintContrast(); });
    else if (id === "acc-pick") { saveLocal(); renderNow(); }
  });
  const inCed = () => !!(G.ced && dialog()?.querySelector(".ced"));
  document.addEventListener("click", (e) => {
    if (!inCed()) return;
    const x = e.target.closest('[data-act="dlg-close"]');
    if ((x && dialog().contains(x)) || e.target === dialog()) { e.preventDefault(); e.stopPropagation(); cedEnd(false); }
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && inCed()) { e.preventDefault(); e.stopPropagation(); cedEnd(false); } }, true);
}


