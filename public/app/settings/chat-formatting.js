import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let formats = {};
export async function loadFormats() {
  try { formats = (await api("channels/formatting")).formats ?? {}; }
  catch (error) { toast(error.message); }
}
export function formatButtons(id, nativeLabel) {
  const mode = formats[id] ?? "native";
  return [["native", nativeLabel], ["plain", t("window.p17d.plain-text")]].map(([value, label]) =>
    `<button type="button" data-act="chfmt17d" data-id="${esc(id)}" data-v="${value}" aria-pressed="${mode === value}">${esc(label)}</button>`).join("");
}
export function initFormatting() {
  markLive(["chfmt17d"]);
  on("chfmt17d", async (el) => {
    try {
      formats = (await api("channels/formatting", { channel: el.dataset.id, mode: el.dataset.v })).formats;
      for (const button of el.parentElement.querySelectorAll("[data-act=chfmt17d]"))
        button.setAttribute("aria-pressed", String(button.dataset.v === formats[el.dataset.id]));
      render();
    } catch (error) { toast(error.message); }
  });
}
