/* Pass 17 part D §8 on a chat app's own page (the setup's Manage view), 1:1 with the prototype's patch17d.js: its status
   from the engine's health (GET /api/channels), and, while Telegram refuses its bot token, "Paste a new token", which
   opens the setup at Paste (revfix17d, handled in flows/chat.js) with the note saying what happened. Seeing edited
   messages, albums, online status in the app and per-app formatting are not in the engine yet, so they stay greyed.
   Every word goes through t() (public/locales); the engine's own reason is shown as the engine wrote it. */

import { esc } from "../core/dom.js";
import { t } from "../../i18n.js";

/** Each app's own formatting: a format's own name, or the words for it. */
const FORMATS = { telegram: () => "MarkdownV2", slack: () => "Slack mrkdwn", discord: () => "Markdown", matrix: () => "HTML",
  whatsapp: () => t("window.p17d.whatsapp-styles"), signal: () => t("window.p17d.signal-styles") };
export const nativeFormat = (id) => FORMATS[id]?.() ?? t("window.p17d.own-styles");
export const pill17d = (cls, text) => `<span class="pill ${cls}"><i></i>${esc(text)}</span>`;
/** The engine's health as the prototype draws it: [pill class, word, line]. */
export const stateOf = (health) => (health?.state === "needs attention" ? ["no", t("window.shell.machines.offline"), health.reason ?? ""] : ["ok", t("strip.status.online"), ""]);

export function manage17d(c, health) {
  const [cls, word, line] = stateOf(health);
  const row = (title, sub) => `<label class="chx-r17d"><input type="checkbox" class="sw" data-sw="chx17d" aria-label="${esc(title)}"><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></label>`;
  return `<div class="chx17d"><div class="chx-h17d">${pill17d(cls, word)}<small>${esc(line)}</small></div>
    ${row(t("window.p17d.sees-edited"), t("window.p17d.sees-edited-hint"))}${row(t("window.p17d.albums"), t("window.p17d.albums-hint"))}${row(t("window.p17d.online-status-in", { name: c.name }), t("window.p17d.online-status-hint"))}
    <div class="chx-f17d"><b>${esc(t("window.p17d.formatting"))}</b><span class="seg">${[nativeFormat(c.id), t("window.p17d.plain-text")].map((o) => `<button type="button" data-act="chfmt17d" data-id="${esc(c.id)}" data-v="${esc(o)}" aria-pressed="false">${esc(o)}</button>`).join("")}</span></div>
    ${cls === "no" ? `<div class="acts"><button class="btn pri sm" type="button" data-act="revfix17d">${esc(t("window.p17d.paste-a-new-token"))}</button></div>` : ""}</div>`;
}

/** The note at Paste while a refused token is being replaced. */
export const fixNote17d = () => `<div class="status chfix17d"><span class="sdot bad"></span><div><b>${esc(t("window.p17d.old-token"))}</b><p>${esc(t("window.p17d.old-token-hint"))}</p></div></div>`;
