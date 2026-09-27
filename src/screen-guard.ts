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
 *   - A task is offered the screen, keyboard, mouse and clipboard tools only when the owner's own words in that
 *     conversation ask for them (`asksForScreen`). Page text, tool results, project instructions, a helper's brief and
 *     anything a chat app, schedule or trigger sent never count. Elsewhere those tools are not listed, not searchable,
 *     not pre-loaded, and a call to one is refused in plain words without asking the owner or touching anything.
 *   - Where they are offered, the first use in a conversation asks the owner, whatever the mode or rules say (Full
 *     access and Auto included); after that yes the usual rules apply there. A yes is never kept "always", so no
 *     later conversation inherits it.
 */

/** The permissions that reach this computer's own screen, keyboard, mouse or clipboard (src/integrations/desktop-tools.ts). */
const screenPermissions: ReadonlySet<string> = new Set(["desktop.view", "desktop.control", "desktop.clipboard"]);

/**
 * Whether a call reaches the owner's screen, keyboard, mouse or clipboard, or a desktop Branch drives on their behalf.
 * `computer.*` works on a page or a window; only the window side is the screen.
 */
export function reachesScreen(tool: string, permission: string, args: unknown): boolean {
  if (screenPermissions.has(permission) || tool.startsWith("desktop.")) return true;
  return tool.startsWith("computer.") && (args as { at?: unknown } | null)?.at === "window";
}

/** Whether a tool is one of the screen tools that are left out of a task the owner did not start for the screen. */
export const screenTool = (tool: string, permission: string): boolean =>
  screenPermissions.has(permission) || tool.startsWith("desktop.");

const screenWords = /\b(screens?|screenshots?|desktop|clipboard|mouse|keyboard)\b|\b(my computer|this computer|my pc|computer use|take over)\b/i;
/** Starting, closing or switching to a program on this computer ("open notepad"), which is the screen too. */
const programWords = /\b(open|launch|start|close|quit|switch to|bring up|minimi[sz]e|maximi[sz]e)\s+(?:the\s+|my\s+|a\s+)?(?:\w+\s+)?(apps?|applications?|programs?|window|notepad|calculator|calc|paint|explorer|finder|terminal|powershell|command prompt|word|excel|outlook|teams|spotify|vs ?code|visual studio code)\b/i;

/** Whether the owner's own words ask for the screen, keyboard, mouse, clipboard or a program on this computer. */
export function asksForScreen(text: string): boolean {
  const words = String(text ?? "");
  return screenWords.test(words) || programWords.test(words);
}

/** What the approval card adds to the label, so the owner knows why a yes is asked for under every mode. */
export const screenHoldReason = "Branch asks before it first looks at or uses your own screen, keyboard, mouse or clipboard in a conversation";

/** The words for "Yes, always" to a screen question. */
export const screenStandingRefusal =
  "A yes to using your screen, keyboard, mouse or clipboard is never kept for good. Answer it just now, or for this conversation.";

/** What the model is told when it calls a screen tool in a task the owner did not start for the screen. */
export const screenWithheldRefusal =
  "This task was not started to use the owner's screen, keyboard, mouse or clipboard, so that tool is not available and "
  + "nothing was done. For a web page use Branch's own browser (browser.* tools, including browser.act to press a key) "
  + "or the web tools. Do not ask the owner to allow screen tools; carry on another way and say what you could not do.";
