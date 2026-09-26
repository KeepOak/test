/* Set up Branch (design doc 6.1): the eleven steps drawn 1:1 from design/redesign/dom/setup-0..10.html, against
   the engine: models from GET /api/accounts and the shared local-model picker (flows/localpick.js), a hello through POST /api/models/test, the look,
   how much it asks (POST /api/conversation-mode/settings), Trunks made with POST /api/trunks, chat apps from
   GET /api/channel-setup, the gateway (POST /api/never-break), and the engine's own checks (GET /api/health).
   "Another computer" opens the same "Pair another computer" dialog as Settings (flows/pair.js: the invitation, the
   owner's yes with the check code, Tailscale when the link only answers here); once the owner lets one in, it is the
   one picked here, and GET /api/devices says when it has connected. "This computer" stays the default.
   Choices the engine cannot act on yet keep their place and are greyed out. */

import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { ic, av, app, toast, hex, SHAPE_NAMES } from "../core/ui.js";
import { lookOf } from "./trunk.js";
import { S, E, refresh } from "../core/state.js";
import { api, origin } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { logo } from "../core/logos.js";
import { t, language, LANGUAGES } from "../../i18n.js";
import { say } from "../core/words.js";
import { canSpeak, chooseLanguage } from "../shell/language.js";
import { localPicker, freshPick, initLocalPick } from "./localpick.js";
import { openDlg, closeDlg } from "../core/ui.js";
import { L, looks, lookEF, wornId, effMode, swatch, wear } from "../shell/look.js";
import { W, D, bgChoice, sceneCards, pickScene, petCard, petChoices, petNow, pickPet } from "../shell/scene.js";
import { startPairing, onPaired } from "./pair.js";
import { toolsStep, initToolsStep } from "./setup-tools.js";

const STEPS = ["window.flows.setup.step-welcome", "window.flows.setup.step-where", "layout.modelTabs", "window.flows.setup.step-yours", "window.flows.setup.step-trunks", "window.flows.setup.step-reach", "dashboard.filter.tools",
  "window.flows.setup.step-keep", "people.admin.people", "window.flows.setup.step-more", "settings.card.health-check"];
const POSES = [null, "point", "think", null, "work", "mail", "work", "sleep", "wave", null, "yay"];
/* A template's name and job are keys: shown in the chosen language, and the Trunk it makes is named in those words. Its
   colour and shape are the prototype's jobs' (flows/trunk.js TEMPLATES): the card draws that face, and the Trunk made
   from it is given the same face. */
const TEMPLATES = [
  ["window.flows.tmpl.inbox", "window.flows.tmpl.inbox-job", "#4F6FA8", 0],
  ["window.flows.tmpl.expense", "window.flows.tmpl.expense-job", "#D8612A", 2],
  ["window.flows.tmpl.researcher", "window.flows.tmpl.researcher-job", "#2F8C86", 1],
  ["window.flows.tmpl.chief", "window.flows.tmpl.chief-job", "#56616B", 3],
  ["window.flows.tmpl.bug", "window.flows.tmpl.bug-job", "#B84A6B", 4],
  ["window.flows.tmpl.trip", "window.flows.tmpl.trip-job", "#8A5AA8", 3],
];
/* The language comes first (the owner's call). Only languages with words on file are listed (i18n.js LANGUAGES, the
   locale files), so one appears as soon as its file does; each is named in its own language by the browser
   (Intl.DisplayNames), never written here. The one shown is the one in force. */
const ownName = (code) => {
  const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
};
const POPULAR = 9;

const mac = () => app()?.dataset.surface === "mac";
const pressed = (on) => `aria-pressed="${on}"`;
const pose = (i) => POSES[i] ? `<img class="pose11 ob-pose11" src="/art/branch-${POSES[i]}.webp" alt="" loading="lazy" decoding="async" draggable="false">` : "";
const prov = (act, k, v, icon, name, sub, on) =>
  `<button class="prov" type="button" data-act="${act}" data-k="${k}" data-v="${v}" ${pressed(on)}><span class="ico-tile">${ic(icon, "s")}</span><b>${name}</b><small>${sub}</small></button>`;
/* A switch row: drawn from the engine's value; `off` disables only this switch (not read yet, or not possible here). */
const ctl = (id, name, sub, on, off) => `<div class="ctl"><b>${name}</b><input class="sw" type="checkbox" id="${id}" aria-label="${name}" data-sw="${id}" ${on ? "checked" : ""} ${off ? "disabled" : ""}><small>${sub}</small></div>`;

function languageControl() {
  const now = language();
  const opts = LANGUAGES.map(({ id }) => `<option value="${esc(id)}"${id === now ? " selected" : ""}>${esc(ownName(id))}</option>`).join("");
  return `<div class="ctl ob-lang"><b>${t("appearance.language")}</b><span class="right"><select class="inp" id="ob-lang" data-sw="ob-lang" aria-label="${t("appearance.language")}">${opts}</select></span></div>`;
}

function welcome(o) {
  return `${languageControl()}<div class="ob-stage11"><video class="pose11 vid11 ob-art11" src="/art/anim-idle.webm" poster="/art/branch-wave.webp" muted loop autoplay playsinline aria-hidden="true"></video></div><h2>${t("window.flows.first.hi")}</h2><p>${t("window.flows.setup.hi-lede")}</p><div class="ob-trust"><b>${t("window.flows.setup.safe")}</b><ul class="may6"><li>${ic("check", "s")}${t("window.flows.setup.safe-asks")}</li><li>${ic("check", "s")}${t("window.flows.setup.safe-stay")}</li><li>${ic("check", "s")}${t("window.flows.setup.safe-stop")}</li></ul><label class="chk ob-agree"><input type="checkbox" id="ob-trust" ${o.trust ? "checked" : ""}><span class="ob-box" aria-hidden="true">${ic("check", "s")}</span><span>${t("window.flows.setup.understand")}</span></label></div>`;
}

/* The computer let in from here: its name (the engine's), and whether GET /api/devices says it is connected. Until it
   is, the step it still needs is the one `branch node pair` prints on it when the yes arrives. */
function remoteStatus(o) {
  const r = o.remote;
  if (!r || o.where !== "remote") return "";
  const said = r.connected ? t("devices.device.connected") : `${ic("spin", "s spin")} ${t("pair.waiting.computer")} <code>branch node run</code>`;
  return `<div class="status ob-remote" role="status" data-css="margin-top:12px"><span class="sdot"></span><div><b>${esc(r.name)}</b><p>${said}</p></div></div>`;
}

function where(o) {
  return `<h2 tabindex="-1">${t("window.flows.setup.where")}</h2><p>${t("window.flows.setup.where-lede")}</p><div class="provs">
    ${prov("ob-set", "where", "this", "monitor", t("dashboard.computer.title"), t("window.flows.setup.this-computer-hint"), o.where === "this")}
    ${prov("ob-where-remote", "where", "remote", "key", t("studio.tab.computer"), o.remote ? esc(o.remote.name) : t("window.flows.setup.another-hint"), o.where === "remote")}
    ${prov("ob-where-keepoak", "where", "keepoak", "globe", t("window.flows.setup.keepoak"), t("window.flows.setup.keepoak-hint"), false)}
    ${prov("ob-set", "where", "later", "clock", t("window.flows.setup.later"), t("window.flows.setup.later-hint"), o.where === "later")}</div>${remoteStatus(o)}`;
}

function modelRows(o) {
  const rows = [];
  for (const p of o.pools) for (const a of p.accounts ?? []) rows.push([p.pool, a.label || p.pool, p.pool + (p.defaultAccount === a.id ? ` · ${t("glance.usedNext")}` : "")]);
  if (!rows.length && E.state?.activeModel) rows.push([E.state.activeModel.presetName, E.state.activeModel.presetName, E.state.activeModel.model ?? ""]);
  return rows.map(([id, name, sub], i) => `<div class="prow">${logo(id, name, 30)}<span class="grow"><b>${esc(name)}</b><small>${esc(sub)}</small></span><input class="sw" type="checkbox" data-sw="ob-brain" data-i="${i}" aria-label="${esc(name)}"></div>`).join("");
}

function testOut(o) {
  const res = o.test;
  if (!res) return "";
  if (res === "wait") return `<div class="status"><span class="sdot"></span><div><b>${t("window.flows.setup.saying-hello")}</b></div></div>`;
  if (!res.ok) return `<div class="status"><span class="sdot bad"></span><div><b>${t("window.flows.setup.no-answer")}</b><p>${esc(res.error ?? res.reply ?? "")}</p></div></div>`;
  return `<div class="status"><span class="sdot"></span><div><b>${t("window.flows.setup.answered-in", { s: (res.ms / 1000).toFixed(1) })}</b><p>“${esc(res.reply)}” · ${esc(res.presetName)}</p></div></div>`;
}

function models(o) {
  /* Accounts found are listed under the prototype's line; what runs on this computer is the picker's (it says plainly
     when nothing was found), so the line never stands over an empty list. */
  const rows = modelRows(o);
  return `<h2 tabindex="-1">${t("window.flows.setup.models")}</h2>${rows ? `<p>${t("window.flows.setup.found")}</p><div class="rows">${rows}</div>` : ""}${localPicker()}<div class="acts" data-css="margin-top:10px"><button class="btn sm" type="button" data-act="addacct">${ic("plus", "s")}${t("window.flows.setup.add-account")}</button><button class="btn sm" type="button" data-act="ob-test">${t("window.flows.setup.say-hello")}</button></div><div id="ob-test-out">${testOut(o)}</div>`;
}

/* Make it yours. Light or dark, then a small gallery drawn with Settings › Appearance's own pieces: every theme as its
   swatch (worn through POST /api/look, shell/look.js), the painted scenes as stills (which one is this window's, with
   the engine's background switch, shell/scene.js) and the pet (POST /api/delight/settings). Each applies at once, behind
   setup, and is drawn from what was saved. Until the engine's themes have been read, the gallery is left out.
   How much it asks saves what new conversations start on. Auto lets workspace changes go ahead and keeps a standing
   yes per website (src/conversation-mode.ts), so it is weighed by the engine: anything looser than what is saved is
   refused until the owner says yes in a confirm that shows the engine's words, and Lockdown refuses it outright. */
function lookGallery() {
  if (!L.cat) return "";
  const mode = effMode(), worn = wornId(), scene = bgChoice() === "painted" ? W.scene : null, kind = petNow();
  const themes = looks().map(([id, name]) => `<button type="button" class="ob-th15" data-act="ob15-skin" data-v="${esc(id)}" ${pressed(worn === id)} aria-label="${esc(name)}">${swatch(lookEF(id, mode))}<b>${esc(name)}</b></button>`).join("");
  const strip = (title, cls, cards) => `<div class="ob-q15"><b>${title}</b><div class="ob-strip15 ${cls}" data-scroll>${cards}</div></div>`;
  return strip(t("look.theme"), "ob-themes15", themes) + strip(t("window.settings.appearance.painted-scenes"), "ob-scenes15", sceneCards("ob15-scene", (v) => v === scene))
    + (D.settings ? strip(t("window.settings.appearance.the-pet"), "ob-pets15", petChoices().map(([v, l]) => petCard(v, l, kind, "ob15-pet")).join("")) : "");
}

function yours(o) {
  const look = document.documentElement.dataset.theme || "system";
  const looks = [["system", mac() ? t("window.flows.setup.match-mac") : t("window.flows.setup.match-windows")], ["light", t("look.mode.light")], ["dark", t("look.mode.dark")]];
  const asks = [["auto", "spark", t("look.season.auto"), t("window.chat.mode.auto-hint")], ["ask", "shield", t("mode.ask"), t("window.chat.mode.ask-hint")], ["plan", "list15", t("mode.plan"), t("window.chat.mode.plan-hint")]];
  return `<h2 tabindex="-1">${t("window.flows.setup.step-yours")}</h2><p>${t("window.flows.setup.yours-lede")}</p>
    <div class="ob-q15"><b>${t("window.flows.setup.looks")}</b><div class="ob-pick15">${looks.map(([v, l]) => `<button type="button" class="ob-card15 look-${v}" data-act="ob15" data-k="look" data-v="${v}" ${pressed(look === v)}><span class="ob-sw15"><i></i><i></i><i></i></span>${l}</button>`).join("")}</div></div>
    ${lookGallery()}
    <div class="ob-q15"><b>${t("window.flows.setup.asks")}</b><div class="ob-pick15 col15x">${asks.map(([v, i, l, s]) => `<button type="button" class="ob-row15" data-act="${v === "auto" ? "ob15-auto" : "ob15"}" data-k="asks" data-v="${v}" ${pressed(o.asks === v)}><span class="ico-tile">${ic(i, "s")}</span><span><b>${l}</b><small>${s}</small></span></button>`).join("")}</div><p class="hint" data-css="margin:6px 0 0">${t("window.flows.setup.full-off")}</p></div>`;
}

/* What Branch proposed from the owner's words (trunk.propose), each a card picked like a template, with the face its
   name gives (the face the Trunk is made with). */
function proposed(o, made) {
  if (!o.proposals.length) return "";
  const card = (p, i) => `<button class="ob-tpl" type="button" data-act="ob-prop" data-i="${i}" ${pressed(o.picks.has(p.name) || made.has(p.name))}>${av({ name: p.name }, 34)}<b>${esc(p.name)}</b><small>${esc(p.description || p.title)}</small></button>`;
  return `<div class="ob-props15"><b>${t("window.chat.mktrunk.proposed")}</b><div class="ob-tr">${o.proposals.map(card).join("")}</div></div>`;
}

function trunks(o) {
  const made = new Set(E.trunks.map((tr) => tr.name));
  const face = (n, col, sh) => av({ kind: "trunk", name: t(n), color: col, shape: sh }, 34);
  const busy = o.proposing ? ` disabled aria-busy="true"` : "";
  return `<h2 tabindex="-1">${t("window.flows.setup.step-trunks")}</h2><p>${t("window.flows.setup.trunks-lede")}</p><div class="ob-tr">${TEMPLATES.map(([n, s, col, sh], i) => `<button class="ob-tpl" type="button" data-act="ob-tpl" data-i="${i}" ${pressed(o.tpls.has(i) || made.has(t(n)))}>${face(n, col, sh)}<b>${esc(t(n))}</b><small>${esc(t(s))}</small></button>`).join("")}</div>${proposed(o, made)}<label class="fld" data-css="margin-top:12px"><span>${t("window.flows.setup.describe")}</span><textarea class="inp" id="ob-life" rows="2" placeholder="${t("window.flows.setup.describe-hint")}">${esc(o.life)}</textarea></label><button class="btn sm" type="button" data-act="ob-propose"${busy}>${ic(o.proposing ? "spin" : "spark", o.proposing ? "s spin" : "s")}${t("window.flows.setup.propose")}</button>${o.note ? `<p class="hint" role="status">${esc(o.note)}</p>` : ""}${o.error ? `<p class="hint" role="alert">${esc(o.error)}</p>` : ""}`;
}

function reach(o) {
  const live = new Set((o.connected ?? []).flatMap((c) => [c.id, c.kind]));
  const tiles = o.channels.slice(0, POPULAR).map((c) => `<button type="button" class="ch12 ${live.has(c.id) ? "on12" : ""}" data-act="ch-open" data-v="${esc(c.id)}">${logo(c.id, c.name, 30)}<span><b>${esc(say(c.name))}</b><small>${live.has(c.id) ? t("layout.connected") : t("channel-setup.row-button")}</small></span></button>`).join("");
  return `<h2 tabindex="-1">${t("window.flows.setup.reach")}</h2><p>${t("window.flows.setup.reach-lede", { count: o.channels.length })}</p><div class="ch-grid12 ob-ch12">${tiles}</div><div class="prow" data-css="margin-top:12px"><span class="ico-tile">${ic("phone", "s")}</span><span class="grow"><b>${t("studio.tab.phone")}</b><small>${t("window.flows.setup.scan")}</small></span><button class="btn sm" type="button" data-act="pair">${t("phoneApp.show")}</button></div>`;
}

/* What this Branch can use, every row from the engine (flows/setup-tools.js). */
const tools = (o) => toolsStep(o, draw);

/* Step 8, Keep it running: three on/off switches, read from the engine when the step opens (loadKeep).
   - The gateway: GET/POST /api/never-break. "when-needed" and "on" both run it (src/never-break/gateway-config.ts), so
     an old "when-needed" reads as on and the switch saves "on" or "off". It takes effect the next time Branch starts,
     said right under its row once saved. No OS permission is involved.
   - Starting at sign-in: GET /api/deployment autostart, POST /api/deployment/autostart. Windows writes the per-person
     sign-in list (no administrator prompt); a Mac uses the app's login item, which macOS may want approved in System
     Settings › Login Items. Only an installed app can be registered, so a source checkout says so and only this switch
     is off.
   - Updating by itself: GET/POST /api/comfort, notify.autoUpdate "install" or "off".
   A click saves at once. In a first setup (onboarding not done) a switch still at its shipped off is drawn on (the
   ship-on rule: none of these spends, sends, deletes or uses the microphone or camera) and saved on Continue. */
const KEEP = ["gw", "boot", "upd"];
const keepOf = (o) => (o.keep ??= { ready: false, boot: null, upd: null, platform: "", touched: new Set(), busy: new Set() });
function keepState(o) {
  const k = keepOf(o), boot = k.boot;
  const real = { gw: o.gw == null ? null : o.gw !== "off", boot: boot ? boot.enabled : null, upd: k.upd == null ? null : k.upd === "install" };
  const shipped = { gw: o.gw === "off", boot: boot?.available === true && !boot.enabled, upd: k.upd === "off" };
  const first = !E.state?.onboarding?.done;
  const shown = Object.fromEntries(KEEP.map((n) => [n, real[n] === true || (first && !k.touched.has(n) && shipped[n])]));
  return { real, shown };
}

function bootWhy(boot, platform) {
  if (boot.available) return "";
  if (!boot.installed) return t(platform === "darwin" ? "window.flows.setup.boot-install-mac" : platform === "win32" ? "window.flows.setup.boot-install-windows" : "window.flows.setup.boot-install-other");
  return t("window.flows.setup.boot-not-here");
}

function bootNotes(boot, platform) {
  const why = bootWhy(boot, platform);
  if (why) return `<p class="hint ob-keep-note">${why}</p>`;
  if (!boot.needsApproval) return "";
  const open = boot.settingsLink && typeof window.branchDesktop?.openExternal === "function"
    ? `<button class="btn sm" type="button" data-act="ob-login-items">${t("action.open-system-settings")}</button>` : "";
  return `<p class="hint ob-keep-note">${t("window.flows.setup.boot-approve")}</p>${open}`;
}

function keep(o) {
  const k = keepOf(o), { shown } = keepState(o), boot = k.boot;
  const off = (n, known) => !k.ready || !known || k.busy.has(n);
  const gwRow = ctl("ob-gw", t("window.flows.setup.gateway"), t("window.flows.setup.gateway-hint"), shown.gw, off("gw", o.gw != null));
  const gwNote = o.gwNote ? `<p class="hint ob-keep-note">${t("never-break.saved")}</p>` : "";
  const bootRow = ctl("ob-boot", mac() ? t("window.flows.setup.start-mac") : t("window.flows.setup.start-windows"), mac() ? t("window.flows.setup.menu-bar") : t("window.flows.setup.tray"),
    shown.boot, off("boot", boot?.available === true));
  const updRow = ctl("ob-upd", t("comfort.update.install"), t("window.flows.setup.upd-hint"), shown.upd, off("upd", k.upd != null));
  return `<h2 tabindex="-1">${t("window.flows.setup.step-keep")}</h2>${gwRow}${gwNote}${bootRow}${boot ? bootNotes(boot, k.platform) : ""}${updRow}`;
}

function people() {
  return `<h2 tabindex="-1">${t("window.flows.setup.anyone")}</h2><p>${t("window.flows.setup.anyone-lede")}</p><div class="provs">
    ${prov("ob-people-local", "people", "local", "users", t("window.flows.setup.someone"), t("window.flows.setup.someone-hint"), false)}
    ${prov("ob-people-invite", "people", "invite", "chat", t("window.flows.setup.teammate"), t("window.flows.setup.teammate-hint"), false)}
    ${prov("ob-people-keepoak", "people", "keepoak", "globe", t("window.flows.setup.team"), t("window.flows.setup.team-hint"), false)}</div>`;
}

function more() {
  return `<h2 tabindex="-1">${t("window.flows.setup.step-more")}</h2><p>${t("window.flows.setup.more-lede")}</p>
    <div class="ob-two15"><div class="tile"><div class="th"><span class="ico-tile">${ic("mail", "s")}</span><b>${t("window.flows.setup.email")}</b></div><p>${t("window.flows.setup.email-hint")}</p><div class="acts"><button class="btn sm" type="button" data-act="ob-mail">${logo("outlook", "Outlook", 16)}Outlook</button><button class="btn sm" type="button" data-act="ob-mail">${ic("mail", "s")}Gmail</button></div></div>
    <div class="tile"><div class="th"><span class="ico-tile">${ic("clock", "s")}</span><b>${t("first-run-steps.restore-title")}</b></div><p>${t("window.flows.setup.bring-back-hint")}</p><div class="acts"><button class="btn sm" type="button" data-act="ob-restore">${ic("folder", "s")}${t("window.flows.setup.backup")}</button></div></div></div>`;
}

function check(o) {
  return `<h2>${t("window.flows.setup.all-set")}</h2><p>${t("window.flows.setup.checks-lede")}</p><ol class="tl ob-checks">${o.checks.map((c) => `<li class="${c.ok === true ? "ok" : ""}">${c.ok == null ? ic("spin", "s spin") : ic(c.ok ? "check" : "x", "s")}<span>${esc(c.name ?? t(c.key))}<small>${c.ok == null ? t("window.flows.setup.checking") : esc(c.said)}</small></span></li>`).join("")}</ol>`;
}

const BODIES = [welcome, where, models, yours, trunks, reach, tools, keep, people, more, check];

function frame(o) {
  const i = o.i, last = i === STEPS.length - 1;
  const rail = STEPS.map((l, j) => `<li class="${j < i ? "done" : j === i ? "now" : ""}"><button type="button" data-act="ob-go" data-v="${j}" ${j > i && !o.trust ? "disabled" : ""}><em>${j < i ? ic("check", "s") : j + 1}</em>${t(l)}</button></li>`).join("");
  const done = o.checks.filter((c) => c.ok != null).length;
  const next = !last ? `<button class="btn pri" type="button" data-act="ob-next" ${i === 0 && !o.trust ? 'data-wait="trust"' : ""}>${i === 0 ? t("personal.tunnel.start") : t("window.flows.chw.continue")}</button>`
    : `<button class="btn pri" type="button" data-act="ob-done" ${done < o.checks.length ? "disabled" : ""}>${done < o.checks.length ? t("window.flows.setup.checking-n", { done, total: o.checks.length }) : t("window.flows.setup.open-walkthrough")}</button>`;
  return `<aside class="ob-rail"><span class="ob-brand"><span class="mark mark-face" data-css="width:26px;height:26px"></span>${t("window.setup.label")}</span><ol>${rail}</ol>${o.i > 0 ? `<button class="link ob-skip" type="button" data-act="ob-close">${t("window.flows.first.skip")}</button>` : ""}</aside>
    <section class="ob-main"><div class="ob-body">${pose(i)}${BODIES[i](o)}</div><footer class="ob-foot">${i ? `<button class="btn ghost" type="button" data-act="ob-go" data-v="${i - 1}">${t("action.back")}</button>` : "<span></span>"}<span class="grow"></span>${next}</footer></section>`;
}

function draw() {
  const o = S.ob;
  if (!o) return;
  let el = $(".ob9");
  const fresh = !el;
  if (fresh) {
    el = document.createElement("div");
    el.className = "ob9";
    el.setAttribute("role", "dialog");
    app().appendChild(el);
  } else el.classList.add("ob-still12");
  el.setAttribute("aria-label", t("window.setup.label")); // named on every draw, so a language picked here renames it
  /* A choice within a step redraws the step in place: the moving picture, where the page is scrolled and the control the
     person just pressed all stay as they were, so a click never looks like the screen starting over. Only a new step
     starts at its heading. */
  const sameStep = !fresh && el.dataset.step === String(o.i);
  const keptArt = sameStep ? [...el.querySelectorAll("video, img.pose11")] : [];
  const scrolled = sameStep ? [...el.querySelectorAll(".ob-main, .ob-body, [data-scroll]")].map((n) => [n.scrollTop, n.scrollLeft]) : [];
  const pressed = sameStep ? document.activeElement : null;
  const pressedKey = pressed && el.contains(pressed) ? [pressed.id, pressed.dataset?.act, pressed.dataset?.k, pressed.dataset?.v, pressed.dataset?.i] : null;
  el.innerHTML = frame(o);
  el.dataset.step = String(o.i);
  const fresh11 = [...el.querySelectorAll("video, img.pose11")];
  for (const old of keptArt) {
    const at = fresh11.findIndex((n) => n.tagName === old.tagName && n.getAttribute("src") === old.getAttribute("src"));
    if (at >= 0) { fresh11[at].replaceWith(old); fresh11.splice(at, 1); }
  }
  [...el.querySelectorAll(".ob-main, .ob-body, [data-scroll]")].forEach((n, i) => { if (scrolled[i]) [n.scrollTop, n.scrollLeft] = scrolled[i]; });
  /* A new step's rows that scroll sideways open with the picked card in the middle. */
  if (!sameStep) el.querySelectorAll("[data-scroll] > [aria-pressed='true']").forEach((b) => { b.parentElement.scrollLeft = b.offsetLeft - (b.parentElement.clientWidth - b.offsetWidth) / 2; });
  applyCss(el);
  greyOut(el);
  if (!fresh && !sameStep) el.querySelector("h2")?.focus({ preventScroll: true });
  else if (pressedKey) {
    const [id, act, k, v, i] = pressedKey;
    const again = id ? el.querySelector(`#${CSS.escape(id)}`) : [...el.querySelectorAll(`[data-act="${act}"]`)].find((n) => n.dataset.k === k && n.dataset.v === v && n.dataset.i === i);
    again?.focus({ preventScroll: true });
  }
}

async function load(o) {
  const [accounts, channels, connected, mcp, gw, mode] = await Promise.all([
    api("accounts").catch(() => ({})), api("channel-setup").catch(() => ({})),
    api("channels").catch(() => ({})), api("mcp/connections").catch(() => ({})), api("never-break").catch(() => ({})),
    api("conversation-mode/settings").catch(() => ({})),
  ]);
  Object.assign(o, {
    pools: accounts.pools ?? [], channels: channels.channels ?? [], connected: connected.channels ?? [],
    servers: mcp.servers ?? [], gw: gw.mode ?? o.gw, asks: ["auto", "ask", "plan"].includes(mode.settings?.newConversation) ? mode.settings.newConversation : "ask",
  });
}

/* jump: the step "Start" goes to once the trust box is ticked; the message box's "Set up" (chat/nomodel.js) asks for the
   Models step when no model is set up yet. */
export async function openSetup(jump = 1) {
  origin.setup = true;
  S.ob = { i: 0, jump, trust: false, where: "this", remote: null, pools: [], channels: [], connected: [], servers: [], gw: "off", asks: "ask", tpls: new Set(), test: null, checks: [], error: "", gwNote: "",
    life: "", proposals: [], picks: new Set(), proposing: false, note: "" };
  draw();
  freshPick();
  await load(S.ob).catch(() => {});
  draw();
}

function close() {
  $(".ob9")?.remove();
  S.ob = null;
  origin.setup = false;
  try { localStorage.setItem("branch-setup-seen", "1"); } catch { /* private window */ }
}

/* Leaving "Your first Trunks" makes each picked template a Trunk, skipping names that already exist. Picking one is
   asking for Trunks, so they are switched on first if they are off. */
async function makeTrunks(o) {
  if (E.trunkModes.trunks === "off") await api("trunks/switch", { part: "trunks", mode: "on" });
  const have = new Set(E.trunks.map((tr) => tr.name));
  for (const i of o.tpls) {
    const [name, description] = TEMPLATES[i].slice(0, 2).map((key) => t(key));
    const [, , colour, shape] = TEMPLATES[i];
    if (have.has(name)) continue;
    /* The create takes name, title and description; the template's face follows as an edit, as flows/trunk.js does. */
    const { trunk } = await api("trunks", { name, description });
    await api(`trunks/${encodeURIComponent(trunk.id)}`, { chosenColour: hex(colour), look: { ...lookOf(null), shape: SHAPE_NAMES[shape] } });
  }
  /* A proposal is made with exactly the fields Branch proposed, the owner's own create (as chat/mktrunk.js). */
  for (const p of o.proposals) {
    if (o.picks.has(p.name) && !have.has(p.name)) await api("trunks", { name: p.name, title: p.title, description: p.description });
  }
  o.tpls.clear();
  o.picks.clear();
  await refresh().catch(() => {});
}

/* The trunk.propose calls in a conversation's replies, with their arguments; one whose arguments are not JSON proposed
   nothing (chat/mktrunk.js reads the same calls). */
function proposalsIn(messages) {
  return (messages ?? []).flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : [])).filter((call) => call.name === "trunk.propose").map((call) => {
    let args;
    try { args = JSON.parse(call.arguments || "{}"); } catch { return null; } // not JSON: nothing was proposed
    const name = typeof args?.name === "string" ? args.name.trim().slice(0, 40) : "";
    return name ? { name, title: String(args.title ?? "").slice(0, 80), description: String(args.description ?? "").slice(0, 1000) } : null;
  }).filter(Boolean);
}

/* "Or describe what you do": the owner's words start a real task, "Make me a Trunk: <words>" (the + menu's ask), in a
   temporary conversation that is discarded once read. What Branch proposes with trunk.propose becomes cards, picked. With
   no model yet, the engine's own words say so and nothing is asked; a reply with no proposal is shown as it came. */
async function propose() {
  const o = S.ob, what = ($("#ob-life")?.value ?? o.life).trim();
  o.life = what;
  if (!what || o.proposing) { $("#ob-life")?.focus(); return; }
  await refresh().catch(() => {});
  if (E.state?.modelNeeded) { o.note = E.state.modelNeeded; draw(); return; }
  Object.assign(o, { proposing: true, note: "", error: "" });
  draw();
  try {
    const task = await api("run", { prompt: t("window.chat.mktrunk.ask", { what }), temporary: true });
    const view = await api(`sessions/${encodeURIComponent(task.sessionId)}`);
    const found = proposalsIn(view.messages).filter((p) => !o.proposals.some((q) => q.name === p.name));
    for (const p of found) { o.proposals.push(p); o.picks.add(p.name); }
    if (!found.length) o.note = task.status === "completed" ? [...view.messages].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? task.output : task.output;
    await api(`sessions/${encodeURIComponent(task.sessionId)}/discard`, {});
  } catch (error) { o.error = error.message; }
  o.proposing = false;
  if (S.ob === o) draw();
}

async function go(i) {
  const o = S.ob;
  if (!o || i < 0 || i >= STEPS.length || (i > 0 && !o.trust)) return;
  if (o.i === 4 && (o.tpls.size || o.picks.size)) {
    try { await makeTrunks(o); o.error = ""; } catch (error) { o.error = error.message; draw(); return; }
  }
  if (o.i === 7 && i > 7) await applyKeep(o);
  o.i = i;
  draw();
  if (i === 7) loadKeep(o);
  if (i === STEPS.length - 1) runChecks(o);
}

async function timed(fn) {
  const began = performance.now();
  const value = await fn();
  return [value, Math.round(performance.now() - began)];
}

/* The engine's own answers only: how fast it replies, a hello from the default model, the gateway, and three of
   GET /api/health's checks. Each row settles as its check comes back. */
async function runChecks(o) {
  /* The engine names its health items in English; those names find them, and the keys beside them are what each row shows. */
  const HEALTH = [["Channels", "place.customize.channels"], ["Saved data", "dashboard.computer.database"], ["Device key", "window.flows.setup.device-key"]];
  o.checks = [{ key: "window.flows.setup.engine" }, { key: "layout.modelTabs" }, { key: "window.flows.setup.gateway" }, ...HEALTH.map(([, key]) => ({ key }))];
  draw();
  const settle = (n, ok, said) => { if (S.ob !== o) return; Object.assign(o.checks[n], { ok, said }); draw(); };
  const [health, ms] = await timed(() => api("health")).catch(() => [null, 0]);
  settle(0, !!health, health ? t("window.flows.setup.answering-in", { ms }) : t("window.flows.setup.not-answering"));
  const test = await api("models/test", {}).catch((error) => ({ ok: false, error: error.message }));
  if (test.presetName) o.checks[1].name = test.presetName;
  settle(1, !!test.ok, test.ok ? t("window.flows.setup.answered-lower", { s: (test.ms / 1000).toFixed(1) }) : test.error ?? t("window.flows.setup.did-not-answer"));
  const gw = await api("never-break").catch(() => null);
  const GW = { off: "comfort.choice.off", "when-needed": "terminal.state.on", on: "terminal.state.on" }; // when-needed runs it too
  settle(2, !!gw, gw ? (GW[gw.mode] ? t(GW[gw.mode]) : gw.mode) : t("window.flows.setup.not-answering"));
  HEALTH.forEach(([name], j) => {
    const item = health?.items?.find((x) => x.name === name);
    settle(3 + j, item ? item.ok : false, item?.summary ?? t("window.flows.setup.not-checked"));
  });
}

async function finish() {
  try {
    await api("onboarding", { done: true });
  } catch (error) {
    toast(error.message);
    return;
  }
  close();
  await refresh().catch(() => {});
  toast(t("window.flows.setup.ready"));
  setTimeout(() => run("tour"), 700);
}

async function test() {
  const o = S.ob;
  o.test = "wait";
  draw();
  o.test = await api("models/test", {}).catch((error) => ({ ok: false, error: error.message }));
  if (S.ob === o) draw();
}

/* What new conversations start on, sent first without the owner's yes to loosening. When the engine says the choice
   makes Branch less careful, its words are shown in a confirm and only "Yes, make it less careful" there sends it
   again with confirmLoosening; any other refusal (Lockdown's among them) is shown as the engine says it. The choice
   shown is then read back from the engine. */
const ASKS = ["auto", "ask", "plan"];
async function saveAsks(v, confirmLoosening = false) {
  const o = S.ob;
  if (!o || !ASKS.includes(v)) return;
  try {
    await api("conversation-mode/settings", { newConversation: v, ...(confirmLoosening ? { confirmLoosening: true } : {}) });
  } catch (error) {
    if (!confirmLoosening && /less careful/.test(error.message)) { askLoosening(v, error.message); return; }
    toast(error.message);
  }
  try { const mode = await api("conversation-mode/settings"); o.asks = ASKS.includes(mode.settings?.newConversation) ? mode.settings.newConversation : "ask"; } catch (error) { toast(error.message); }
  if (S.ob === o) draw();
}
function askLoosening(v, words) {
  openDlg({ title: t("window.flows.setup.asks"), body: `<p data-css="margin:0">${esc(words)}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="ob15-loosen" data-v="${esc(v)}">${t("settings-kit.confirm")}</button>` });
}

/* A theme, a painted scene or the pet picked in Make it yours: saved the way Settings › Appearance saves it, the window
   behind setup drawn again in it, then setup from what was saved. */
async function pickLook(kind, v) {
  if (kind === "skin") await wear(v);
  else if (kind === "scene") await pickScene(v);
  else await pickPet(v);
  renderNow();
  if (S.ob) draw();
}
function initYours() {
  markLive(["ob15-auto", "ob15-loosen", "ob15-skin", "ob15-scene", "ob15-pet"]);
  on("ob15-auto", () => saveAsks("auto"));
  on("ob15-loosen", (el) => { closeDlg(); saveAsks(el.dataset.v, true); });
  on("ob15-skin", (el) => pickLook("skin", el.dataset.v));
  on("ob15-scene", (el) => pickLook("scene", el.dataset.v));
  on("ob15-pet", (el) => pickLook("pet", el.dataset.v));
}

/* The language picked at the top of Welcome: saved the way Settings › Appearance saves it (the engine's look and this
   browser, shell/language.js), then setup is drawn again in its words. One that cannot be picked changes nothing. */
async function pickLanguage(code) {
  if (canSpeak(code)) {
    try { await chooseLanguage(code); } catch (error) { toast(error.message); }
  }
  renderNow(); // the window behind setup, in the same words
  draw();
}

/* "Another computer": a computer already let in from this setup is picked again; otherwise pairing starts, and the
   card is picked only once the owner lets one in (below). Closing or refusing leaves the choice as it was. */
function pickRemote() {
  const o = S.ob;
  if (o.remote) { o.where = "remote"; draw(); return; }
  startPairing("computer");
}

/* After the owner's yes to this card's dialog: that computer is the one picked, and GET /api/devices is read until it
   says it is connected (the other computer dials in once it runs). A phone let in from "Reach it anywhere" changes
   nothing here. Stops when setup closes, another computer is let in, or it connects. */
async function remoteLetIn({ approve, kind, request } = {}) {
  const o = S.ob;
  if (!o || !approve || kind !== "computer" || !request?.deviceId || ["ios", "android"].includes(request.platform)) return;
  const r = o.remote = { id: request.deviceId, name: request.name, connected: false };
  o.where = "remote";
  draw();
  while (S.ob === o && o.remote === r && !r.connected) {
    await new Promise((done) => setTimeout(done, 1500));
    let view;
    try { view = await api("devices"); } catch (error) { toast(error.message); return; }
    const device = (view.devices ?? []).find((d) => d.id === r.id);
    if (!device) { // taken off the list meanwhile: nothing is picked in its name
      if (S.ob === o && o.remote === r) { o.remote = null; if (o.where === "remote") o.where = "this"; draw(); }
      return;
    }
    r.name = device.name;
    r.connected = device.connected === true;
    if (r.connected && S.ob === o) draw();
  }
}

/* Keep it running, read when the step opens: the gateway's mode, whether Branch starts at sign-in here (and whether it
   can), and whether it updates by itself. A read that fails says why and leaves its switch off. */
async function loadKeep(o) {
  const k = keepOf(o);
  const read = (path) => api(path).catch((error) => { toast(error.message); return null; });
  const [gw, dep, comfort] = await Promise.all([read("never-break"), read("deployment"), read("comfort")]);
  o.gw = gw?.mode ?? null;
  k.boot = dep?.autostart ? { ...dep.autostart, installed: dep.installed === true } : null;
  k.platform = dep?.platform ?? "";
  k.upd = comfort?.values?.notify?.autoUpdate ?? null;
  k.ready = true;
  if (S.ob === o) draw();
}

/* One switch saved through its engine route; the engine's answer is what is drawn next. */
const KEEP_SAVE = {
  gw: async (o, on) => { const view = await api("never-break", { mode: on ? "on" : "off" }); o.gw = view.mode; o.gwNote = !!view.note; },
  boot: async (o, on) => { const view = await api("deployment/autostart", { enabled: on }); Object.assign(o.keep.boot, view); },
  upd: async (o, on) => { const view = await api("comfort", { card: "notify", values: { autoUpdate: on ? "install" : "off" } }); o.keep.upd = view.values?.notify?.autoUpdate ?? o.keep.upd; },
};

async function saveKeep(o, name, on) {
  const k = keepOf(o);
  k.touched.add(name);
  k.busy.add(name);
  draw();
  try { await KEEP_SAVE[name](o, on); } catch (error) { toast(error.message); }
  k.busy.delete(name);
  if (S.ob === o) draw();
}

/* Continue from Keep it running: a switch drawn on by the ship-on rule, still off in the engine, is saved now. */
async function applyKeep(o) {
  const k = keepOf(o);
  if (!k.ready) return;
  const { real, shown } = keepState(o);
  for (const name of KEEP) if (shown[name] && real[name] === false) await saveKeep(o, name, true);
}

function openLoginItems() {
  const link = S.ob?.keep?.boot?.settingsLink;
  if (link) Promise.resolve(window.branchDesktop?.openExternal?.(link)).catch((error) => toast(error.message));
}

export function init() {
  initLocalPick();
  markLive(["sw:ob-trust", "sw:ob-lang", "onboard", "ob-go", "ob-next", "ob-close", "ob-done", "ob-set", "ob-where-remote", "ob-test", "ob15", "ob-tpl", "ob-propose", "ob-prop", "sw:ob-life", "sw:ob-gw", "sw:ob-boot", "sw:ob-upd", "ob-login-items"]);
  on("ob-where-remote", () => pickRemote());
  onPaired.add((said) => remoteLetIn(said));
  on("onboard", (el) => openSetup(Number(el?.dataset?.v) || 1));
  on("ob-go", (el) => go(+el.dataset.v));
  on("ob-next", () => { if (S.ob.i === 0 && !S.ob.trust) { nudgeTrust(); return; } go(S.ob.i === 0 ? S.ob.jump : S.ob.i + 1); });
  on("ob-close", () => close());
  on("ob-done", () => finish());
  on("ob-set", (el) => { S.ob[el.dataset.k] = el.dataset.v; draw(); });
  on("ob-test", () => test());
  on("ob15", (el) => { if (el.dataset.k === "look") { run("themeset", el); draw(); } else saveAsks(el.dataset.v); });
  on("ob-tpl", (el) => { const i = +el.dataset.i; if (S.ob.tpls.has(i)) S.ob.tpls.delete(i); else S.ob.tpls.add(i); draw(); });
  on("ob-propose", () => propose());
  on("ob-prop", (el) => { const name = S.ob.proposals[+el.dataset.i]?.name; if (!name) return; if (S.ob.picks.has(name)) S.ob.picks.delete(name); else S.ob.picks.add(name); draw(); });
  document.addEventListener("input", (e) => { if (e.target.id === "ob-life" && S.ob) S.ob.life = e.target.value; });
  on("ob-login-items", () => openLoginItems());
  const KEEP_IDS = { "ob-gw": "gw", "ob-boot": "boot", "ob-upd": "upd" };
  document.addEventListener("change", (e) => { const name = KEEP_IDS[e.target.id]; if (name && S.ob) saveKeep(S.ob, name, e.target.checked); });
  initToolsStep(draw);
  document.addEventListener("change", (e) => { if (e.target.id === "ob-trust" && S.ob) { S.ob.trust = e.target.checked; draw(); } });
  document.addEventListener("change", (e) => { if (e.target.id === "ob-lang" && S.ob) pickLanguage(e.target.value); });
  /* The language can also change while setup is open without it being picked here (the engine's saved choice arriving
     after the first draw, or another window): setup is drawn again in the words now in force. */
  document.addEventListener("branch-language", () => { if (S.ob) draw(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.ob && !document.querySelector(".scrim")) close(); });
  initYours();
}

/* Start before the box is ticked: the box and its line light up and shake once, and the keyboard lands on the box, so the
   one thing between the person and the next step is plain. Pressed again, it does it again. */
function nudgeTrust() {
  const box = document.querySelector(".ob-trust");
  if (!box) return;
  box.classList.remove("nudge");
  void box.offsetWidth;
  box.classList.add("nudge");
  document.getElementById("ob-trust")?.focus();
}
