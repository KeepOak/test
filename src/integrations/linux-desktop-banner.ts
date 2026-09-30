import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinModules, powerShellPath, scriptEnvironment } from './desktop-script.js';
import type { BannerNotice, BannerWindow, BannerWindowFactory } from './desktop-banner.js';

/**
 * The notice that sits on top of everything while a shared Linux desktop is running, with a
 * "Take over" button on it. Unlike the Stop notice in `desktop-banner.ts` (which ends the run),
 * pressing this one does not stop anything: it hands control of the shared desktop to the owner,
 * exactly as `LinuxDesktopSandbox.takeOver` does, so the two are always the same action.
 */
export const takeOverBannerTitle = 'Branch is using a shared desktop';
/** The same words on a Mac or Linux, where the notice is the desktop app's own window (`src/desktop/banner-window.ts`). */
export const takeOverNotice: BannerNotice = { title: takeOverBannerTitle, text: 'Branch is using a shared Linux desktop', button: 'Take over' };
const bannerScript = String.raw`
$ErrorActionPreference = 'Stop'
${builtinModules}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Branch is using a shared desktop'
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
$label.Text = 'Branch is using a shared Linux desktop'
$label.ForeColor = [System.Drawing.Color]::White
$label.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$label.AutoSize = $false
$label.TextAlign = 'MiddleLeft'
$label.SetBounds(16, 0, 280, 52)

$takeover = New-Object System.Windows.Forms.Button
$takeover.Text = 'Take over'
$takeover.Name = 'TakeOver'
$takeover.ForeColor = [System.Drawing.Color]::White
$takeover.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
$takeover.FlatStyle = 'Flat'
$takeover.FlatAppearance.BorderSize = 0
$takeover.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$takeover.SetBounds(308, 10, 136, 32)
$takeover.Add_Click({ $form.Close() })

$form.Controls.Add($label)
$form.Controls.Add($takeover)
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
`;

const bannerFailed = 'The "Take over" notice could not be shown.';

export interface TakeOverBannerOptions { platform?: string; window?: BannerWindowFactory }

/**
 * One notice per shared desktop. `show` puts it up and resolves once it is really on screen;
 * closing it (the button, or `hide` taking it down because the desktop stopped) is told apart the
 * same way `DesktopBanner` does: `hide` marks itself first, so only a real button press calls back.
 */
export class TakeOverBanner {
  private child: ChildProcess | undefined;
  private hiding = false;
  private window: BannerWindow | undefined;
  private generation = 0;
  constructor(private readonly executable = powerShellPath, private readonly options: TakeOverBannerOptions = {}) {}
  private get platform(): string { return this.options.platform ?? process.platform; }
  get visible(): boolean {
    if (this.platform !== 'win32') return Boolean(this.window?.showing);
    return Boolean(this.child) && this.child!.exitCode === null;
  }
  async show(onTakeOver: () => void): Promise<void> {
    if (this.platform !== 'win32') return this.showWindow(onTakeOver);
    if (this.visible) return;
    const folder = await mkdtemp(join(tmpdir(), 'branch-shared-desktop-'));
    const path = join(folder, 'branch-takeover.ps1');
    await writeFile(path, bannerScript, { mode: 0o600 });
    this.hiding = false;
    const child = spawn(this.executable, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path], {
      cwd: tmpdir(), windowsHide: true, stdio: 'ignore', env: scriptEnvironment(),
    });
    this.child = child;
    child.on('error', () => { this.child = undefined; });
    child.once('exit', () => {
      this.child = undefined;
      if (!this.hiding) onTakeOver();
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  private async showWindow(onTakeOver: () => void): Promise<void> {
    if (this.visible) return;
    const factory = this.options.window;
    if (!factory) throw new Error(bannerFailed);
    let made: BannerWindow | undefined;
    let gone = false;
    const gen = this.generation;
    const closed = () => {
      gone = true;
      if (!made || this.window !== made) return;
      this.window = undefined;
      onTakeOver();
    };
    made = await factory(closed, takeOverNotice).catch(() => { throw new Error(bannerFailed); });
    if (gen !== this.generation) {
      made.close();
      return;
    }
    if (gone || !made.showing) {
      made.close();
      throw new Error(bannerFailed);
    }
    this.window = made;
  }
  async hide(): Promise<void> {
    this.generation++;
    if (this.platform !== 'win32') {
      const window = this.window;
      this.window = undefined;
      window?.close();
      return;
    }
    const child = this.child;
    if (!child) return;
    this.hiding = true;
    this.child = undefined;
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
