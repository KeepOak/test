/* Row builders for the prototype's round-15 settings rows (prototype.html sw15, btn15, code15, num15), 1:1 in markup.
   A switch is checked only from a value the engine gave (on is computed by the caller); a button carries the action
   named by the caller, so one with no route stays greyed ("soon"). A button or a row of choices carries data-why (the
   caller's key, else the title's id15), the key of the reason it stays greyed when it does (core/why.js). */
import { esc } from "../core/dom.js";
import { say } from "../core/words.js";
import { reason } from "../core/why.js";

/** The prototype's switch id: "f15-" and the title, lowercased, every run of other characters a dash, at most 40. */
export const id15 = (title) => "f15-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

/** A row about how Branch always works, not a setting ("Real or greyed, never fake"): its title and the sentence kept as
    window.why.<key>, and no control. `value` is what the engine says it is now, shown as words on the right (how it
    listens), when there is one. */
export const fact15 = (title, key, value = "") =>
  `<div class="ctl fact15" data-fact="${esc(key)}"><b>${esc(say(title))}</b>${value ? `<span class="right"><span class="fact15-v">${esc(value)}</span></span>` : ""}<small>${esc(reason(key))}</small></div>`;

export const sw15 = (title, sub, on = false) =>
  `<div class="ctl"><b>${esc(say(title))}</b><input class="sw" type="checkbox" id="${id15(title)}" ${on ? "checked" : ""} aria-label="${esc(say(title))}" data-sw="set"><small>${esc(say(sub))}</small></div>`;

export const btn15 = (title, sub, label, act = "soon", why = "") =>
  `<div class="ctl"><b>${esc(title)}</b><span class="right"><button class="btn sm" type="button" data-act="${esc(act)}" data-why="${esc(why || id15(title))}">${esc(label)}</button></span><small>${esc(sub)}</small></div>`;

export const code15 = (title, sub, code) =>
  `<div class="ctl"><b>${esc(title)}</b><span class="right"><code class="code15">${esc(code)}</code></span><small>${esc(sub)}</small></div>`;

/** A segmented control: opts are [value, label]; cur is the engine's value (none pressed when unknown). */
export const seg15 = (title, sub, opts, cur, act = "seg", why = "") =>
  `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(([v, l]) => `<button type="button" aria-pressed="${cur === v}" data-act="${esc(act)}" data-v="${esc(v)}" data-why="${esc(why || id15(title))}">${esc(l)}</button>`).join("")}</span></span><small>${esc(sub)}</small></div>`;

export const sec15 = (title, body) => `<div class="sec x15-sec"><h2>${esc(title)}</h2>${body}</div>`;
