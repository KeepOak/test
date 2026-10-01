/* Two things from the conversation's header and menu (design doc 4.3, pass 10 and 15).
   - Open another conversation beside: now a pane of its own, among many (RES-703, chat/panes.js).
   - Who it knows: the Trunks this computer has (GET /api/trunks) and the Trunks on the owner's other computers
     (POST /api/reach/trunks/remote, which only looks). "Connect another agent" opens Customize › Tools at Agents. The
     per-row "may talk to" switches stay greyed: widening whom a Trunk may message is a security-reviewed change, and the
     engine keeps no per-Trunk list for it; the hops note stays greyed because the engine does not say its limit. */

import { $, esc, render } from "../core/dom.js";
import { S } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run, has } from "../core/actions.js";
import { ic, av, mi, openPop, closePop } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { shareMenu } from "../flows/share.js";
import { githubReaderMenu, initGithubReader } from "./github-reader.js";

/* ---------- the conversation's menu ---------- */
/* "Open another conversation beside" pulls one into a pane of its own (chat/panes.js). */
export function chatMenuTop() {
  return mi("beside15", "cols15", t("window.chat.beside.open-another")) + shareMenu() + githubReaderMenu() + mi("roster10", "spark", t("window.chat.beside.who-it-knows")) + "<hr>";
}

/* ---------- who it knows ---------- */
/* The Trunks on the owner's other computers (POST /api/reach/trunks/remote), asked for only while the engine's "Trunks
   on other computers" part is on (GET /api/reach modes, read at most once a minute). While it is off the window asks
   nothing, so there is no refused request and no toast; the @ list (messages.js) reads them here too. */
const REMOTE = { at: 0, on: false };
async function remoteOn() {
  if (Date.now() - REMOTE.at > 60000) {
    const mode = (await api("reach")).modes?.["remote-trunks"];
    REMOTE.on = typeof mode === "string" && mode !== "off";
    REMOTE.at = Date.now();
  }
  return REMOTE.on;
}
/** The other computers and their Trunks, or none while the part is off. */
export async function remoteTrunks() {
  return (await remoteOn()) ? (await api("reach/trunks/remote", {})).computers ?? [] : [];
}

export const rosterButton = () => `<button class="icon-btn" type="button" aria-label="${t("window.chat.beside.roster-label")}" data-tip="${t("window.chat.beside.who-it-knows")}" data-act="roster10h">${ic("users")}</button>`;

async function rosterPop() {
  const [mine, away] = await Promise.all([
    api("trunks").then((r) => ({ trunks: r.trunks ?? [] }), (error) => ({ error })),
    remoteTrunks().then((computers) => ({ computers }), (error) => ({ error })),
  ]);
  const own = (mine.trunks ?? []).find((tr) => tr.chatSessionId && tr.chatSessionId === S.chat);
  const row = (key, name, sub, face) => `<div class="mi" role="menuitem">${face}<span><span class="mi-t">${esc(name)}</span><span class="mi-s">${esc(sub)}</span></span><input type="checkbox" class="sw" data-sw="knows" data-k="${esc(key)}" aria-label="${t("window.chat.beside.may-talk", { who: esc(own?.name ?? "Branch"), name: esc(name) })}"></div>`;
  const here = (mine.trunks ?? []).filter((tr) => !tr.hidden && tr.id !== own?.id).map((tr) => row(tr.id, tr.name, tr.title ?? "", av(tr, 26))).join("")
    + (own ? row("branch", "Branch", "", `<span class="ico-tile">${ic("branch", "s")}</span>`) : "");
  const there = (away.computers ?? []).flatMap((c) => (c.trunks ?? []).map((tr) => row(tr.address ?? tr.handle, tr.name, [c.machine, tr.title].filter(Boolean).join(" · "), av({ name: tr.name }, 26)))).join("");
  const note = (r) => (r.error ? `<p class="hint" data-css="margin:4px 10px">${esc(r.error.message)}</p>` : "");
  return `<div class="ph">${t("window.chat.beside.knows", { name: esc(own?.name ?? "Branch") })}</div>${here}${note(mine)}<div class="ph">${t("window.chat.beside.other-computers")}</div>${there}${note(away)}<hr>${mi("toast", "info", t("window.chat.beside.hops"), "", 'data-why="hops"')}${mi("t9-kind-roster", "plug", t("window.chat.beside.connect-agent"), "", 'data-v="agents"')}`;
}
async function roster(anchor, force) {
  if (!anchor) return;
  openPop(anchor, await rosterPop(), { right: true, force });
}

/* Connect another agent: Customize › Tools at its Agents kind (other assistants over A2A), where one is added. */
function connectAgent() {
  closePop();
  S.view = "customize";
  S.tabs.customize = "tools";
  const kind = document.createElement("button");
  kind.dataset.v = "agents";
  if (has("t9-kind")) run("t9-kind", kind); else render();
}

export function initBeside() {
  initGithubReader();
  markLive(["roster10", "roster10h", "t9-kind-roster"]);
  on("t9-kind-roster", () => connectAgent());
  on("roster10", () => roster($('[data-act="roster10h"]') || $('[data-act="chatmenu"]'), true));
  on("roster10h", (el) => roster(el, false));
}
