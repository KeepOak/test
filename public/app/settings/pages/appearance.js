/* Settings › Appearance, 1:1 with the prototype's page, from the engine: light or dark and the reading choices from the
   preferences (POST /api/preferences replaces the whole record, so shell/look.js lays each change over it), the theme
   from GET /api/look (the gallery and the colour editor are shell/themes.js), the background and the pet from the
   engine's delight switches (shell/scene.js). The painted scene, its season and where the pet walks are this window's.
   Your own background's file stays in this window's storage (shell/ownbg.js); the engine keeps how it fits. */

import { E, S, refresh, ownName as chatName } from "../../core/state.js";
import { esc, renderNow } from "../../core/dom.js";
import { on } from "../../core/actions.js";
import { ic, toast, openDlg, closeDlg } from "../../core/ui.js";
import { L, lookOf, lookEF, wornId, effMode, more, swatch, looks, savePrefs } from "../../shell/look.js";
import { ACCENTS } from "../../shell/themes.js";
import { D, W, loadDelight, saveDelight, saveWindow, showsBackground, bgChoice, drawBackground, pickScene, sceneCards, PIXEL_PETS, petCard, petChoices, petNow, pickPet } from "../../shell/scene.js";
import { OWN, LIMITS, kindOf, keep, forget } from "../../shell/ownbg.js";
import { appearance17 } from "../p17-more.js";
import { level as level17 } from "../../core/state.js";
import { ART17, PETS17, art17Slot } from "../../core/art17.js";
import { sec17 } from "../rows17.js";
import { AG, saveUi } from "../../chat/agent17.js";
import { LANGUAGES, language, t } from "../../../i18n.js";
import { say } from "../../core/words.js";
import { canSpeak, chooseLanguage } from "../../shell/language.js";

const pressed = (on) => `aria-pressed="${!!on}"`;
const segAct = (title, sub, opts, cur, act) => `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(([v, l, a]) => `<button type="button" ${pressed(v === cur)} data-act="${a ?? act}" data-v="${v}">${esc(l)}</button>`).join("")}</span></span><small>${esc(sub)}</small></div>`;
const prefs = () => E.state?.preferences ?? {};

/* The light and dark previews mirror the conversation that is open (its title and last line). */
const current = () => E.sessions.find((s) => (s.sessionId ?? s.id) === S.chat) ?? E.sessions[0];
function mirror(mode) {
  const c = mode === "light"
    ? { bg: "#F8FAFB", side: "#EFF3F5", u: "#7A8791", bub: "#E6ECEF", ink: "#16212A", edge: "#C9D3D9" }
    : { bg: "#11161A", side: "#0C1013", u: "#7D8A93", bub: "#1A2228", ink: "#E8EEF2", edge: "#2D3840" };
  const rows = ["#2F8C86", "#D8612A", "#8A5AA8", "#5E8C4A"].map((d) => `<span class="mm-r"><i data-css="background:${d}"></i><u data-css="background:${c.u};opacity:.5"></u></span>`).join("");
  const s = current(), name = (s && chatName(s.sessionId ?? s.id)) || s?.opening || E.state?.identity?.name || "";
  return `<button class="mirror" type="button" data-act="themeset" data-v="${mode}" ${pressed(document.documentElement.dataset.theme === mode)}><span class="mm" data-css="background:${c.bg}"><span class="mm-s" data-css="background:${c.side}">${rows}</span><span class="mm-m"><span><span class="mm-b" data-css="background:${c.bub};color:${c.ink};display:block">${esc(s?.opening ?? "")}</span><span class="mm-t" data-css="color:${c.ink};display:block">${esc((s?.lastMessage ?? "").slice(0, 90))}</span></span><span class="mm-c" data-css="border:1px solid ${c.edge}"><i data-css="background:#E07033"></i></span></span></span><b>${t("window.settings.appearance.mode-live-mirror-of-name", { mode: mode === "light" ? t("look.mode.light") : t("look.mode.dark"), name: esc(name) })}</b></button>`;
}

function themeSection() {
  const id = wornId(), mode = effMode(), x = lookOf(id), eff = lookEF(id, mode);
  const accs = ACCENTS.map((a) => `<button type="button" class="acc" data-css="--c:${a}" data-act="acc-set" data-v="${a}" ${pressed(L.accent === a)} aria-label="${t("window.settings.appearance.accent-value", { value: a })}"></button>`).join("");
  const mine = L.my.length ? `<div class="ctl"><b>${t("window.settings.appearance.your-themes")}</b><span class="right acts" data-css="gap:6px;flex-wrap:wrap">${L.my.map((t) => `<button class="chip6" type="button" data-act="skin" data-v="my-${esc(t.id)}" ${pressed(id === "my-" + t.id)}>${esc(t.name)}</button>`).join("")}</span><small>${t("window.settings.appearance.saved-on-this-computer-edit-copy")}</small></div>` : "";
  return `<div class="sec"><h2>${t("look.theme")}</h2><div class="theme-now">${swatch(eff)}<span class="grow"><b>${esc(x[1])}</b><small>${esc(x[3] ? t("people.home.own") : x[2])} · ${mode === "dark" ? t("look.moonlight") : t("appearance.daylight")}${more() ? ` · ${t("window.settings.appearance.more-contrast-lower")}` : ""}</small><span class="acts"><button class="btn pri sm" type="button" data-act="skins">${t("window.settings.appearance.browse-all-count-themes", { count: looks().length })}</button><button class="btn sm" type="button" data-act="ce-new">${ic("palette", "s")}${t("window.settings.appearance.make-your-own")}</button></span></span></div>
    <div class="ctl"><b>${t("settingsIndex.look-accent")}</b><span class="right accs"><button type="button" class="acc theme-acc" data-act="acc-set" data-v="theme" ${pressed(!L.accent)} aria-label="${t("window.settings.appearance.the-themes-own-accent")}">A</button>${accs}<label class="acc acc-pick" aria-label="${t("studio.colour.custom")}"><input type="color" id="acc-pick" value="${L.accent || eff.accent}"></label></span><small>${t("window.settings.appearance.only-for-what-wants-you-the")} <button class="link" type="button" data-act="acc-save">${t("window.settings.appearance.save-as-a-theme")}</button></small></div>
    <div class="ctl"><b>${t("window.settings.appearance.more-contrast")}</b><input class="sw" type="checkbox" id="a-contrast" data-sw="contrast" aria-label="${t("window.settings.appearance.more-contrast")}" ${more() ? "checked" : ""}><small>${t("window.settings.appearance.stronger-lines-and-text-from-each")}</small></div>${mine}</div>`;
}

/* The agent beside the conversation (chat/agent17.js): whether it shows and its size are this window's. */
function agentsSection() {
  return `<div class="sec"><h2>${t("window.settings.appearance.agents")}</h2><div class="ctl"><b>${t("window.settings.appearance.show-the-agent-beside-the-conversation")}</b><input class="sw" type="checkbox" id="ag-show" aria-label="${t("window.settings.appearance.show-the-agent-beside-the-conversation")}" data-sw="set" ${AG.show ? "checked" : ""}><small>${t("window.settings.appearance.it-acts-out-what-the-trunk")}</small></div>${segAct(t("window.settings.appearance.size"), t("window.settings.appearance.small-keeps-it-out-of-the"), [["s", t("appearance.textSize.small")], ["m", t("appearance.textSize.medium")], ["l", t("appearance.textSize.large")]], AG.size, "ag-size")}</div>`;
}

/* Pass 17 (Advanced): the pictures Branch uses where a feature starts or has nothing to show yet (core/art17.js). */
const picturesSection = (lv) => (lv < 1 ? "" : sec17(t("window.settings.appearance.pictures-around-branch"), `<div class="arts17e">${Object.entries(ART17).map(([id, [label]]) => `<figure class="art-c17e">${art17Slot(id)}<figcaption>${esc(say(label))}</figcaption></figure>`).join("")}</div>`,
  t("window.settings.appearance.shown-where-a-feature-starts-or")));

/* Your own file: choosing one, or the one kept with its fit, Remove and a file to replace it (prototype pass 6). */
const KINDS = { picture: "Picture", animation: "Animation", video: "Video", "3d": "3D model" };
function ownRows() {
  const s = OWN.saved, file = (id, label) => `<input type="file" id="${id}" data-sw="bgfile" accept="image/*,video/*" aria-label="${label}">`;
  if (!s) return `<div class="ctl"><b>${t("delight.bg.choose")}</b><span class="right">${file("bg-file6", t("window.settings.appearance.choose-a-background-file"))}</span><small>${t("window.settings.appearance.a-picture-or-animation-up-to", { picture: LIMITS.picture, video: LIMITS.video })}</small></div>`;
  const fits = [["fill", t("window.settings.appearance.fill")], ["fit", t("window.settings.appearance.fit")], ...(s.kind === "video" ? [] : [["tile", t("window.settings.appearance.tile")]])];
  return `<div class="ctl"><b>${esc(s.name)}</b><span class="right"><button class="btn sm" type="button" data-act="bg-remove">${t("accounts.action.remove")}</button></span><small>${t("window.settings.appearance.value-value2-mb", { value: say(KINDS[s.kind] ?? ""), value2: (s.size / 1048576).toFixed(1) })}</small></div>
    ${s.kind !== "3d" ? segAct(t("window.settings.appearance.fit"), t("window.settings.appearance.tile-is-for-pictures-and-animations"), fits, D.settings?.background?.fit ?? "fill", "bgfit") : ""}<div class="ctl"><b>${t("window.settings.appearance.another-file")}</b><span class="right">${file("bg-file6", t("window.settings.appearance.choose-another-background-file"))}</span><small>${t("window.settings.appearance.replaces-this-one")}</small></div>`;
}

/* Pass 17's six scenes carry a small "New" mark, as the prototype's do. */
const NEW_SCENES17 = new Set(["night17-lake", "night17-highland", "day17-sea", "day17-meadow", "glow17-amber", "season17-snow"]);
function backgroundSection() {
  const on = showsBackground(), choice = bgChoice(), scrim = D.settings?.background?.scrim ?? 60;
  const kinds = [["none", t("comfort.placeholder.none")], ["painted", t("window.settings.appearance.painted-grove")], ["grove", t("window.settings.appearance.the-grove"), "bgset-grove"], ["oak3d", t("window.settings.appearance.the-oak-in-3d"), "bgset-oak3d"], ["rings", t("window.settings.appearance.growth-rings"), "bgset-rings"], ["own", t("window.settings.appearance.your-own")]];
  const scenes = sceneCards("scene-set", (v) => choice === "painted" && W.scene === v, (v) => (NEW_SCENES17.has(v) ? " new17e" : ""));
  const season = choice === "painted" ? segAct(t("look.seasonRow"), t("window.settings.appearance.spring-greens-autumn-copper-winter-snow"), [["auto", t("window.settings.appearance.by-the-date")], ["spring", t("look.season.spring")], ["autumn", t("look.season.autumn")], ["winter", t("look.season.winter")]], W.season, "season") : "";
  return `<div class="sec"><h2>${t("window.settings.appearance.background")}</h2>${segAct(t("window.settings.appearance.behind-the-glass"), t("window.settings.appearance.the-grove-and-the-oak-wear"), kinds, choice, "bgset")}${season}${choice === "own" ? ownRows() : ""}<div class="fld"><span>${t("window.settings.appearance.painted-scenes")}</span><div class="scenes12">${scenes}</div></div>
    <div class="ctl"><b>${t("window.settings.appearance.how-much-the-theme-covers-it")}</b><span class="right"><input class="range" type="range" id="scrim6" min="20" max="90" step="5" value="${scrim}" aria-label="${t("window.settings.appearance.how-much-the-theme-covers-the")}" disabled><span data-css="font:12px var(--mono);color:var(--ink-3);width:34px">${scrim}%</span></span><small>${t("window.settings.appearance.more-keeps-text-calmer-less-shows")}</small></div>
    <div class="ctl"><b>${t("window.settings.appearance.see-through-panels")}</b><span class="right"><input class="range" type="range" id="see" min="0" max="60" step="5" value="${prefs().seeThrough ?? 30}" aria-label="${t("window.settings.appearance.see-through-panels")}" disabled><span data-css="font:12px var(--mono);color:var(--ink-3);width:34px">${prefs().seeThrough ?? 30}%</span></span><small>${t("window.settings.appearance.panels-blur-whats-behind-them")}</small></div>
    <div class="ctl"><b>${t("agent-files.preview")}</b><span class="right"><button class="btn sm" type="button" data-act="bg-peek" ${on ? "" : "disabled"}>${ic("eye", "s")}${t("window.settings.appearance.see-it-clearly")}</button></span><small>${t("settingsGrown.look.clear")}</small></div></div>`;
}

function readingSection() {
  const p = prefs();
  return `<div class="sec"><h2>${t("window.settings.appearance.reading")}</h2>${segAct(t("look.widthRow"), t("window.settings.appearance.wide-uses-more-of-a-big"), [["comfortable", t("appearance.density.comfortable")], ["wide", t("onscreen.width.wide")], ["full", t("window.settings.appearance.full")]], p.conversationWidth, "widthset")}${segAct(t("appearance.textSize"), t("window.settings.appearance.changes-every-screen"), [["small", t("appearance.textSize.small")], ["medium", t("settingsGrown.level.regular")], ["large", t("appearance.textSize.large")]], p.textSize, "size")}</div>`;
}

/* The pets the engine keeps (petKinds) that this window can draw, drawn as the gallery's cards (shell/scene.js). The
   prototype's older picture pets and Little Branch are not in the engine's list. The row of buttons stays hidden, as
   there (after the gallery, so the first control for each pet is the one you can see). */
function petSection() {
  const pets = D.settings?.pets, kind = petNow(), all = petChoices();
  const row = segAct(t("window.settings.appearance.pet"), t("window.settings.appearance.it-walks-along-the-foot-of"), [["none", t("comfort.placeholder.none")], ...PETS17.map((p) => [p.id, say(p.name)]), ...PIXEL_PETS.map(([v, l]) => [v, say(l)])], kind, "petset").replace('<div class="ctl">', '<div class="ctl" data-css="display:none">');
  const cards = all.map(([v, l]) => petCard(v, l, kind)).join("");
  const where = pets?.on ? segAct(t("window.settings.appearance.where-it-walks"), t("window.settings.appearance.it-keeps-out-of-the-way"), [["side", t("window.settings.appearance.the-list")], ["status", t("window.settings.appearance.status-bar")], ["dock", t("window.settings.appearance.by-the-message-box"), "petwhere15-dock"]], W.petWhere, "petwhere15") : "";
  const name = pets ? `<div class="ctl"><b>${t("accounts.field.name")}</b><span class="right"><input class="inp" id="pet-name" value="${esc(pets.name ?? "")}" aria-label="${t("window.settings.appearance.pet-name")}" maxlength="20" data-sw="set" data-css="width:140px"></span><small>${t("window.settings.appearance.pat-it-for-a-tip")}</small></div>` : "";
  return `<div class="sec"><h2>${t("window.settings.appearance.the-pet")}</h2><div class="pets12">${cards}</div>${row}${where}${name}</div>`;
}

/* Each switch names a part of the window the engine keeps in preferences.hidden. */
const HIDES = [["h-usage", "usage", "The usage ring"], ["h-gateway", "gateway", "The gateway in the status bar"], ["h-pet", "pet", "The pet"], ["h-projects", "projects", "Projects in the list"], ["h-notes", "notes", "The Guide button"], ["h-statusbar", "statusbar", "The whole status bar"]];
function shownSection() {
  const hidden = prefs().hidden ?? [];
  const rows = HIDES.map(([id, k, l]) => `<div class="ctl"><b>${say(l)}</b><input class="sw" type="checkbox" id="${id}" ${hidden.includes(k) ? "" : "checked"} aria-label="${say(l)}" data-sw="hide" data-k="${k}"><small>${k === "statusbar" ? t("window.settings.appearance.lockdowns-banner-and-stop-while-a") : t("window.settings.appearance.right-click-it-anywhere-to-hide")}</small></div>`).join("");
  return `<div class="sec"><h2>${t("window.settings.appearance.whats-shown")}</h2>${rows}
    <div class="ctl"><b>${t("window.settings.appearance.keep-things-still")}</b><input class="sw" type="checkbox" id="a-still" aria-label="${t("window.settings.appearance.keep-things-still")}" data-sw="still"><small>${t("window.settings.appearance.stops-the-pet-walking-the-working")}</small></div>
    <div class="ctl"><b>${t("window.settings.appearance.scenery-behind-the-list")}</b><input class="sw" type="checkbox" id="a-scenery" aria-label="${t("window.settings.appearance.scenery-behind-the-list")}" data-sw="scenery"><small>${t("window.settings.appearance.a-small-pixel-oak-at-the")}</small></div></div>
  ${languageSection()}`;
}

/* Only the languages that have words on file (public/locales, i18n.js LANGUAGES) are listed, the same list setup's
   Language picker shows, each named in its own language by the browser (Intl.DisplayNames). The one in force is the one
   shown; picking one saves it (shell/language.js). */
const ownName = (code) => {
  const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
};
function languageSection() {
  const now = language();
  const opts = LANGUAGES.map(({ id }) => `<option value="${esc(id)}"${id === now ? " selected" : ""}>${esc(ownName(id))}</option>`).join("");
  return `<div class="sec"><h2>${t("appearance.language")}</h2><div class="ctl"><b>${t("appearance.language")}</b><span class="right"><select class="inp" id="lang" data-sw="lang" aria-label="${t("appearance.language")}">${opts}</select></span><small>${t("window.settings.appearance.dates-and-numbers-follow-it-too")}</small></div></div>`;
}
/* The window is drawn again in the new words; English says so as the prototype does. */
async function pickLanguage(code) {
  if (!canSpeak(code)) { renderNow(); return; }
  try { L.look = await chooseLanguage(code); } catch (error) { toast(error.message); renderNow(); return; }
  renderNow();
  if (code === "en") toast(t("window.settings.appearance.english"));
}

export function draw() {
  return `<h1>${t("appearance.theme")}</h1><p class="lede">${t("window.settings.appearance.how-branch-looks-on-this-computer")}</p>
  <div class="sec"><h2>${t("window.settings.appearance.light-or-dark")}</h2><div class="mirrors">${mirror("light")}${mirror("dark")}<button class="mirror" type="button" data-act="themeset" data-v="system" ${pressed(!document.documentElement.dataset.theme)}><span class="mm" data-css="grid-template-columns:1fr 1fr"><span data-css="background:#F8FAFB"></span><span data-css="background:#11161A"></span></span><b>${t("window.settings.appearance.match-this-computer")}</b></button></div></div>
  ${themeSection()}${agentsSection()}${backgroundSection()}${readingSection()}${petSection()}${shownSection()}${appearance17(level17())}${picturesSection(level17())}`;
}

async function savePrefsAndDraw(change) {
  await savePrefs(change);
  await refresh().catch((error) => toast(error.message));
  renderNow();
}
async function setBackground(on) { await saveDelight({ background: { on } }); drawBackground(); renderNow(); }

/* A chosen file is checked against the prototype's kinds and limits, kept, and shown behind the glass. */
async function pickOwn(file) {
  const kind = await kindOf(file);
  if (!kind) { toast(t("window.settings.appearance.that-kind-of-file-cant-go")); return; }
  if (file.size > LIMITS[kind] * 1048576) { toast(t("delight.bg.tooBig", { size: (file.size / 1048576).toFixed(1), limit: LIMITS[kind], kind })); return; }
  try { await keep(file, kind); } catch (error) { toast(error.message); return; }
  W.bg = "own";
  saveWindow();
  if (!D.settings?.background?.on) await saveDelight({ background: { on: true } });
  drawBackground();
  renderNow();
  toast(t("window.settings.appearance.kept-on-this-computer-it-is"));
}
function removeDlg() {
  if (!OWN.saved) return;
  openDlg({ title: t("window.settings.appearance.remove-your-background"), body: `<p data-css="margin:0">${t("window.settings.appearance.name-is-thrown-away-from-this", { name: esc(OWN.saved.name) })}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("window.core.keep-it")}</button><button class="btn bad" type="button" data-act="bg-remove-yes">${t("accounts.action.remove")}</button>` });
}
async function removeOwn() {
  try { await forget(); } catch (error) { toast(error.message); return; }
  W.bg = "painted";
  saveWindow();
  await saveDelight({ background: { on: false } });
  closeDlg();
  drawBackground();
  renderNow();
  toast(t("window.settings.appearance.removed-nothing-is-kept"));
}
async function setFit(fit) { await saveDelight({ background: { fit } }); drawBackground(); renderNow(); }

export function init() {
  // "themeset" belongs to the shell, which applies the look and saves it to the engine; the theme controls are shell/themes.js.
  on("widthset", (el) => savePrefsAndDraw({ conversationWidth: el.dataset.v }));
  on("size", (el) => savePrefsAndDraw({ textSize: el.dataset.v }));
  on("bgset", (el) => { if (el.dataset.v === "painted" || el.dataset.v === "own") { W.bg = el.dataset.v; saveWindow(); } setBackground(el.dataset.v !== "none"); });
  on("bgfit", (el) => setFit(el.dataset.v));
  on("bg-remove", () => removeDlg());
  on("bg-remove-yes", () => removeOwn());
  on("scene-set", async (el) => { await pickScene(el.dataset.v); renderNow(); });
  on("season", (el) => { W.season = el.dataset.v; saveWindow(); drawBackground(); renderNow(); });
  on("bg-peek", () => document.getElementById("app").classList.add("peek"));
  on("petset", async (el) => { await pickPet(el.dataset.v); renderNow(); });
  on("petwhere15", (el) => { W.petWhere = el.dataset.v; saveWindow(); renderNow(); });
  on("ag-size", (el) => { saveUi({ size: el.dataset.v }); renderNow(); });
  document.addEventListener("change", (e) => {
    const tr = e.target;
    if (tr.id === "bg-file6") { if (tr.files?.[0]) pickOwn(tr.files[0]); return; }
    if (tr.id === "ag-show") { saveUi({ show: tr.checked }); toast(tr.checked ? t("window.settings.appearance.the-agent-is-back-beside-the") : t("window.settings.appearance.hidden")); return; }
    if (tr.id === "pet-name") { saveDelight({ pets: { name: tr.value } }).then(() => renderNow()); return; }
    if (tr.id === "lang") { pickLanguage(tr.value); return; }
    const row = HIDES.find(([id]) => id === tr.id);
    if (!row) return;
    const k = row[1], hidden = (prefs().hidden ?? []).filter((x) => x !== k);
    savePrefsAndDraw({ hidden: tr.checked ? hidden : [...hidden, k] });
  });
  /* "See it clearly" lasts until a click anywhere or Escape. */
  document.addEventListener("pointerdown", (e) => { const app = document.getElementById("app"); if (app.classList.contains("peek")) { app.classList.remove("peek"); e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener("keydown", (e) => { const app = document.getElementById("app"); if (e.key === "Escape" && app.classList.contains("peek")) { app.classList.remove("peek"); e.stopPropagation(); } }, true);
  load();
}

export async function load() {
  await loadDelight();
  renderNow();
}

export const live = {
  "widthset": true,
  "size": true,
  "bgset": true,
  "petset": true,
  "scene-set": true,
  "season": true,
  "bg-peek": true,
  "petwhere15": true,
  "ag-size": true,
  "sw:ag-show": true,
  "bgfit": true,
  "bg-remove": true,
  "bg-remove-yes": true,
  "sw:bg-file6": true,
  "sw:pet-name": true,
  "sw:lang": true,
  "sw:h-usage": true,
  "sw:h-gateway": true,
  "sw:h-pet": true,
  "sw:h-projects": true,
  "sw:h-notes": true,
  "sw:h-statusbar": true,
};
