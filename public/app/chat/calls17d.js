/* Pass 17 part D §2: phone calls and meeting notes, 1:1 with the prototype's patch17d.js and all greyed. A phone call
   needs the owner's own Twilio number and account, and a meeting bot needs a service that joins Meet, Teams or Zoom as a
   guest; Branch has neither, so no call, meeting, live view or result card can happen. Both would ship off anyway
   (calls cost by the minute and reach people outside Branch; the meeting bot listens to everyone there). Drawn: the
   message box's + menu items, saying "off", and Settings › Voice › Calls and meetings at Advanced, every switch off and
   no choice pressed. None of call17d, meet17d or the cmsw17d switches has a handler, so each greys itself. Every word
   goes through t() (public/locales). */

import { esc } from "../core/dom.js";
import { mi } from "../core/ui.js";
import { ctlSeg } from "../settings/parts.js";
import { t } from "../../i18n.js";

/** The + menu's two items, after the rest. */
export const plus17d = () => "<hr>" + mi("call17d", "call17d", t("window.p17d.phone-call"), t("comfort.choice.off")) + mi("meet17d", "meet17d", t("window.p17d.join-meeting"), t("comfort.choice.off"));

const sw = (v, title, sub) => `<div class="ctl"><b>${esc(title)}</b><input class="sw" type="checkbox" data-sw="cmsw17d" data-v="${v}" aria-label="${esc(title)}"><small>${esc(sub)}</small></div>`;
const k = (name) => t(`window.p17d.${name}`);

/** Settings › Voice, at Advanced. */
export function calls17d() {
  const rows = sw("call", k("phone-calls"), k("phone-calls-hint"))
    + `<div class="ctl"><b>${esc(k("calling-from"))}</b><span class="right"><button class="btn sm" type="button" data-act="call17d">${esc(t("window.places.automations17.set-one-up"))}</button></span><small>${esc(k("calling-from-hint"))}</small></div>`
    + ctlSeg(k("who-may-call"), k("who-may-call-hint"), [t("window.flows.chw.approved"), k("anyone-i-name")], null)
    + ctlSeg(k("recording"), k("recording-hint"), [k("only-if-agree"), t("window.flows.trunk.never")], null)
    + sw("meet", t("window.places.automations.meeting-notes"), k("meeting-notes-hint"))
    + ctlSeg(k("join-from-calendar"), k("join-from-calendar-hint"), [k("only-when-ask"), k("meetings-invited")], null)
    + ctlSeg(k("send-notes"), k("send-notes-hint"), [k("to-me"), k("to-everyone")], null);
  return `<div class="sec x15-sec"><h2>${esc(k("calls-meetings"))}</h2><p class="hint">${esc(k("calls-meetings-hint"))}</p>${rows}</div>`;
}
