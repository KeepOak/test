/* your-profile: Your profile, opened from your own tile in "Who is using Branch" (the person menu). Everything saves at
   once through the engine (src/person-about.ts), then GET /api/profiles is read again so every tile shows it:
     name, face (photo, initial, emoji), colour, emoji: POST /api/profiles/owner/about, or /<your id>/about for a household
       person, each only for themselves (the engine refuses anybody else, the owner included);
     photo: POST …/picture { picture } (the picture made small here, flows/photo-pick.js; the engine checks its bytes),
       Remove: POST …/picture/remove;
     the owner's own too: language (the engine's look, shell/language.js chooseLanguage, as setup's first step), the time
       zone schedules and automations are proposed in, App lock (settings/applock17.js, the row itself), the PIN for
       switching back (a link to Team › Signing in) and connected accounts (a link to Settings › Accounts).
   A household person sees only their own name and picture: the language, the time zone, App lock and accounts are the
   owner's, and there is no window route for changing their own PIN, so none of it is drawn for them.
   Setup's People step asks the owner's name once (nameField, #ob-name). */
import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { openDlg, closeDlg, closePop, toast, COLOURS, hex } from "../core/ui.js";
import { E, activeId, ownerHere } from "../core/state.js";
import { face, profilePath, knowPicture } from "../core/faces.js";
import { pickButton, picked } from "./photo-pick.js";
import { chooseLanguage, canSpeak, languageOptions } from "../shell/language.js";
import { applockRow, initApplock, load as loadLock } from "../settings/applock17.js";
import { t } from "../../i18n.js";

const EMOJI = ["🙂", "😎", "🦊", "🐻", "🐼", "🦉", "🐙", "🌻", "🌳", "🍀", "⭐", "🔥", "🎧", "🎨", "🚀", "☕"];
const P = { who: null, about: null };
const mine = () => P.who === null && ownerHere();

async function reread() {
  try { E.profiles = await api("profiles"); } catch (error) { toast(error.message); }
  renderNow();
}

/* ---------- drawing ---------- */

function pictureRows(a) {
  const kinds = [["photo", t("window.profile.photo")], ["initial", t("window.profile.initial")], ["emoji", t("window.profile.emoji")]];
  const seg = kinds.map(([v, l]) => `<button type="button" data-act="yp-face" data-v="${v}" aria-pressed="${a.face === v}">${l}</button>`).join("");
  const colour = hex(a.color);
  const swatches = a.face === "photo" ? "" : `<div class="yp-row" role="group" aria-label="${t("window.profile.colour")}">${COLOURS.map((c, i) => `<button type="button" class="yp-sw" data-act="yp-colour" data-v="${c}" aria-pressed="${colour === c.toLowerCase()}" aria-label="${t("window.profile.colour")} ${i + 1}" data-css="background:${c}"></button>`).join("")}</div>`;
  const emojis = a.face === "emoji" ? `<div class="yp-row">${EMOJI.map((e) => `<button type="button" class="yp-em" data-act="yp-emoji" data-v="${e}" aria-pressed="${a.emoji === e}">${e}</button>`).join("")}</div>` : "";
  return `<div class="fld"><span>${t("window.profile.picture")}</span><span class="seg">${seg}</span></div>${swatches}${emojis}`;
}

function zoneRow(a) {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = (Intl.supportedValuesOf?.("timeZone") ?? []).map((z) => `<option value="${esc(z)}"${a.timezone === z ? " selected" : ""}>${esc(z.replaceAll("_", " "))}</option>`).join("");
  const select = `<select class="inp" id="yp-tz" aria-label="${t("window.profile.timezone")}"><option value=""${a.timezone ? "" : " selected"}>${esc(t("window.profile.timezone-computer", { zone: here }))}</option>${zones}</select>`;
  return `<div class="ctl"><b>${t("window.profile.timezone")}</b><span class="right">${select}</span><small>${t("window.profile.timezone-hint")}</small></div>`;
}

/* The owner's own: language, time zone, App lock, the PIN for switching back, and connected accounts. */
function ownerRows(a) {
  const lang = `<div class="ctl"><b>${t("appearance.language")}</b><span class="right"><select class="inp" id="yp-lang" aria-label="${t("appearance.language")}">${languageOptions()}</select></span></div>`;
  const back = `<div class="ctl"><b>${t("window.places.team.ask-for-my-pin-when-switching")}</b><span class="right"><button class="btn sm" type="button" data-act="yp-go" data-to="p-open-team" data-v="signin">${t("ov.open")}</button></span><small>${E.profiles?.ownerPin ? t("household.pin.isSet") : t("window.places.team.off-by-default")}</small></div>`;
  const accounts = `<div class="ctl"><b>${t("window.profile.accounts")}</b><span class="right"><button class="btn sm" type="button" data-act="yp-go" data-to="setgo" data-v="accounts">${t("ov.open")}</button></span><small>${t("window.profile.accounts-hint")}</small></div>`;
  return `<div class="sec"><h2>${t("window.profile.region")}</h2>${lang}${zoneRow(a)}</div><div class="sec"><h2>${t("window.profile.security")}</h2>${applockRow()}${back}</div><div class="sec">${accounts}</div>`;
}

function body() {
  const a = P.about;
  const photo = `<div class="yp-pic">${pickButton("yp-file", a.picture ? t("window.profile.change-photo") : t("window.profile.upload"))}${a.picture ? `<button class="btn ghost sm" type="button" data-act="yp-photo-rm">${t("window.profile.remove-photo")}</button>` : ""}</div>`;
  const name = `<label class="fld"><span>${t("window.profile.name")}</span><input class="inp" id="yp-name" maxlength="40" autocomplete="off" value="${esc(a.name ?? "")}" placeholder="${t("window.profile.name-hint")}"></label>`;
  return `<div class="yp-top">${face(P.who, { css: "width:72px;height:72px;font-size:28px" })}${photo}</div>${name}${pictureRows(a)}${mine() ? ownerRows(a) : ""}`;
}

/* Drawn again in place while the dialog is open, so the keyboard stays where it was. */
function redraw() {
  const box = $("#yp");
  if (!box) return;
  box.innerHTML = body();
  applyCss(box);
  greyOut(box);
}

async function openProfile() {
  closePop();
  P.who = activeId();
  try { P.about = await api(profilePath(P.who, "about")); } catch (error) { toast(error.message); return; }
  if (mine()) { initApplock(); await loadLock(); }
  openDlg({ title: t("window.profile.title"), body: `<div class="yp" id="yp">${body()}</div>`, foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("window.profile.done")}</button>` });
}

/* ---------- saving ---------- */

async function save(change) {
  try { P.about = await api(profilePath(P.who, "about"), change); } catch (error) { toast(error.message); redraw(); return false; }
  await reread();
  redraw();
  return true;
}

async function upload(file) {
  let picture;
  try {
    picture = await picked(file);
    P.about = await api(profilePath(P.who, "picture"), { picture });
  } catch (error) { toast(error.message); return; }
  knowPicture(P.who, P.about.picture, picture);
  await reread();
  redraw();
}

async function removePhoto() {
  try { P.about = await api(profilePath(P.who, "picture/remove"), {}); } catch (error) { toast(error.message); return; }
  await reread();
  redraw();
}

function pickFace(el) {
  if (el.dataset.v === "photo" && !P.about.picture) return $("#yp-file")?.click();
  save({ face: el.dataset.v });
}

async function saveName(box) {
  const name = box.value.trim();
  if (name === (P.about.name ?? "")) return;
  if (!name && P.who !== null) { box.setAttribute("aria-invalid", "true"); box.value = P.about.name ?? ""; return; }
  box.removeAttribute("aria-invalid");
  if (await save({ name: name || null })) toast(t("window.profile.saved"));
}

async function pickLanguage(code) {
  if (!canSpeak(code)) return;
  try { await chooseLanguage(code); } catch (error) { toast(error.message); }
  renderNow();
  const box = $("#yp");
  const dlg = box?.closest(".dlg");
  if (dlg) { $(".dlg-h h2", dlg).textContent = t("window.profile.title"); $(".dlg-f .btn", dlg).textContent = t("window.profile.done"); }
  redraw();
}

function changed(e) {
  const id = e.target.id;
  if (id === "yp-file" && e.target.files?.[0]) upload(e.target.files[0]);
  else if (id === "yp-name") saveName(e.target);
  else if (id === "yp-lang") pickLanguage(e.target.value);
  else if (id === "yp-tz") save({ timezone: e.target.value || null });
  else if (id === "ob-name") saveSetupName(e.target);
}

/* ---------- setup asks the owner's name once ---------- */

export const nameField = () => (ownerHere() ? `<label class="fld ob-name-yp"><span>${t("window.profile.name-hint")}</span><input class="inp" id="ob-name" maxlength="40" autocomplete="off" value="${esc(E.profiles?.owner?.name ?? "")}"></label>` : "");

async function saveSetupName(box) {
  const name = box.value.trim();
  if (name === (E.profiles?.owner?.name ?? "")) return;
  try { await api("profiles/owner/about", { name: name || null }); } catch (error) { toast(error.message); return; }
  await reread();
  toast(t("window.profile.saved"));
}

export function init() {
  markLive(["yp-open", "yp-face", "yp-colour", "yp-emoji", "yp-photo-rm", "yp-go", "sw:yp-file", "sw:yp-name", "sw:yp-lang", "sw:yp-tz", "sw:ob-name"]);
  on("yp-open", () => openProfile());
  on("yp-face", (el) => pickFace(el));
  on("yp-colour", (el) => save({ color: el.dataset.v }));
  on("yp-emoji", (el) => save({ face: "emoji", emoji: el.dataset.v }));
  on("yp-photo-rm", () => removePhoto());
  on("yp-go", (el) => { closeDlg(); run(el.dataset.to, el); });
  document.addEventListener("change", changed);
  document.addEventListener("keydown", (e) => { if ((e.target.id === "yp-name" || e.target.id === "ob-name") && e.key === "Enter") e.target.blur(); });
}
