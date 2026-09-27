/* Setup's "Tools to start with" (step 7): what this Branch can use, every row read from the engine.
   - Comes with Branch: GET /api/setup/tools counts the built-in tools of six kinds, how many are off, and how many ask
     first or are refused for a new conversation (src/setup-tools.ts). No kind has one switch of its own, so none is drawn.
   - Recommended for your Trunks: the same route says what each starter Trunk works with; the Trunks made from the
     templates in step 5 are the ones in E.trunks. Each thing's state is read where it is changed: a chat app from
     GET /api/channels (Connect opens its setup, "ch-open"), a personal connector from GET /api/personal (its switch is
     POST /api/personal/switch) and GET /api/personal/signin/<id>, a command-line tool from GET /api/clis, a skill from
     the skills in GET /api/state. Signing in to Google or Microsoft has no window flow yet, so its Connect stays greyed.
   - Skills: the ones that come with Branch (GET /api/skills/browser). On installs one the first time
     (POST /api/skills/browser) and turns it on (POST /api/skills/<id>/activate); off turns it off (…/disable).
   - Found on this computer: the command-line tools the engine found (GET /api/clis). The one switch lets Branch use all
     of them (POST /api/clis for each) or takes back the found ones you allowed (POST /api/clis/remove); every command
     still follows the approval settings. It is on only when every one found is allowed.
   - Tool servers: the engine's list (GET /api/mcp/connections, read by setup.js), and "Add a tool server". */

import { esc } from "../core/dom.js";
import { app, ic, toast } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";
import { t } from "../../i18n.js";
import { TEMPLATE_WORDS } from "./trunk.js";

const KINDS = { files: ["folder", "files"], web: ["globe", "web"], terminal: ["term", "terminal"], mail: ["mail", "mail"], memory: ["bulb", "memory"], more: ["image", "more"] };
const MODES = { ask: "mode.ask", plan: "mode.plan", auto: "mode.auto", full: "mode.full", follow: "mode.follow" };
/* Logos for the personal connectors and tools whose engine id is not a brand the logo helper knows. */
const LOGO = { google: "gmail", microsoft: "outlook", "mail-search": "email", gh: "github" };
const K = (key, values) => t(`window.flows.setup.tools-${key}`, values);
const pill = (cls, words) => `<span class="pill ${cls}">${words}</span>`;
const sw = (attrs, on, label) => `<input class="sw" type="checkbox" ${attrs} ${on ? "checked" : ""} aria-label="${esc(label)}">`;

/* ---------- reading ---------- */

const read = (path, errors) => api(path).catch((error) => { errors.push(error.message); return null; });

async function load(o, redraw) {
  const errors = [];
  const open = o.obt?.open ?? new Set();
  o.obt = { ...(o.obt ?? {}), loading: true, open };
  const paths = ["setup/tools", "personal", "clis", "skills/browser", "channels", "mcp/servers", "mcp/connections"];
  const [view, personal, clis, skills, channels, own, conn] = await Promise.all(paths.map((path) => read(path, errors)));
  const signin = {};
  for (const id of ["google", "microsoft"]) if (neededParts(view).has(id)) signin[id] = (await read(`personal/signin/${id}`, errors))?.status ?? null;
  o.obt = { loading: false, open, view, personal, clis, skills: skills?.skills ?? [], channels: channels?.channels ?? [], signin, errors,
    own: own?.servers ?? [], conn: conn?.servers ?? [] };
  if (S.ob === o) redraw();
}

/* The starter Trunks made in step 5: the templates whose name, in the words in force, is a Trunk now. */
function picked() {
  const names = new Set(E.trunks.map((tr) => tr.name));
  return TEMPLATE_WORDS.filter(([name]) => names.has(t(name))).map(([name]) => ({ id: name.split(".").pop(), name: t(name) }));
}
function neededParts(view) {
  return new Set(picked().flatMap((p) => view?.starters?.[p.id] ?? []).filter((n) => n.kind === "personal").map((n) => n.id));
}

/* ---------- drawing ---------- */

function kindTile(k, open) {
  const [icon, key] = KINDS[k.id] ?? ["bolt", k.id];
  const pills = k.off === k.tools ? pill("idle", K("off", { count: k.off }))
    : [k.asks ? pill("warn", K("asks", { count: k.asks })) : "", k.refused ? pill("no", K("refused", { count: k.refused })) : "",
      !k.asks && !k.refused ? pill("ok", K("free")) : "", k.off ? pill("idle", K("off", { count: k.off })) : ""].join("");
  const names = k.names.map((n) => `<code>${esc(n)}</code>`).join("");
  return `<details class="obt-kind" data-kind="${esc(k.id)}" ${open ? "open" : ""}><summary><span class="ico-tile">${ic(icon, "s")}</span><span class="obt-kt"><b>${K(`kind-${key}`)}</b><small>${K("n", { count: k.tools })}</small></span><span class="obt-pills">${pills}</span></summary><div class="obt-names">${names}</div></details>`;
}

function builtIn(o) {
  const view = o.obt.view;
  if (!view) return "";
  const mode = MODES[view.mode] ? t(MODES[view.mode]) : esc(view.mode);
  return `<h3 class="obt-h">${K("builtin")}</h3><div class="obt-kinds">${view.kinds.map((k) => kindTile(k, o.obt.open.has(k.id))).join("")}</div><p class="hint obt-hint">${K("mode", { mode })}</p>`;
}

/* One row per thing the picked Trunks work with, each named once with every Trunk that needs it. */
function needRows(o) {
  const rows = new Map();
  for (const p of picked()) for (const need of o.obt.view?.starters?.[p.id] ?? []) {
    const key = `${need.kind}:${need.id}`;
    if (!rows.has(key)) rows.set(key, { need, for: [] });
    rows.get(key).for.push(p.name);
  }
  return [...rows.values()];
}

function channelRow({ need, for: who }, o) {
  const c = (o.channels ?? []).find((x) => x.id === need.id);
  const name = c?.name ?? need.id;
  const live = o.obt.channels.some((x) => x.id === need.id || x.kind === need.id);
  const act = live ? pill("ok", t("layout.connected")) : `<button class="btn sm" type="button" data-act="ch-open" data-v="${esc(need.id)}">${K("connect")}</button>`;
  return row(logo(need.id, name, 28), name, who, live ? t("layout.connected") : K("not-connected"), act);
}

function personalRow({ need, for: who }, o) {
  const label = o.obt.personal?.labels?.[need.id] ?? need.id;
  const on = (o.obt.personal?.modes?.[need.id] ?? "off") !== "off";
  const signin = o.obt.signin[need.id];
  const state = signin ? (signin.signedIn ? K("signed-in") : K("signed-out")) : (on ? t("accounts.switch.on") : t("accounts.switch.off"));
  const connect = signin && !signin.signedIn ? `<button class="btn sm" type="button" data-act="obt-signin" data-v="${esc(need.id)}">${K("connect")}</button>` : "";
  return row(logo(LOGO[need.id] ?? need.id, label, 28), label, who, state, connect + sw(`data-sw="obt-part" data-v="${esc(need.id)}"`, on, label));
}

function cliRow({ need, for: who }, o) {
  const found = (o.obt.clis?.found ?? []).find((c) => c.name === need.id);
  const state = !found ? K("missing") : found.allowed ? K("allowed") : K("not-allowed");
  return row(logo(LOGO[need.id] ?? need.id, need.id, 28), need.id, who, state, "");
}

function skillRow({ need, for: who }) {
  const on = (E.state?.skills ?? []).some((s) => s.name === need.id && s.activeVersion != null);
  return row(`<span class="ico-tile">${ic("bolt", "s")}</span>`, need.id, who, on ? t("accounts.switch.on") : t("accounts.switch.off"), "");
}

const row = (art, name, who, state, controls) =>
  `<div class="prow">${art}<span class="grow"><b>${esc(name)}</b><small>${K("for", { names: esc(who.join(", ")) })} · ${state}</small></span>${controls}</div>`;

function recommended(o) {
  const rows = needRows(o);
  const ROW = { channel: channelRow, personal: personalRow, cli: cliRow, skill: skillRow };
  const body = rows.length ? `<div class="rows">${rows.map((r) => ROW[r.need.kind]?.(r, o) ?? "").join("")}</div>` : `<p class="hint">${K("no-trunks")}</p>`;
  return `<h3 class="obt-h">${K("trunks")}</h3>${body}`;
}

function skills(o) {
  if (!o.obt.skills.length) return "";
  const active = new Set((E.state?.skills ?? []).filter((s) => s.activeVersion != null).map((s) => s.name));
  const cards = o.obt.skills.map((s) => `<label class="obt-skill"><span class="ico-tile">${ic("bolt", "s")}</span><span class="obt-kt"><b>${esc(s.name)}</b><small>${esc(s.description)}</small></span>${sw(`data-sw="obt-skill" data-v="${esc(s.name)}"`, active.has(s.name), s.name)}</label>`).join("");
  return `<h3 class="obt-h">${K("skills")}</h3><div class="obt-skills">${cards}</div><p class="hint obt-hint">${K("skills-more")}</p>`;
}

function found(o) {
  const list = o.obt.clis?.found;
  if (!list) return "";
  const chips = list.map((c) => `<span class="obt-cli ${c.allowed ? "on" : ""}">${esc(c.name)}</span>`).join("");
  const all = list.length > 0 && list.every((c) => c.allowed);
  const toggle = list.length ? `<input class="sw" type="checkbox" id="obt-cli" ${all ? "checked" : ""} aria-label="${K("clis")}">` : "";
  return `<h3 class="obt-h">${K("found")}</h3><div class="prow"><span class="ico-tile">${ic("term", "s")}</span><span class="grow"><b>${K("clis")}</b><small>${list.length ? K("clis-hint") : K("clis-none")}</small></span>${toggle}</div>${chips ? `<div class="obt-clis">${chips}</div>` : ""}`;
}

/* Your own servers (GET /api/mcp/servers) and the launch file's (GET /api/mcp/connections), as Customize › Tools lists them. */
function servers(o) {
  const own = o.obt.own.map((s) => [s.id, s.name, [s.how, s.on ? t("accounts.switch.on") : t("accounts.switch.off"), s.error].filter(Boolean).join(" · ")]);
  const launch = o.obt.conn.filter((s) => !o.obt.own.some((x) => x.id === s.id)).map((s) => [s.id, s.id, s.summary ?? s.lastError ?? ""]);
  const rows = [...own, ...launch];
  const list = rows.length ? `<h3 class="obt-h">${K("servers")}</h3><div class="rows">${rows.map(([id, n, s]) => `<div class="prow">${logo(id, n, 28)}<span class="grow"><b>${esc(n)}</b><small>${esc(s)}</small></span></div>`).join("")}</div>` : "";
  return `${list}<button class="link obt-add" type="button" data-act="tool-add" data-v="mcp">${ic("plug", "s")}${K("add-server")}</button>`;
}

/* The step's body. Coming to the step reads everything again, so a chat app connected elsewhere shows as connected. */
export function toolsStep(o, redraw) {
  const entering = document.querySelector(".ob9")?.dataset.step !== String(o.i);
  if (entering && !o.obt?.loading) load(o, redraw);
  const head = `<h2 tabindex="-1">${t("window.flows.setup.tools")}</h2><p>${t("window.flows.setup.tools-lede")}</p>`;
  if (!o.obt || o.obt.loading && !o.obt.view) return `${head}<p class="hint">${K("loading")}</p>`;
  const errors = (o.obt.errors ?? []).map((e) => `<p class="hint" role="alert">${esc(e)}</p>`).join("");
  return `${head}${errors}<div class="obt">${builtIn(o)}${recommended(o)}${skills(o)}${found(o)}${servers(o)}</div>`;
}

/* ---------- the switches ---------- */

async function skillSwitch(name, on) {
  const have = (E.state?.skills ?? []).find((s) => s.name === name);
  if (!on) {
    if (have) await api(`skills/${have.id}/disable`, { expectedRevision: have.revision });
    return;
  }
  const skill = have ?? (await api("skills/browser", { name })).skill;
  await api(`skills/${skill.id}/activate`, { version: skill.headVersion, expectedRevision: skill.revision });
}

async function cliSwitch(o, on) {
  const clis = o.obt.clis ?? { found: [], programs: [] };
  if (on) for (const c of clis.found.filter((x) => !x.allowed)) await api("clis", { name: c.name });
  else for (const p of clis.programs.filter((x) => clis.found.some((c) => c.name === x.name))) await api("clis/remove", { name: p.name });
}

/* Each switch saves through its own route, then its state is read back from the engine before it is drawn again. */
async function flip(el, redraw) {
  const o = S.ob;
  if (!o?.obt) return;
  const [kind, value, on] = [el.id === "obt-cli" ? "cli" : el.dataset.sw, el.dataset.v, el.checked];
  try {
    if (kind === "obt-skill") await skillSwitch(value, on);
    if (kind === "obt-part") await api("personal/switch", { part: value, mode: on ? "when-needed" : "off" });
    if (kind === "cli") await cliSwitch(o, on);
  } catch (error) { toast(error.message); }
  if (kind === "obt-skill") await refresh().catch((error) => toast(error.message));
  if (kind === "obt-part") o.obt.personal = await api("personal").catch((error) => { toast(error.message); return o.obt.personal; });
  if (kind === "cli") o.obt.clis = await api("clis").catch((error) => { toast(error.message); return o.obt.clis; });
  if (S.ob !== o) return;
  redraw();
  const again = kind === "cli" ? document.getElementById("obt-cli") : [...document.querySelectorAll(`.ob9 [data-sw="${kind}"]`)].find((n) => n.dataset.v === value);
  again?.focus({ preventScroll: true });
}

export function initToolsStep(redraw) {
  markLive(["sw:obt-skill", "sw:obt-part", "sw:obt-cli"]);
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (S.ob && (el.id === "obt-cli" || el.dataset?.sw === "obt-skill" || el.dataset?.sw === "obt-part")) flip(el, redraw);
  });
  /* A dialog opened from this step (a chat app's setup, the connector catalogue) may have connected or added something:
     once the last dialog is gone, the step reads everything again. A wizard moving to its next page replaces its dialog
     in the same moment, so the check waits a turn. */
  new MutationObserver((changes) => {
    const closed = changes.some((c) => [...c.removedNodes].some((n) => n.classList?.contains("scrim")));
    if (!closed) return;
    setTimeout(() => {
      const o = S.ob;
      if (o?.obt && !o.obt.loading && document.querySelector(".ob9 .obt") && !document.querySelector(".scrim")) load(o, redraw);
    }, 0);
  }).observe(app(), { childList: true });
  /* Which kind is open is window state, kept so a redraw leaves it open. */
  document.addEventListener("toggle", (e) => {
    const kind = e.target?.dataset?.kind;
    if (!S.ob?.obt || !kind || !e.target.closest?.(".ob9")) return;
    if (e.target.open) S.ob.obt.open.add(kind);
    else S.ob.obt.open.delete(kind);
  }, true);
}
