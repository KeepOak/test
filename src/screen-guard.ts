/**
 * Dogfood D4 (qa/DOGFOOD-0005): a read-only web research task reached for the owner's own desktop. It asked to press
 * Escape through the desktop tools, and a picture of the owner's screen landed in the Library. Two things let it:
 *
 *   1. With the screen switch on, every screen tool travelled in full with every task (`switchedToolTiers` pre-loads a
 *      switched-on feature's tools), so a research task on a cookie wall had "press a key" right in front of it.
 *   2. Under Full access (and Auto) nothing asked before looking at the screen: only `desktop.shared.*` asked by default.
 *
 * The rule now, enforced in the engine:
 *
 *   - A task is offered the screen, keyboard, mouse and clipboard tools only when the owner's own words ask for them:
 *     the task's own and the owner's message before it (`asksForScreen`). Page text, tool results, project
 *     instructions, a helper's brief, an engine-framed prompt and anything a chat app, schedule or trigger sent never
 *     count. Elsewhere those tools are not listed, not searchable, not pre-loaded, and a call to one is refused in
 *     plain words without asking the owner or touching anything.
 *   - Where they are offered, the first screen use of each task asks the owner, whatever the mode or rules say (Full
 *     access and Auto included); after that yes the usual rules apply for the rest of that task. A program a Trunk
 *     opened before after a yes (unhold-control's record) stands in for the yes to opening it again. A yes is never
 *     kept "always", and "just now" never reaches a later task.
 */

/** The permissions that reach this computer's own screen, keyboard, mouse or clipboard (src/integrations/desktop-tools.ts). */
const screenPermissions: ReadonlySet<string> = new Set(["desktop.view", "desktop.control", "desktop.clipboard"]);

/**
 * Whether a call reaches the owner's screen, keyboard, mouse or clipboard, or a desktop Branch drives on their behalf.
 * `computer.*` works on a page or a window; only the window side is the screen.
 */
export function reachesScreen(tool: string, permission: string, args: unknown, declared = false): boolean {
  if (declared || screenPermissions.has(permission) || tool.startsWith("desktop.")) return true;
  return tool.startsWith("computer.") && (args as { at?: unknown } | null)?.at === "window";
}

/** Whether a tool is one of the screen tools that are left out of a task the owner did not start for the screen. */
export const screenTool = (tool: string, permission: string, declared = false): boolean =>
  declared || screenPermissions.has(permission) || tool.startsWith("desktop.");

const screenWords = /\b(screens?|screenshots?|desktop|clipboard|mouse|keyboard)\b|\b(my computer|this computer|my pc|computer use|take over)\b/i;
/** Starting, closing or switching to a program on this computer ("open notepad"), which is the screen too. */
const programWords = /\b(open|launch|start|close|quit|switch to|bring up|minimi[sz]e|maximi[sz]e)\s+(?:the\s+|my\s+|a\s+)?(?:\w+\s+)?(apps?|applications?|programs?|window|notepad|calculator|calc|paint|explorer|finder|terminal|powershell|command prompt|word|excel|powerpoint|outlook|teams|spotify|vs ?code|visual studio code|chrome|firefox|edge|safari|slack|discord|zoom|telegram|whatsapp|signal|obsidian|notion|steam|vlc|photoshop|task manager|control panel|system settings|file manager)\b/i;

/** Whether the owner's own words ask for the screen, keyboard, mouse, clipboard or a program on this computer. */
export function asksForScreen(text: string): boolean {
  const words = String(text ?? "");
  return screenWords.test(words) || programWords.test(words);
}

/** What the approval card adds to the label, so the owner knows why a yes is asked for under every mode. */
export const screenHoldReason = "Branch asks before it first looks at or uses your own screen, keyboard, mouse or clipboard for a task";

/** The words for "Yes, always" to a screen question. */
export const screenStandingRefusal =
  "A yes to using your screen, keyboard, mouse or clipboard is never kept for good. Answer it just now, or for this conversation.";

/** What the model is told when it calls a screen tool in a task the owner did not start for the screen. */
export const screenWithheldRefusal =
  "This task was not started to use the owner's screen, keyboard, mouse or clipboard, so that tool is not available and "
  + "nothing was done. For a web page use Branch's own browser (browser.* tools, including browser.act to press a key) "
  + "or the web tools. Do not ask the owner to allow screen tools; carry on another way and say what you could not do.";

/**
 * Dogfood follow-up: a tool from outside (an MCP server, a plugin, a program lending tools) that reaches the owner's
 * own screen, keyboard, mouse or clipboard, whatever it is called, so it gets the same guard as desktop.*. Read from
 * what the tool says about itself: a declared category, its MCP annotations' title, its name, its description and its
 * inputs. Only ever stricter: a tool wrongly taken for a screen tool is offered only when the owner asks for the screen.
 * Tools that drive a browser of their own (a page, a tab, Playwright) are not the owner's screen, unless their inputs
 * are computer-use actions: a name never exempts those.
 */
export interface ToolSelfDescription {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  /** A category the tool declares for itself ("computer-use", "screen", "desktop"). */
  category?: string | undefined;
}
const words = (text: string): string[] =>
  text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const screenCategories = /^(computer[-_ ]?use|screen|desktop|gui|input[-_ ]?control|remote[-_ ]?desktop)$/i;
/** Name words that on their own mean the screen. */
const strongNames = new Set(["screenshot", "screenshots", "screencap", "screen", "desktop", "mouse", "cursor", "clipboard",
  "keyboard", "keypress", "hotkey", "hotkeys", "computer"]);
/** Name words that mean the screen when the description says so too. */
const weakNames = new Set(["click", "type", "key", "keys", "scroll", "drag", "zoom", "focus", "window", "windows", "app",
  "apps", "application", "launch", "press", "tap", "swipe", "ui", "ocr", "capture"]);
/** Name words for a tool that works in a browser of its own, which is not the owner's screen. */
const browserNames = new Set(["browser", "page", "tab", "tabs", "playwright", "puppeteer", "web", "url", "navigate", "dom", "html"]);
const screenNouns = /\b(screen|desktop|mouse|keyboard|clipboard|display|cursor|(?:app(?:lication)?|native) windows?|the user'?s computer|this computer)\b/i;
const screenVerbs = /\b(click|press|type|keystroke|capture|screenshot|move the (?:mouse|cursor)|control|scroll|drag)\w*/i;
/** Inputs that are the actions of a computer-use tool. */
const screenInputs = /"(left_click|right_click|double_click|middle_click|mouse_move|left_click_drag|screenshot|key_press|cursor_position|type_text)"/;

export function describesScreen(tool: ToolSelfDescription): boolean {
  if (tool.category && screenCategories.test(tool.category.trim())) return true;
  // What a tool can be asked to do comes first: a name never exempts inputs that are computer-use actions.
  let inputs = "";
  try { inputs = JSON.stringify(tool.inputSchema ?? {}).slice(0, 20_000); } catch { /* unreadable inputs say nothing */ }
  if (screenInputs.test(inputs)) return true;
  // "screen name" (a social account's handle) is not the screen.
  const named = words(`${tool.name} ${tool.title ?? ""}`).filter((word, at, all) => !(word === "screen" && all[at + 1] === "name"));
  // A browser word in the name only helps classify what is otherwise unknown.
  if (named.some((word) => browserNames.has(word))) return false;
  const described = String(tool.description ?? "");
  if (named.some((word) => strongNames.has(word))) return true;
  if (named.some((word) => weakNames.has(word)) && screenNouns.test(described)) return true;
  return screenNouns.test(described) && screenVerbs.test(described) && !/\b(browser|web ?page|tab)\b/i.test(described);
}
