/* Pass 17 part D §2: phone and automatic meeting controls remain unavailable. Explicit guest notes now use
   flows/meeting-guest.js: owner-reviewed Recall join, separate participant consent, live events and approved export.
   The historical transcript form remains alongside it. A phone call
   needs the owner's own Twilio number and account, and a meeting bot needs a service that joins Meet, Teams or Zoom as a
   guest; the guest path requires a separately prepared provider. Both ship off anyway
   (calls cost by the minute and reach people outside Branch; the meeting bot listens to everyone there). Drawn: the
   message box's + menu items, saying "off", and Settings › Voice › Calls and meetings at Advanced, every switch off and
   no choice pressed. None of call17d, meet17d or the cmsw17d switches has a handler, so each greys itself. Every word
   goes through t() (public/locales). */

import { esc } from "../core/dom.js";
import { mi } from "../core/ui.js";
import { ctlSeg } from "../settings/parts.js";
import { t } from "../../i18n.js";

/** The + menu's two items, after the rest. */
export const plus17d = () => "<hr>" + mi("call17d", "call17d", t("window.p17d.phone-call"), t("comfort.choice.off")) + mi("meeting-guest", "meet17d", "Guest meeting notes", "Opt-in Recall.ai join, consent and live notes") + mi("meeting-notes", "meet17d", "Teams transcript notes", "Review an existing transcript and Docs export");

const sw = (v, title, sub) => `<div class="ctl"><b>${esc(title)}</b><input class="sw" type="checkbox" data-sw="cmsw17d" data-v="${v}" data-why="cmsw17d-${v}" aria-label="${esc(title)}"><small>${esc(sub)}</small></div>`;
const k = (name) => t(`window.p17d.${name}`);

/** Settings › Voice, at Advanced. */
export function calls17d() {
  const rows = sw("call", k("phone-calls"), k("phone-calls-hint"))
    + `<div class="ctl"><b>${esc(k("calling-from"))}</b><span class="right"><button class="btn sm" type="button" data-act="call17d">${esc(t("window.places.automations17.set-one-up"))}</button></span><small>${esc(k("calling-from-hint"))}</small></div>`
    + ctlSeg(k("who-may-call"), k("who-may-call-hint"), [t("window.flows.chw.approved"), k("anyone-i-name")], null, "f15-who-it-may-call")
    + ctlSeg(k("recording"), k("recording-hint"), [k("only-if-agree"), t("window.flows.trunk.never")], null, "f15-recording")
    + sw("meet", t("window.places.automations.meeting-notes"), k("meeting-notes-hint"))
    + ctlSeg(k("join-from-calendar"), k("join-from-calendar-hint"), [k("only-when-ask"), k("meetings-invited")], null, "f15-join-from-your-calendar")
    + ctlSeg(k("send-notes"), k("send-notes-hint"), [k("to-me"), k("to-everyone")], null, "f15-send-notes-afterwards");
  return `<div class="sec x15-sec"><h2>${esc(k("calls-meetings"))}</h2><p class="hint">${esc(k("calls-meetings-hint"))}</p>${rows}<button class="btn" type="button" data-act="meeting-guest">Opt-in guest meeting notes</button><button class="btn" type="button" data-act="meeting-notes">Teams transcript notes</button><p class="hint">Guest joins and recording require separate owner grants. Live excerpts can be edited and shared with a further Docs approval.</p></div>`;
}
