/* The window's language is kept by the engine too (GET/POST /api/look "language", the same setting `branch theme language`
   changes), so a choice made in Settings › Appearance reaches a new browser and the terminal. public/i18n.js keeps this
   browser's copy (localStorage), so the first draw is already in the right words; once the engine's choice is read, it
   wins. "auto" (never chosen here, or "follow the computer" from the terminal) leaves this browser's choice as it is.
   Only a language with a locale file (i18n.js LANGUAGES) can be chosen. */

import { LANGUAGES, language, setLanguage } from "../../i18n.js";
import { api } from "../core/api.js";
import { esc } from "../core/dom.js";

export const canSpeak = (code) => LANGUAGES.some((l) => l.id === code);

/* your-profile: setup's first-step language list, for any page that offers it (each language named in its own words by
   the browser, the one in force chosen). The page listens for its select's change and calls chooseLanguage. */
const ownWords = (code) => { const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code; return name.charAt(0).toLocaleUpperCase(code) + name.slice(1); };
export const languageOptions = () => LANGUAGES.map(({ id }) => `<option value="${esc(id)}"${id === language() ? " selected" : ""}>${esc(ownWords(id))}</option>`).join("");

/* While a choice is being saved, a look read just before it would put the old language back. */
let saving = 0;

/* Settled once the engine's saved language has been read and put on the page (or found to change nothing), so words the
   engine writes for the window (achievements) are asked for in the language the window ends up in, not the first draw's. */
let followed;
export const lookFollowed = new Promise((resolve) => { followed = resolve; });

/* Puts the engine's saved language on the page when it differs. True when the words changed. */
export async function followLook(look) {
  try {
    const want = look?.language;
    if (saving || !canSpeak(want) || want === language()) return false;
    await setLanguage(want);
    return true;
  } finally {
    followed();
  }
}

/* A choice made in Settings › Appearance: saved to the engine (the route changes only the language), then its words
   loaded and put on the page. Returns the engine's look as it now stands. */
export async function chooseLanguage(code) {
  saving += 1;
  try {
    const look = await api("look", { language: code });
    await setLanguage(code);
    return look;
  } finally {
    saving -= 1;
  }
}
