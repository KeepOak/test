/* Pass 17e art, 1:1 with the prototype's ("pass 17e: new art" in design/redesign/prototype.html): the six picture pets
   (Appearance › The pet), the characters a Trunk can wear (its Look tab) and the feature pictures that fill any
   element marked data-art17="<id>" (data-art17-still="1" asks for the still).
   A loop plays muted; its still shows instead when motion is reduced (the engine's reduceMotion preference or the
   computer's own setting) and where see-through video can't be shown (Safari). Stills load lazily; loops preload nothing.
   The window redraws its regions with innerHTML, so a picture is drawn as a placeholder that is filled once the draw
   lands, with the node the last draw used: a loop keeps playing through a redraw instead of starting again. */

import { esc } from "./dom.js";
import { E } from "./state.js";

/* The prototype's key → [what it shows, file without its extension, still only]. */
export const ART17 = {
  "art17-cloud": ["A cloud computer at work", "/art/cloud"],
  "art17-call": ["A phone call in progress", "/art/call"],
  "art17-meeting": ["Joining a meeting", "/art/meeting"],
  "art17-learn": ["Learning an app", "/art/learn"],
  "art17-timeline": ["A timeline replaying", "/art/timeline"],
  "art17-branch-call": ["Branch on a call", "/art/branch-call", true],
  "art17-branch-workbook": ["Branch reading a workbook", "/art/branch-workbook", true],
};

/* Pets: a still and a walk loop each. The engine keeps which one (src/achievements.ts petKinds). */
export const PETS17 = [["redpanda", "Red panda"], ["pangolin", "Pangolin"], ["quokka", "Quokka"], ["acornling", "Acorn sprite"], ["goatkid", "Goat kid"], ["piglet", "Teacup piglet"]]
  .map(([id, name]) => ({ id, name, still: `/art/pets/${id}.webp`, walk: `/art/pets/${id}-walk.webm` }));
export const pet17 = (id) => PETS17.find((p) => p.id === id);

/* Characters: the engine's catalogue (GET /api/trunks characters, read from public/art/agents/manifest-*.json and Branch's
   own art, src/trunks/characters.ts), in the prototype's LOOKS order. Each has a still and a loop per state it acts out;
   a state it has no loop for falls back to idle. The engine keeps which one a Trunk wears (src/trunks/record.ts character). */
export const looks17 = () => (Array.isArray(E.characters) ? E.characters : []);
export const look17 = (id) => (id ? looks17().find((l) => l.id === id) : undefined);
/* The prototype marks only pass 17's own characters New (markNew17: the ids of its LOOKS17). */
export const NEW17 = new Set(["sorrel", "skein", "nib"]);

const NOALPHA = (() => { const u = navigator.userAgent || ""; return /iPhone|iPad|iPod/.test(u) || (/Safari\//.test(u) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(u)); })();
const REDUCE = matchMedia("(prefers-reduced-motion: reduce)");
export const calm17 = () => !!E.state?.preferences?.reduceMotion || REDUCE.matches || NOALPHA;

/* A still and its loop, as a placeholder; cls goes on the picture itself. */
export const media17 = (still, loop, cls = "") => `<span class="m17" data-m17="${esc(still)}" data-m17-loop="${esc(loop ?? "")}" data-m17-cls="${esc(cls)}"></span>`;
/* A character in a state: its loop, or the still when motion is reduced. */
export const figure17 = (look, st, cls = "") => media17(look.still, look.states[st] ?? look.states.idle, `fig12 ${cls}`.trim());
/* A feature picture's slot, as the prototype marks it. */
export const art17Slot = (id, still = false, cls = "") => `<span class="${esc(cls)}" data-art17="${esc(id)}"${still ? ' data-art17-still="1"' : ""}></span>`;

function picture(still, loop, cls) {
  if (!loop) return Object.assign(document.createElement("img"), { className: cls, loading: "lazy", src: still, alt: "", draggable: false });
  const v = document.createElement("video");
  Object.assign(v, { className: cls, preload: "none", muted: true, defaultMuted: true, loop: true, autoplay: true, playsInline: true, poster: still });
  v.setAttribute("aria-hidden", "true");
  v.src = loop;
  return v;
}

/* Nodes kept by what they show, so the next draw puts the same one back. */
const pool = new Map();
function kept(key, make) {
  const list = pool.get(key) ?? [];
  let node = list.find((n) => !n.isConnected);
  if (!node) { node = make(); list.push(node); pool.set(key, list); }
  return node;
}
function put(slot, node) {
  slot.replaceChildren(node);
  const v = node.tagName === "VIDEO" ? node : node.querySelector("video");
  if (v?.paused) v.play().catch((error) => console.warn(error.message)); // moved nodes pause; the loop carries on
}

function fillMedia(slot) {
  const still = slot.dataset.m17, loop = calm17() ? "" : slot.dataset.m17Loop, cls = slot.dataset.m17Cls ?? "";
  const want = loop || still, have = slot.firstElementChild;
  if (have?.dataset.src17 === want) return;
  put(slot, kept(`${cls}|${want}`, () => { const n = picture(still, loop, cls); n.dataset.src17 = want; return n; }));
}
function fillArt(slot) {
  const a = ART17[slot.dataset.art17];
  if (!a) return;
  const [label, file, stillOnly] = a, move = !slot.dataset.art17Still && !stillOnly && !calm17(), m = move ? "v" : "i", have = slot.firstElementChild;
  slot.classList.add("slot17e");
  if (have?.dataset.art17Id === slot.dataset.art17 && have.dataset.m === m) return;
  put(slot, kept(`${slot.dataset.art17}|${m}`, () => {
    const box = Object.assign(document.createElement("span"), { className: "art17e", title: label });
    Object.assign(box.dataset, { art17Id: slot.dataset.art17, m });
    box.setAttribute("aria-hidden", "true");
    box.append(picture(file + ".webp", move ? file + ".webm" : "", ""));
    return box;
  }));
}
/* Fill every placeholder that is empty or shows the wrong kind (a loop where motion is now reduced, or the reverse). */
export function fill17(root = document) {
  root.querySelectorAll("[data-m17]").forEach(fillMedia);
  root.querySelectorAll("[data-art17]").forEach(fillArt);
}

/* Hovering a still in a gallery plays its loop, as the prototype's pickers do. */
function hoverLoop(e) {
  const img = e.target.closest?.("img[data-hov]");
  if (!img || !img.dataset.hov || calm17() || img.dataset.playing) return;
  img.dataset.playing = "1";
  const v = picture(img.src, img.dataset.hov, img.className + " hov12");
  img.hidden = true;
  img.after(v);
  (img.closest("button") ?? img.parentElement).addEventListener("pointerleave", () => { v.remove(); img.hidden = false; delete img.dataset.playing; }, { once: true });
}

/* Regions, dialogs and panels all draw outside one place, so any drawn placeholder is filled as it lands. */
new MutationObserver(() => fill17()).observe(document.body, { childList: true, subtree: true });
REDUCE.addEventListener?.("change", () => fill17());
document.addEventListener("pointerover", hoverLoop);
