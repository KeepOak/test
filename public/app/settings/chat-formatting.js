import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { S, ownerHere, activeId } from "../core/state.js";

let formats = {};
/* A late answer is kept, drawn or its error shown only for the newest read, by the same owner on the same page, with the
   window unlocked: nothing lands behind the lock or for another person. */
let reading = 0;
function fence() {
  const mine = ++reading, profile = activeId(), view = S.view;
  return () => mine === reading && ownerHere() && activeId() === profile && S.view === view
    && !document.getElementById("app")?.classList.contains("locked-b17");
}
export async function loadFormats() {
  const still = fence();
  try { const read = (await api("channels/formatting")).formats ?? {}; if (still()) formats = read; }
  catch (error) { if (still()) toast(error.message); }
}
export function formatButtons(id, nativeLabel) {
  const mode = formats[id] ?? "native";
  return [["native", nativeLabel], ["plain", t("window.p17d.plain-text")]].map(([value, label]) =>
    `<button type="button" data-act="chfmt17d" data-id="${esc(id)}" data-v="${value}" aria-pressed="${mode === value}">${esc(label)}</button>`).join("");
}
export function initFormatting() {
  markLive(["chfmt17d"]);
  on("chfmt17d", async (el) => {
    const still = fence();
    try {
      const saved = (await api("channels/formatting", { channel: el.dataset.id, mode: el.dataset.v })).formats;
      if (!still()) return;
      formats = saved;
      for (const button of el.parentElement.querySelectorAll("[data-act=chfmt17d]"))
        button.setAttribute("aria-pressed", String(button.dataset.v === formats[el.dataset.id]));
      render();
    } catch (error) { if (still()) toast(error.message); }
  });
}
