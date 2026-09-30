import { spawn, type ChildProcess } from 'node:child_process';
import { assertRealScreenAllowed } from './real-screen-guard.js'; // dogfood follow-up
import { tmpdir } from 'node:os';
import { DesktopScriptRunner, builtinModules, powerShellPath, scriptEnvironment, type PosixDesktopOptions } from './desktop-script.js';

/**
 * The small notice that sits on top of everything while the assistant is using the screen, with a
 * Stop button on it. It is a window of its own, in a process of its own, so it keeps working even
 * while the assistant is busy: pressing Stop ends that process, and Branch treats that as "stop
 * now" for the task that put the notice up.
 *
 * On a Mac or Linux the notice is a small window of the desktop app's own, made by its main process
 * through a `BannerWindowFactory`. Without the app (the command line, a background engine) there is
 * no notice, so screen control is refused there in one plain sentence.
 */
export const bannerTitle = 'Branch is using your screen';

const bannerScript = String.raw`
$ErrorActionPreference = 'Stop'
${builtinModules}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Branch is using your screen'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Width = 460
$form.Height = 52
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 27)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $screen.X + [int](($screen.Width - $form.Width) / 2)
$form.Top = $screen.Y + 12

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Branch is using your screen and keyboard'
$label.ForeColor = [System.Drawing.Color]::White
$label.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$label.AutoSize = $false
$label.TextAlign = 'MiddleLeft'
$label.SetBounds(16, 0, 320, 52)

$stop = New-Object System.Windows.Forms.Button
$stop.Text = 'Stop'
$stop.Name = 'Stop'
$stop.ForeColor = [System.Drawing.Color]::White
$stop.BackColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
$stop.FlatStyle = 'Flat'
$stop.FlatAppearance.BorderSize = 0
$stop.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$stop.SetBounds(348, 10, 96, 32)
$stop.Add_Click({ $form.Close() })

$form.Controls.Add($label)
$form.Controls.Add($stop)
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
`;

/** One notice window made by the desktop app (macOS and Linux). */
export interface BannerWindow {
  /** True only while the window exists and the window system has put it on the screen. */
  readonly showing: boolean;
  close(): void;
}
/** What a notice says and the one button on it. Left out, it is the screen control Stop notice. */
export interface BannerNotice { title: string; text: string; button: string }
/**
 * Makes the notice window. It resolves only once the window is really on the screen, and throws
 * otherwise. `closed` is called whenever the window goes, whether its button was pressed or it was
 * taken down. The shared Linux desktop hands in its own words (a "Take over" notice).
 */
export type BannerWindowFactory = (closed: () => void, notice?: BannerNotice) => Promise<BannerWindow>;

export const noBannerRefusal = 'Branch can only use your screen and keyboard from the Branch Agent app on this computer, where a notice with a Stop button can sit on top of everything. Open the app and ask again.';
const bannerFailed = 'The notice with the Stop button could not be shown, so Branch has not touched your screen.';

export interface BannerOptions { platform?: string; window?: BannerWindowFactory }
/** A long-lived view's notice, independent of a task putting its shorter notice up or taking it down. */
export interface BannerLease { visible(): boolean; release(): Promise<void> }

export class DesktopBanner {
  private child: ChildProcess | undefined;
  private readonly hiddenChildren = new WeakSet<ChildProcess>();
  private window: BannerWindow | undefined;
  private readonly taskStops = new Set<() => void>();
  private readonly leases = new Set<() => void>();
  private starting: Promise<void> | undefined;
  constructor(
    private readonly runner: DesktopScriptRunner, private readonly executable = powerShellPath,
    private readonly options: BannerOptions = {},
  ) {}
  private get platform(): string { return this.options.platform ?? process.platform; }
  get visible(): boolean {
    if (this.platform !== 'win32') return Boolean(this.window?.showing);
    return Boolean(this.child) && this.child!.exitCode === null;
  }
  /**
   * Puts the notice up, if it is not up already. `onStop` is called when the person presses Stop,
   * which happens within a moment of the click because the notice's own process ends there.
   */
  async show(onStop: () => void): Promise<void> {
    this.taskStops.add(onStop);
    try { await this.ensureVisible(); }
    catch (error) { this.taskStops.delete(onStop); throw error; }
  }
  /** A remote view keeps its Stop button when a task ends or the owner hands control back to a task. */
  async acquire(onStop: () => void): Promise<BannerLease> {
    let released = false;
    const stopped = () => { released = true; onStop(); };
    this.leases.add(stopped);
    try {
      await this.ensureVisible();
      if (!this.visible) throw new Error(bannerFailed);
    } catch (error) { this.leases.delete(stopped); throw error; }
    return {
      visible: () => !released && this.visible,
      release: async () => {
        if (released) return;
        released = true;
        this.leases.delete(stopped);
        if (!this.leases.size && !this.taskStops.size) await this.hideNotice();
      },
    };
  }
  private async ensureVisible(): Promise<void> {
    if (this.visible) return;
    if (!this.starting) this.starting = this.showNotice();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private stopped(): void {
    const callbacks = [...this.taskStops, ...this.leases];
    this.taskStops.clear();
    this.leases.clear();
    for (const callback of callbacks) { try { callback(); } catch { /* One failed task cannot swallow another view's Stop. */ } }
  }
  private async showNotice(): Promise<void> {
    if (this.platform !== 'win32') return this.showWindow(() => this.stopped());
    if (this.visible) return;
    const path = await this.runner.materialise('branch-banner.ps1', bannerScript);
    assertRealScreenAllowed(); // dogfood follow-up: never the real screen from a test without the opt-in
    const child = spawn(this.executable, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path], {
      cwd: tmpdir(), windowsHide: true, stdio: 'ignore', env: scriptEnvironment(),
    });
    this.child = child;
    child.on('error', () => { if (this.child === child) this.child = undefined; });
    child.once('exit', () => {
      if (this.child === child) this.child = undefined;
      if (!this.hiddenChildren.has(child)) this.stopped();
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  /**
   * The Mac and Linux notice. A window that closes while it is the current one means Stop; one that
   * is taken down by `hide` is forgotten first, so its closing means nothing.
   */
  private async showWindow(onStop: () => void): Promise<void> {
    if (this.visible) return;
    const factory = this.options.window;
    if (!factory) throw new Error(noBannerRefusal);
    let made: BannerWindow | undefined;
    let gone = false;
    const closed = () => {
      gone = true;
      if (!made || this.window !== made) return;
      this.window = undefined;
      onStop();
    };
    made = await factory(closed).catch(() => { throw new Error(bannerFailed); });
    if (gone || !made.showing) {
      made.close();
      throw new Error(bannerFailed);
    }
    this.window = made;
  }
  /** Takes the notice down because the work is over, which is not the same as the person stopping it. */
  async hide(): Promise<void> {
    this.taskStops.clear();
    if (this.leases.size) return;
    await this.hideNotice();
  }
  private async hideNotice(): Promise<void> {
    await this.starting?.catch(() => undefined);
    if (this.platform !== 'win32') {
      const window = this.window;
      this.window = undefined;
      window?.close();
      return;
    }
    const child = this.child;
    if (!child) return;
    this.hiddenChildren.add(child);
    this.child = undefined;
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * The runner and the notice screen control uses. On a Mac or Linux the runner is switched on only
 * while the notice is really showing, so no action can reach the screen without a Stop button on it.
 * Windows gets exactly the two it always had. Pass both to `DesktopControl` together: the runner only
 * knows this banner, so a runner handed in alone refuses every action.
 */
export function screenControlParts(options: {
  window?: BannerWindowFactory; platform?: string; posix?: Omit<PosixDesktopOptions, 'enabled' | 'platform'>;
} = {}): { runner: DesktopScriptRunner; banner: DesktopBanner } {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const named = options.platform ? { platform } : {};
    const runner = new DesktopScriptRunner(undefined, named);
    return { runner, banner: new DesktopBanner(runner, undefined, named) };
  }
  let banner: DesktopBanner | undefined;
  const runner = new DesktopScriptRunner(undefined, { ...options.posix, platform, enabled: () => Boolean(banner?.visible) });
  banner = new DesktopBanner(runner, undefined, { platform, ...(options.window ? { window: options.window } : {}) });
  return { runner, banner };
}
