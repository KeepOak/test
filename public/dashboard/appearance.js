/* The dashboard's own copy of what was public/appearance.js before the old window was removed (#291), served at /dashboard/appearance.js. */
/* Appearance settings: theme, highlight colour, text size, spacing, lettering,
   movement and the acorn, and how much of the window shows (the calm window, or everything, and
   the voice buttons). Every change shows at once; Save keeps it for next time.
   The record matches PreferencesSchema in src/preferences.ts. */
import { t } from "/dashboard/i18n.js";

export const defaultAppearance = {
  appearance: "forest",
  followSystem: false,
  accent: "copper",
  textSize: "medium",
  density: "comfortable",
  font: "geist",
  reduceMotion: false,
  showAcorn: false,
  showEverything: false,
  showVoice: false,
  /* phase2/panels (public/panels-hide.js) */
  seeThrough: 30,
  conversationWidth: "wide",
  hidden: [],
  rightClickHide: false,
};

/* Wave 7: the buttons name their words with a key, so another language covers them too. */
const CHOICES = {
  accent: [["copper"], ["leaf"], ["earth"], ["slate"], ["ink"]],
  textSize: [["small"], ["medium"], ["large"]],
  density: [["comfortable"], ["compact"]],
  font: [["geist"], ["system"]],
};
const GROUPS = {
  accent: "accent-choices",
  textSize: "text-size-choices",
  density: "density-choices",
  font: "font-choices",
};
/* Switches that may sit on any Settings page but belong to this same record. */
const SWITCHES = [["appearance-everything", "showEverything"], ["appearance-voice", "showVoice"]];
const darkQuery = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
const $ = (id) => document.getElementById(id);
let current = { ...defaultAppearance };
let persist = async () => {};

/** The theme actually shown, once "follow this computer" is taken into account. */
export function resolvedTheme(value) {
  if (!value.followSystem) return value.appearance;
  return darkQuery?.matches === false ? "daylight" : "forest";
}

/** Write the whole look onto <html>. tokens.css does the rest. */
export function applyAppearance(value) {
  current = { ...defaultAppearance, ...value };
  const root = document.documentElement.dataset;
  root.theme = resolvedTheme(current);
  root.accent = current.accent;
  root.textSize = current.textSize;
  root.density = current.density;
  root.font = current.font;
  if (current.reduceMotion) root.motion = "reduced";
  else delete root.motion;
  root.acorn = current.showAcorn ? "on" : "off";
  /* The calm window is the default; layout.css hides the rest unless this says "on". */
  root.everything = current.showEverything ? "on" : "off";
  root.voice = current.showVoice ? "on" : "off";
  root.convw = current.conversationWidth; // phase2/panels
  render();
  document.dispatchEvent(new CustomEvent("branch-appearance", { detail: { ...current } })); // phase2/panels
}
/** phase2/panels (and phase2/settings, for the Settings level): a change made from anywhere, saved like one made here. */
export const changeAppearance = (patch) => change(patch);

function render() {
  if (!$("appearance")) return;
  $("appearance").value = current.appearance;
  if ($("appearance-follow")) {
    $("appearance-follow").checked = current.followSystem;
    $("appearance-follow").setAttribute("aria-checked", String(current.followSystem));
  }
  $("appearance").disabled = current.followSystem;
  if ($("appearance-motion")) {
    $("appearance-motion").checked = current.reduceMotion;
    $("appearance-motion").setAttribute("aria-checked", String(current.reduceMotion));
  }
  if ($("appearance-acorn")) {
    $("appearance-acorn").checked = current.showAcorn;
    $("appearance-acorn").setAttribute("aria-checked", String(current.showAcorn));
  }
  for (const [id, key] of SWITCHES) {
    const el = $(id);
    if (el) {
      el.checked = current[key];
      el.setAttribute("aria-checked", String(current[key]));
    }
  }
  for (const [key, id] of Object.entries(GROUPS))
    for (const button of $(id).children)
      button.setAttribute("aria-pressed", String(button.value === current[key]));
}

function choiceButton(key, value) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "choice";
  button.value = value;
  if (key === "accent") {
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.dataset.swatch = value;
    button.append(swatch);
  }
  /* i18n.js writes this word again whenever the language changes. */
  const word = document.createElement("span");
  word.dataset.t = `appearance.${key}.${value}`;
  word.textContent = t(word.dataset.t);
  button.append(word);
  button.addEventListener("click", () => change({ [key]: value }));
  return button;
}

/* Changes are saved one after another, so the last one made is the last one kept. */
let saving = Promise.resolve();
let unsaved = 0;
/** How many changes this window has made, so a look asked for before one of them is known to be older. */
let made = 0;
export const appearanceChanges = () => made;
function change(patch) {
  made += 1;
  applyAppearance({ ...current, ...patch });
  const value = { ...current };
  unsaved += 1;
  saving = saving.then(() => persist(value)).catch(() => {}).finally(() => { unsaved -= 1; });
}

/**
 * The look as saved, from the window's regular refresh. While this window's own changes are still
 * being saved it can only be older than what is on screen: applying it then undid the choices made
 * after it, and the next save sent the undone value back (a lettering choice came back as the
 * default in shell-ui). So it is taken only once nothing here is waiting to be saved.
 */
/* ci-flakes-3: nor when a change was made here after the refresh asked (`since`). Its answer could arrive
   after that change had been saved, and put the look from before it back on screen. */
export function adoptSaved(value, since = made) {
  if (unsaved === 0 && since === made) applyAppearance(value);
}

/** Called once by public/app.js with the way to save a preferences record. */
export function initAppearance(save) {
  persist = save;
  for (const [key, id] of Object.entries(GROUPS))
    $(id).replaceChildren(...CHOICES[key].map(([value]) => choiceButton(key, value)));

  const switches = [
    ["appearance-follow", "followSystem"],
    ["appearance-motion", "reduceMotion"],
    ["appearance-acorn", "showAcorn"],
    ...SWITCHES,
  ];
  for (const [id, key] of switches) {
    const control = $(id);
    if (!control) continue;
    control.classList.add("sw");
    control.setAttribute("role", "switch");
    control.addEventListener("change", () => change({ [key]: control.checked }));
  }

  $("appearance").addEventListener("change", () =>
    change({ appearance: $("appearance").value }),
  );

  darkQuery?.addEventListener("change", () => {
    if (current.followSystem) applyAppearance(current);
  });
  applyAppearance(current);
}

/** What the Save button sends. */
export function currentAppearance() {
  return { ...current };
}
