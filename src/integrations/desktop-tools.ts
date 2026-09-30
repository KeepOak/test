import { z } from "zod";
import { NativeWatchSchema } from "../native-capture/driver.js";
import type { ToolRegistry } from '../registry.js';
import type { DesktopControl } from './desktop.js';
import {
  DesktopClickSchema, DesktopClipboardSchema, DesktopKeySchema, DesktopOpenSchema,
  DesktopReadSchema, DesktopScreenshotSchema, DesktopTypeSchema, DesktopWindowsSchema,
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
  registry.register({ name: "desktop.nativeTargets", permission: "desktop.view", parameters: z.object({}).strict(),
    description: "Discover exact native windows and Mac displays for a bounded watch. Requires the visible Stop notice and owner-prepared hash-pinned helper. Wayland is refused.",
    target: () => "native window discovery", execute: (_input, context) => desktop.nativeTargets(context) });
  registry.register({ name: "desktop.watchNative", permission: "desktop.view", parameters: NativeWatchSchema,
    description: "Watch an exact previously discovered native window for up to 20 frames/30 seconds and keep only the latest private PNG. Mac display capture can exclude exact discovered windows using ScreenCaptureKit before pixels are read. Linux X11 supports window-only capture; display exclusion and Wayland are refused. No screen rectangle fallback.",
    target: (input) => JSON.stringify(input),
    execute: (input, context) => desktop.watchNative(input, context) });
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
    description: `List what is in a window — its buttons, boxes and text, by name — so you can act on names instead of guessing at pixels. Always read a window before clicking or typing in it. ${bounds}`,
    parameters: DesktopReadSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.read(input, context),
  });
  registry.register({
    name: 'desktop.click', permission: 'desktop.control',
    description: `Press a button, box or link in a window by the name desktop.read gives it. A point inside the window is a last resort when nothing is named. ${bounds}`,
    parameters: DesktopClickSchema,
    target: (input) => input.window,
    execute: (input, context) => desktop.click(input, context),
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
    description: `Press one key or key combination in a window, such as "enter" or "ctrl+s". The window is brought to the front first, and nothing is sent if Windows will not bring it forward. ${bounds}`,
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
