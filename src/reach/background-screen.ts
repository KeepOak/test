import { execFile } from "node:child_process";
import { z } from "zod";
import { cappedMessage, readDesktopSettings, refusalFor, secretReferenceIn, switchedOffMessage } from "../integrations/desktop-config.js";
import type { PosixExec, PosixOutcome } from "../integrations/desktop-script-posix.js";
import { macFailure, osascriptPath } from "../integrations/desktop-script-posix.js";
import type { Store } from "../store.js";

/**
 * R17-078: using apps in the background on a Mac and on Linux, leaving the pointer, the keyboard
 * focus and the front window exactly where the person has them.
 *
 * The ordinary screen tools (src/integrations/desktop-script-posix.ts, owned by mac1/desktop-os)
 * bring a window forward and move the real pointer. These do neither: they work through each
 * system's accessibility tree, pressing a named control or setting a field's text directly.
 *
 *   Mac    one fixed JavaScript for Automation script (`osascript -l JavaScript -e`). It never sets
 *          `frontmost`, never raises a window, never sends a keystroke or a click at a position.
 *   Linux  one fixed Python script over AT-SPI (the accessibility bus GNOME and KDE both carry),
 *          and `xdotool type --window`, which sends keys to that window without focusing it.
 *
 * What was asked travels as a separate JSON argument that the script reads as data, so nothing a
 * reply says is ever part of a program. Every program is run with an argument list, never a shell.
 * Tests hand in a fake runner and check the exact arguments; nothing here is run on the owner's Mac
 * by a test, so no macOS permission is ever asked for.
 *
 * The idea is Hermes Agent's background computer use (MIT); this is an independent implementation.
 */
export const backgroundActions = ["windows", "controls", "press", "set-text", "type"] as const;
export type BackgroundAction = (typeof backgroundActions)[number];
export const BackgroundSchema = z.object({
  action: z.enum(backgroundActions),
  /** A window, as `windows` names it. */
  handle: z.string().trim().max(40).regex(/^\d+:\d+$/, "Use a window handle from the list of windows").optional(),
  /** The control's name, as `controls` lists it. */
  name: z.string().trim().min(1).max(200).optional(),
  text: z.string().max(4000).optional(),
  /** Linux only, for `type`: the X window number (as `xdotool search` prints it). */
  xwindow: z.number().int().positive().max(2 ** 32).optional(),
}).strict();
export type BackgroundRequest = z.infer<typeof BackgroundSchema>;

/** The Mac script. Read-only apart from AXPress and AXValue on one control it found by name. */
export const macBackgroundScript = String.raw`
function run(argv) {
  var action = argv[0];
  var req = JSON.parse(argv[1] || '{}');
  var se = Application('System Events');
  function wins(p) { try { return p.windows(); } catch (e) { return []; } }
  function out(result) { return JSON.stringify({ ok: true, result: result }); }
  if (action === 'windows') {
    var found = [];
    se.processes.whose({ backgroundOnly: false })().forEach(function (p) {
      wins(p).forEach(function (w, i) { var t = ''; try { t = w.name() || ''; } catch (e) {} if (t) found.push({ handle: p.unixId() + ':' + (i + 1), title: t, program: p.name() }); });
    });
    return out({ windows: found });
  }
  var parts = String(req.handle || '').split(':');
  var procs = se.processes.whose({ unixId: Number(parts[0]) })();
  var w = procs.length ? wins(procs[0])[Number(parts[1]) - 1] : null;
  if (!w) throw new Error('That window is no longer open.');
  var all = w.entireContents();
  if (action === 'controls') {
    var list = [];
    for (var i = 0; i < all.length && list.length < 300; i++) {
      var n = ''; var r = ''; try { n = all[i].name() || ''; r = all[i].role() || ''; } catch (e) {}
      if (n) list.push({ name: n, role: r });
    }
    return out({ controls: list });
  }
  var target = null;
  for (var j = 0; j < all.length && j < 2000 && !target; j++) { var m = ''; try { m = all[j].name() || ''; } catch (e) {} if (m === req.name) target = all[j]; }
  if (!target) throw new Error('There is no control with that name in the window.');
  if (action === 'press') { target.actions.byName('AXPress').perform(); return out({ pressed: req.name }); }
  if (action === 'set-text') { target.value = String(req.text || ''); return out({ set: req.name }); }
  throw new Error('That cannot be done in the background on a Mac.');
}`;

/** The Linux script. The same four actions over AT-SPI; it never grabs focus. */
export const linuxBackgroundScript = String.raw`
import json, sys
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception:
    print(json.dumps({'ok': False, 'error': 'no-atspi'})); sys.exit(0)
action = sys.argv[1]
req = json.loads(sys.argv[2] if len(sys.argv) > 2 else '{}')
desk = Atspi.get_desktop(0)
def done(result): print(json.dumps({'ok': True, 'result': result})); sys.exit(0)
def fail(text): print(json.dumps({'ok': False, 'error': text})); sys.exit(0)
def walk(node, found, limit):
    if node is None or len(found) >= limit: return
    found.append(node)
    for k in range(min(node.get_child_count(), 200)): walk(node.get_child_at_index(k), found, limit)
if action == 'windows':
    rows = []
    for a in range(desk.get_child_count()):
        app = desk.get_child_at_index(a)
        for w in range(app.get_child_count() if app else 0):
            win = app.get_child_at_index(w)
            if win and win.get_name(): rows.append({'handle': '%d:%d' % (a, w + 1), 'title': win.get_name(), 'program': app.get_name()})
    done({'windows': rows})
a, w = [int(x) for x in str(req.get('handle', '')).split(':')]
app = desk.get_child_at_index(a)
win = app.get_child_at_index(w - 1) if app else None
if win is None: fail('gone')
nodes = []
walk(win, nodes, 2000)
if action == 'controls':
    done({'controls': [{'name': n.get_name(), 'role': n.get_role_name()} for n in nodes if n.get_name()][:300]})
hit = next((n for n in nodes if n.get_name() == req.get('name')), None)
if hit is None: fail('no-control')
if action == 'press':
    hit.get_action_iface().do_action(0); done({'pressed': req.get('name')})
if action == 'set-text':
    hit.get_editable_text_iface().set_text_contents(str(req.get('text', ''))); done({'set': req.get('name')})
fail('unsupported')
`;

export const pythonPath = "/usr/bin/python3";
export const xdotoolPath = "/usr/bin/xdotool";

/** The one program and argument list a request becomes on this platform, or a plain refusal. */
export function backgroundCommand(platform: NodeJS.Platform, request: BackgroundRequest): { executable: string; args: string[] } {
  const { action, handle, name, text, xwindow } = request;
  if (action !== "windows" && action !== "type" && !handle) throw new Error("Say which window, using a handle from the list of windows.");
  if ((action === "press" || action === "set-text") && !name) throw new Error("Say which control, by its name.");
  const payload = JSON.stringify({ handle, name, text });
  if (platform === "darwin") {
    if (action === "type") throw new Error("A Mac only takes typed keys in the front window. Use set-text to fill a field in the background.");
    return { executable: osascriptPath, args: ["-l", "JavaScript", "-e", macBackgroundScript, action, payload] };
  }
  if (platform === "linux") {
    if (action === "type") {
      if (!xwindow) throw new Error("Say which X window to type into (xwindow).");
      return { executable: xdotoolPath, args: ["type", "--window", String(xwindow), "--delay", "12", "--", text ?? ""] };
    }
    return { executable: pythonPath, args: ["-c", linuxBackgroundScript, action, payload] };
  }
  throw new Error("Using apps in the background works on a Mac and on Linux. On Windows, use the ordinary screen tools.");
}

/** What the program printed, as the answer, or the plain sentence for why not. */
export function readBackground(platform: NodeJS.Platform, outcome: PosixOutcome): Record<string, unknown> {
  if (platform === "linux" && outcome.stdout.trim() === "" && outcome.exitCode === 0) return { done: true };
  if (outcome.exitCode !== 0) {
    if (platform === "darwin") throw new Error(macFailure(outcome.stderr));
    throw new Error(/ENOENT|not found/i.test(outcome.stderr) ? "xdotool or python3 is not installed on this computer." : "Linux did not do that.");
  }
  let parsed: { ok?: boolean; result?: Record<string, unknown>; error?: string };
  try { parsed = JSON.parse(outcome.stdout.trim()); } catch { throw new Error("The computer did not answer in a way Branch could read."); }
  if (parsed.ok && parsed.result) return parsed.result;
  const reasons: Record<string, string> = {
    "no-atspi": "This Linux computer has no accessibility bus for Python (install the AT-SPI Python bindings, gir1.2-atspi-2.0).",
    gone: "That window is no longer open.",
    "no-control": "There is no control with that name in the window.",
    unsupported: "That cannot be done in the background here.",
  };
  throw new Error(reasons[parsed.error ?? ""] ?? "The computer did not do that.");
}

export async function runBackground(exec: PosixExec, platform: NodeJS.Platform, input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const request = BackgroundSchema.parse(input);
  const { executable, args } = backgroundCommand(platform, request);
  return readBackground(platform, await exec(executable, args, signal));
}

/** The real runner: an argument list, no shell, a time limit and a cap on what is read back. */
export const execBackground: PosixExec = (executable, args, signal) => new Promise((resolve) => {
  execFile(executable, args, { signal, timeout: 20000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true },
    (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ status: error ? "failed" : "ok", exitCode: code, stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")) });
    });
});

export const psPath = "/bin/ps";
const gone = "That window is no longer open.";
type Win = { handle: string; title: string; program: string };

/**
 * Integration review: background app use keeps every rule the ordinary screen tools keep
 * (src/integrations/desktop.ts). The owner's "use my screen and keyboard" switch is read before every
 * action (Lockdown turns it off), each task has the same allowance of screen actions, a password or
 * sign-in window is never listed as usable, looked into, pressed or typed into — judged by the title
 * and program the computer reports, never by what was asked — and a saved-password placeholder is
 * never typed. The one thing it does not do is put up the Stop notice: it works without the screen.
 */
export class BackgroundScreen {
  private readonly runs = new Map<string, number>();
  /**
   * `held`: waits while the owner has taken over this computer's screen (DesktopControl.whileDriving), so a background
   * press or typing never reaches an app the owner is using. Ends with the task's own stop or time limit.
   */
  constructor(private readonly host: { store: Store; owner: string; exec: PosixExec; platform: NodeJS.Platform;
    held?: (runId: string, signal: AbortSignal) => Promise<void> }) {}

  closeRun(runId: string): void { this.runs.delete(runId); }

  private begin(runId: string, text: string | undefined): void {
    const settings = readDesktopSettings(this.host.store, this.host.owner);
    if (!settings.enabled) throw new Error(switchedOffMessage);
    const typed = text === undefined ? null : secretReferenceIn(text);
    if (typed) throw new Error(typed);
    const used = this.runs.get(runId) ?? 0;
    if (used >= settings.maxActionsPerRun) throw new Error(cappedMessage(settings.maxActionsPerRun));
    this.runs.set(runId, used + 1);
  }

  private async windows(signal: AbortSignal): Promise<Win[]> {
    const listed = await runBackground(this.host.exec, this.host.platform, { action: "windows" }, signal);
    return Array.isArray(listed.windows) ? (listed.windows as Win[]) : [];
  }

  /** The title and program of an X window, for the refusal check. */
  private async xWindow(xwindow: number, signal: AbortSignal): Promise<Win> {
    const ask = async (executable: string, args: string[]) => {
      const outcome = await this.host.exec(executable, args, signal);
      if (outcome.exitCode !== 0) throw new Error(gone);
      return outcome.stdout.trim();
    };
    const title = await ask(xdotoolPath, ["getwindowname", String(xwindow)]);
    const pid = await ask(xdotoolPath, ["getwindowpid", String(xwindow)]).catch(() => "");
    const program = /^\d+$/.test(pid) ? await ask(psPath, ["-o", "comm=", "-p", pid]).catch(() => "") : "";
    return { handle: String(xwindow), title, program };
  }

  private async check(request: BackgroundRequest, signal: AbortSignal): Promise<void> {
    let target: Win | undefined;
    if (request.action === "type" && request.xwindow) target = await this.xWindow(request.xwindow, signal);
    else if (request.handle) {
      target = (await this.windows(signal)).find((w) => w.handle === request.handle);
      if (!target) throw new Error(gone);
    }
    const refused = target ? refusalFor({ title: String(target.title ?? ""), program: String(target.program ?? "") }) : null;
    if (refused) throw new Error(refused);
  }

  async run(input: unknown, context: { runId: string; signal: AbortSignal }): Promise<Record<string, unknown>> {
    const request = BackgroundSchema.parse(input);
    backgroundCommand(this.host.platform, request); // refuses what cannot be done before anything runs
    await this.host.held?.(context.runId, context.signal); // the owner drives: wait, then check the switch afresh
    this.begin(context.runId, request.text);
    if (request.action === "windows") {
      const all = await this.windows(context.signal);
      return { windows: all.map((w) => ({ ...w, offLimits: Boolean(refusalFor({ title: String(w.title ?? ""), program: String(w.program ?? "") })) })) };
    }
    await this.check(request, context.signal);
    return runBackground(this.host.exec, this.host.platform, request, context.signal);
  }
}
