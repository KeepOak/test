/**
 * The two pictures of a recorded task (public list, bucket 13):
 *
 * - `pathPicture` draws the path the task took — one box per step, in order, coloured by how each
 *   ended, with helpers it sent off drawn to one side — as an SVG that reads its colours from the
 *   page's tokens, so it follows all 44 themes.
 * - `recordingPage` is a whole page the owner can save and open anywhere: the recording, a player
 *   (play, pause, step, speed), and the path picture. It carries its own copy of `public/tokens.css`
 *   because a saved file cannot fetch one, and it can reach nothing: its content rules allow only its
 *   own inline style and script and pictures written into the file.
 */
import type { RecordingFrame, RunRecording } from "./run-recording.js";

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Every status's edge colour, as a token name. Nothing here writes a colour down. */
const edge: Record<RecordingFrame["status"], string> = {
  done: "var(--good)", failed: "var(--bad)", stopped: "var(--warn)", waiting: "var(--warn)",
  working: "var(--copper)", info: "var(--line-strong)",
};
const statusWords: Record<RecordingFrame["status"], string> = {
  done: "done", failed: "failed", stopped: "stopped", waiting: "waiting for you", working: "still going", info: "",
};

export interface PathOptions { maxBoxes?: number; width?: number }

/** The path as SVG. Notes are left out: the picture is about what it did, not what it said. */
export function pathPicture(recording: RunRecording, options: PathOptions = {}): string {
  const width = options.width ?? 360, box = 30, gap = 14, indent = 36;
  const steps = recording.frames.filter((frame) => frame.kind !== "note");
  const shown = steps.slice(0, options.maxBoxes ?? 120);
  const parts: string[] = [];
  shown.forEach((frame, index) => {
    const y = index * (box + gap) + 4, x = frame.kind === "helper" ? indent : 4;
    if (index > 0) parts.push(`<line x1="20" y1="${y - gap}" x2="20" y2="${y}" style="stroke:var(--line-strong)" stroke-width="2"/>`);
    if (frame.kind === "helper") parts.push(`<path d="M20 ${y + box / 2} H${x}" style="stroke:var(--line-strong)" stroke-dasharray="4 3" fill="none"/>`);
    parts.push(boxSvg(frame, x, y, width - x - 4, box, index + 1));
  });
  const more = steps.length - shown.length;
  const height = shown.length * (box + gap) + (more ? 24 : 0) + 4;
  if (more) parts.push(`<text x="4" y="${height - 6}" style="fill:var(--muted)" font-size="12">… and ${more} more steps</text>`);
  const title = `The path this task took: ${steps.length} steps`;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(title)}" viewBox="0 0 ${width} ${Math.max(height, 40)}" style="width:100%;height:auto"><title>${escapeXml(title)}</title>${parts.join("")}</svg>`;
}

function boxSvg(frame: RecordingFrame, x: number, y: number, w: number, h: number, number: number): string {
  const words = `${number}. ${frame.label}${frame.seconds === null ? "" : ` (${frame.seconds}s)`}`;
  const fitted = words.length > Math.floor(w / 7) ? `${words.slice(0, Math.floor(w / 7) - 1)}…` : words;
  const state = statusWords[frame.status];
  return `<g><title>${escapeXml(`${words}${state ? `, ${state}` : ""}`)}</title>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" style="fill:var(--panel-2);stroke:${edge[frame.status]}" stroke-width="2"/>`
    + `<text x="${x + 10}" y="${y + h / 2 + 4}" style="fill:var(--text)" font-size="12">${escapeXml(fitted)}</text></g>`;
}

export interface PageInput {
  recording: RunRecording;
  /** The text of public/tokens.css, carried inside the page. */
  tokensCss: string;
  theme: "forest" | "daylight";
  /** The owner's words for the page's fixed labels, by locale key. */
  t: (key: string) => string;
  /** The language the fixed words are in, for the page's `lang`. */
  language?: string;
}

/** The fixed labels the page uses; each is a key in public/locales. */
export const pageWordKeys = [
  "recording.page.title", "recording.page.purpose", "recording.page.play", "recording.page.pause",
  "recording.page.back", "recording.page.next", "recording.page.speed", "recording.page.path",
  "recording.page.steps", "recording.page.position",
  ...["asked", "model", "step", "picture", "helper", "helpers", "plan", "steered", "checked", "asked-you", "waiting", "finished"]
    .map((name) => `recording.frame.${name}`),
] as const;

/** A frame's label in the page's language: its fixed words from the language file, the task's own words filled in. */
function inPageWords(frame: RecordingFrame, t: (key: string) => string): RecordingFrame {
  if (!frame.words) return frame;
  const words = t(frame.words.key);
  if (words === frame.words.key) return frame;
  const values = frame.words.values ?? {};
  return { ...frame, label: words.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole) };
}

const layoutCss = `
body{margin:0;background:var(--ground);color:var(--text);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:0 0 4px}
.purpose,.subtle{color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button,select{font:inherit;color:var(--text);background:var(--panel-2);border:1px solid var(--line-strong);border-radius:8px;padding:6px 12px}
button.primary{background:var(--copper);color:var(--on-copper);border-color:var(--copper)}
input[type=range]{width:100%}
ol{padding-left:22px;margin:0}
li{padding:4px 6px;border-radius:6px;overflow-wrap:anywhere}
li[aria-current="step"]{background:var(--selected);outline:2px solid var(--accent-ring,var(--line-strong))}
.detail{color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
img{max-width:100%;border-radius:8px;border:1px solid var(--line)}
`;

const script = `
const data = JSON.parse(document.getElementById("recording-data").textContent);
const frames = data.frames, items = [...document.querySelectorAll("#frames li")];
const slider = document.getElementById("position"), now = document.getElementById("now");
const playButton = document.getElementById("play"), speed = document.getElementById("speed");
let index = 0, timer = null;
function show(i) {
  index = Math.max(0, Math.min(frames.length - 1, i));
  items.forEach((item, n) => n === index ? item.setAttribute("aria-current", "step") : item.removeAttribute("aria-current"));
  slider.value = String(index);
  const frame = frames[index];
  now.replaceChildren();
  const head = document.createElement("strong"); head.textContent = frame.label; now.append(head);
  const detail = document.createElement("p"); detail.className = "detail"; detail.textContent = frame.detail; now.append(detail);
  if (frame.picture && frame.picture.data && /^image\\/(png|jpeg|webp|gif)$/.test(frame.picture.mediaType || "")) {
    const img = document.createElement("img"); img.alt = frame.picture.name; img.src = "data:" + frame.picture.mediaType + ";base64," + frame.picture.data; now.append(img);
  }
}
function stop() { clearTimeout(timer); timer = null; playButton.textContent = playButton.dataset.play; }
function tick() {
  if (index >= frames.length - 1) return stop();
  const wait = Math.min(3000, Math.max(150, (frames[index + 1].at - frames[index].at) / Number(speed.value)));
  timer = setTimeout(() => { show(index + 1); tick(); }, wait);
}
playButton.addEventListener("click", () => { if (timer) return stop(); if (index >= frames.length - 1) show(0); playButton.textContent = playButton.dataset.pause; tick(); });
document.getElementById("back").addEventListener("click", () => { stop(); show(index - 1); });
document.getElementById("next").addEventListener("click", () => { stop(); show(index + 1); });
slider.addEventListener("input", () => { stop(); show(Number(slider.value)); });
items.forEach((item, n) => item.addEventListener("click", () => { stop(); show(n); }));
show(0);
`;

/** The saved page. Everything inside it is escaped; the recording travels as JSON a script cannot break out of. */
export function recordingPage(input: PageInput): string {
  const { t } = input;
  const recording = { ...input.recording, frames: input.recording.frames.map((frame) => inPageWords(frame, t)) };
  const esc = (key: string) => escapeXml(t(key));
  const json = JSON.stringify(recording).replace(/</g, "\\u003c");
  const list = recording.frames.map((frame) =>
    `<li>${escapeXml(frame.label)}<span class="detail"> — ${escapeXml(`${(frame.at / 1000).toFixed(1)}s`)}${frame.status === "info" ? "" : `, ${escapeXml(statusWords[frame.status])}`}</span></li>`).join("");
  // Nothing may be fetched, sent, framed or submitted; a stray <base> or <form> would change nothing.
  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  const lang = /^[a-z]{2}$/.test(input.language ?? "") ? input.language! : "en";
  // phase2/everywhere: named Forest, so the Slate first paint tokens.css gives an unnamed page does not apply to a saved file.
  return `<!doctype html><html lang="${lang}" data-palette="forest" data-theme="${input.theme === "daylight" ? "daylight" : "forest"}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc("recording.page.title")}</title>
<style>${input.tokensCss.replace(/<\//g, "<\\/")}${layoutCss}</style></head><body><main>
<h1>${esc("recording.page.title")}</h1>
<p class="purpose">${esc("recording.page.purpose")}</p>
<section class="card"><p><strong>${escapeXml(recording.prompt.slice(0, 400))}</strong></p>
<p class="subtle">${escapeXml(`${recording.status}, ${recording.seconds}s, ${recording.frames.length} steps`)}</p>
<div class="controls"><button type="button" class="primary" id="play" data-play="${esc("recording.page.play")}" data-pause="${esc("recording.page.pause")}">${esc("recording.page.play")}</button>
<button type="button" id="back">${esc("recording.page.back")}</button><button type="button" id="next">${esc("recording.page.next")}</button>
<label for="speed">${esc("recording.page.speed")}</label><select id="speed"><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option><option value="20">20×</option></select></div>
<label for="position">${esc("recording.page.position")}</label><input type="range" id="position" min="0" max="${Math.max(0, recording.frames.length - 1)}" value="0">
<div id="now" aria-live="polite"></div></section>
<section class="card"><h2>${esc("recording.page.steps")}</h2><ol id="frames">${list}</ol></section>
<section class="card"><details><summary>${esc("recording.page.path")}</summary>${pathPicture(recording)}</details></section>
</main><script type="application/json" id="recording-data">${json}</script><script>${script}</script></body></html>`;
}
