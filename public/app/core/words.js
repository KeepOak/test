/* Words that reach a drawing as English, from a table or a row helper's title (a switch's id is made from its title, so
   the title itself must stay English): shown in the language chosen, the locale files' own words for exactly that English
   (public/i18n.js fromEnglish), else as they are. Read at draw time, never when a module loads. */

import { fromEnglish } from "../../i18n.js";

export const say = (english) => (typeof english === "string" && english ? fromEnglish(english) ?? english : english);
