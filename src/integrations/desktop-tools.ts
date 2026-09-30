import type { ToolRegistry } from '../registry.js';
import type { DesktopControl } from './desktop.js';
import {
  DesktopClickSchema, DesktopClipboardSchema, DesktopKeySchema, DesktopOpenSchema,
  DesktopReadSchema, DesktopScreenshotSchema, DesktopTypeSchema, DesktopWindowsSchema,
  DesktopMoveSchema, DesktopDragSchema, DesktopScrollSchema, DesktopWaitSchema, DesktopZoomSchema,
  DesktopHoldKeySchema, DesktopButtonSchema, DesktopCursorSchema, DesktopComputerSchema,
} from './desktop-config.js';

/**
 * The screen and keyboard tools.
 *
 * They are registered whether or not the owner has switched them on, and each one checks the
 * switch again when it is called: that way turning the switch off stops work already under way,
 * and the assistant is told plainly why it cannot carry on instead of the tools quietly vanishing.
 *
 * None of these permissions is on the read-only list in `policy.ts`, so under "Ask before changes"
 * every one of them stops and asks the owner first. Looking at the screen counts as a change here
 * on purpose: a photograph of someone's screen is not a free action.
 */
export function registerDesktop(registry: ToolRegistry, desktop: DesktopControl): void {
  registry.onRunFinished((context) => desktop.closeRun(context));
  const bounds = 'Only works while "Allow the assistant to use my screen and keyboard" is on in Settings. Password managers and sign-in windows are always refused, and a notice with a Stop button is on screen throughout.';
  registry.register({
    name: 'desktop.screenshot', permission: 'desktop.view',
    description: `Take a picture of one window (give part of its name) or of a whole screen. The picture is kept beside Branch's own records and shown to the model when it can look at pictures. A whole-screen picture is refused while a password manager is showing. ${bounds}`,
    parameters: DesktopScreenshotSchema,
    target: (input) => input.window ?? `screen ${input.display ?? 1}`,
    execute: (input, context) => desktop.screenshot(input, context),
  });
  registry.register({
    name: 'desktop.windows', reach: 'outbound', permission: 'desktop.view',
    description: `List the windows that are open, or bring one to the front, minimise it, or close it. ${bounds}`,
    parameters: DesktopWindowsSchema,
    target: (input) => input.window ?? 'all windows',
    execute: (input, context) => desktop.windows(input, context),
  });
  registry.register({
    name: 'desktop.read', permission: 'desktop.view',
    description: `List what is in a window — its buttons, boxes and text, by name, each with a ref and its box in window pixels — so you can act on names or refs instead of guessing at pixels. Always read a window before clicking or typing in it. ${bounds}`,
    parameters: DesktopReadSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.read(input, context),
  });
  registry.register({
    name: 'desktop.click', permission: 'desktop.control',
    description: `Click in a window: a part by the name or ref desktop.read gives it, or a point in window pixels (pass the shot of the picture or reading it came from, so a window that moved since is refused instead of clicked in the wrong place). button "right" opens a menu, count 2 is a double-click and 3 a triple-click, and modifiers hold ctrl, shift or alt. A plain click on a named part presses it without moving the pointer. Nothing is clicked where another window covers the spot. ${bounds}`,
    parameters: DesktopClickSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.click(input, context),
  });
  // computer-control: the rest of the pointer, as Anthropic's computer tool and OpenClaw name it, bound by the same switch,
  // approvals, Lockdown, Stop notice and "You're driving" wait as every screen action (DesktopControl.begin).
  registry.register({
    name: 'desktop.move', permission: 'desktop.control',
    description: `Move the pointer onto a part (by name or ref) or a point in a window and rest there (hoverMs), to show a tooltip or open a menu that appears on hover. ${bounds}`,
    parameters: DesktopMoveSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.move(input, context),
  });
  registry.register({
    name: 'desktop.drag', permission: 'desktop.control',
    description: `Drag inside one window: press on one spot (a name, ref or point), glide to another and let go, to move a file, a slider or a selection. Both spots must be inside the window and not covered by another. ${bounds}`,
    parameters: DesktopDragSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.drag(input, context),
  });
  registry.register({
    name: 'desktop.scroll', permission: 'desktop.control',
    description: `Scroll a window up, down, left or right by 1 to 10 steps. Name a list or page (or give its ref) to scroll it without moving the pointer; otherwise the wheel turns over a point, or over the middle of the window. ${bounds}`,
    parameters: DesktopScrollSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.scroll(input, context),
  });
  registry.register({
    name: 'desktop.zoom', permission: 'desktop.view',
    description: `A close-up picture of part of a window (a region in window pixels), enlarged when small, to read small print or find a small target. Points stay window pixels; the answer says how to turn a spot in the close-up back into one. ${bounds}`,
    parameters: DesktopZoomSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.zoom(input, context),
  });
  registry.register({
    name: 'desktop.wait', permission: 'desktop.view',
    description: `Wait 0.1 to 30 seconds for a program to finish loading or animating, touching nothing. Stop ends the wait at once. ${bounds}`,
    parameters: DesktopWaitSchema,
    target: (input) => `${input.seconds} s`,
    execute: (input, context) => desktop.wait(input, context),
  });
  // computer-control: the last of Anthropic's computer actions (hold_key, left_mouse_down/up, cursor_position), and the
  // whole tool in Anthropic's own shape, so a Claude model drives it without translation. Same guards as the rest.
  registry.register({
    name: 'desktop.mouse_down', permission: 'desktop.control',
    description: `Press a mouse button and keep it held, on a part (by name or ref), a point, or where the pointer is, in a window. Let go with desktop.mouse_up; Stop, the task ending, the owner taking over or thirty seconds let go of it too. ${bounds}`,
    parameters: DesktopButtonSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.mouseDown(input, context),
  });
  registry.register({
    name: 'desktop.mouse_up', permission: 'desktop.control',
    description: `Let go of the mouse button this task holds, at a part or point in the same window, or where the pointer is. A spot that is covered or outside the window is not where it lets go: it lets go where it was pressed. ${bounds}`,
    parameters: DesktopButtonSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.mouseUp(input, context),
  });
  registry.register({
    name: 'desktop.hold_key', permission: 'desktop.control',
    description: `Hold a key or chord (such as "shift" or "ctrl+a") down in a window for 0.1 to 10 seconds, then let go; it is let go even if the task is stopped meanwhile. ${bounds}`,
    parameters: DesktopHoldKeySchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.holdKey(input, context),
  });
  registry.register({
    name: 'desktop.cursor', permission: 'desktop.view',
    description: `Where the pointer is: on the screen, and for a named window in its pixels, whether it is inside it and whether that window is on top there. Nothing moves. ${bounds}`,
    parameters: DesktopCursorSchema,
    target: (input) => input.window ?? 'the pointer',
    execute: (input, context) => desktop.cursor(input, context),
  });
  registry.register({
    name: 'desktop.computer', permission: 'desktop.control',
    description: `Anthropic's computer tool, action for action: screenshot, zoom, left_click, right_click, middle_click, double_click, triple_click, left_click_drag, mouse_move, left_mouse_down, left_mouse_up, scroll, type, key, hold_key, wait, cursor_position, with coordinate, start_coordinate, text (keys or held keys), scroll_direction, scroll_amount, duration and region as that tool takes them. Name the window: coordinates are in the pixels of that window's own picture, not the whole screen. Each action is the matching desktop.* tool, with the same checks. ${bounds}`,
    parameters: DesktopComputerSchema,
    target: (input) => input.window ?? input.action,
    execute: (input, context) => desktop.computer(input, context),
  });
  registry.register({
    name: 'desktop.type', permission: 'desktop.control',
    description: `Put text into a box in a window. Saved passwords are never typed, and text that still has a placeholder in it is refused. ${bounds}`,
    parameters: DesktopTypeSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.type(input, context),
  });
  registry.register({
    name: 'desktop.key', permission: 'desktop.control',
    description: `Press one key or key combination in a window, such as "enter" or "ctrl+s", once or up to 20 times (repeat). The window is brought to the front first, and nothing is sent if Windows will not bring it forward. ${bounds}`,
    parameters: DesktopKeySchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.key(input, context),
  });
  registry.register({
    name: 'desktop.open', permission: 'desktop.control',
    description: `Start a program by name, or open a file from the workspace with whatever program usually opens it. A workspace file that is itself a program is refused. ${bounds}`,
    parameters: DesktopOpenSchema,
    target: (input) => input.app ?? input.path ?? '',
    execute: (input, context) => desktop.open(input, context),
  });
  registry.register({
    name: 'desktop.clipboard', permission: 'desktop.clipboard',
    description: `Read what is on the clipboard, or put text on it. Asked about separately from the rest, because the clipboard often holds something private. ${bounds}`,
    parameters: DesktopClipboardSchema,
    target: (input) => input.action,
    execute: (input, context) => desktop.clipboard(input, context),
  });
}
