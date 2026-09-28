import { accessSync, constants } from 'node:fs';
import { assertRealScreenAllowed } from './real-screen-guard.js'; // dogfood follow-up
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { ShellProcess, killWindowsTree } from './shell-process.js';
import { macDesktopScript, posixAvailability, runLinux, runMac, type PosixExec } from './desktop-script-posix.js';
import { CaptureBoundsSchema, CaptureExclusionSchema, NativeCaptureTargetSchema, type CaptureExclusion, type NativeCaptureTarget } from '../desktop/capture-lease.js';
export type { CaptureExclusion, NativeCaptureTarget } from '../desktop/capture-lease.js';

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
export type DesktopAction = 'windows' | 'capture-targets' | 'screenshot' | 'read' | 'click' | 'scroll' | 'type' | 'key' | 'act' | 'open' | 'clipboard'
  // computer-control: the tools' own pointer verbs (button, double click, move, drag, wheel, press and let go), a
  // close-up picture, holding keys, where the pointer is, and letting go of whatever a task still holds.
  | 'pointer' | 'zoom' | 'hold-key' | 'cursor' | 'release';

const CaptureInputSchema = z.object({
  handle: z.string().regex(/^[1-9][0-9]{0,18}$/),
  expectedTarget: NativeCaptureTargetSchema, expectedProcessId: z.number().int().positive(), exclusion: CaptureExclusionSchema,
  expectedWindowBounds: CaptureBoundsSchema.optional(),
  pointOnTarget: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().optional(),
  steps: z.number().int().min(-10).max(10).refine((n) => n !== 0).optional(),
}).passthrough();

/** The remote port's pinned selection, checked before any native program receives an input request. */
export function captureInputPayload(action: DesktopAction, payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.expectedTarget === undefined && action !== 'scroll') return payload;
  const checked = CaptureInputSchema.parse(payload);
  if (checked.expectedProcessId === checked.exclusion.processId) throw new Error('Branch cannot drive its own viewer.');
  if (checked.expectedTarget.kind === 'window' &&
    (checked.expectedTarget.handle !== payload.handle || checked.expectedTarget.processId !== checked.expectedProcessId))
    throw new Error('That is not the window shown in the view.');
  if (checked.expectedTarget.kind === 'monitor' && !checked.expectedWindowBounds)
    throw new Error('Monitor input needs the window bounds from its displayed frame.');
  if ((action === 'click' && !payload.name || action === 'scroll') && !checked.pointOnTarget)
    throw new Error('Remote pointer input needs a point on its selected target.');
  if (action === 'scroll' && checked.steps === undefined) throw new Error('Scroll needs between one and ten wheel steps.');
  return checked;
}

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
  public static void Wheel(int x, int y, int steps) {
    SetCursorPos(x, y);
    mouse_event(0x0800, 0, 0, unchecked((uint)(steps * 120)), IntPtr.Zero);
  }
  // computer-control: physical pixels everywhere (window boxes, UI Automation boxes, the pointer), so a point read on a
  // scaled display lands where it was read. Called once, before any window is looked at.
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  /** The top-level window that would receive a click at this point: what is really on top there. */
  public static IntPtr RootAt(int x, int y) { var p = new POINT(); p.X = x; p.Y = y; return GetAncestor(WindowFromPoint(p), 2); }
  static uint Down(string b) { return b == "right" ? 0x0008u : b == "middle" ? 0x0020u : 0x0002u; }
  static uint Up(string b) { return b == "right" ? 0x0010u : b == "middle" ? 0x0040u : 0x0004u; }
  static byte Vk(string m) { return m == "ctrl" ? (byte)0x11 : m == "shift" ? (byte)0x10 : (byte)0x12; }
  public static void Hold(string[] mods, bool down) { foreach (var m in mods) keybd_event(Vk(m), 0, down ? 0u : 0x0002u, IntPtr.Zero); }
  public static void Press(int x, int y, string button, int count) {
    SetCursorPos(x, y);
    int gap = (int)Math.Min(120, GetDoubleClickTime() / 4);
    for (int i = 0; i < count; i++) {
      mouse_event(Down(button), 0, 0, 0, IntPtr.Zero); mouse_event(Up(button), 0, 0, 0, IntPtr.Zero);
      if (i + 1 < count) System.Threading.Thread.Sleep(gap);
    }
  }
  /** Press, glide in small steps (so the program sees a drag, not a jump), and always let go. */
  public static void Drag(int x1, int y1, int x2, int y2, string button) {
    SetCursorPos(x1, y1); System.Threading.Thread.Sleep(40);
    mouse_event(Down(button), 0, 0, 0, IntPtr.Zero);
    try { for (int i = 1; i <= 16; i++) { SetCursorPos(x1 + (x2 - x1) * i / 16, y1 + (y2 - y1) * i / 16); System.Threading.Thread.Sleep(15); } }
    finally { mouse_event(Up(button), 0, 0, 0, IntPtr.Zero); }
  }
  public static void WheelAt(int x, int y, int steps, bool sideways) {
    SetCursorPos(x, y);
    mouse_event(sideways ? 0x01000u : 0x0800u, 0, 0, unchecked((uint)(steps * 120)), IntPtr.Zero);
  }
  // computer-control: one button pressed and held (left_mouse_down), and let go (left_mouse_up, or a release).
  public static void ButtonDown(int x, int y, string button) { SetCursorPos(x, y); mouse_event(Down(button), 0, 0, 0, IntPtr.Zero); }
  public static void ButtonUp(string button) { mouse_event(Up(button), 0, 0, 0, IntPtr.Zero); }
  /** Keys held for a while (hold_key), always let go in reverse order, even when the wait is cut short. */
  public static void HoldKeys(byte[] keys, int ms) {
    int pressed = 0;
    try {
      foreach (var k in keys) { keybd_event(k, 0, 0u, IntPtr.Zero); pressed++; }
      System.Threading.Thread.Sleep(ms);
    } finally { for (int i = pressed - 1; i >= 0; i--) keybd_event(keys[i], 0, 0x0002u, IntPtr.Zero); }
  }
  public static void KeysUp(byte[] keys) { for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 0x0002u, IntPtr.Zero); }
}
'@
[void][BranchDesktop]::SetProcessDpiAwarenessContext([IntPtr](-4))

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
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
    })
  }
  return $list
}

function Get-Handle {
  $handle = [IntPtr][int64]$request.handle
  if (-not [BranchDesktop]::IsWindow($handle)) { throw 'That window is no longer open.' }
  Assert-CaptureInput $handle
  return $handle
}

function Assert-CaptureInput($handle) {
  if (-not $request.expectedTarget) { return }
  $target = $request.expectedTarget
  $owner = 0
  [void][BranchDesktop]::GetWindowThreadProcessId($handle, [ref]$owner)
  if ($owner -ne $request.expectedProcessId -or $owner -eq $request.exclusion.processId) { throw 'That input window changed or belongs to Branch. Nothing was done.' }
  $program = ''
  try { $program = (Get-Process -Id $owner -ErrorAction Stop).ProcessName } catch { throw 'The application identity cannot be verified. Nothing was done.' }
  $className = [BranchDesktop]::ClassOf($handle)
  if (-not $program -or -not $className -or $program -match '^(chrome|chromium|msedge|msedgewebview2|firefox|brave|opera|vivaldi|iexplore|electron|branch([ ._-]agent)?|arc|browser|zen|waterfox|librewolf|floorp|thorium|ungoogled-chromium)$' -or $className -match 'chrome_widget|chromium|mozilla|webview|cefbrowser') {
    throw 'Browser and Branch viewer windows cannot be controlled through this application view. Nothing was done.'
  }
  $rect = New-Object BranchDesktop+RECT
  if (-not [BranchDesktop]::GetWindowRect($handle, [ref]$rect)) { throw 'That input window is no longer open.' }
  if ($target.kind -eq 'window') {
    if ($target.handle -ne $handle.ToInt64().ToString() -or $target.processId -ne $owner) { throw 'That is not the window shown in the view.' }
    $actual = @{ x = $rect.Left; y = $rect.Top; w = $rect.Right - $rect.Left; h = $rect.Bottom - $rect.Top }
  } else {
    $display = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -ceq $target.deviceName })
    if ($display.Count -ne 1) { throw 'That monitor is no longer connected.' }
    $actual = @{ x = $display[0].Bounds.X; y = $display[0].Bounds.Y; w = $display[0].Bounds.Width; h = $display[0].Bounds.Height }
  }
  foreach ($axis in @('x', 'y', 'w', 'h')) {
    if ($actual[$axis] -ne $target.bounds.$axis) { throw 'The target moved or resized. Open a fresh view before using it.' }
  }
  if ([BranchDesktop]::IsIconic($handle)) { throw 'That input window is minimised. Nothing was done.' }
  if ($request.expectedWindowBounds) {
    $window = @{ x = $rect.Left; y = $rect.Top; w = $rect.Right - $rect.Left; h = $rect.Bottom - $rect.Top }
    foreach ($axis in @('x', 'y', 'w', 'h')) {
      if ($window[$axis] -ne $request.expectedWindowBounds.$axis) { throw 'That input window moved or resized. Open a fresh view before using it.' }
    }
  }
}

function Capture-Point($handle) {
  Assert-CaptureInput $handle
  $point = $request.pointOnTarget
  if (-not $point) { throw 'The remote input needs a point on its selected target.' }
  $bounds = $request.expectedTarget.bounds
  $x = [int][Math]::Floor($bounds.x + $point.x * ($bounds.w - 1))
  $y = [int][Math]::Floor($bounds.y + $point.y * ($bounds.h - 1))
  $rect = New-Object BranchDesktop+RECT
  [void][BranchDesktop]::GetWindowRect($handle, [ref]$rect)
  if ($x -lt $rect.Left -or $x -ge $rect.Right -or $y -lt $rect.Top -or $y -ge $rect.Bottom) { throw 'That point is outside the selected input window. Nothing was done.' }
  return @{ x = $x; y = $y }
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

# computer-control: reading a window asks the program for everything about a part in one round trip (a UI Automation
# cache request) and for all of a part's children in one more, instead of one round trip per property and per sibling:
# a list of a few hundred rows once cost thousands of cross-process calls and could outlast the script's time limit.
# The walk also stops at its limit and at a time budget (a slow or hung program answers "more", not nothing); the
# script's own 25-second limit is the hard stop for a single call a program never answers.
function New-ReadCache {
  $cache = New-Object System.Windows.Automation.CacheRequest
  foreach ($property in @($auto::NameProperty, $auto::ControlTypeProperty, $auto::AutomationIdProperty, $auto::IsEnabledProperty,
    $auto::BoundingRectangleProperty, $auto::RuntimeIdProperty, $auto::IsValuePatternAvailableProperty,
    [System.Windows.Automation.ValuePattern]::ValueProperty)) { $cache.Add($property) }
  $cache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
  return $cache
}

function Read-Node($node) {
  $value = ''
  try { if ($node.GetCachedPropertyValue($auto::IsValuePatternAvailableProperty)) { $value = [string]$node.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty) } } catch { $value = '' }
  $role = $node.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  # A handle on this exact part (UI Automation's runtime id) and where it sits in the window, so a tool can act on it by
  # ref even when several parts share a name. The box is in window pixels, like a picture's.
  $ref = ''
  try { $ref = (@($node.GetCachedPropertyValue($auto::RuntimeIdProperty)) -join '.') } catch { $ref = '' }
  $box = $null
  $area = $node.Cached.BoundingRectangle
  if ($script:origin -and -not $area.IsEmpty -and $area.Width -gt 0 -and $area.Height -gt 0) {
    $box = @([int]($area.X - $script:origin.Left), [int]($area.Y - $script:origin.Top), [int]$area.Width, [int]$area.Height)
  }
  return [pscustomobject]@{
    role = $role
    name = $node.Cached.Name
    value = $value
    id = $node.Cached.AutomationId
    enabled = $node.Cached.IsEnabled
    ref = $ref
    box = $box
  }
}

function Read-Tree($root, $limit) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $nodes = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $cut = $false
  $active = (New-ReadCache).Activate()
  try {
    $queue.Enqueue($root.GetUpdatedCache((New-ReadCache)))
    while ($queue.Count -gt 0 -and $nodes.Count -lt $limit) {
      if ($clock.ElapsedMilliseconds -gt 8000) { $cut = $true; break }
      $node = $queue.Dequeue()
      try { [void]$nodes.Add((Read-Node $node)) } catch { continue }
      # Children are asked for only while the reading still has room for them.
      if ($nodes.Count + $queue.Count -ge $limit) { if ($queue.Count -eq 0) { $cut = $true }; continue }
      try {
        foreach ($child in $node.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Automation]::ControlViewCondition)) {
          $queue.Enqueue($child)
        }
      } catch { }
    }
  } finally { $active.Dispose() }
  return @{ nodes = $nodes; more = ($queue.Count -gt 0 -or $cut); ms = $clock.ElapsedMilliseconds }
}

function Find-Named($root, $name) {
  $condition = New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, $name)
  # computer-control: a control's own window (a Pane) and the control inside it can share a name; the one that can be
  # pressed, toggled, selected or expanded is the one meant, so it is preferred over its plain container.
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  foreach ($each in $all) {
    foreach ($able in @($auto::IsInvokePatternAvailableProperty, $auto::IsTogglePatternAvailableProperty,
      $auto::IsSelectionItemPatternAvailableProperty, $auto::IsExpandCollapsePatternAvailableProperty)) {
      try { if ($each.GetCurrentPropertyValue($able)) { return $each } } catch { }
    }
  }
  if ($all.Count -gt 0) {
    # A named container whose one pressable part carries no name of its own (a button drawn inside its own window).
    $pressable = New-Object System.Windows.Automation.PropertyCondition($auto::IsInvokePatternAvailableProperty, $true)
    $inside = $all[0].FindAll([System.Windows.Automation.TreeScope]::Descendants, $pressable)
    if ($inside.Count -eq 1) { return $inside[0] }
    return $all[0]
  }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  $checked = 0
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  while ($queue.Count -gt 0 -and $checked -lt 400 -and $clock.ElapsedMilliseconds -lt 8000) {
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

# computer-control: the part a tool names, by the ref desktop.read gave it or by its name. Searched inside this window only.
function Find-Ref($root, $ref) {
  if (-not ([string]$ref -match '^-?[0-9]+(\.-?[0-9]+){0,15}$')) { throw 'That ref is not one desktop.read gave. Read the window again.' }
  $ids = [int[]]@(([string]$ref).Split('.') | ForEach-Object { [int]$_ })
  $condition = New-Object System.Windows.Automation.PropertyCondition($auto::RuntimeIdProperty, $ids)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $condition)
}
function Find-Part($root, $spec) {
  if ($spec.ref) {
    $node = Find-Ref $root $spec.ref
    if ($node -eq $null) { throw 'That part is no longer in the window (the window changed). Read the window again.' }
    return $node
  }
  $node = Find-Named $root $spec.name
  if ($node -eq $null) { throw ('Nothing in that window is called "' + $spec.name + '". Use desktop.read to see what is there.') }
  return $node
}
function Window-Rect($handle) {
  $rect = New-Object BranchDesktop+RECT
  if (-not [BranchDesktop]::GetWindowRect($handle, [ref]$rect)) { throw 'That window is no longer open.' }
  return $rect
}
# A picture's promise: the window is where it was when the picture (or the reading) its points came from was taken.
function Assert-Seen($handle) {
  if (-not $request.expect) { return }
  $rect = Window-Rect $handle
  $now = @{ x = $rect.Left; y = $rect.Top; w = $rect.Right - $rect.Left; h = $rect.Bottom - $rect.Top }
  foreach ($axis in @('x', 'y', 'w', 'h')) {
    if ($now[$axis] -ne [int]$request.expect.$axis) { throw 'That window moved or changed size since the picture its points came from. Take a new picture first. Nothing was done.' }
  }
}
# The screen point for a spot: the middle of a named part, a point in window pixels, or the middle of the window.
function Spot-Of($handle, $spec) {
  $rect = Window-Rect $handle
  if ($spec -and ($spec.ref -or $spec.name)) {
    $node = Find-Part ($auto::FromHandle($handle)) $spec
    $box = $node.Current.BoundingRectangle
    if ($box.IsEmpty -or $box.Width -le 0) { throw 'That part has no place on the screen right now (it may be scrolled out of view).' }
    $x = [int]($box.X + $box.Width / 2); $y = [int]($box.Y + $box.Height / 2)
  } elseif ($spec -and $spec.point) {
    $x = $rect.Left + [int]$spec.point.x; $y = $rect.Top + [int]$spec.point.y
  } else {
    $x = [int](($rect.Left + $rect.Right) / 2); $y = [int](($rect.Top + $rect.Bottom) / 2)
  }
  if ($x -lt $rect.Left -or $x -ge $rect.Right -or $y -lt $rect.Top -or $y -ge $rect.Bottom) { throw 'That spot is outside the window. Nothing was done.' }
  return @{ x = $x; y = $y }
}
# What is really on top at that spot must be this window: never a click through onto something covering it (another
# program, a password prompt, or Branch's own window).
function Assert-Uncovered($handle, $at) {
  # A spot off every display would be clamped to a screen edge by Windows and pressed there instead: refused.
  $shown = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Contains([int]$at.x, [int]$at.y) })
  if ($shown.Count -eq 0) { throw 'That spot is not on any screen (the window is off screen), so nothing was done. Bring the window onto a screen first.' }
  if ([BranchDesktop]::RootAt($at.x, $at.y) -ne $handle) { throw 'Another window covers that spot, so nothing was done. Bring this window up or move what covers it.' }
}
function Scroll-Part($node, $direction, $amount) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $pattern = $null; $at = $node
  for ($i = 0; $i -lt 6 -and $at -ne $null; $i++) {
    if ($at.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern)) { break }
    $pattern = $null; $at = $walker.GetParent($at)
  }
  if ($pattern -eq $null) { return $false }
  $none = [System.Windows.Automation.ScrollAmount]::NoAmount
  $step = if ($direction -eq 'up' -or $direction -eq 'left') { [System.Windows.Automation.ScrollAmount]::SmallDecrement } else { [System.Windows.Automation.ScrollAmount]::SmallIncrement }
  for ($i = 0; $i -lt $amount; $i++) {
    if ($direction -eq 'up' -or $direction -eq 'down') { $pattern.Scroll($none, $step) } else { $pattern.Scroll($step, $none) }
  }
  return $true
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
  'capture-targets' {
    $monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
      @{ kind = 'monitor'; deviceName = $_.DeviceName; primary = $_.Primary; bounds = @{ x = $_.Bounds.X; y = $_.Bounds.Y; w = $_.Bounds.Width; h = $_.Bounds.Height } }
    })
    $result = @{ monitors = $monitors; windows = @(Get-Windows) }
  }
  'screenshot' {
    if ($request.handle) {
      $handle = Get-Handle
      if ([BranchDesktop]::IsIconic($handle)) { throw 'That window is minimised, so there is nothing to photograph. Bring it up first.' }
      $size = Save-Window $handle $request.outPath
      $o = Window-Rect $handle
      $result = @{ width = $size.width; height = $size.height; method = $size.method; title = [BranchDesktop]::Title($handle)
        bounds = @{ x = $o.Left; y = $o.Top; w = $o.Right - $o.Left; h = $o.Bottom - $o.Top } }
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
    $script:origin = Window-Rect $handle
    $tree = Read-Tree ($auto::FromHandle($handle)) ([int]$request.limit)
    $o = $script:origin
    $result = @{ nodes = @($tree.nodes); more = $tree.more; readMs = $tree.ms; title = [BranchDesktop]::Title($handle)
      bounds = @{ x = $o.Left; y = $o.Top; w = $o.Right - $o.Left; h = $o.Bottom - $o.Top } }
  }
  'click' {
    $handle = Get-Handle
    $root = $auto::FromHandle($handle)
    if ($request.name) {
      $node = Find-Named $root $request.name
      if ($node -eq $null) { throw ('Nothing in that window is called "' + $request.name + '". Use desktop.read to see what is there.') }
      # Where it is on the screen, for the owner's live view to draw the Trunk's cursor (the middle of what was pressed).
      $box = $node.Current.BoundingRectangle
      $at = @()
      if (-not $box.IsEmpty) { $at = @([int]($box.X + $box.Width / 2), [int]($box.Y + $box.Height / 2)) }
      $pattern = $null
      Assert-CaptureInput $handle
      if ($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke(); $result = @{ how = 'invoke'; name = $node.Current.Name; at = $at }
      } elseif ($node.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
        $pattern.Toggle(); $result = @{ how = 'toggle'; name = $node.Current.Name; at = $at }
      } elseif ($node.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select(); $result = @{ how = 'select'; name = $node.Current.Name; at = $at }
      } elseif ($node.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
        $pattern.Expand(); $result = @{ how = 'expand'; name = $node.Current.Name; at = $at }
      } else {
        if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so nothing was clicked.' }
        Assert-CaptureInput $handle
        $box = $node.Current.BoundingRectangle
        $at = @([int]($box.X + $box.Width / 2), [int]($box.Y + $box.Height / 2))
        Assert-Uncovered $handle @{ x = [int]($box.X + $box.Width / 2); y = [int]($box.Y + $box.Height / 2) }
        [BranchDesktop]::Click([int]($box.X + $box.Width / 2), [int]($box.Y + $box.Height / 2))
        $result = @{ how = 'point'; name = $node.Current.Name; at = $at }
      }
    } else {
      if ($request.expectedTarget) {
        if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so nothing was clicked.' }
        $point = Capture-Point $handle
        Assert-Uncovered $handle $point
        [BranchDesktop]::Click($point.x, $point.y)
        $result = @{ how = 'point'; name = ''; at = @($point.x, $point.y) }
        break
      }
      $rect = New-Object BranchDesktop+RECT
      [void][BranchDesktop]::GetWindowRect($handle, [ref]$rect)
      $x = $rect.Left + [int]$request.x
      $y = $rect.Top + [int]$request.y
      if ($x -gt $rect.Right -or $y -gt $rect.Bottom) { throw 'That point is outside the window.' }
      if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so nothing was clicked.' }
      Assert-Uncovered $handle @{ x = $x; y = $y }
      [BranchDesktop]::Click($x, $y)
      $result = @{ how = 'point'; name = ''; at = @($x, $y) }
    }
  }
  'scroll' {
    $handle = Get-Handle
    if (-not $request.expectedTarget -or [int]$request.steps -eq 0 -or [int]$request.steps -lt -10 -or [int]$request.steps -gt 10) { throw 'Scroll needs a selected target and between one and ten wheel steps.' }
    if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so nothing was scrolled.' }
    $point = Capture-Point $handle
    Assert-Uncovered $handle $point
    [BranchDesktop]::Wheel($point.x, $point.y, [int]$request.steps)
    $result = @{ how = 'wheel'; steps = [int]$request.steps }
  }
  'pointer' {
    # computer-control: the tools' pointer verbs. The window comes to the front, the spot must be inside it and this
    # window must be what is really on top there; modifier keys are always let go, and the owner's pointer goes back
    # where it was after a click, drag or wheel (a hover leaves it resting where it was asked to).
    $handle = Get-Handle
    Assert-Seen $handle
    $mods = [string[]]@($request.modifiers | Where-Object { $_ -in @('ctrl', 'shift', 'alt') })
    $button = [string]$request.button
    if ($button -notin @('left', 'right', 'middle')) { $button = 'left' }
    $kind = [string]$request.kind
    if ($kind -eq 'scroll' -and ($request.at.ref -or $request.at.name) -and $mods.Length -eq 0) {
      $node = Find-Part ($auto::FromHandle($handle)) $request.at
      if (Scroll-Part $node ([string]$request.direction) ([int]$request.amount)) {
        $result = @{ how = 'scroll-pattern'; at = @(); title = [BranchDesktop]::Title($handle) }
        break
      }
    }
    if ($kind -eq 'up') {
      # Let go where the task says, or where the pointer is now; a spot not on this window (or covered) is not where
      # anything is dropped: the button is let go back where it was pressed, which was checked when it was.
      $spot = $null
      if ($request.at -and ($request.at.point -or $request.at.name -or $request.at.ref)) { $spot = Spot-Of $handle $request.at }
      else { $now = New-Object BranchDesktop+POINT; [void][BranchDesktop]::GetCursorPos([ref]$now); $spot = @{ x = $now.X; y = $now.Y } }
      $how = 'up'
      try { Assert-Uncovered $handle $spot } catch { $spot = @{ x = [int]$request.pressedAt[0]; y = [int]$request.pressedAt[1] }; $how = 'up-where-pressed' }
      [void][BranchDesktop]::SetCursorPos($spot.x, $spot.y)
      [BranchDesktop]::ButtonUp($button)
      $result = @{ how = $how; at = @($spot.x, $spot.y); title = [BranchDesktop]::Title($handle) }
      break
    }
    if ($kind -notin @('click', 'move', 'drag', 'scroll', 'down')) { throw ('Unknown pointer action: ' + $kind) }
    if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so nothing was done.' }
    Assert-Seen $handle
    if ($kind -eq 'down' -and $request.atCurrent) {
      # left_mouse_down with no spot presses where the pointer is, which must be inside this window.
      $now = New-Object BranchDesktop+POINT; [void][BranchDesktop]::GetCursorPos([ref]$now)
      $o = Window-Rect $handle
      if ($now.X -lt $o.Left -or $now.X -ge $o.Right -or $now.Y -lt $o.Top -or $now.Y -ge $o.Bottom) { throw 'The pointer is not over that window, so nothing was pressed. Move it there first.' }
      $from = @{ x = $now.X; y = $now.Y }
    } else { $from = Spot-Of $handle $(if ($kind -eq 'drag') { $request.from } else { $request.at }) }
    Assert-Uncovered $handle $from
    $to = $null
    if ($kind -eq 'drag') { $to = Spot-Of $handle $request.to; Assert-Uncovered $handle $to }
    $rest = New-Object BranchDesktop+POINT
    [void][BranchDesktop]::GetCursorPos([ref]$rest)
    [BranchDesktop]::Hold($mods, $true)
    try {
      if ($kind -eq 'click') { [BranchDesktop]::Press($from.x, $from.y, $button, [Math]::Max(1, [Math]::Min(3, [int]$request.count))) }
      elseif ($kind -eq 'down') { [BranchDesktop]::ButtonDown($from.x, $from.y, $button) }
      elseif ($kind -eq 'drag') { [BranchDesktop]::Drag($from.x, $from.y, $to.x, $to.y, $button) }
      elseif ($kind -eq 'scroll') {
        $steps = [Math]::Max(1, [Math]::Min(10, [int]$request.amount))
        $sign = if ($request.direction -eq 'down' -or $request.direction -eq 'left') { -1 } else { 1 }
        [BranchDesktop]::WheelAt($from.x, $from.y, $sign * $steps, ($request.direction -eq 'left' -or $request.direction -eq 'right'))
      } else {
        [void][BranchDesktop]::SetCursorPos($from.x, $from.y)
        Start-Sleep -Milliseconds ([Math]::Max(0, [Math]::Min(10000, [int]$request.hoverMs)))
      }
    } finally {
      [BranchDesktop]::Hold($mods, $false)
      if ($kind -ne 'move' -and $kind -ne 'down') { [void][BranchDesktop]::SetCursorPos($rest.X, $rest.Y) }
    }
    $landed = if ($to) { $to } else { $from }
    $result = @{ how = $kind; at = @($landed.x, $landed.y); title = [BranchDesktop]::Title($handle) }
  }
  'hold-key' {
    # computer-control: keys held down for a while (up to ten seconds) in the window brought to the front.
    $handle = Get-Handle
    if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so no key was held.' }
    $keys = [byte[]]@($request.keys | ForEach-Object { [byte][int]$_ })
    if ($keys.Length -lt 1 -or $keys.Length -gt 4) { throw 'Hold one key, with up to three held with it.' }
    $ms = [Math]::Max(100, [Math]::Min(10000, [int]$request.ms))
    [BranchDesktop]::HoldKeys($keys, $ms)
    $result = @{ held = $ms; title = [BranchDesktop]::Title($handle) }
  }
  'cursor' {
    # computer-control: where the pointer is, on the screen and (for a window) in its pixels, and whether that window is
    # what is on top there. Nothing moves.
    $now = New-Object BranchDesktop+POINT
    [void][BranchDesktop]::GetCursorPos([ref]$now)
    $result = @{ at = @($now.X, $now.Y) }
    if ($request.handle) {
      $handle = Get-Handle
      $o = Window-Rect $handle
      $result.window = @($now.X - $o.Left, $now.Y - $o.Top)
      $result.inside = ($now.X -ge $o.Left -and $now.X -lt $o.Right -and $now.Y -ge $o.Top -and $now.Y -lt $o.Bottom)
      $result.onTop = ([BranchDesktop]::RootAt($now.X, $now.Y) -eq $handle)
      $result.title = [BranchDesktop]::Title($handle)
    }
  }
  'release' {
    # computer-control: let go of a button or keys a task still holds (it was stopped, its time ran out, or the owner
    # took over). Letting go changes nothing else, so it needs no window.
    foreach ($b in @($request.buttons)) { if ($b -in @('left', 'right', 'middle')) { [BranchDesktop]::ButtonUp([string]$b) } }
    $keys = [byte[]]@($request.keys | Where-Object { $_ -ne $null } | ForEach-Object { [byte][int]$_ })
    if ($keys.Length) { [BranchDesktop]::KeysUp($keys) }
    $result = @{ released = $true }
  }
  'zoom' {
    # computer-control: a close-up of part of one window, taken from the window itself (never the screen on top of it),
    # at its full size and larger for a small part, so small print and small targets can be read.
    $handle = Get-Handle
    Assert-Seen $handle
    if ([BranchDesktop]::IsIconic($handle)) { throw 'That window is minimised, so there is nothing to look at. Bring it up first.' }
    $rect = Window-Rect $handle
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
    $r = $request.region; $scale = [Math]::Max(1, [Math]::Min(4, [int]$request.scale))
    if ([int]$r.x -lt 0 -or [int]$r.y -lt 0 -or [int]$r.width -lt 1 -or [int]$r.height -lt 1 -or ([int]$r.x + [int]$r.width) -gt $w -or ([int]$r.y + [int]$r.height) -gt $h) { throw 'That part is not inside the window. Nothing was done.' }
    $full = New-Object System.Drawing.Bitmap($w, $h)
    $method = 'window'
    $graphics = [System.Drawing.Graphics]::FromImage($full)
    $hdc = $graphics.GetHdc()
    $printed = [BranchDesktop]::PrintWindow($handle, $hdc, 2)
    $graphics.ReleaseHdc($hdc)
    if (-not $printed) { $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h))); $method = 'screen' }
    $graphics.Dispose()
    $close = New-Object System.Drawing.Bitmap(([int]$r.width * $scale), ([int]$r.height * $scale))
    $g = [System.Drawing.Graphics]::FromImage($close)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $close.Width, $close.Height)), (New-Object System.Drawing.Rectangle([int]$r.x, [int]$r.y, [int]$r.width, [int]$r.height)), [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose(); $full.Dispose()
    $close.Save($request.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $result = @{ width = $close.Width; height = $close.Height; scale = $scale; method = $method; title = [BranchDesktop]::Title($handle)
      bounds = @{ x = $rect.Left; y = $rect.Top; w = $w; h = $h } }
    $close.Dispose()
  }
  'type' {
    $handle = Get-Handle
    $root = $auto::FromHandle($handle)
    $node = Find-Writable $root $request.name
    if ($node -eq $null) { throw 'There is nothing to type into in that window.' }
    $pattern = $null
    if ($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and -not $pattern.Current.IsReadOnly) {
      Assert-CaptureInput $handle
      $pattern.SetValue([string]$request.text)
      Start-Sleep -Milliseconds 250
      $again = $null
      [void]$node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$again)
      $result = @{ how = 'set'; into = $node.Current.Name; value = [string]$again.Current.Value }
    } else {
      if (-not (Bring-Forward $handle)) { throw 'Windows would not bring that window to the front, so nothing was typed.' }
      Assert-CaptureInput $handle
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
    Assert-CaptureInput $handle
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
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint affinity);
  [DllImport("dwmapi.dll")] static extern int DwmIsCompositionEnabled(out bool enabled);
  [DllImport("ntdll.dll", CharSet=CharSet.Unicode)] static extern int RtlGetVersion(ref VERSION version);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct VERSION {
    public uint Size, Major, Minor, Build, Platform;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string ServicePack;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint owner);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr p, uint flags, StringBuilder name, ref uint size);
  static ImageCodecInfo jpeg;
  static string kind, deviceName, targetJson;
  static IntPtr targetWindow;
  static uint targetPid, ownPid;
  static Rectangle pinned;
  public static void Configure(string k, string device, long handle, uint pid, int x, int y, int w, int h, uint owner, string target) {
    kind = k; deviceName = device; targetWindow = new IntPtr(handle); targetPid = pid; ownPid = owner;
    pinned = new Rectangle(x, y, w, h); targetJson = target;
    if (kind != "monitor" && kind != "window") throw new Exception("Choose a monitor or window before opening this view.");
    if (w < 1 || h < 1 || (long)w * h > 32000000) throw new Exception("That target is too large to capture safely.");
  }
  static Rectangle TargetBounds() {
    if (kind == "monitor") {
      foreach (var display in Screen.AllScreens) if (display.DeviceName == deviceName) {
        if (display.Bounds != pinned) throw new Exception("The monitor moved or resized. Open a fresh view.");
        return display.Bounds;
      }
      throw new Exception("That monitor is no longer connected.");
    }
    uint pid;
    if (!IsWindow(targetWindow) || GetWindowThreadProcessId(targetWindow, out pid) == 0 || pid != targetPid)
      throw new Exception("That window closed or changed. Open a fresh view.");
    if (pid == ownPid) throw new Exception("Branch cannot capture its own viewer. Choose another window.");
    if (IsIconic(targetWindow)) throw new Exception("That window is minimised. Bring it up before opening the view.");
    RECT r;
    if (!GetWindowRect(targetWindow, out r)) throw new Exception("That window has no capture bounds.");
    var bounds = new Rectangle(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    if (bounds != pinned) throw new Exception("The window moved or resized. Open a fresh view.");
    return bounds;
  }
  static string VerifyExclusion() {
    bool composed;
    var version = new VERSION(); version.Size = (uint)Marshal.SizeOf(typeof(VERSION));
    if (ownPid == 0 || RtlGetVersion(ref version) != 0 || version.Major < 10 || version.Build < 19041 ||
      DwmIsCompositionEnabled(out composed) != 0 || !composed)
      throw new Exception("This monitor view cannot exclude Branch here. Choose a window or use Windows 10 version 2004 or newer.");
    var handles = new StringBuilder(); bool safe = true;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != ownPid || !IsWindowVisible(h)) return true;
      uint affinity;
      if (!GetWindowDisplayAffinity(h, out affinity) || affinity != 0x11) safe = false;
      handles.Append(h.ToInt64()).Append(','); return true;
    }, IntPtr.Zero);
    if (!safe) throw new Exception("Branch could not exclude its viewer from this monitor. Choose a window instead.");
    return handles.ToString();
  }
  static bool EmptyWindow(Bitmap image) {
    // A failed GPU window may claim success yet paint a uniform white/black frame or leave the sentinel untouched.
    // Read every pixel: sampling could miss a useful small label and wrongly call that window empty.
    var data = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      var row = new byte[image.Width * 4];
      byte red = 0, green = 0, blue = 0;
      for (int y = 0; y < image.Height; y++) {
        Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
        for (int x = 0; x < row.Length; x += 4) {
          if (y == 0 && x == 0) { blue = row[x]; green = row[x + 1]; red = row[x + 2]; }
          else if (row[x] != blue || row[x + 1] != green || row[x + 2] != red) return false;
        }
      }
      return true;
    } finally { image.UnlockBits(data); }
  }
  static void Capture(Bitmap image, Rectangle bounds) {
    using (var g = Graphics.FromImage(image)) {
      if (kind == "monitor") { g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size); return; }
      g.Clear(Color.Magenta);
      var dc = g.GetHdc(); bool printed;
      try { printed = PrintWindow(targetWindow, dc, 2); } finally { g.ReleaseHdc(dc); }
      if (!printed) throw new Exception("That app cannot provide a window capture. Choose another target; no screen fallback was taken.");
    }
    if (EmptyWindow(image)) throw new Exception("That app returned an empty window capture. Choose another target.");
  }
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
      var className = new StringBuilder(256); GetClassNameW(h, className, 256);
      if (title.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid); RECT rect;
      if (!GetWindowRect(h, out rect)) return true;
      if (into[into.Length - 1] != '[') into.Append(',');
      into.Append("{\"title\":").Append(Quoted(title.ToString())).Append(",\"program\":").Append(Quoted(Program(h)))
        .Append(",\"className\":").Append(Quoted(className.ToString()))
        .Append(",\"handle\":").Append(Quoted(h.ToInt64().ToString())).Append(",\"processId\":").Append(pid)
        .Append(",\"x\":").Append(rect.Left).Append(",\"y\":").Append(rect.Top)
        .Append(",\"width\":").Append(rect.Right - rect.Left).Append(",\"height\":").Append(rect.Bottom - rect.Top)
        .Append(",\"minimised\":").Append(IsIconic(h) ? "true" : "false").Append('}');
      return true;
    }, IntPtr.Zero);
  }
  public static string Frame(int maxWidth) {
    var answer = new StringBuilder("{\"windows\":[");
    Windows(answer);
    Rectangle bounds = TargetBounds();
    string excluded = kind == "monitor" ? VerifyExclusion() : "";
    if (bounds.Width < 1 || bounds.Height < 1) throw new Exception("That screen has nothing to show.");
    double scale = Math.Min(1.0, (double)Math.Max(160, maxWidth) / bounds.Width);
    int w = Math.Max(1, (int)Math.Round(bounds.Width * scale)), h = Math.Max(1, (int)Math.Round(bounds.Height * scale));
    string data;
    using (var full = new Bitmap(bounds.Width, bounds.Height))
    using (var small = new Bitmap(w, h)) {
      Capture(full, bounds);
      TargetBounds();
      if (kind == "monitor" && VerifyExclusion() != excluded) throw new Exception("Branch's windows changed during capture. Open a fresh view.");
      using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.Bilinear; g.DrawImage(full, 0, 0, w, h); }
      if (jpeg == null) foreach (var codec in ImageCodecInfo.GetImageEncoders()) if (codec.MimeType == "image/jpeg") jpeg = codec;
      var quality = new EncoderParameters(1);
      quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
      using (var stream = new MemoryStream()) { small.Save(stream, jpeg, quality); data = Convert.ToBase64String(stream.ToArray()); }
    }
    answer.Append("],\"after\":[");
    Windows(answer);
    return answer.Append("],\"width\":").Append(w).Append(",\"height\":").Append(h).Append(",\"data\":\"").Append(data)
      .Append("\",\"method\":").Append(Quoted(kind)).Append(",\"target\":").Append(targetJson)
      .Append(",\"screen\":{\"x\":").Append(bounds.X).Append(",\"y\":").Append(bounds.Y)
      .Append(",\"w\":").Append(bounds.Width).Append(",\"h\":").Append(bounds.Height).Append("}}").ToString();
  }
}
'@
    $target = $request.target
    $bounds = $target.bounds
    [BranchLive]::Configure([string]$target.kind, [string]$target.deviceName, [long]$target.handle, [uint32]$target.processId,
      [int]$bounds.x, [int]$bounds.y, [int]$bounds.w, [int]$bounds.h, [uint32]$request.exclusion.processId, (ConvertTo-Json $target -Depth 5 -Compress))
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
if ($request.expectedTarget -and $result) { $result.target = $request.expectedTarget; $result.processId = $request.expectedProcessId }
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
  /** How long one Windows action may take (default 25 s); a busy CI runner compiling the script's C# needs longer. */
  timeoutMs?: number;
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
    payload = captureInputPayload(action, payload);
    if (this.platform !== 'win32' && (action === 'capture-targets' || action === 'scroll' || payload.expectedTarget))
      throw new Error('This selected native monitor or window view is available on Windows only. Choose an explicitly supported computer target.');
    if (this.platform !== 'win32' && (action === 'zoom' || ((action === 'pointer' || action === 'hold-key' || action === 'cursor' || action === 'release') && this.platform !== 'linux')))
      throw new Error(action === 'zoom' ? 'Close-ups work on Windows for now.'
        : 'Right-click, double-click, dragging, hovering, holding keys and the scroll wheel work on Windows and on Linux (X11) for now. Use desktop.click with a name here.');
    if (this.platform !== 'win32') return this.runPosix(action, payload, signal);
    assertRealScreenAllowed(); // dogfood follow-up: never the real screen from a test without the opt-in
    const script = await this.scriptPath();
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const child = new ShellProcess({
      executable: this.executable,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-Payload', body],
      cwd: tmpdir(), env: scriptEnvironment(),
      signal, timeoutMs: Math.min(120000, Math.max(1000, this.posix.timeoutMs ?? timeoutMs)), maxOutputBytes, maxMemoryMb: 1024, maxCpuSeconds: 60,
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
    // A program finder handed in by code (tests only; Branch itself never passes one) may point at a test's stand-in.
    const exec = this.posix.exec ?? boundedRunner(this.posix.locate !== undefined);
    if (this.platform === 'darwin') {
      const folder = await this.privateFolder();
      const script = join(folder, 'branch-desktop.js');
      await writeFile(script, macDesktopScript, { mode: 0o600 });
      return runMac(exec, script, action, payload, signal);
    }
    return runLinux(exec, locate('xdotool')!, action, payload, signal);
  }
  /** parity-b2 (smooth): the one program the owner's live view of this screen reads from on Windows, started on first use. */
  liveProcess(target?: NativeCaptureTarget, exclusion?: CaptureExclusion): LiveScreenProcess | null {
    if (this.platform !== 'win32') return null;
    const selected = target ? NativeCaptureTargetSchema.parse(target) : undefined;
    const proof = exclusion ? CaptureExclusionSchema.parse(exclusion) : undefined;
    return new LiveScreenProcess(async () => {
      assertRealScreenAllowed(); // dogfood follow-up: the real screen reader, never from a test without the opt-in
      if (!selected || !proof) throw new Error('Choose a monitor or window and acquire its Branch exclusion lease before opening this view.');
      const payload = { target: selected, exclusion: proof };
      if (selected.kind === 'window' && selected.processId === proof.processId) throw new Error('Branch cannot capture its own viewer.');
      return { executable: this.executable,
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', await this.scriptPath(), '-Action', 'live',
          '-Payload', Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')] };
    }, selected);
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

/**
 * A Mac or Linux program run through the same bounded runner, with only the search path passed on. Dogfood follow-up:
 * the real-screen guard is asked first; only when the program came from a finder handed in by code may a test's own
 * stand-in in the temp folder run.
 */
const boundedRunner = (standIns: boolean): PosixExec => async (executable, args, signal) => {
  assertRealScreenAllowed(standIns ? executable : undefined);
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
export interface LiveAnswer {
  width: number; height: number; data: string; windows: unknown; after: unknown;
  target?: NativeCaptureTarget; method?: 'monitor' | 'window'; screen?: ScreenBox;
}
/** Where a screen sits among the computer's screens, in the pixels clicks are reported in. */
export interface ScreenBox { x: number; y: number; w: number; h: number }
/** A screen box, from what a script answered, or undefined when it is not one. */
export function screenBox(value: unknown): ScreenBox | undefined {
  const box = value as Partial<ScreenBox> | null;
  const whole = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return box && whole(box.x) && whole(box.y) && whole(box.w) && whole(box.h) && box.w > 0 && box.h > 0 ? { x: box.x, y: box.y, w: box.w, h: box.h } : undefined;
}
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
  private taking = false;
  private readonly target: NativeCaptureTarget | undefined;
  constructor(private readonly command: () => Promise<{ executable: string; args: string[] }>, target?: NativeCaptureTarget) {
    this.target = target ? NativeCaptureTargetSchema.parse(target) : undefined;
  }
  /** True while the program is running. */
  get running(): boolean { return this.child !== null; }
  private async start(signal: AbortSignal): Promise<ChildProcess> {
    const { executable, args } = await this.command();
    if (this.closed) throw new Error('The live view was closed.');
    if (signal.aborted) throw new Error('That was stopped before it finished.');
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
    if (this.taking) throw new Error('A frame is already being taken.');
    if (signal.aborted) throw new Error('That was stopped before it finished.');
    this.taking = true;
    try {
      return await this.takeFrame(maxWidth, signal);
    } catch (error) {
      if (this.child) this.end(this.child);
      throw error;
    } finally { this.taking = false; }
  }

  private async takeFrame(maxWidth: number, signal: AbortSignal): Promise<LiveAnswer> {
    // computer-control: the first frame also starts the program, which compiles its C# (slow on a busy computer), so it
    // is given a minute; every frame after it has twenty seconds.
    const starting = !this.child;
    const child = this.child ?? await this.start(signal);
    const line = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => stop('The screen did not answer in time.'), starting ? 60000 : 20000);
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
    const screen = screenBox(answer.screen);
    if (this.target) {
      const actual = NativeCaptureTargetSchema.parse(answer.target);
      if (JSON.stringify(actual) !== JSON.stringify(this.target) || answer.method !== this.target.kind ||
        JSON.stringify(answer.screen) !== JSON.stringify(this.target.bounds))
        throw new Error('The captured target changed. Open a fresh view before using it.');
    }
    return { width: Number(answer.width) || 0, height: Number(answer.height) || 0, data: String(answer.data ?? ''),
      windows: answer.windows, after: answer.after,
      ...(this.target ? { target: this.target, method: this.target.kind, screen: this.target.bounds } : screen ? { screen } : {}) };
  }
  /** Lets the program go; nothing runs after this. */
  close(): void {
    this.closed = true;
    const child = this.child;
    if (child) this.end(child);
    this.settle(new Error('The live view was closed.'));
  }
}
