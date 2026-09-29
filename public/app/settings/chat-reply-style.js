/* Settings › Chat apps › Replies in each app: per app, whether Branch's messages quote yours and whether it reacts to
   your message while it works. The values are the engine's (GET/POST /api/channels/reply-style, src/channels/reply-style.ts). */
import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let styles = {};
const styleOf = (id) => ({ quote: "auto", react: true, ...styles[id] });
export async function loadReplyStyles() {
  try { styles = (await api("channels/reply-style")).styles ?? {}; }
  catch (error) { toast(error.message); }
}
const seg = (act, id, label, pairs, current) =>
  `<span class="seg" role="group" aria-label="${esc(label)}">${pairs.map(([value, words]) =>
    `<button type="button" data-act="${act}" data-id="${esc(id)}" data-v="${esc(value)}" aria-pressed="${current === value}">${esc(words)}</button>`).join("")}</span>`;
/** One app's rows: quoting (only where its replies can quote; elsewhere a reply keeps its thread), then the reaction. */
export function replyStyleRows(id, name, quotes = true) {
  const style = styleOf(id);
  const quote = seg("chquote", id, t("window.chat-reply.quote-in", { name }), [["auto", t("window.chat-reply.auto")], ["first", t("window.chat-reply.first")],
    ["all", t("window.chat-reply.all")], ["off", t("window.chat-reply.never")]], style.quote);
  const react = seg("chreact", id, t("window.chat-reply.react-in", { name }), [["on", t("accounts.switch.on")], ["off", t("accounts.switch.off")]], style.react ? "on" : "off");
  return (quotes ? `<div class="ctl"><b>${esc(t("window.chat-reply.quote-in", { name }))}</b><span class="right">${quote}</span><small>${esc(t("window.chat-reply.quote-hint"))}</small></div>` : "")
    + `<div class="ctl"><b>${esc(t("window.chat-reply.react-in", { name }))}</b><span class="right">${react}</span><small>${esc(t("window.chat-reply.react-hint"))}</small></div>`;
}
async function save(change) {
  try { styles = (await api("channels/reply-style", change)).styles ?? styles; }
  catch (error) { toast(error.message); }
  render();
}
export function initReplyStyle() {
  markLive(["chquote", "chreact"]);
  on("chquote", (el) => save({ channel: el.dataset.id, quote: el.dataset.v }));
  on("chreact", (el) => save({ channel: el.dataset.id, react: el.dataset.v === "on" }));
}
