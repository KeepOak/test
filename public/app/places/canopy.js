/* Canopy in Overview: the engine's live Trunks, helpers, computers, boards and tasks. Controls use the task's and
   Trunk's existing routes; drafts stay in the window while the live view changes. Nothing starts a task here. */
import { esc, renderNow } from "../core/dom.js";
import { E, S, ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { av, toast } from "../core/ui.js";
import { t } from "../../i18n.js";
import { chooseOrchardBoard } from "./orchard.js";

const C = { view: null, problem: "", editing: null, drafts: {}, busy: new Set() };
const taskOf = (id) => C.view?.tasks.find((task) => task.id === id);
const trunkOf = (id) => E.trunks.find((trunk) => trunk.id === id);
const button = (action, key, id) => `<button type="button" class="btn sm" data-act="cn-${action}" data-id="${esc(id)}"${C.busy.has(id) ? " disabled" : ""}>${t(key)}</button>`;

function taskRow(task) {
  const trunk = trunkOf(task.trunkId), parent = taskOf(task.parentRunId);
  const computer = C.view.computers.find((item) => item.id === task.computer);
  const identity = [trunk?.name, parent?.title, computer?.name || (computer?.here ? t("window.places.canopy.this-computer") : ""), task.card?.title].filter(Boolean);
  const state = task.paused ? t("window.chat.live.paused") : task.status === "needs_input" ? t("place.inbox.needs") : task.step?.label || "";
  const controls = `${task.status === "running" ? button("steer", "window.chat.hf.steer", task.id) + button("pause", "autonomy.pause", task.id) : ""}${task.paused ? button("resume", "autonomy.resume", task.id) : ""}${button("stop", "dashboard.stop", task.id)}`;
  const draft = C.editing === task.id ? `<div class="cn-steer"><input class="inp" id="cn-draft" maxlength="2000" data-id="${esc(task.id)}" value="${esc(C.drafts[task.id] ?? "")}" aria-label="${esc(t("window.chat.steer.what"))}">${button("send", "composer.send", task.id)}</div>` : "";
  return `<li class="cn-task" data-cn-task="${esc(task.id)}">${trunk ? av(trunk, 28) : ""}<div class="grow"><button class="link" type="button" data-act="chat" data-id="${esc(task.sessionId)}">${esc(task.title)}</button><small>${identity.map(esc).join(" · ")}</small><p>${esc(state)}${task.asks ? ` · ${esc(t("window.places.canopy.questions", { count: task.asks }))}` : ""}</p><div class="acts">${controls}</div>${draft}</div></li>`;
}

export function canopyTile() {
  if (!ownerHere()) return "";
  const head = `<h2>${t("window.places.canopy.title")}</h2>`;
  if (!C.view) return C.problem ? `<section class="tile cn">${head}<p>${esc(C.problem)}</p></section>` : "";
  const trunks = C.view.trunks.map((trunk) => `<li data-cn-trunk="${esc(trunk.id)}"><span class="grow">${esc(trunk.name)} · ${trunk.tasks.length}</span>${button(trunk.paused ? "trunk-resume" : "trunk-pause", trunk.paused ? "autonomy.resume" : "autonomy.pause", trunk.id)}</li>`).join("");
  const computers = C.view.computers.map((computer) => `<li><span class="dot ${computer.connected ? "" : "bad"}"></span><span>${esc(computer.name || (computer.here ? t("window.places.canopy.this-computer") : ""))} · ${computer.tasks.length}</span></li>`).join("");
  const boards = C.view.boards.map((board) => `<li><button type="button" class="link" data-act="cn-board" data-id="${esc(board.id)}">${esc(board.name)}</button><small>${Object.entries(board.counts).map(([lane, count]) => `${t(`window.places.orchard.lane.${lane}`)} ${count}`).join(" · ")}</small></li>`).join("");
  const section = (key, rows) => `<div><h3>${t(key)}</h3><ul class="cn-list">${rows}</ul></div>`;
  return `<section class="tile cn">${head}${C.problem ? `<p>${esc(C.problem)}</p>` : ""}<ul class="cn-tasks">${C.view.tasks.map(taskRow).join("") || `<li>${t("ov.now.none")}</li>`}</ul><div class="cn-cols">${section("trunks.title", trunks)}${section("window.places.canopy.computers", computers)}${section("window.places.orchard.boards", boards)}</div></section>`;
}

export async function loadCanopy() {
  if (!ownerHere()) { C.view = null; C.problem = ""; return false; }
  let view = C.view, problem = "";
  try { view = await api("canopy"); } catch (error) { problem = error.message; }
  const changed = JSON.stringify(view) !== JSON.stringify(C.view) || problem !== C.problem;
  C.view = view; C.problem = problem;
  return changed;
}

async function change(id, path, body = {}) {
  if (C.busy.has(id)) return false;
  C.busy.add(id);
  let done = false;
  try { await api(path, body); done = true; } catch (error) { toast(error.message); }
  C.busy.delete(id);
  await loadCanopy(); renderNow();
  return done;
}

export function initCanopy() {
  markLive(["cn-steer", "cn-send", "cn-pause", "cn-resume", "cn-stop", "cn-trunk-pause", "cn-trunk-resume", "cn-board", "sw:cn-draft"]);
  on("cn-steer", (el) => { C.editing = el.dataset.id; renderNow(); document.getElementById("cn-draft")?.focus(); });
  on("cn-send", async (el) => {
    const id = el.dataset.id, text = (C.drafts[id] ?? "").trim();
    if (!text) { document.getElementById("cn-draft")?.focus(); return; }
    if (await change(id, `runs/${encodeURIComponent(id)}/steer`, { text })) { delete C.drafts[id]; C.editing = null; renderNow(); }
  });
  on("cn-pause", (el) => change(el.dataset.id, `runs/${encodeURIComponent(el.dataset.id)}/pause`));
  on("cn-resume", (el) => change(el.dataset.id, `runs/${encodeURIComponent(el.dataset.id)}/resume`));
  on("cn-stop", (el) => change(el.dataset.id, `runs/${encodeURIComponent(el.dataset.id)}/cancel`));
  on("cn-trunk-pause", (el) => change(el.dataset.id, `trunks/${encodeURIComponent(el.dataset.id)}/pause`));
  on("cn-trunk-resume", (el) => change(el.dataset.id, `trunks/${encodeURIComponent(el.dataset.id)}/resume`));
  on("cn-board", (el) => { chooseOrchardBoard(el.dataset.id); S.view = "automations"; S.tabs.automations = "board"; renderNow(); });
  document.addEventListener("input", (event) => { if (event.target.id === "cn-draft") C.drafts[event.target.dataset.id] = event.target.value; });
}
