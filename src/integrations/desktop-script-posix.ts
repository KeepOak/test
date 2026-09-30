import { readFile } from 'node:fs/promises';
import type { DesktopAction } from './desktop-script.js';

/**
 * Using the screen and keyboard on a Mac and on Linux, as commands and nothing else.
 *
 * On a Mac every action goes through one fixed JavaScript for Automation script run by `osascript`:
 * what was asked for travels as a separate argument holding JSON, and the script reads it as data,
 * so nothing a reply says is ever part of the program. On Linux the same actions are `xdotool`
 * argument lists. Anything a computer cannot do is one plain sentence rather than a guess.
 */
export const osascriptPath = '/usr/bin/osascript';
export const screencapturePath = '/usr/sbin/screencapture';
export const openPath = '/usr/bin/open';

/** What running one program came back with. */
export interface PosixOutcome { status: string; exitCode: number | null; stdout: string; stderr: string }
export type PosixExec = (executable: string, args: string[], signal: AbortSignal) => Promise<PosixOutcome>;

/** The one script a Mac runs. It never changes: the request is `argv[1]`, parsed as JSON. */
export const macDesktopScript = String.raw`
function run(argv) {
  var action = argv[0];
  var request = JSON.parse(argv[1] || '{}');
  var se = Application('System Events');
  function windowsOf(p) { try { return p.windows(); } catch (e) { return []; } }
  function describe(p, w, i) {
    var title = ''; try { title = w.name() || ''; } catch (e) {}
    var size = [0, 0]; try { size = w.size(); } catch (e) {}
    var min = false; try { min = w.attributes.byName('AXMinimized').value() === true; } catch (e) {}
    return { handle: p.unixId() + ':' + (i + 1), title: title, className: '', program: p.name(),
      processId: p.unixId(), minimised: min, width: size[0], height: size[1] };
  }
  function list() {
    var found = [];
    se.processes.whose({ backgroundOnly: false })().forEach(function (p) {
      windowsOf(p).forEach(function (w, i) { var d = describe(p, w, i); if (d.title) found.push(d); });
    });
    return found;
  }
  function target() {
    var parts = String(request.handle || '').split(':');
    var matches = se.processes.whose({ unixId: Number(parts[0]) })();
    var wins = matches.length ? windowsOf(matches[0]) : [];
    var w = wins[Number(parts[1]) - 1];
    if (!w || (request.title && w.name() !== request.title)) throw new Error('That window is no longer open.');
    return { p: matches[0], w: w };
  }
  function forward(t) {
    t.p.frontmost = true;
    try { t.w.actions.byName('AXRaise').perform(); } catch (e) {}
    delay(0.3);
  }
  function named(t, name) {
    var all = t.w.entireContents();
    for (var i = 0; i < all.length && i < 2000; i++) {
      var n = ''; try { n = all[i].name() || ''; } catch (e) {}
      if (n === name || (n && n.indexOf(name) >= 0)) return all[i];
    }
    return null;
  }
  function read(t, limit) {
    var all = t.w.entireContents(), nodes = [];
    for (var i = 0; i < all.length && nodes.length < limit; i++) {
      var e = all[i], node = { role: '', name: '', value: '', id: '', enabled: true };
      try { node.role = String(e.role()).replace(/^AX/, ''); } catch (x) {}
      try { node.name = String(e.name() || ''); } catch (x) {}
      try { node.value = String(e.value() || ''); } catch (x) {}
      try { node.enabled = e.enabled() !== false; } catch (x) {}
      nodes.push(node);
    }
    return { nodes: nodes, more: all.length > nodes.length, title: t.w.name() };
  }
  function click(t) {
    if (request.name) {
      var node = named(t, request.name);
      if (!node) throw new Error('Nothing in that window is called "' + request.name + '". Use desktop.read to see what is there.');
      node.actions.byName('AXPress').perform();
      var spot = [];
      try { var p = node.position(), z = node.size(); spot = [Math.round(p[0] + z[0] / 2), Math.round(p[1] + z[1] / 2)]; } catch (e) { spot = []; }
      return { how: 'invoke', name: node.name(), at: spot };
    }
    var at = t.w.position(), size = t.w.size();
    if (request.x > size[0] || request.y > size[1]) throw new Error('That point is outside the window.');
    forward(t);
    se.click({ at: [at[0] + request.x, at[1] + request.y] });
    return { how: 'point', name: '', at: [at[0] + request.x, at[1] + request.y] };
  }
  function type(t) {
    if (request.name) {
      var node = named(t, request.name);
      if (!node) throw new Error('There is nothing to type into in that window.');
      node.value = String(request.text);
      delay(0.25);
      return { how: 'set', into: node.name(), value: String(node.value() || '') };
    }
    forward(t);
    se.keystroke(String(request.text));
    delay(0.25);
    return { how: 'keys', into: '', value: '' };
  }
  function key(t) {
    forward(t);
    var using = { using: request.modifiers || [] };
    if (request.keyCode !== undefined) se.keyCode(request.keyCode, using); else se.keystroke(request.key, using);
    delay(0.2);
    return { sent: request.chord, title: t.w.name() };
  }
  function act(t) {
    var title = t.w.name();
    if (request.verb === 'focus') forward(t);
    if (request.verb === 'minimise') t.w.attributes.byName('AXMinimized').value = true;
    if (request.verb === 'close') t.w.buttons.whose({ subrole: 'AXCloseButton' })()[0].click();
    delay(0.4);
    var still = false; try { target(); still = true; } catch (e) {}
    return { verb: request.verb, title: title, stillOpen: still };
  }
  function clipboard() {
    var app = Application.currentApplication();
    app.includeStandardAdditions = true;
    if (request.mode === 'write') { app.setTheClipboardTo(String(request.text)); return { written: true }; }
    var text = ''; try { text = app.theClipboard(); } catch (e) {}
    return { text: String(text || '') };
  }
  function frame(t) {
    return { x: t.w.position()[0], y: t.w.position()[1], width: t.w.size()[0], height: t.w.size()[1],
      title: t.w.name(), minimised: t.w.attributes.byName('AXMinimized').value() === true };
  }
  var result;
  if (action === 'windows') result = { windows: list() };
  else if (action === 'read') result = read(target(), Number(request.limit) || 200);
  else if (action === 'click') result = click(target());
  else if (action === 'type') result = type(target());
  else if (action === 'key') result = key(target());
  else if (action === 'act') result = act(target());
  else if (action === 'clipboard') result = clipboard();
  else if (action === 'frame') result = frame(target());
  else throw new Error('Unknown screen action: ' + action);
  return JSON.stringify({ ok: true, result: result });
}
`;

/** How `osascript` is started for one action: the script file, the action, and the request as JSON. */
export function osascriptArgs(scriptPath: string, action: string, payload: Record<string, unknown>): string[] {
  return ['-l', 'JavaScript', scriptPath, action, JSON.stringify(payload)];
}

const macKeyCodes: Record<string, number> = {
  ENTER: 36, TAB: 48, ESC: 53, BACKSPACE: 51, DELETE: 117, HOME: 115, END: 119, PGUP: 116, PGDN: 121,
  UP: 126, DOWN: 125, LEFT: 123, RIGHT: 124,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};
const xdotoolKeys: Record<string, string> = {
  ENTER: 'Return', TAB: 'Tab', ESC: 'Escape', BACKSPACE: 'BackSpace', DELETE: 'Delete', HOME: 'Home', END: 'End',
  PGUP: 'Prior', PGDN: 'Next', UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right', INSERT: 'Insert',
};

/** "^+s" (the checked Windows form) split into held keys and the one key pressed. */
function splitChord(keys: string): { held: string[]; key: string } {
  const held: string[] = [];
  let rest = keys;
  while (rest.length > 1 && '^%+'.includes(rest[0]!)) { held.push(rest[0]!); rest = rest.slice(1); }
  const named = /^\{([A-Z0-9]+)\}$/.exec(rest);
  if (named) return { held, key: named[1]! };
  if (!/^[a-z0-9 ]$/.test(rest)) throw new Error('That is not a key Branch knows how to press.');
  return { held, key: rest };
}

/**
 * A key chord for a Mac. Ctrl is taken to mean Command, because that is the key a Mac's shortcuts
 * use: "ctrl+s" saves, as it does on Windows.
 */
export function macChord(keys: string): { key?: string; keyCode?: number; modifiers: string[] } {
  const { held, key } = splitChord(keys);
  const names: Record<string, string> = { '^': 'command down', '%': 'option down', '+': 'shift down' };
  const modifiers = held.map((symbol) => names[symbol]!);
  if (key.length === 1) return { key, modifiers };
  const code = macKeyCodes[key];
  if (code === undefined) throw new Error(`A Mac has no ${key.toLowerCase()} key to press.`);
  return { keyCode: code, modifiers };
}

/** A key chord in the form `xdotool key` takes, for example "ctrl+shift+s". */
export function xdotoolChord(keys: string): string {
  const { held, key } = splitChord(keys);
  const names: Record<string, string> = { '^': 'ctrl', '%': 'alt', '+': 'shift' };
  const last = key === ' ' ? 'space' : key.length === 1 ? key : xdotoolKeys[key] ?? (/^F\d+$/.test(key) ? key : null);
  if (!last) throw new Error('That is not a key Branch knows how to press.');
  return [...held.map((symbol) => names[symbol]!), last].join('+');
}

/** Why a Mac said no, in one sentence, with where to change it. */
export function macFailure(stderr: string): string {
  if (/-1743|not allowed to send/i.test(stderr))
    return 'Your Mac is not letting Branch control other apps. Open System Settings, Privacy & Security, Automation, and turn System Events on for Branch Agent.';
  if (/-25211|-1719|assistive access/i.test(stderr))
    return 'Your Mac is not letting Branch press keys and click in other apps. Open System Settings, Privacy & Security, Accessibility, and turn Branch Agent on.';
  if (/could not create image|screen ?recording/i.test(stderr))
    return 'Your Mac is not letting Branch take pictures of the screen. Open System Settings, Privacy & Security, Screen & System Audio Recording, and turn Branch Agent on.';
  const detail = /Error: (.+?)(?: \(-?\d+\))?$/m.exec(stderr)?.[1] ?? stderr.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return detail ? detail.slice(0, 300) : 'That did not work on this computer.';
}

/** Width and height from the header of a PNG file, or zeros when it is not one. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return { width: 0, height: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A program name or path that can only be that: nothing that `open` would read as an option. */
function plainName(value: unknown, what: string): string {
  const text = String(value ?? '');
  if (!text || text.startsWith('-') || /[\x00-\x1f]/.test(text)) throw new Error(`That is not ${what} Branch can open.`);
  return text;
}

/** The screenshot command for a whole screen, one rectangle of it, or where a window sits. */
export function screencaptureArgs(payload: Record<string, unknown>, frame?: { x: number; y: number; width: number; height: number }): string[] {
  const region = frame ?? (payload.region as { x: number; y: number; width: number; height: number } | undefined);
  const out = String(payload.outPath);
  if (region) return ['-x', '-R', [region.x, region.y, region.width, region.height].map((n) => Math.round(Number(n))).join(','), out];
  return ['-x', '-D', String(Math.max(1, Math.round(Number(payload.display ?? 1)))), out];
}

/** The steps a Mac takes for one action, each a program and its arguments. */
export async function runMac(exec: PosixExec, scriptPath: string, action: DesktopAction, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const script = async (name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const outcome = await exec(osascriptPath, osascriptArgs(scriptPath, name, body), signal);
    if (outcome.exitCode !== 0) throw new Error(macFailure(outcome.stderr));
    return parseAnswer(outcome.stdout);
  };
  if (action === 'open') {
    const args = payload.path ? [plainName(payload.path, 'a file')] : ['-a', plainName(payload.app, 'a program')];
    const outcome = await exec(openPath, args, signal);
    if (outcome.exitCode !== 0) throw new Error(macFailure(outcome.stderr));
    return { opened: String(payload.path ?? ''), app: String(payload.app ?? ''), processId: 0 };
  }
  if (action === 'screenshot') return macScreenshot(exec, script, payload, signal);
  if (action === 'key') return script('key', { handle: payload.handle, chord: payload.keys, ...macChord(String(payload.keys)) });
  return script(action, payload);
}

async function macScreenshot(
  exec: PosixExec, script: (name: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>,
  payload: Record<string, unknown>, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let frame: { x: number; y: number; width: number; height: number } | undefined;
  let title = `Screen ${String(payload.display ?? 1)}`;
  if (payload.handle) {
    const found = await script('frame', { handle: payload.handle });
    if (found.minimised) throw new Error('That window is minimised, so there is nothing to photograph. Bring it up first.');
    frame = { x: Number(found.x), y: Number(found.y), width: Number(found.width), height: Number(found.height) };
    title = String(found.title ?? '');
  }
  const outcome = await exec(screencapturePath, screencaptureArgs(payload, frame), signal);
  if (outcome.exitCode !== 0) throw new Error(macFailure(outcome.stderr));
  const size = pngSize(await readFile(String(payload.outPath)).catch(() => new Uint8Array()));
  if (!size.width) throw new Error(macFailure('could not create image from display'));
  // A Mac copies that patch of the screen, so anything on top would show: say so, as Windows does.
  return { ...size, title, ...(frame ? { method: 'screen' } : {}) };
}

function parseAnswer(stdout: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; result?: Record<string, unknown> };
    if (parsed.ok && parsed.result) return parsed.result;
  } catch { /* fall through to the plain sentence */ }
  throw new Error('Your Mac did not answer that in a way Branch could read.');
}

/* ------------------------------------------------------------------------------- Linux */

const unavailableOnLinux = (what: string): Error =>
  new Error(`${what} is not available on Linux yet. Use desktop.windows, desktop.key, desktop.type or a click at a point instead.`);

/** An X11 window id as `xdotool` prints it; anything else is refused before a program is started. */
function windowId(handle: unknown): string {
  const text = String(handle ?? '');
  if (!/^\d{1,12}$/.test(text)) throw new Error('That window is no longer open.');
  return text;
}

/**
 * The `xdotool` arguments for one action that works on its own window. Typed text comes after `--`,
 * so words beginning with a dash are typed, never read as an option.
 */
export function xdotoolArgs(action: DesktopAction, payload: Record<string, unknown>): string[] {
  const id = windowId(payload.handle);
  if (action === 'key') return ['windowactivate', '--sync', id, 'key', '--clearmodifiers', xdotoolChord(String(payload.keys))];
  if (action === 'type') {
    if (payload.name) throw unavailableOnLinux('Typing into a named box');
    return ['windowactivate', '--sync', id, 'type', '--clearmodifiers', '--delay', '12', '--', String(payload.text ?? '')];
  }
  if (action === 'click') {
    if (payload.name) throw unavailableOnLinux('Clicking something by its name');
    const x = Math.round(Number(payload.x)), y = Math.round(Number(payload.y));
    return ['windowactivate', '--sync', id, 'mousemove', '--window', id, String(x), String(y), 'click', '1'];
  }
  if (action === 'act') {
    const verbs: Record<string, string[]> = { focus: ['windowactivate', '--sync', id], minimise: ['windowminimize', id], close: ['windowclose', id] };
    const args = verbs[String(payload.verb)];
    if (!args) throw new Error('That is not something Branch can do to a window.');
    return args;
  }
  throw unavailableOnLinux(action === 'read' ? 'Reading what is in a window' : action === 'screenshot' ? 'Taking a picture of the screen' : `That (${action})`);
}

/** Pixel size from `xdotool getwindowgeometry`, which prints "Geometry: 800x600". */
export function parseGeometry(output: string): { width: number; height: number } {
  const match = /Geometry:\s*(\d+)x(\d+)/.exec(output);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 0, height: 0 };
}

/** Every visible, named window, asked of `xdotool` one question at a time. */
async function linuxWindows(exec: PosixExec, xdotool: string, signal: AbortSignal): Promise<Record<string, unknown>[]> {
  const search = await exec(xdotool, ['search', '--onlyvisible', '--name', '.'], signal);
  const ids = search.stdout.split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).slice(0, 100);
  const windows: Record<string, unknown>[] = [];
  for (const id of ids) {
    const title = (await exec(xdotool, ['getwindowname', id], signal)).stdout.trim();
    if (!title) continue;
    const pid = Number((await exec(xdotool, ['getwindowpid', id], signal)).stdout.trim()) || 0;
    const size = parseGeometry((await exec(xdotool, ['getwindowgeometry', id], signal)).stdout);
    const program = pid ? (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim() : '';
    windows.push({ handle: id, title, className: '', program, processId: pid, minimised: false, ...size });
  }
  return windows;
}

/** The steps Linux takes for one action. */
export async function runLinux(exec: PosixExec, xdotool: string, action: DesktopAction, payload: Record<string, unknown>, signal: AbortSignal, xwininfo: string | null = null): Promise<Record<string, unknown>> {
  if (action === 'pointer' || action === 'hold-key' || action === 'cursor' || action === 'release') return linuxPointer(exec, xdotool, action, payload, signal, xwininfo);
  if (action === 'windows') return { windows: await linuxWindows(exec, xdotool, signal) };
  if (action === 'open') {
    if (!payload.path) throw unavailableOnLinux('Starting a program by name');
    const outcome = await exec('xdg-open', [plainName(payload.path, 'a file')], signal);
    if (outcome.exitCode !== 0) throw new Error('This computer could not open that file.');
    return { opened: String(payload.path), app: '', processId: 0 };
  }
  if (action === 'clipboard') throw unavailableOnLinux('The clipboard');
  const title = action === 'act' || action === 'key' ? (await exec(xdotool, ['getwindowname', windowId(payload.handle)], signal)).stdout.trim() : '';
  const outcome = await exec(xdotool, xdotoolArgs(action, payload), signal);
  if (outcome.exitCode !== 0) throw new Error(outcome.stderr.includes('BadWindow') ? 'That window is no longer open.' : 'xdotool could not do that on this computer.');
  if (action === 'act') {
    const still = await exec(xdotool, ['getwindowname', windowId(payload.handle)], signal);
    return { verb: String(payload.verb), title, stillOpen: still.exitCode === 0 };
  }
  if (action === 'key') return { sent: String(payload.keys), title };
  if (action === 'type') return { how: 'keys', into: '', value: '' };
  return { how: 'point', name: '' };
}

/**
 * Whether this computer can be driven at all, or the one sentence that says why not. Wayland does
 * not let one program type into another's windows, so that is said rather than tried.
 */
export function posixAvailability(platform: string, env: NodeJS.ProcessEnv, locate: (name: string) => string | null): string | null {
  if (platform === 'darwin') return null;
  if (platform !== 'linux') return 'Using the screen and keyboard is not available on this computer.';
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY)
    return 'Your desktop session is Wayland, which does not let Branch use other programs\' windows. Sign in with an X11 session to use the screen and keyboard.';
  if (!env.DISPLAY) return 'There is no desktop session here, so there is no screen for Branch to use.';
  if (!locate('xdotool')) return 'Using the screen and keyboard on Linux needs xdotool, which is not installed on this computer.';
  return null;
}

/* ------------------------------------------------------------------ Linux pointer (computer-control) */

const xButtons: Record<string, string> = { left: '1', middle: '2', right: '3' };
const wheelButtons: Record<string, string> = { up: '4', down: '5', left: '6', right: '7' };
const button = (value: unknown): string => xButtons[String(value ?? 'left')] ?? '1';
const heldKeys = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).filter((key): key is string => key === 'ctrl' || key === 'shift' || key === 'alt');

/** A window's place and size, from `xdotool getwindowgeometry --shell`. */
export function parseShellGeometry(output: string): { x: number; y: number; width: number; height: number } {
  const value = (name: string) => Number(new RegExp(`^${name}=(-?\\d+)$`, 'm').exec(output)?.[1] ?? NaN);
  return { x: value('X'), y: value('Y'), width: value('WIDTH'), height: value('HEIGHT') };
}

/**
 * Brings the window to the front and checks that it is the active window before anything is pressed: X11 has no
 * reliable "what is on top at this spot", and the active window is what receives the press. Gives back its geometry.
 */
/**
 * Where a window's own area starts on the screen. `xdotool getwindowgeometry` counts a window manager's frame offset
 * twice for a framed window, so `xwininfo` (x11-utils) is asked when this computer has it; without it the xdotool
 * answer stands, which is right for a window with no frame.
 */
export function parseXwininfo(output: string): { x: number; y: number } | null {
  const x = /Absolute upper-left X:\s*(-?\d+)/.exec(output)?.[1], y = /Absolute upper-left Y:\s*(-?\d+)/.exec(output)?.[1];
  return x !== undefined && y !== undefined ? { x: Number(x), y: Number(y) } : null;
}
async function windowBox(exec: PosixExec, xdotool: string, xwininfo: string | null, id: string, signal: AbortSignal): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = parseShellGeometry((await exec(xdotool, ['getwindowgeometry', '--shell', id], signal)).stdout);
  if (xwininfo) {
    const info = await exec(xwininfo, ['-id', id], signal);
    const origin = info.exitCode === 0 ? parseXwininfo(info.stdout) : null;
    if (origin) return { ...box, ...origin };
  }
  return box;
}
async function frontWindow(exec: PosixExec, xdotool: string, id: string, signal: AbortSignal, xwininfo: string | null = null): Promise<{ x: number; y: number; width: number; height: number }> {
  const raised = await exec(xdotool, ['windowactivate', '--sync', id], signal);
  if (raised.exitCode !== 0) throw new Error('That window is no longer open.');
  const active = (await exec(xdotool, ['getactivewindow'], signal)).stdout.trim();
  if (active !== id) throw new Error('Another window is in front of that one, so nothing was done. Bring it up first.');
  const box = await windowBox(exec, xdotool, xwininfo, id, signal);
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 1) throw new Error('That window is no longer open.');
  return box;
}

/** A spot in window pixels: a point, or the middle of the window. Names and refs need an accessibility tree Linux lacks here. */
function linuxSpot(at: unknown, box: { width: number; height: number }): { x: number; y: number } {
  const spot = (at ?? {}) as { point?: { x: number; y: number }; name?: string; ref?: string };
  if (spot.name || spot.ref) throw unavailableOnLinux('Pointing at something by its name or ref');
  const x = spot.point ? Math.round(spot.point.x) : Math.floor(box.width / 2), y = spot.point ? Math.round(spot.point.y) : Math.floor(box.height / 2);
  if (!(x >= 0 && y >= 0 && x < box.width && y < box.height)) throw new Error('That spot is outside the window. Nothing was done.');
  return { x, y };
}

/** The xdotool steps for one pointer verb, after the window was checked to be in front. */
export function xdotoolPointerArgs(payload: Record<string, unknown>, id: string, box: { width: number; height: number }): string[] {
  const kind = String(payload.kind), mods = heldKeys(payload.modifiers);
  const down = mods.flatMap((key) => ['keydown', key]), up = mods.flatMap((key) => ['keyup', key]);
  const move = (at: { x: number; y: number }) => ['mousemove', '--window', id, String(at.x), String(at.y)];
  if (kind === 'click') {
    const count = String(Math.max(1, Math.min(3, Number(payload.count) || 1)));
    return [...move(linuxSpot(payload.at, box)), ...down, 'click', '--repeat', count, '--delay', '80', button(payload.button), ...up];
  }
  if (kind === 'move') return move(linuxSpot(payload.at, box));
  if (kind === 'down') return [...(payload.atCurrent ? [] : move(linuxSpot(payload.at, box))), 'mousedown', button(payload.button)];
  if (kind === 'up') {
    const at = payload.at as { point?: unknown } | undefined;
    return [...(at?.point ? move(linuxSpot(at, box)) : []), 'mouseup', button(payload.button)];
  }
  if (kind === 'drag') {
    return [...move(linuxSpot(payload.from, box)), ...down, 'mousedown', button(payload.button), 'sleep', '0.05',
      ...move(linuxSpot(payload.to, box)), 'sleep', '0.05', 'mouseup', button(payload.button), ...up];
  }
  if (kind === 'scroll') {
    const wheel = wheelButtons[String(payload.direction)];
    if (!wheel) throw new Error('Scroll up, down, left or right.');
    const steps = String(Math.max(1, Math.min(10, Number(payload.amount) || 3)));
    return [...move(linuxSpot(payload.at, box)), ...down, 'click', '--repeat', steps, '--delay', '30', wheel, ...up];
  }
  throw new Error(`Unknown pointer action: ${kind}`);
}

/** Pointer verbs, holding keys, where the pointer is, and letting go, on an X11 desktop. */
export async function linuxPointer(exec: PosixExec, xdotool: string, action: DesktopAction, payload: Record<string, unknown>, signal: AbortSignal, xwininfo: string | null = null): Promise<Record<string, unknown>> {
  const run = async (args: string[]) => {
    const outcome = await exec(xdotool, args, signal);
    if (outcome.exitCode !== 0) throw new Error(outcome.stderr.includes('BadWindow') ? 'That window is no longer open.' : 'xdotool could not do that on this computer.');
    return outcome.stdout;
  };
  if (action === 'release') {
    const buttons = (Array.isArray(payload.buttons) ? payload.buttons : []).map(button);
    const keys = Array.isArray(payload.chords) ? payload.chords.map((chord) => xdotoolHoldChord(String(chord))) : [];
    await run([...buttons.flatMap((b) => ['mouseup', b]), ...keys.flatMap((k) => ['keyup', k]), ...(buttons.length || keys.length ? [] : ['getmouselocation'])]);
    return { released: true };
  }
  if (action === 'cursor') {
    const where = parseShellGeometry((await run(['getmouselocation', '--shell'])).replace(/^SCREEN=.*$/m, ''));
    const at = [where.x, where.y];
    if (!payload.handle) return { at };
    const box = await windowBox(exec, xdotool, xwininfo, windowId(payload.handle), signal);
    const inside = at[0]! >= box.x && at[1]! >= box.y && at[0]! < box.x + box.width && at[1]! < box.y + box.height;
    return { at, window: [at[0]! - box.x, at[1]! - box.y], inside };
  }
  const id = windowId(payload.handle);
  const box = await frontWindow(exec, xdotool, id, signal, xwininfo);
  if (action === 'hold-key') {
    const chord = xdotoolHoldChord(String(payload.chord));
    const ms = Math.max(100, Math.min(10000, Number(payload.ms) || 500));
    await run(['keydown', chord]);
    try { await new Promise((done) => setTimeout(done, ms)); } finally { await exec(xdotool, ['keyup', chord], AbortSignal.timeout(5000)); }
    return { held: ms };
  }
  await run(xdotoolPointerArgs(payload, id, box));
  if (payload.kind === 'move') await new Promise((done) => setTimeout(done, Math.max(0, Math.min(10000, Number(payload.hoverMs) || 0))));
  const spot = payload.kind === 'drag' ? payload.to : payload.at;
  const point = (spot as { point?: { x: number; y: number } } | undefined)?.point;
  const at = point ? [box.x + point.x, box.y + point.y] : [box.x + Math.floor(box.width / 2), box.y + Math.floor(box.height / 2)];
  return { how: String(payload.kind), at };
}

const xdotoolHeld: Record<string, string> = {
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape',
  escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End', pageup: 'Prior',
  pagedown: 'Next', up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'space', insert: 'Insert',
};
/** A chord to hold ("shift", "ctrl+a") as xdotool names it; only keys Branch may press. */
export function xdotoolHoldChord(chord: string): string {
  return chord.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean).map((part) => {
    if (xdotoolHeld[part]) return xdotoolHeld[part]!;
    if (/^f([1-9]|1[0-2])$/.test(part)) return part.toUpperCase();
    if (/^[a-z0-9]$/.test(part)) return part;
    throw new Error('That is not a key Branch knows how to hold.');
  }).join('+');
}
