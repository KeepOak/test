/* A message's More (…) button (pass 17, patch17c POPS.more17c): one small way in to what each message offers beyond its
   own row. Each area adds its item with addMoreItem((message) => html | ""), so the button is registered here once:
   Branch from here (chat/branches.js), Leave out of context (chat/leaveout.js), and whatever else a message offers. */

import { esc } from "../core/dom.js";
import { on } from "../core/actions.js";
import { ic, openPop } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const items = [];
let messages = () => [];

/* item(message) gives the menu row for that message, or "" when it has none. */
export function addMoreItem(item) { items.push(item); }

/* The button for one message, placed by chat/messages.js in the message's action row. */
export const moreButton = (m) => (m.messageId ? `<button type="button" aria-label="${t("window.chat.more.label")}" aria-haspopup="menu" data-act="more17c" data-mid="${esc(m.messageId)}">${ic("more")}</button>` : "");

function openMore(el) {
  const m = messages().find((x) => String(x.messageId) === el.dataset.mid);
  if (!m) return;
  const html = items.map((item) => item(m)).join("");
  if (html) openPop(el, html, { right: true });
}

export function initMore(context) {
  messages = () => context.state().messages ?? [];
  markLive(["more17c"]);
  on("more17c", (el) => openMore(el));
}
