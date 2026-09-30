import { S, E, activeId, ownName, ownerHere, refresh } from "../core/state.js";
import { esc, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, toast } from "../core/ui.js";
import { attachedChips, sessionAttachmentTray, pickFiles, readyUploads, filesSent, hasFiles } from "./attach.js";
import { dictating, dictRow, micButton } from "./dictate.js";
import { routeFor } from "./rooms.js";
import { requestRows } from "./furniture.js";

let focus = null, scope = "", epoch = 0, pending = false, questions = [], questionRead = false;
let pair = "";
const approving = new Set();
const principal = () => JSON.stringify([activeId(), E.profiles?.isOwner ?? null]);
const draftKey = sid => `beside:${principal()}:${sid}`;
const unlocked = () => S.signedIn && !document.getElementById("app")?.classList.contains("locked-b17");
export function focusedBeside() {
  if (scope !== principal()) { scope = principal(); focus = null; questions = []; epoch++; }
  const selected = JSON.stringify([S.chat, S.beside15]);
  if (pair !== selected) { pair = selected; focus = null; questions = []; epoch++; }
  return unlocked() && S.view === "chat" && innerWidth >= 1000 && focus === S.beside15 && focus !== S.chat ? focus : null;
}
const current = (sid, generation, who) => unlocked() && principal() === who && generation === epoch && focusedBeside() === sid;
const busyRun = sid => (E.state?.runs ?? []).find(run => run.sessionId === sid && ["running", "queued", "waiting", "needs_input"].includes(run.status));
function choose(side) {
  if (dictating() || pending) { toast("Finish dictation or the pending send before changing the composer recipient."); return; }
  pair = JSON.stringify([S.chat, S.beside15]);
  focus = side ? S.beside15 : null; scope = principal(); epoch++; questions = [];
  renderNow(); document.getElementById(side ? "beside-prompt" : "prompt")?.focus();
}
export function paneComposeBar() {
  if (!S.beside15 || S.beside15 === S.chat || innerWidth < 1000) return "";
  const side = focusedBeside();
  return `<div class="pane-compose-bar" role="group" aria-label="Composer recipient"><button class="btn sm" type="button" data-act="beside-focus" data-side="main" aria-pressed="${!side}">Write to main conversation</button><button class="btn sm" type="button" data-act="beside-focus" data-side="beside" aria-pressed="${!!side}">Write to ${esc(ownName(S.beside15) || "conversation beside")}</button></div>`;
}
async function readQuestions(sid) {
  if (questionRead) return;
  questionRead = true; const generation = epoch, who = principal();
  try {
    const got = await api("policy", undefined, undefined, AbortSignal.timeout(5000));
    if (current(sid, generation, who)) { questions = (got.waiting ?? []).filter(q => q.sessionId === sid); renderNow(); }
  } catch { if (current(sid, generation, who)) questions = []; }
  finally { questionRead = false; }
}
function approvalCards(sid) {
  return questions.filter(q => q.sessionId === sid).map(q => `<section class="card ask"><b>${esc(q.question || q.label)}</b>${q.question && q.label ? `<p>${esc(q.label)}</p>` : ""}${q.bytes ? `<dl class="kv">${requestRows(q.bytes)}</dl>` : ""}${(q.jobs ?? []).map(j => `<p>${esc(j.name ?? "")} ${esc(j.job)}</p>`).join("")}<div class="acts"><button class="btn pri" type="button" data-act="beside-approve" data-sid="${esc(sid)}" data-fp="${esc(q.fingerprint ?? "")}" data-choice="allow">Allow this request</button><button class="btn" type="button" data-act="beside-approve" data-sid="${esc(sid)}" data-fp="${esc(q.fingerprint ?? "")}" data-choice="deny">Deny</button></div></section>`).join("");
}
export function besideComposer() {
  const sid = focusedBeside(); if (!sid) return null;
  const tray = sessionAttachmentTray(sid), words = S.drafts[draftKey(sid)] ?? "", run = busyRun(sid);
  return `<div class="dock" data-composer-tray="${esc(tray)}">${approvalCards(sid)}<p>Writing to ${esc(ownName(sid) || "conversation beside")}</p><div id="beside-attached" data-attachment-tray="${esc(tray)}">${attachedChips(tray)}</div><form class="composer" id="beside-composer"><button class="c-btn" type="button" data-act="beside-attach" aria-label="Attach files to this conversation">${ic("clip")}</button>${dictating() ? dictRow() : ""}<textarea id="beside-prompt" data-compose-session="${esc(sid)}" data-draft-key="${esc(draftKey(sid))}" rows="1" aria-label="Message to conversation beside"${dictating() ? " hidden" : ""}>${esc(words)}</textarea>${dictating() ? "" : `${micButton()}<button class="c-btn" type="button" data-act="voice" aria-label="Talk live in this conversation">${ic("wave")}</button>`}${!words.trim() && run ? `<button class="c-btn" type="button" data-act="beside-stop" data-sid="${esc(sid)}" data-run="${esc(run.id)}" aria-label="Stop this conversation's task">${ic("stop")}</button>` : `<button class="c-btn send" type="submit" aria-label="Send to this conversation"${pending ? " disabled" : ""}>${ic("up")}</button>`}</form></div>`;
}
async function validate(sid, generation, who) {
  const snapshot = await api(`sessions/${encodeURIComponent(sid)}`, undefined, undefined, AbortSignal.timeout(5000));
  if (!current(sid, generation, who)) throw new Error("The composer recipient or profile changed. Nothing further was sent.");
  return snapshot;
}
export async function sendBeside(words) {
  const sid = focusedBeside(); if (!sid || pending) return;
  const tray = sessionAttachmentTray(sid), prompt = (words ?? document.getElementById("beside-prompt")?.value ?? "").trim();
  if (!prompt && !hasFiles(tray)) return;
  if (prompt.startsWith("/")) { toast("Open this conversation fully to use slash commands. Your draft is kept here."); return; }
  const generation = epoch, who = principal(); pending = true;
  const key = draftKey(sid), originalDraft = S.drafts[key] ?? prompt;
  S.drafts[key] = ""; renderNow();
  let sent = false;
  try {
    await validate(sid, generation, who);
    const info = ((ownerHere() && E.trunkModes?.trunks !== "off") || E.rooms.some(room => room.sessionId === sid))
      ? await api(`trunks/conversations/${encodeURIComponent(sid)}`) : null;
    await validate(sid, generation, who);
    if (info?.kind === "member") throw new Error("A helper's conversation is view only.");
    const running = busyRun(sid);
    if (running && ["running", "queued"].includes(running.status)) {
      if (!prompt) throw new Error("Files stay with this conversation until its next message.");
      await api("flows-boards/busy/send", { sessionId: sid, prompt }); sent = true;
    } else {
      const uploads = await readyUploads(tray); await validate(sid, generation, who);
      if (uploads.length && (info?.kind === "room" || /(^|\s)@/.test(prompt))) throw new Error("Keep these files here and open this conversation fully to send attachments with a room or mention route.");
      const sendPlain = async text => {
        await validate(sid, generation, who);
        await api("run", { sessionId: sid, prompt: text, ...(uploads.length ? { uploads } : {}) });
        sent = true; filesSent(tray);
      };
      const hooks = { sendPlain, open: async id => { if (id !== sid) throw new Error("Open the mentioned conversation fully before routing there."); },
        after: async () => { await validate(sid, generation, who); }, followRoom: async () => { sent = true; }, mark: () => null, readAloud: () => {} };
      const route = routeFor(prompt, sid, info, hooks);
      if (route) { await route(); sent = true; } else await sendPlain(prompt);
    }
  } catch (error) { if (!sent && principal() === who && !S.drafts[key]) S.drafts[key] = originalDraft; toast(error.message); }
  finally { pending = false; if (current(sid, generation, who)) { await refresh().catch(() => {}); readQuestions(sid); renderNow(); } }
}
async function stop(el) {
  const sid = focusedBeside(), generation = epoch, who = principal();
  if (sid !== el.dataset.sid) return;
  await validate(sid, generation, who);
  const state = await api("state");
  if (!current(sid, generation, who) || !(state.runs ?? []).some(run => run.sessionId === sid && run.id === el.dataset.run && ["running", "queued", "waiting", "needs_input"].includes(run.status))) throw new Error("This conversation's task changed. Review it again.");
  await api(`runs/${encodeURIComponent(el.dataset.run)}/cancel`, {}); await refresh(); renderNow();
}
async function approve(el) {
  const sid = focusedBeside(), generation = epoch, who = principal(), fingerprint = el.dataset.fp;
  if (sid !== el.dataset.sid || !/^[a-f0-9]{32}$/.test(fingerprint) || approving.has(fingerprint)) return;
  approving.add(fingerprint); el.disabled = true;
  try {
  await validate(sid, generation, who);
  const got = await api("policy");
  if (!current(sid, generation, who) || !(got.waiting ?? []).some(q => q.sessionId === sid && q.fingerprint === fingerprint)) return;
  await api("policy/approve", { sessionId: sid, fingerprint, decision: el.dataset.choice, remember: "never", carryOn: true });
  if (current(sid, generation, who)) { await refresh(); readQuestions(sid); renderNow(); }
  } finally { approving.delete(fingerprint); el.disabled = false; }
}
export function stopFocusedBeside() {
  const button = document.querySelector('[data-act="beside-stop"]');
  if (button) return stop(button).catch(error => toast(error.message));
}
on("beside-focus", el => choose(el.dataset.side === "beside"));
on("beside-attach", () => { const sid = focusedBeside(); if (sid) pickFiles(false, sessionAttachmentTray(sid)); });
on("beside-stop", el => stop(el).catch(error => toast(error.message)));
on("beside-approve", el => approve(el).catch(error => { el.disabled = false; toast(error.message); }));
markLive(["beside-focus", "beside-attach", "beside-stop", "beside-approve", "sw:beside-prompt"]);
document.addEventListener("input", event => { if (event.target.id === "beside-prompt" && focusedBeside()) S.drafts[draftKey(focusedBeside())] = event.target.value; });
document.addEventListener("submit", event => { if (event.target.id === "beside-composer") { event.preventDefault(); sendBeside(); } });
document.addEventListener("keydown", event => { if (event.target.id === "beside-prompt" && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendBeside(); } });
setInterval(() => { const sid = focusedBeside(); if (sid && !document.hidden) readQuestions(sid); }, 3000);
