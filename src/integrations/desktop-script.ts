import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ShellProcess, killWindowsTree } from './shell-process.js';
import { macDesktopScript, posixAvailability, runLinux, runMac, type PosixExec } from './desktop-script-posix.js';

/**
 * The one Windows script every screen action goes through, and the bounded way it is run.
 *
 * It is written once to a private temporary folder and then called with `-File`, so the arguments
 * are handed over literally and nothing the model writes is ever pasted into a command line. The
 * body of the request travels as base64, the answer comes back as a single line of JSON, and the
 * whole thing runs through the same bounded child-process runner the host-command tool uses, so a
 * hung script is stopped by time, by output size, or the moment the task is cancelled.
 */
export const powerShellPath = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

/** Windows actions; the script does exactly one of these per run and then exits. */
export type DesktopAction = 'windows' | 'screenshot' | 'read' | 'click' | 'type' | 'key' | 'act' | 'open' | 'clipboard';

export const desktopScript = String.raw`
param([Parameter(Mandatory=$true)][string]$Action, [Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class BranchDesktop {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint owner);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static string Title(IntPtr h) { var b = new StringBuilder(512); GetWindowTextW(h, b, 512); return b.ToString(); }
  public static string ClassOf(IntPtr h) { var b = new StringBuilder(256); GetClassNameW(h, b, 256); return b.ToString(); }
  public static List<IntPtr> Top() {
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h) && Title(h).Length > 0) found.Add(h); return true; }, IntPtr.Zero);
    return found;
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@

$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$auto = [System.Windows.Automation.AutomationElement]

function Get-Windows {
  $list = New-Object System.Collections.ArrayList
  foreach ($handle in [BranchDesktop]::Top()) {
    $owner = 0
    [void][BranchDesktop]::GetWindowThreadProcessId($handle, [ref]$owner)
    $program = ''
    try { $program = (Get-Process -Id $owner -ErrorAction Stop).ProcessName } catch { $program = '' }
    $rect = New-Object BranchDesktop+RECT
    [void][BranchDesktop]::GetWindowRect($handle, [ref]$rect)
    [void]$list.Add([pscustomobject]@{
      handle = $handle.ToInt64().ToString()
      title = [BranchDesktop]::Title($handle)
      className = [BranchDesktop]::ClassOf($handle)
      program = $program
      processId = $owner
      minimised = [BranchDesktop]::IsIconic($handle)
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
    })
  }
  return $list
}

function Get-Handle {
  $handle = [IntPtr][int64]$request.handle
  if (-not [BranchDesktop]::IsWindow($handle)) { throw 'That window is no longer open.' }
  return $handle
}

function Save-Area($x, $y, $width, $height, $path) {
  if ($width -lt 1 -or $height -lt 1) { throw 'That window has nothing to photograph.' }
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($width, $height)))
  $graphics.Dispose()
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  return @{ width = $width; height = $height }
}

function Save-Window($handle, $path) {
  $rect = New-Object BranchDesktop+RECT
  [void][BranchDesktop]::GetWindowRect($handle, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 1 -or $height -lt 1) { throw 'That window has nothing to photograph.' }
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  $printed = [BranchDesktop]::PrintWindow($handle, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  $method = 'window'
  if (-not $printed) {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
    $method = 'screen'
  }
  $graphics.Dispose()
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  return @{ width = $width; height = $height; method = $method }
}

function Read-Node($node) {
  $value = ''
  $pattern = $null
  try { if ($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $value = [string]$pattern.Current.Value } } catch { $value = '' }
  $role = $node.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  return [pscustomobject]@{
    role = $role
    name = $node.Current.Name
    value = $value
    id = $node.Current.AutomationId
    enabled = $node.Current.IsEnabled
  }
}

function Read-Tree($root, $limit) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $nodes = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  $seen = 0
  while ($queue.Count -gt 0 -and $nodes.Count -lt $limit) {
    $node = $queue.Dequeue()
    $seen = $seen + 1
    try { [void]$nodes.Add((Read-Node $node)) } catch { continue }
    try {
      $child = $walker.GetFirstChild($node)
      while ($child -ne $null) {
        $queue.Enqueue($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch { }
  }
  return @{ nodes = $nodes; more = ($queue.Count -gt 0) }
}

function Find-Named($root, $name) {
  $condition = New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, $name)
  $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($found -ne $null) { return $found }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  $checked = 0
  while ($queue.Count -gt 0 -and $checked -lt 400) {
    $node = $queue.Dequeue()
    $checked = $checked + 1
    try { if ($node.Current.Name -like ('*' + $name + '*')) { return $node } } catch { continue }
    try {
      $child = $walker.GetFirstChild($node)
      while ($child -ne $null) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
    } catch { }
  }
  return $null
}

function Find-Writable($root, $name) {
  if ($name) { return (Find-Named $root $name) }
  foreach ($kind in @([System.Windows.Automation.ControlType]::Document, [System.Windows.Automation.ControlType]::Edit)) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, $kind)
    $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($found -ne $null) { return $found }
  }
  return $null
}

function Bring-Forward($handle) {
  [void][BranchDesktop]::ShowWindow($handle, 9)
  [void][BranchDesktop]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 350
  return ([BranchDesktop]::GetForegroundWindow() -eq $handle)
}

$result = $null
switch ($Action) {
  'windows' { $result = @{ windows = @(Get-Windows) } }
  'screenshot' {
    if ($request.handle) {
      $handle = Get-Handle
      if ([BranchDesktop]::IsIconic($handle)) { throw 'That window is minimised, so there is nothing to photograph. Bring it up first.' }
      $size = Save-Window $handle $request.outPath
      $result = @{ width = $size.width; height = $size.height; method = $size.method; title = [BranchDesktop]::Title($handle) }
    } else {
      $screens = [System.Windows.Forms.Screen]::AllScreens
      $index = [int]$request.display - 1
      if ($index -lt 0 -or $index -ge $screens.Length) { throw ('This computer has ' + $screens.Length + ' screen(s).') }
      $bounds = $screens[$index].Bounds
      $size = Save-Area $bounds.X $bounds.Y $bounds.Width $bounds.Height $request.outPath
      $result = @{ width = $size.width; height = $size.height; title = ('Screen ' + $request.display) }
    }
  }
  'read' {
    $handle = Get-Handle
    $tree = Read-Tree ($auto::FromHandle($handle)) ([int]$request.limit)
    $result = @{ nodes = @($tree.nodes); more = $tree.more; title = [BranchDesktop]::Title($handle) }
  }
  'click' {
    $handle = Get-Handle
    $root = $auto::FromHandle($handle)
    if ($request.name) {
      $node = Find-Named $root $request.name
      if ($node -eq $null) { throw ('Nothing in that window is called "' + $request.name + '". Use desktop.read to see what is there.') }
      $pattern = $null
      if ($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke(); $result = @{ how = 'invoke'; name = $node.Current.Name }
      } elseif ($node.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
        $pattern.Toggle(); $result = @{ how = 'toggle'; name = $node.Current.Name }
      } elseif ($node.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select(); $result = @{ how = 'select'; name = $node.Current.Name }
      } elseif ($node.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
        $pattern.Expand(); $result = @{ how = 'expand'; name = $node.Current.Name }
      } else {
        if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so nothing was clicked.' }
        $box = $node.Current.BoundingRectangle
        [BranchDesktop]::Click([int]($box.X + $box.Width / 2), [int]($box.Y + $box.Height / 2))
        $result = @{ how = 'point'; name = $node.Current.Name }
      }
    } else {
      $rect = New-Object BranchDesktop+RECT
      [void][BranchDesktop]::GetWindowRect($handle, [ref]$rect)
      $x = $rect.Left + [int]$request.x
      $y = $rect.Top + [int]$request.y
      if ($x -gt $rect.Right -or $y -gt $rect.Bottom) { throw 'That point is outside the window.' }
      if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so nothing was clicked.' }
      [BranchDesktop]::Click($x, $y)
      $result = @{ how = 'point'; name = '' }
    }
  }
  'type' {
    $handle = Get-Handle
    $root = $auto::FromHandle($handle)
    $node = Find-Writable $root $request.name
    if ($node -eq $null) { throw 'There is nothing to type into in that window.' }
    $pattern = $null
    if ($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and -not $pattern.Current.IsReadOnly) {
      $pattern.SetValue([string]$request.text)
      Start-Sleep -Milliseconds 250
      $again = $null
      [void]$node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$again)
      $result = @{ how = 'set'; into = $node.Current.Name; value = [string]$again.Current.Value }
    } else {
      if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so nothing was typed.' }
      $escaped = ''
      foreach ($ch in ([string]$request.text).ToCharArray()) {
        if ('+^%~()[]{}'.Contains($ch)) { $escaped = $escaped + '{' + $ch + '}' } else { $escaped = $escaped + $ch }
      }
      [System.Windows.Forms.SendKeys]::SendWait($escaped)
      Start-Sleep -Milliseconds 250
      $result = @{ how = 'keys'; into = $node.Current.Name; value = '' }
    }
  }
  'key' {
    $handle = Get-Handle
    if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so no key was pressed.' }
    [System.Windows.Forms.SendKeys]::SendWait([string]$request.keys)
    Start-Sleep -Milliseconds 200
    $result = @{ sent = [string]$request.keys; title = [BranchDesktop]::Title($handle) }
  }
  'act' {
    $handle = Get-Handle
    $title = [BranchDesktop]::Title($handle)
    switch ($request.verb) {
      'focus' { if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front.' } }
      'minimise' { [void][BranchDesktop]::ShowWindow($handle, 6) }
      'close' { [void][BranchDesktop]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    }
    Start-Sleep -Milliseconds 400
    $result = @{ verb = [string]$request.verb; title = $title; stillOpen = [BranchDesktop]::IsWindow($handle) }
  }
  'open' {
    if ($request.path) {
      Start-Process -FilePath ([string]$request.path) -ErrorAction Stop
      $started = $null
    } else {
      $started = Start-Process -FilePath ([string]$request.app) -PassThru -ErrorAction Stop
    }
    Start-Sleep -Milliseconds 900
    $identifier = 0
    if ($started -ne $null) { $identifier = $started.Id }
    $result = @{ opened = [string]($request.path); app = [string]($request.app); processId = $identifier }
  }
  'clipboard' {
    if ($request.mode -eq 'write') { Set-Clipboard -Value ([string]$request.text); $result = @{ written = $true } }
    else { $text = Get-Clipboard -Raw; if ($text -eq $null) { $text = '' }; $result = @{ text = [string]$text } }
  }
  'live' {
    # The owner's live view of this screen (src/live-screen.ts): one program for as long as the view is open. Each line
    # the engine sends (the widest the frame may be) is answered with one line: the windows open just before and just
    # after the frame, and the frame itself as a JPEG in base64. Nothing is written to a file. When the engine lets go
    # (the view closed, or Branch stopped or died) the next read finds nothing and the program ends.
    Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public static class BranchLive {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint owner);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr p, uint flags, StringBuilder name, ref uint size);
  static ImageCodecInfo jpeg;
  static string Quoted(string s) {
    var b = new StringBuilder(s.Length + 2);
    b.Append('"');
    foreach (char c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  // The program a window belongs to, read afresh for every frame (a number Windows gives out again is never trusted).
  static string Program(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return "";
    try {
      var name = new StringBuilder(1024); uint size = 1024;
      return QueryFullProcessImageNameW(p, 0, name, ref size) ? Path.GetFileNameWithoutExtension(name.ToString()) : "";
    } finally { CloseHandle(p); }
  }
  static void Windows(StringBuilder into) {
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var title = new StringBuilder(512); GetWindowTextW(h, title, 512);
      if (title.Length == 0) return true;
      if (into[into.Length - 1] != '[') into.Append(',');
      into.Append("{\"title\":").Append(Quoted(title.ToString())).Append(",\"program\":").Append(Quoted(Program(h)))
        .Append(",\"minimised\":").Append(IsIconic(h) ? "true" : "false").Append('}');
      return true;
    }, IntPtr.Zero);
  }
  public static string Frame(int maxWidth) {
    var answer = new StringBuilder("{\"windows\":[");
    Windows(answer);
    Rectangle bounds = Screen.AllScreens[0].Bounds;
    if (bounds.Width < 1 || bounds.Height < 1) throw new Exception("That screen has nothing to show.");
    double scale = Math.Min(1.0, (double)Math.Max(160, maxWidth) / bounds.Width);
    int w = Math.Max(1, (int)Math.Round(bounds.Width * scale)), h = Math.Max(1, (int)Math.Round(bounds.Height * scale));
    string data;
    using (var full = new Bitmap(bounds.Width, bounds.Height))
    using (var small = new Bitmap(w, h)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size);
      using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.Bilinear; g.DrawImage(full, 0, 0, w, h); }
      if (jpeg == null) foreach (var codec in ImageCodecInfo.GetImageEncoders()) if (codec.MimeType == "image/jpeg") jpeg = codec;
      var quality = new EncoderParameters(1);
      quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
      using (var stream = new MemoryStream()) { small.Save(stream, jpeg, quality); data = Convert.ToBase64String(stream.ToArray()); }
    }
    answer.Append("],\"after\":[");
    Windows(answer);
    return answer.Append("],\"width\":").Append(w).Append(",\"height\":").Append(h).Append(",\"data\":\"").Append(data).Append("\"}").ToString();
  }
}
'@
    while ($true) {
      $line = [Console]::In.ReadLine()
      if ($line -eq $null) { break }
      try { $answer = [BranchLive]::Frame([int]$line) }
      catch { $answer = '{"error":' + (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}' }
      [Console]::Out.WriteLine($answer)
      [Console]::Out.Flush()
    }
    exit 0
  }
  default { throw ('Unknown screen action: ' + $Action) }
}
[Console]::Out.Write((@{ ok = $true; result = $result } | ConvertTo-Json -Depth 8 -Compress))
`;

/** How long one screen action may take, and how much it may say. A tree of controls is the big one. */
const timeoutMs = 25000;
const maxOutputBytes = 512 * 1024;

/**
 * The few settings the script needs and nothing else: where Windows is, a place for temporary
 * files, and just enough of the search path for Windows to find a program by name and to work out
 * which program opens a given file. None of the owner's own environment is passed on.
 */
export function scriptEnvironment(root = process.env.SYSTEMROOT ?? 'C:\\Windows'): NodeJS.ProcessEnv {
  return {
    SYSTEMROOT: root, WINDIR: root, TEMP: tmpdir(), TMP: tmpdir(),
    PATH: `${root}\\system32;${root}`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    ...(process.env.SYSTEMDRIVE ? { SYSTEMDRIVE: process.env.SYSTEMDRIVE } : {}),
  };
}

/**
 * How a Mac or Linux computer is driven. It stays off unless switched on here, because screen
 * control never runs without a way to stop it: the switch is a question asked before every action,
 * and `screenControlParts` (desktop-banner.ts) answers it with "is the Stop notice showing right now".
 */
export interface PosixDesktopOptions {
  /** On only while the on-screen notice with its Stop button is really showing on this computer. */
  enabled?: boolean | (() => boolean);
  platform?: string;
  env?: NodeJS.ProcessEnv;
  exec?: PosixExec;
  locate?: (name: string) => string | null;
}

export class DesktopScriptRunner {
  private folder: Promise<string> | undefined;
  constructor(private readonly executable = powerShellPath, private readonly posix: PosixDesktopOptions = {}) {}
  private get platform(): string { return this.posix.platform ?? process.platform; }
  /** Writes the script once, into a private folder of its own, and gives back its path. */
  private async scriptPath(): Promise<string> {
    this.folder ??= mkdtemp(join(tmpdir(), 'branch-desktop-')).then(async (folder) => {
      await writeFile(join(folder, 'branch-desktop.ps1'), desktopScript, { mode: 0o600 });
      return folder;
    });
    return join(await this.folder, 'branch-desktop.ps1');
  }
  /** A place for one screenshot to land before it is read back and kept as an artifact. */
  async temporaryPng(name: string): Promise<string> {
    await this.scriptPath();
    return join(await this.folder!, `${name}.png`);
  }
  /** Writes one more script into the same private folder, for the on-screen notice. */
  async materialise(name: string, content: string): Promise<string> {
    await this.scriptPath();
    const path = join(await this.folder!, name);
    await writeFile(path, content, { mode: 0o600 });
    return path;
  }
  /**
   * Runs one action. The answer is a single JSON line; anything else (a crash, a refusal from
   * Windows, a timeout) becomes a plain error the model can read.
   */
  async run(action: DesktopAction, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.platform !== 'win32') return this.runPosix(action, payload, signal);
    const script = await this.scriptPath();
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const child = new ShellProcess({
      executable: this.executable,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-Payload', body],
      cwd: tmpdir(), env: scriptEnvironment(),
      signal, timeoutMs, maxOutputBytes, maxMemoryMb: 1024, maxCpuSeconds: 60,
    });
    const outcome = await child.run();
    if (outcome.status !== 'completed' || outcome.exitCode !== 0)
      throw new Error(failureText(outcome.status, outcome.stderr));
    try {
      const parsed = JSON.parse(outcome.stdout.trim()) as { ok?: boolean; result?: Record<string, unknown> };
      if (!parsed.ok || !parsed.result) throw new Error('empty answer');
      return parsed.result;
    } catch {
      throw new Error('Windows did not answer that in a way Branch could read.');
    }
  }
  /** A Mac through `osascript`, Linux through `xdotool`, or one plain sentence saying it cannot. */
  private async runPosix(action: DesktopAction, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const enabled = this.posix.enabled;
    if (!(typeof enabled === 'function' ? enabled() : enabled))
      throw new Error(enabled === undefined || enabled === false
        ? 'Using the screen and keyboard is not available on this computer yet: for now Branch can only do it on Windows.'
        : 'Branch only uses your screen while its notice with the Stop button is showing, and it is not showing, so nothing was done.');
    const locate = this.posix.locate ?? locateProgram;
    const problem = posixAvailability(this.platform, this.posix.env ?? process.env, locate);
    if (problem) throw new Error(problem);
    const exec = this.posix.exec ?? runBounded;
    if (this.platform === 'darwin') {
      const folder = await this.privateFolder();
      const script = join(folder, 'branch-desktop.js');
      await writeFile(script, macDesktopScript, { mode: 0o600 });
      return runMac(exec, script, action, payload, signal);
    }
    return runLinux(exec, locate('xdotool')!, action, payload, signal);
  }
  /** parity-b2 (smooth): the one program the owner's live view of this screen reads from on Windows, started on first use. */
  liveProcess(): LiveScreenProcess | null {
    if (this.platform !== 'win32') return null;
    return new LiveScreenProcess(async () => ({ executable: this.executable,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', await this.scriptPath(), '-Action', 'live', '-Payload', 'e30='] }));
  }
  private async privateFolder(): Promise<string> {
    this.folder ??= mkdtemp(join(tmpdir(), 'branch-desktop-'));
    return this.folder;
  }
  async close(): Promise<void> {
    const folder = await this.folder?.catch(() => undefined);
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}

/** A Mac or Linux program run through the same bounded runner, with only the search path passed on. */
const runBounded: PosixExec = async (executable, args, signal) => {
  const child = new ShellProcess({
    executable, args, cwd: tmpdir(),
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin', HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir(),
      ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}), ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) },
    signal, timeoutMs, maxOutputBytes, maxMemoryMb: 1024, maxCpuSeconds: 60,
  });
  const outcome = await child.run();
  if (outcome.status === 'cancelled') throw new Error('That was stopped before it finished.');
  if (outcome.status !== 'completed' && outcome.status !== 'failed')
    throw new Error('This computer did not answer in time, so nothing more was done.');
  return { status: outcome.status, exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr };
};

/** Where a program lives on the search path, without starting it. */
function locateProgram(name: string): string | null {
  for (const folder of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(folder, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/** Turns a stopped or failed script into one plain sentence. */
function failureText(status: string, stderr: string): string {
  if (status === 'cancelled') return 'That was stopped before it finished.';
  if (status === 'timed_out') return 'Windows did not answer in time, so nothing was done.';
  const detail = stderr.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '';
  return detail ? detail.slice(0, 300) : 'That did not work on this computer.';
}

/** What one live frame comes back as: the frame and the windows open just before and just after it. */
export interface LiveAnswer { width: number; height: number; data: string; windows: unknown; after: unknown }
/** The longest line one frame may be (a 1280-wide JPEG in base64 is well under this). */
const liveLineBytes = 8 * 1024 * 1024;

/**
 * parity-b2 (smooth): one PowerShell kept running while the owner's live view is open, instead of one started per frame
 * (which cost a second or two of a processor each time). It waits on its input between frames, so an open view costs
 * only the frames it is asked for. It ends when `close` lets go of its input; a frame that is stopped part way (its
 * request dropped) or never answers ends it at once, and the next frame starts a new one. Should Branch itself die,
 * its input closes with it and the program ends on its next read.
 */
export class LiveScreenProcess {
  private child: ChildProcess | null = null;
  private buffer = '';
  private waiting: { ok: (line: string) => void; fail: (error: Error) => void } | null = null;
  private closed = false;
  constructor(private readonly command: () => Promise<{ executable: string; args: string[] }>) {}
  /** True while the program is running. */
  get running(): boolean { return this.child !== null; }
  private async start(): Promise<ChildProcess> {
    const { executable, args } = await this.command();
    if (this.closed) throw new Error('The live view was closed.');
    const child = spawn(executable, args, { cwd: tmpdir(), env: scriptEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout!.on('data', (chunk: Buffer) => this.heard(child, chunk));
    child.on('error', () => this.gone(child, 'Windows could not start the screen reader.'));
    child.once('exit', () => this.gone(child, 'The screen reader stopped.'));
    child.stdin!.on('error', () => undefined);
    this.child = child;
    this.buffer = '';
    return child;
  }
  private heard(child: ChildProcess, chunk: Buffer): void {
    if (child !== this.child) return;
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > liveLineBytes) { this.end(child); this.settle(new Error('The screen reader answered more than a frame.')); return; }
    const at = this.buffer.indexOf('\n');
    if (at < 0) return;
    const line = this.buffer.slice(0, at).trim();
    this.buffer = this.buffer.slice(at + 1);
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.ok(line);
  }
  private gone(child: ChildProcess, message: string): void {
    if (child !== this.child) return;
    this.child = null;
    this.settle(new Error(message));
  }
  private settle(error: Error): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.fail(error);
  }
  /** Ends a program for good: its input first, then the whole tree if it has not gone within a moment. */
  private end(child: ChildProcess): void {
    if (child === this.child) this.child = null;
    child.stdin?.end();
    const timer = setTimeout(() => { if (child.exitCode === null && child.pid) void killWindowsTree(child.pid); }, 1000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }
  /** One frame no wider than `maxWidth`. Stopping `signal` stops the frame and the program taking it. */
  async frame(maxWidth: number, signal: AbortSignal): Promise<LiveAnswer> {
    if (this.closed) throw new Error('The live view was closed.');
    if (this.waiting) throw new Error('A frame is already being taken.');
    const child = this.child ?? await this.start();
    const line = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => stop('The screen did not answer in time.'), 20000);
      const stop = (why: string) => { this.end(child); this.settle(new Error(why)); };
      const aborted = () => stop('That was stopped before it finished.');
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
      this.waiting = { ok: (value) => { done(); ok(value); }, fail: (error) => { done(); fail(error); } };
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener('abort', aborted, { once: true });
      child.stdin!.write(`${Math.round(maxWidth)}\n`);
    });
    let answer: Record<string, unknown>;
    try { answer = JSON.parse(line) as Record<string, unknown>; } catch { throw new Error('Windows did not answer that in a way Branch could read.'); }
    if (typeof answer.error === 'string') throw new Error(answer.error.slice(0, 300));
    return { width: Number(answer.width) || 0, height: Number(answer.height) || 0, data: String(answer.data ?? ''), windows: answer.windows, after: answer.after };
  }
  /** Lets the program go; nothing runs after this. */
  close(): void {
    this.closed = true;
    const child = this.child;
    if (child) this.end(child);
    this.settle(new Error('The live view was closed.'));
  }
}
