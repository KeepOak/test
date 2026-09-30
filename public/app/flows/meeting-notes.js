import { $, esc } from "../core/dom.js";
import { openDlg, closeDlg, closePop, dialog, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { initMeetingGuest } from "./meeting-guest.js";

let frame = null, draft = null, review = null, busy = false;
const button = (act, text) => `<button class="btn pri" type="button" data-act="${act}">${esc(text)}</button>`;
const field = (id, text, value = "", max = 200) => `<label class="fld"><span>${esc(text)}</span><input class="inp" id="${id}" value="${esc(value)}" maxlength="${max}"></label>`;
const value = id => $("#" + id)?.value ?? "";
function draw(body, foot) { frame = openDlg({ title: "Teams transcript notes", body, foot, wide: true }); }
function open() {
  if (busy) return;
  closePop(); draft = null; review = null;
  draw(`<p>Read an existing Teams transcript you can access with a work or school account. Your tenant must allow Graph transcript access and transcription must already exist. This does not join a meeting or start recording. No model receives the text from this form.</p>
    ${field("mn-source", "Microsoft account ID (from Accounts)", "default", 20)}${field("mn-url", "Teams meeting join URL", "", 2000)}`,
  button("mn-fetch", "Approve transcript access and fetch"));
}
function edit() {
  review = null;
  draw(`<p>${esc(draft.title)} — source account ${esc(draft.source.account)}. ${esc(draft.note)}</p>
    <p>${draft.truncated ? "Only the first 6,000 characters are editable here." : ""} Source transcript ID: ${esc(draft.source.transcriptId)}</p>
    <label class="fld"><span>Your notes (edit the transcript excerpt)</span><textarea class="inp" id="mn-notes" rows="12" maxlength="6000">${esc(draft.text)}</textarea></label>
    ${field("mn-google", "Google account ID (from Accounts)", "default", 20)}${field("mn-doc", "Existing Google document ID")}${field("mn-tab", "Existing document tab ID")}
    <p>Google Docs write permission requires separate reconsent in Accounts. Check who can access the destination document before sharing.</p>`,
  button("mn-review", "Review exact Docs export"));
}
async function perform(work) {
  if (busy || dialog() !== frame) return;
  busy = true; const current = frame;
  current.querySelectorAll("button[data-act^=mn-]").forEach(el => { el.disabled = true; });
  try { await work(() => dialog() === current); }
  catch (error) { if (dialog() === current) toast(error.message); }
  finally { busy = false; current.querySelectorAll("button[data-act^=mn-]").forEach(el => { el.disabled = false; }); }
}
export function initMeetingNotes() {
  initMeetingGuest(answer => { draft = answer; edit(); });
  markLive(["meeting-notes", "mn-fetch", "mn-review", "mn-approve", "mn-edit"]);
  on("meeting-notes", open);
  on("mn-fetch", () => perform(async alive => {
    const answer = await api("personal/meeting-notes/prepare", { account: value("mn-source"), joinUrl: value("mn-url"), approveTranscriptAccess: true });
    if (alive()) { draft = answer; edit(); }
  }));
  on("mn-review", () => perform(async alive => {
    draft.text = value("mn-notes");
    const answer = await api("personal/meeting-notes/review", { draft: draft.draft, notes: draft.text, account: value("mn-google"), documentId: value("mn-doc"), tabId: value("mn-tab") });
    if (!alive()) return;
    review = answer;
    draw(`<p>${esc(answer.warning)}</p><p>${esc(answer.title)} — account ${esc(answer.account)}<br>Document ${esc(answer.target.documentId)} / tab ${esc(answer.target.tabId)}<br>Revision ${esc(answer.target.revisionId)}</p>
      <pre>${esc(answer.target.text)}</pre>`, button("mn-edit", "Edit again") + button("mn-approve", "Approve append to document"));
  }));
  on("mn-edit", () => { if (!busy) edit(); });
  on("mn-approve", () => perform(async alive => {
    const ticket = review.ticket; review = null;
    try {
      const answer = await api("personal/meeting-notes/export", { ticket, approve: true });
      if (alive()) { closeDlg(); toast(answer.note); }
    } catch (error) { if (alive()) { edit(); toast(`${error.message} Review again before retrying.`); } }
  }));
}
