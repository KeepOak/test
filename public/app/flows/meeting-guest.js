import { $, esc } from "../core/dom.js";
import { openDlg, closePop, dialog, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

let frame = null, preview = null, busy = false, useDraft;
const val = id => $("#mb-" + id)?.value ?? "";
const yes = id => $("#mb-" + id)?.checked === true;
const field = (id, label, value = "", max = 300) => `<label class="fld"><span>${esc(label)}</span><input class="inp" id="mb-${id}" value="${esc(value)}" maxlength="${max}"></label>`;
const check = (id, label) => `<label class="fld"><input type="checkbox" id="mb-${id}"> ${esc(label)}</label>`;
const button = (action, label, id = "") => `<button class="btn" type="button" data-act="mb-${action}" data-session="${esc(id)}">${esc(label)}</button>`;
function draw(body, foot) { frame = openDlg({ title: "Guest meeting notes · Recall.ai", body, foot, wide: true }); }
function open() {
  if (busy) return;
  closePop(); preview = null;
  draw(`<p>Off until this exact join is approved. Recall.ai joins as a visible guest; platform host admission may be needed. Provider charges and retention apply. No recording starts until you separately attest participant consent.</p>
    <label class="fld"><span>Platform</span><select class="inp" id="mb-platform"><option value="meet">Google Meet</option><option value="teams">Teams</option><option value="zoom">Zoom</option></select></label>
    ${field("url", "Exact meeting URL", "", 2000)}${field("purpose", "Purpose disclosed to participants", "", 300)}${field("minutes", "Maximum recording minutes (1–120)", "30", 3)}
    ${field("region", "Recall account region", "us-west-2", 20)}${field("api", "Existing API key secret reference", "RECALL_API_KEY", 80)}${field("verify", "Existing workspace verification secret reference", "RECALL_VERIFICATION_SECRET", 80)}${field("origin", "Stable public HTTPS callback origin")}
    <p>Provision secrets in the locker yourself. Public webhook routing and Recall dashboard setup are required; this form does not create a tunnel or configure the provider account.</p>
    ${check("enabled", "Opt in to review one guest join")}`,
  button("preview", "Review exact join") + button("refresh", "Existing sessions and live notes"));
}
async function perform(work) {
  if (busy || dialog() !== frame) return;
  busy = true; const current = frame;
  current.querySelectorAll("button[data-act^=mb-]").forEach(el => { el.disabled = true; });
  try { await work(() => dialog() === current); }
  catch (error) { if (dialog() === current) toast(error.message); }
  finally { busy = false; current.querySelectorAll("button[data-act^=mb-]").forEach(el => { el.disabled = false; }); }
}
async function refresh(alive) {
  const answer = await api("personal/meeting-notes/bot/status");
  if (!alive()) return;
  draw(`<p>Status and transcript come from verified provider events, not guesses. Refresh reads local events; no provider polling. If an outcome is unknown, inspect Recall's dashboard before sending another bot.</p>` + answer.sessions.map(s => `<section><h3>${esc(s.plan.purpose)}</h3>
    <p>${esc(s.plan.platform)} — ${esc(s.plan.meetingUrl)}<br>Session ${esc(s.session)}<br>Status: ${esc(s.status)} ${s.lastEventAt ? `(${esc(new Date(s.lastEventAt).toISOString())})` : "— no verified event yet"}</p>
    <pre>${esc(s.text)}</pre>${s.truncated ? "<p>Excerpt capped at 6,000 characters.</p>" : ""}
    ${button("record-preview", "Review participant consent before recording", s.session)}${button("leave", "Leave now", s.session)}${button("draft", "Edit and review notes export", s.session)}</section>`).join(""),
  button("refresh", "Refresh local live notes") + button("new", "New join preview"));
}
function joinActions() {
  on("mb-preview", () => perform(async alive => {
    const answer = await api("personal/meeting-notes/bot/preview", { enabled: yes("enabled"), platform: val("platform"), meetingUrl: val("url"), purpose: val("purpose"), minutes: Number(val("minutes")), region: val("region"), apiSecret: val("api"), verificationSecret: val("verify"), callbackOrigin: val("origin") });
    if (!alive()) return; preview = answer;
    draw(`<pre>${esc(JSON.stringify(answer.plan, null, 2))}</pre><p>${esc(answer.price)}</p><p>${esc(answer.timing)}</p><p>Participant notice: ${esc(answer.notice)}</p>
      <p>Configure the Recall dashboard lifecycle webhook (including bot.in_call_not_recording, bot.in_call_recording, bot.call_ended, bot.done, bot.fatal) at this exact URL, with the same workspace verification secret:</p><pre>${esc(answer.callback)}</pre>
      ${check("configured", "The public callback is reachable and this lifecycle endpoint is configured in Recall")}`,
    button("join", "Approve this guest join and unknown charges") + button("new", "Cancel and edit"));
  }));
  on("mb-join", () => perform(async alive => {
    const ticket = preview.ticket;
    if (!yes("configured")) throw new Error("Configure and confirm the lifecycle callback before joining.");
    preview = null;
    try { await api("personal/meeting-notes/bot/join", { ticket, approveJoinAndUnknownPrice: true, dashboardEndpointConfigured: true }); }
    catch (error) { if (alive()) { await refresh(alive); toast(`${error.message} Inspect the provider dashboard before retrying.`); } return; }
    await refresh(alive);
  }));
}
function recordingActions() {
  on("mb-record-preview", el => {
    if (busy) return;
    draw(`<p>Audio will be transcribed by Recall.ai in English with low latency. No model summary is generated. Confirm the participant notice is visible, everyone currently present has consented, and you will monitor new arrivals. A new participant notice alone is not consent. Press Leave if anyone objects or has not consented.</p>
      ${check("notice", "The notice is visible to participants")}${check("consent", "Everyone present has explicitly consented to this transcription purpose")}${check("monitor", "I will monitor late arrivals and remove the bot if consent is absent")}`,
    button("record", "Approve recording and live transcript", el.dataset.session) + button("leave", "Leave without recording", el.dataset.session));
  });
  on("mb-record", el => perform(async alive => {
    if (!yes("notice") || !yes("consent") || !yes("monitor")) throw new Error("All participant consent confirmations are required.");
    await api("personal/meeting-notes/bot/record", { session: el.dataset.session, noticeVisible: true, allParticipantsConsented: true, monitorLateArrivals: true });
    await refresh(alive);
  }));
}
export function initMeetingGuest(onDraft) {
  useDraft = onDraft;
  markLive(["meeting-guest", ...["new", "preview", "join", "refresh", "record-preview", "record", "leave", "draft"].map(x => "mb-" + x)]);
  on("meeting-guest", open); on("mb-new", open);
  on("mb-refresh", () => perform(refresh)); joinActions(); recordingActions();
  on("mb-leave", el => perform(async alive => { await api("personal/meeting-notes/bot/leave", { session: el.dataset.session }); await refresh(alive); }));
  on("mb-draft", el => perform(async alive => { const answer = await api("personal/meeting-notes/bot/draft", { session: el.dataset.session }); if (alive()) useDraft(answer); }));
}
