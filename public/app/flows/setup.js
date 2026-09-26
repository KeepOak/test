/* Set up Branch (design doc 6.1): the eleven steps drawn 1:1 from design/redesign/dom/setup-0..10.html, against
   the engine: models from GET /api/accounts and /api/local-models, a hello through POST /api/models/test, the look,
   how much it asks (POST /api/conversation-mode/settings), Trunks made with POST /api/trunks, chat apps from
   GET /api/channel-setup, the gateway (POST /api/never-break), and the engine's own checks (GET /api/health).
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
import { toolsStep, initToolsStep } from "./setup-tools.js";
import { media17 } from "../core/art17.js"; // Branch's idle loop, or its still when motion is reduced (prototype anim11)

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
const ctl = (id, name, sub) => `<div class="ctl"><b>${name}</b><input class="sw" type="checkbox" id="${id}" aria-label="${name}" data-sw="set"><small>${sub}</small></div>`;

function languageControl() {
  const now = language();
  const opts = LANGUAGES.map(({ id }) => `<option value="${esc(id)}"${id === now ? " selected" : ""}>${esc(ownName(id))}</option>`).join("");
  return `<div class="ctl ob-lang"><b>${t("appearance.language")}</b><span class="right"><select class="inp" id="ob-lang" data-sw="ob-lang" aria-label="${t("appearance.language")}">${opts}</select></span></div>`;
}

function welcome(o) {
  return `${languageControl()}<div class="ob-stage11">${media17("/art/branch-wave.webp", "/art/anim-idle.webm", "pose11 vid11 ob-art11")}</div><h2>${t("window.flows.first.hi")}</h2><p>${t("window.flows.setup.hi-lede")}</p><div class="ob-trust"><b>${t("window.flows.setup.safe")}</b><ul class="may6"><li>${ic("check", "s")}${t("window.flows.setup.safe-asks")}</li><li>${ic("check", "s")}${t("window.flows.setup.safe-stay")}</li><li>${ic("check", "s")}${t("window.flows.setup.safe-stop")}</li></ul><label class="chk ob-agree"><input type="checkbox" id="ob-trust" ${o.trust ? "checked" : ""}><span class="ob-box" aria-hidden="true">${ic("check", "s")}</span><span>${t("window.flows.setup.understand")}</span></label></div>`;
}

function where(o) {
  return `<h2 tabindex="-1">${t("window.flows.setup.where")}</h2><p>${t("window.flows.setup.where-lede")}</p><div class="provs">
    ${prov("ob-set", "where", "this", "monitor", t("dashboard.computer.title"), t("window.flows.setup.this-computer-hint"), o.where === "this")}
    ${prov("ob-where-remote", "where", "remote", "key", t("studio.tab.computer"), t("window.flows.setup.another-hint"), false)}
    ${prov("ob-where-keepoak", "where", "keepoak", "globe", t("window.flows.setup.keepoak"), t("window.flows.setup.keepoak-hint"), false)}
    ${prov("ob-set", "where", "later", "clock", t("window.flows.setup.later"), t("window.flows.setup.later-hint"), o.where === "later")}</div>`;
}

function modelRows(o) {
  const rows = [];
  for (const p of o.pools) for (const a of p.accounts ?? []) rows.push([p.pool, a.label || p.pool, p.pool + (p.defaultAccount === a.id ? ` · ${t("glance.usedNext")}` : "")]);
  for (const m of o.local) rows.push(["ollama", t("window.flows.setup.on-computer", { name: m.name ?? m.model ?? m }), "Ollama"]);
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
  return `<h2 tabindex="-1">${t("window.flows.setup.models")}</h2><p>${t("window.flows.setup.found")}</p><div class="rows">${modelRows(o)}</div><div class="acts" data-css="margin-top:10px"><button class="btn sm" type="button" data-act="addacct">${ic("plus", "s")}${t("window.flows.setup.add-account")}</button><button class="btn sm" type="button" data-act="ob-test">${t("window.flows.setup.say-hello")}</button></div><div id="ob-test-out">${testOut(o)}</div>`;
}

/* Auto lets workspace changes go ahead and keeps a standing yes per website (src/conversation-mode.ts), which loosens
   the default Ask first, so it has its own act name and stays greyed until it is reviewed. */
function yours(o) {
  const look = document.documentElement.dataset.theme || "system";
  const looks = [["system", mac() ? t("window.flows.setup.match-mac") : t("window.flows.setup.match-windows")], ["light", t("look.mode.light")], ["dark", t("look.mode.dark")]];
  const asks = [["auto", "spark", t("look.season.auto"), t("window.chat.mode.auto-hint")], ["ask", "shield", t("mode.ask"), t("window.chat.mode.ask-hint")], ["plan", "list15", t("mode.plan"), t("window.chat.mode.plan-hint")]];
  return `<h2 tabindex="-1">${t("window.flows.setup.step-yours")}</h2><p>${t("window.flows.setup.yours-lede")}</p>
    <div class="ob-q15"><b>${t("window.flows.setup.looks")}</b><div class="ob-pick15">${looks.map(([v, l]) => `<button type="button" class="ob-card15 look-${v}" data-act="ob15" data-k="look" data-v="${v}" ${pressed(look === v)}><span class="ob-sw15"><i></i><i></i><i></i></span>${l}</button>`).join("")}</div></div>
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

function keep(o) {
  const seg = [["off", t("accounts.switch.off")], ["when-needed", t("accounts.switch.when-needed")], ["on", t("accounts.switch.on")]].map(([v, l]) => `<button type="button" ${pressed(o.gw === v)} data-act="ob-gw" data-v="${v}">${l}</button>`).join("");
  return `<h2 tabindex="-1">${t("window.flows.setup.step-keep")}</h2><div class="ctl"><b>${t("window.flows.setup.gateway")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.flows.setup.gateway")}">${seg}</span></span><small>${t("window.flows.setup.gateway-hint")}</small></div>${ctl("ob-boot", mac() ? t("window.flows.setup.start-mac") : t("window.flows.setup.start-windows"), mac() ? t("window.flows.setup.menu-bar") : t("window.flows.setup.tray"))}${ctl("ob-upd", t("comfort.update.install"), t("window.flows.setup.upd-hint"))}${o.gwNote ? `<p class="hint">${esc(o.gwNote)}</p>` : ""}`;
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
  const scrolled = sameStep ? [...el.querySelectorAll(".ob-main, .ob-body, [data-scroll]")].map((n) => n.scrollTop) : [];
  const pressed = sameStep ? document.activeElement : null;
  const pressedKey = pressed && el.contains(pressed) ? [pressed.id, pressed.dataset?.act, pressed.dataset?.k, pressed.dataset?.v, pressed.dataset?.i] : null;
  el.innerHTML = frame(o);
  el.dataset.step = String(o.i);
  const fresh11 = [...el.querySelectorAll("video, img.pose11")];
  for (const old of keptArt) {
    const at = fresh11.findIndex((n) => n.tagName === old.tagName && n.getAttribute("src") === old.getAttribute("src"));
    if (at >= 0) { fresh11[at].replaceWith(old); fresh11.splice(at, 1); }
  }
  [...el.querySelectorAll(".ob-main, .ob-body, [data-scroll]")].forEach((n, i) => { if (scrolled[i] != null) n.scrollTop = scrolled[i]; });
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
  const [accounts, local, channels, connected, mcp, gw, mode] = await Promise.all([
    api("accounts").catch(() => ({})), api("local-models").catch(() => ({})), api("channel-setup").catch(() => ({})),
    api("channels").catch(() => ({})), api("mcp/connections").catch(() => ({})), api("never-break").catch(() => ({})),
    api("conversation-mode/settings").catch(() => ({})),
  ]);
  Object.assign(o, {
    pools: accounts.pools ?? [], local: local.ollama?.models ?? [], channels: channels.channels ?? [], connected: connected.channels ?? [],
    servers: mcp.servers ?? [], gw: gw.mode ?? o.gw, asks: ["auto", "ask", "plan"].includes(mode.settings?.newConversation) ? mode.settings.newConversation : "ask",
  });
}

/* jump: the step "Start" goes to once the trust box is ticked; the message box's "Set up" (chat/nomodel.js) asks for the
   Models step when no model is set up yet. */
export async function openSetup(jump = 1) {
  origin.setup = true;
  S.ob = { i: 0, jump, trust: false, where: "this", pools: [], local: [], channels: [], connected: [], servers: [], gw: "off", asks: "ask", tpls: new Set(), test: null, checks: [], error: "", gwNote: "",
    life: "", proposals: [], picks: new Set(), proposing: false, note: "" };
  draw();
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
  o.i = i;
  draw();
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
  const GW = { off: "comfort.choice.off", "when-needed": "terminal.state.whenNeeded", on: "terminal.state.on" };
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

async function saveAsks(v) {
  const o = S.ob;
  try { await api("conversation-mode/settings", { newConversation: v }); o.asks = v; } catch (error) { toast(error.message); }
  draw();
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

async function saveGateway(v) {
  const o = S.ob;
  try { const view = await api("never-break", { mode: v }); o.gw = view.mode ?? v; o.gwNote = view.note ?? ""; } catch (error) { toast(error.message); }
  draw();
}

export function init() {
  markLive(["sw:ob-trust", "sw:ob-lang", "onboard", "ob-go", "ob-next", "ob-close", "ob-done", "ob-set", "ob-test", "ob15", "ob-tpl", "ob-gw", "ob-propose", "ob-prop", "sw:ob-life"]);
  on("onboard", (el) => openSetup(Number(el?.dataset?.v) || 1));
  on("ob-go", (el) => go(+el.dataset.v));
  on("ob-next", () => { if (S.ob.i === 0 && !S.ob.trust) { nudgeTrust(); return; } go(S.ob.i === 0 ? S.ob.jump : S.ob.i + 1); });
  on("ob-close", () => close());
  on("ob-done", () => finish());
  on("ob-set", (el) => { S.ob[el.dataset.k] = el.dataset.v; draw(); });
  on("ob-test", () => test());
  on("ob15", (el) => { if (el.dataset.k === "look") { run("themeset", el); draw(); } else saveAsks(el.dataset.v); });
  on("ob-tpl", (el) => { const i = +el.dataset.i; if (S.ob.tpls.has(i)) S.ob.tpls.delete(i); else S.ob.tpls.add(i); draw(); });
  on("ob-gw", (el) => saveGateway(el.dataset.v));
  on("ob-propose", () => propose());
  on("ob-prop", (el) => { const name = S.ob.proposals[+el.dataset.i]?.name; if (!name) return; if (S.ob.picks.has(name)) S.ob.picks.delete(name); else S.ob.picks.add(name); draw(); });
  document.addEventListener("input", (e) => { if (e.target.id === "ob-life" && S.ob) S.ob.life = e.target.value; });
  initToolsStep(draw);
  document.addEventListener("change", (e) => { if (e.target.id === "ob-trust" && S.ob) { S.ob.trust = e.target.checked; draw(); } });
  document.addEventListener("change", (e) => { if (e.target.id === "ob-lang" && S.ob) pickLanguage(e.target.value); });
  /* The language can also change while setup is open without it being picked here (the engine's saved choice arriving
     after the first draw, or another window): setup is drawn again in the words now in force. */
  document.addEventListener("branch-language", () => { if (S.ob) draw(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.ob && !document.querySelector(".scrim")) close(); });
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
