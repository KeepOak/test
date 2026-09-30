import { controlRow, linkRow, segmentedRow, switchRow } from "./row-kit.js";
/* Row builders for the prototype's round-15 settings rows (prototype.html sw15, btn15, code15, num15), 1:1 in markup.
   A switch is checked only from a value the engine gave (on is computed by the caller); a button carries the action
   named by the caller, so one with no route stays greyed ("soon"). A button or a row of choices carries data-why (the
   caller's key, else the title's id15), the key of the reason it stays greyed when it does (core/why.js). */
import { esc } from "../core/dom.js";
import { say } from "../core/words.js";

/** The prototype's switch id: "f15-" and the title, lowercased, every run of other characters a dash, at most 40. */
export const id15 = (title) => "f15-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

export const sw15 = (title, sub, on = false) => switchRow({title: say(title), description: say(sub), id: id15(title), checked: on});

export const btn15 = (title, sub, label, act = "soon", why = "") => linkRow({title, description: sub, label, action: act, attributes: `data-why="${esc(why || id15(title))}"`});

export const code15 = (title, sub, code) =>
  `${controlRow(`<b>${esc(title)}</b><span class="right"><code class="code15">${esc(code)}</code></span><small>${esc(sub)}</small>`)}`;

/** A segmented control: opts are [value, label]; cur is the engine's value (none pressed when unknown). */
export const seg15 = (title, sub, opts, cur, act = "seg", why = "") => segmentedRow({title, description: sub, options: opts, current: cur, action: act, attributes: () => `data-why="${esc(why || id15(title))}"`});

export const sec15 = (title, body) => `<div class="sec x15-sec"><h2>${esc(title)}</h2>${body}</div>`;
