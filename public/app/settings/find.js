/* Settings search over every row, not only page names (UI-091). The index is read from the pages' own drawings: each page
   is drawn at Regular, Advanced and Technical (and Models at each of its tabs) into a detached template, and every
   settings row it draws becomes an entry with its title, note, card, page, tab, the least "How much to show" that shows
   it, and the other words people use for it. So a row another page adds is found without a list kept by hand, in the
   window's own language, and only with what the engine has told the window (a row waiting on the engine is found once
   the engine has answered). Drawing is kept side-effect free: the level is put back afterwards, nothing is saved or
   redrawn, and nothing is asked of the engine. */
import { S } from "../core/state.js";
import { withoutModePolicy } from "../core/interface-mode.js";

/* The rows a person can change or read as a setting: a titled row, a ticked row, and an operating-system permission row.
   A list of the person's own things (projects, accounts, snapshots) is data, not a setting, so it is never indexed. */
export const ROWS = ".ctl, label.prow, .prow.perm16";
const titleOf = (row) => (row.querySelector(":scope > b") ?? row.querySelector(":scope > .grow > b"))?.textContent.trim() ?? "";
const noteOf = (row) => (row.querySelector(":scope > small") ?? row.querySelector(":scope > .grow > small"))?.textContent.trim() ?? "";
const cardOf = (row) => row.closest(".sec")?.querySelector(":scope > h2")?.textContent.trim() ?? "";
/** A drawn row's identity on its page: its card and its title. */
export const rowKey = (row) => `${cardOf(row)}\u001f${titleOf(row)}`;

/* Other words for the same thing, each group read as one: a row whose title or card has one of a group's words is found
   by any of them. English only; every language finds a row by its own words. */
const SYNONYMS = [
  ["theme", "dark mode", "light mode", "night mode", "skin", "colours", "colors"],
  ["background", "wallpaper", "scene"],
  ["pet", "animal", "companion"],
  ["notification", "alert", "notify", "ping"],
  ["sound", "audio", "volume"],
  ["password", "sign-in", "sign in", "login", "log in", "credential"],
  ["key", "token", "secret", "api key"],
  ["start", "startup", "boot", "launch", "autostart"],
  ["language", "locale", "translation"],
  ["text size", "font", "zoom"],
  ["model", "llm", "ai", "gpt", "claude"],
  ["voice", "speech", "microphone", "mic", "talk", "dictation"],
  ["update", "upgrade", "version", "release"],
  ["shortcut", "hotkey", "keybinding", "keyboard"],
  ["cost", "spend", "money", "price", "budget"],
  ["backup", "restore", "snapshot", "export"],
  ["permission", "access", "allow", "approval", "ask first"],
  ["chat app", "telegram", "whatsapp", "discord", "slack", "signal"],
  ["trunk", "agent", "assistant", "bot"],
  ["delete", "remove", "erase", "forget"],
  ["memory", "remember", "recall"],
  ["awake", "sleep", "idle"],
  ["time zone", "timezone", "clock"],
  ["privacy", "tracking", "telemetry"],
  ["browser", "web", "website"],
  ["gateway", "background", "keep running"],
];
export const fold = (text) => String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/* A word counts from where a word starts ("start" finds "starts", but "ai" is not found inside "again"). */
const starts = (hay, w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay);
const synonymsOf = (words) => {
  const hay = fold(words);
  return SYNONYMS.filter((group) => group.some((w) => starts(hay, w))).flat().filter((w) => !starts(hay, w));
};

/* A drawing read once: the same HTML gives the same rows, so a redraw with nothing new costs only the drawing. */
const read = new Map();
function rowsIn(html) {
  let rows = read.get(html);
  if (rows) return rows;
  if (read.size > 600) read.clear();
  const box = document.createElement("template");
  box.innerHTML = html;
  rows = [...box.content.querySelectorAll(ROWS)].map((row) => ({ title: titleOf(row), note: noteOf(row), card: cardOf(row) }))
    .filter((row) => row.title);
  read.set(html, rows);
  return rows;
}

const LEVEL_NAMES = ["regular", "advanced", "technical"];
/**
 * Every row of every page. `pages` is [{ id, name, least, draw, tabs }]: `least` the least level the page itself shows at,
 * `tabs` (optional) [{ id, name, draw }] when the page draws one tab at a time.
 */
export function buildIndex(pages) { return withoutModePolicy(() => indexPreferences(pages)); }
function indexPreferences(pages) {
  const found = new Map(), was = S.level;
  try {
    for (const [lv, name] of LEVEL_NAMES.entries()) {
      S.level = name;
      for (const page of pages) {
        if (lv < page.least) continue;
        for (const tab of page.tabs ?? [{ id: "", name: "", draw: page.draw }]) {
          let html = "";
          try { html = tab.draw() ?? ""; } catch { continue; } // a page not yet able to draw has nothing to find yet
          for (const row of rowsIn(html)) {
            const key = [page.id, row.card, row.title].join("\u001f"), seen = found.get(key);
            if (seen) { seen.tabs.set(tab.id, tab.name); continue; }
            found.set(key, { ...row, page: page.id, pageName: page.name, tabs: new Map([[tab.id, tab.name]]), every: (page.tabs ?? [0]).length, level: lv,
              synonyms: synonymsOf(`${row.title} ${row.card}`) });
          }
        }
      }
    }
  } finally { S.level = was; }
  /* A row every tab draws (a page's Advanced cards under its tabs) needs no tab; any other opens the first tab drawing it. */
  return [...found.values()].map(({ tabs, every, ...row }) => {
    const [[tab, tabName]] = tabs;
    return tabs.size === every && every > 1 ? { ...row, tab: "", tabName: "" } : { ...row, tab, tabName };
  });
}

/** The rows matching every word typed, best first: the title before the card before the note, then the least level. */
export function search(index, text, limit = Infinity) {
  const q = fold(text).trim(), words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const [order, row] of index.entries()) {
    const title = fold(row.title), hay = `${title} ${fold(row.card)} ${fold(row.pageName)} ${fold(row.tabName)} ${fold(row.note)} ${row.synonyms.join(" ")}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const rank = title.startsWith(q) ? 0 : title.includes(q) ? 1 : words.every((w) => title.includes(w)) ? 2 : fold(row.card).includes(q) ? 3 : 4;
    scored.push({ row, rank, order });
  }
  return scored.sort((a, b) => a.rank - b.rank || a.row.level - b.row.level || a.order - b.order).slice(0, limit).map((s) => s.row);
}
