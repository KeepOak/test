import { z } from "zod";

/**
 * A key combination written the way people say it: "Ctrl+K", "Ctrl+Shift+K", "F8". Empty means none.
 * "Ctrl" is the computer's main key: Command on a Mac, Control elsewhere. On a Mac the Control key
 * itself is "Control", so Control+B and Command+B are two different combinations there.
 * Kept apart from comfort/settings.ts so the desktop app's main process reads the keys without the settings' code.
 */
export const keyCombo = z.string().max(40).regex(
  /^$|^((Ctrl|Control|Alt|Shift)\+){1,4}([A-Z0-9,./;]|Space|Enter|Tab|F([1-9]|1[0-2]))$|^F([1-9]|1[0-2])$/,
  "Write a key as Ctrl+K, Alt+Shift+P or F8",
);
/** The window's shortcuts that can be changed, with the keys they have always had. */
export const shortcutDefaults = {
  palette: "Ctrl+K",
  newConversation: "Ctrl+N",
  appearance: "Ctrl+,",
  sidePane: "Ctrl+Shift+K",
  sideList: "Ctrl+B",
  newTrunk: "",
  focusPrompt: "",
  stopTask: "Ctrl+Shift+S",
  searchHistory: "",
  lookInside: "",
  /** Pass 17: the small ask box from any app. The desktop app registers it system-wide; ⌥ Space on a Mac. */
  quickAsk: "Ctrl+Shift+Space",
  /** The redesigned window's own (prototype KEYS15): focus mode, Talk live, the Inbox, the next conversation. */
  focusMode: "Ctrl+.",
  talkLive: "Ctrl+Shift+V",
  openInbox: "Ctrl+I",
  nextConversation: "Ctrl+Tab",
} as const;
