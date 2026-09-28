import type { Store } from "../store.js";
import type { Row } from "../terminal-place-data.js";
import type { Words } from "../terminal-words.js";
import { readComfort, saveComfort, statusItems, type ComfortCard, type StatusItem } from "./settings.js";
import { defaultRoom, statusLineText, type StatusFacts } from "./status-line.js";
import { validateNetwork } from "./network.js";
import { inCatalogue, recordedWrite } from "../settings-kit/recorded-write.js"; // Q48

/**
 * R17-S21: the comfort settings as real controls in the terminal view. Each row on a Settings page
 * carries a `/switch <name>` command: Enter moves it to its next choice, and `/switch <name> <value>`
 * sets it outright. The window shows the same records, so a change here is a change there.
 */
type Value = string | number | boolean | null | readonly string[];
interface Control {
  name: string;
  card: ComfortCard;
  field: string;
  page: string;
  key: string;
  english: string;
  choices: readonly Value[];
  /** The value written for a typed word, when the word is not one of the choices' own names. */
  parse?: (word: string) => Value;
  ownerOnly?: boolean;
}
const onOff = [false, true] as const;
const statusChoices: readonly (readonly StatusItem[] | null)[] = [null, ["model", "context", "cost"], [...statusItems]];

export const comfortControls: readonly Control[] = [
  { name: "vim", card: "keys", field: "vim", page: "general", key: "comfort.field.vim", english: "Vim keys in the message box", choices: onOff },
  { name: "statusLine", card: "display", field: "statusLine", page: "appearance", key: "comfort.field.statusLine", english: "Status line", choices: statusChoices,
    parse: (word) => (word === "default" ? null : word.split(",").filter((item) => (statusItems as readonly string[]).includes(item))) },
  { name: "timestamps", card: "display", field: "timestamps", page: "appearance", key: "comfort.field.timestamps", english: "A time on every message", choices: onOff },
  { name: "notify", card: "notify", field: "method", page: "notifications", key: "comfort.field.method", english: "How Branch gets your attention", choices: ["system", "window"] },
  { name: "sound", card: "notify", field: "sound", page: "notifications", key: "comfort.field.sound", english: "Sound", choices: ["off", "chime", "knock"] },
  { name: "maxRecording", card: "voice", field: "maxRecordingSeconds", page: "voice", key: "comfort.field.maxRecordingSeconds", english: "Longest recording, in seconds", choices: [null, 30, 60, 120],
    parse: (word) => (word === "off" ? null : Number(word)) },
  { name: "confirmBrowser", card: "browser", field: "confirmSensitive", page: "computer", key: "comfort.field.confirmSensitive", english: "Ask before the browser types, presses or sends files", choices: onOff, ownerOnly: true },
  { name: "blockUploads", card: "browser", field: "blockUploads", page: "computer", key: "comfort.field.blockUploads", english: "Never send files to websites", choices: onOff, ownerOnly: true },
  { name: "dialogs", card: "browser", field: "dialogs", page: "computer", key: "comfort.field.dialogs", english: "A website's message boxes", choices: ["dismiss", "accept"], ownerOnly: true },
  { name: "askNewSites", card: "browser", field: "askNewSites", page: "computer", key: "comfort.field.askNewSites", english: "Ask before a site it hasn't visited", choices: onOff, ownerOnly: true },
  { name: "openFullSize", card: "browser", field: "openFullSize", page: "computer", key: "comfort.field.openFullSize", english: "Open the browser full size when a task starts", choices: onOff, ownerOnly: true },
  { name: "numberMarks", card: "browser", field: "numberMarks", page: "computer", key: "comfort.field.numberMarks", english: "Number the clickable things", choices: onOff, ownerOnly: true },
  { name: "recordBrowser", card: "browser", field: "recordTasks", page: "computer", key: "comfort.field.recordTasks", english: "Record browser tasks", choices: onOff, ownerOnly: true },
  { name: "downloadsFrom", card: "browser", field: "downloadsFrom", page: "permissions", key: "comfort.field.downloadsFrom", english: "Downloads may come from", choices: ["anywhere", "known", "ask"], ownerOnly: true },
  { name: "proxy", card: "network", field: "proxy", page: "computer", key: "comfort.field.proxy", english: "Proxy", choices: [null],
    parse: (word) => (word === "off" ? null : word), ownerOnly: true },
  { name: "gitignore", card: "files", field: "respectGitignore", page: "general", key: "comfort.field.respectGitignore", english: "Searches skip what .gitignore lists", choices: [true, false] },
  { name: "mcpTimeout", card: "mcp", field: "startupTimeoutSeconds", page: "advanced", key: "comfort.field.startupTimeoutSeconds", english: "Seconds a tool server may take to start", choices: [10, 30, 60, 120],
    parse: (word) => Number(word) },
  { name: "autoUpdate", card: "notify", field: "autoUpdate", page: "about", key: "comfort.field.autoUpdate", english: "Updates", choices: ["off", "check", "install"], ownerOnly: true },
];

const same = (a: Value, b: Value): boolean => JSON.stringify(a) === JSON.stringify(b);
const valueOf = (store: Pick<Store, "get">, owner: string, control: Control): Value =>
  (readComfort(store, owner, control.card) as Record<string, Value>)[control.field] ?? null;

function words(value: Value, say: Words): string {
  if (value === null) return say.t("comfort.terminal.asAlways", "as always");
  if (value === true) return say.t("terminal.state.on", "on");
  if (value === false) return say.t("terminal.state.off", "off");
  if (Array.isArray(value)) return value.map((item) => say.t(`comfort.status.item.${item}`, item)).join(", ");
  return typeof value === "string" ? say.t(`comfort.choice.${value}`, value) : String(value);
}

/** The rows a Settings page adds for these settings. */
export function comfortRows(store: Pick<Store, "get">, owner: string, say: Words, page: string): Row[] {
  return comfortControls.filter((control) => control.page === page).map((control) => {
    const value = valueOf(store, owner, control);
    const detail = control.name === "proxy"
      ? say.t("comfort.terminal.proxyDetail", "/switch proxy http://host:port, or /switch proxy off")
      : say.t("comfort.terminal.cycle", "Enter moves to the next choice.");
    return { title: `${say.t(control.key, control.english)}: ${words(value, say)}`, detail, command: `/switch ${control.name}` };
  });
}

/**
 * Carries out `/switch <name> [value]` for one of these settings. Returns what to say, or null when
 * the name is not one of them (the terminal's own switches handle it then).
 */
export function switchComfort(store: Store, owner: string, name: string, word: string, say: Words,
  applied?: (card: ComfortCard) => void): string | null {
  const control = comfortControls.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!control) return null;
  if (control.ownerOnly) store.profiles.requireOwner(say.t(control.key, control.english));
  const current = valueOf(store, owner, control);
  let next: Value;
  if (word) {
    const named = control.choices.find((choice) => words(choice, say) === word || String(choice) === word);
    next = named !== undefined ? named : control.parse ? control.parse(word) : word;
  } else {
    const at = control.choices.findIndex((choice) => same(choice, current));
    next = control.choices[(at + 1) % control.choices.length] ?? null;
  }
  if (control.card === "network") validateNetwork({ ...readComfort(store, owner, "network"), [control.field]: next } as never);
  // Q48: a switch typed in the terminal is written down like one moved in the window.
  recordedWrite(store, owner, { writer: "owner-by-command", source: "command", detail: `/switch ${control.name}` },
    inCatalogue(`comfort-${control.card}`), () => saveComfort(store, owner, control.card, { [control.field]: next }));
  applied?.(control.card);
  return `${say.t(control.key, control.english)}: ${words(valueOf(store, owner, control), say)}`;
}

/** The terminal's status line under the owner's choice, or null to keep it as it has always been. */
export function terminalStatus(store: Pick<Store, "get">, owner: string, facts: Omit<StatusFacts, "room" | "now">, say: Words, dot: string): string | null {
  const items = readComfort(store, owner, "display").statusLine;
  return statusLineText(items, { ...facts, room: defaultRoom, now: new Date() }, say, dot);
}
