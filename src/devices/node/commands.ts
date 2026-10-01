/**
 * mac7/nodes: the operating-system programs a Branch node uses for each capability, as plain
 * argument lists. Nothing here runs anything; `actions.ts` hands these to an injectable runner, so
 * tests on any machine can check the exact command each platform would use.
 *
 * Text from the model never becomes part of a script: it is passed as a separate argument (macOS,
 * Linux) or in an environment variable the fixed script reads (Windows PowerShell).
 */
export type NodeOs = "darwin" | "linux" | "win32";
export interface OsCommand {
  executable: string;
  args: string[];
  /** Extra environment for the program: how Windows scripts receive the model's text. */
  env?: Record<string, string>;
  /** Text written to the program's input (the clipboard on macOS and Linux). */
  input?: string;
  /** The file the program writes its picture or sound to, when it makes one. */
  output?: string;
  /** Integration review: `env` is the whole environment (a walled `device.run`), not additions to the node's own. */
  exactEnv?: boolean;
}

const ps = (script: string, env: Record<string, string> = {}): OsCommand =>
  ({ executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script], env });

/** Whether a Linux session is Wayland; decides between grim/wl-clipboard and scrot/xclip. */
export const onWayland = (env: NodeJS.ProcessEnv): boolean => Boolean(env.WAYLAND_DISPLAY);

export function screenCommand(os: NodeOs, out: string, env: NodeJS.ProcessEnv): OsCommand {
  if (os === "darwin") return { executable: "screencapture", args: ["-x", "-t", "png", out], output: out };
  if (os === "linux") return onWayland(env) ? { executable: "grim", args: [out], output: out }
    : { executable: "scrot", args: ["--overwrite", out], output: out };
  return { ...ps([
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height",
    "$g=[System.Drawing.Graphics]::FromImage($i)",
    "$g.CopyFromScreen($b.Left,$b.Top,0,0,$i.Size)",
    "$i.Save($env:BRANCH_NODE_OUT,[System.Drawing.Imaging.ImageFormat]::Png)",
  ].join(";"), { BRANCH_NODE_OUT: out }), output: out };
}

/** One photo. macOS and Linux use ffmpeg, which is looked for and never installed. */
export function cameraCommand(os: NodeOs, out: string): OsCommand | null {
  if (os === "darwin") return { executable: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "avfoundation",
    "-framerate", "30", "-video_size", "1280x720", "-i", "0", "-frames:v", "1", "-y", out], output: out };
  if (os === "linux") return { executable: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "v4l2",
    "-i", "/dev/video0", "-frames:v", "1", "-y", out], output: out };
  return null;
}

/** A few seconds from the microphone. */
export function listenCommand(os: NodeOs, out: string, seconds: number): OsCommand | null {
  const length = String(Math.max(1, Math.min(30, Math.round(seconds))));
  if (os === "darwin") return { executable: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "avfoundation",
    "-i", ":0", "-t", length, "-ac", "1", "-ar", "16000", "-y", out], output: out };
  if (os === "linux") return { executable: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "pulse",
    "-i", "default", "-t", length, "-ac", "1", "-ar", "16000", "-y", out], output: out };
  return null;
}

export function locationCommand(os: NodeOs): OsCommand | null {
  if (os === "linux") return { executable: "/usr/libexec/geoclue-2.0/demos/where-am-i", args: ["-t", "10"] };
  return null;
}

export function notifyCommand(os: NodeOs, title: string, body: string): OsCommand {
  if (os === "darwin") return { executable: "osascript", args: ["-e", "on run argv",
    "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body] };
  if (os === "linux") return { executable: "notify-send", args: ["--app-name=Branch", "--", title, body] };
  return ps([
    "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
    "$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$t=$x.GetElementsByTagName('text')",
    "[void]$t.Item(0).AppendChild($x.CreateTextNode($env:BRANCH_NODE_TITLE))",
    "[void]$t.Item(1).AppendChild($x.CreateTextNode($env:BRANCH_NODE_BODY))",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Branch').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
  ].join(";"), { BRANCH_NODE_TITLE: title, BRANCH_NODE_BODY: body });
}

export function clipboardReadCommand(os: NodeOs, env: NodeJS.ProcessEnv): OsCommand {
  if (os === "darwin") return { executable: "pbpaste", args: [] };
  if (os === "linux") return onWayland(env) ? { executable: "wl-paste", args: ["--no-newline"] }
    : { executable: "xclip", args: ["-selection", "clipboard", "-o"] };
  return ps("Get-Clipboard -Raw");
}

export function clipboardWriteCommand(os: NodeOs, text: string, env: NodeJS.ProcessEnv): OsCommand {
  if (os === "darwin") return { executable: "pbcopy", args: [], input: text };
  if (os === "linux") return onWayland(env) ? { executable: "wl-copy", args: [], input: text }
    : { executable: "xclip", args: ["-selection", "clipboard", "-i"], input: text };
  return ps("Set-Clipboard -Value $env:BRANCH_NODE_TEXT", { BRANCH_NODE_TEXT: text });
}

/** Opens a web page in the device's browser. The address is checked to be http(s) before this. */
export function openCommand(os: NodeOs, url: string): OsCommand {
  if (os === "darwin") return { executable: "open", args: [url] };
  if (os === "linux") return { executable: "xdg-open", args: [url] };
  return ps("Start-Process -FilePath $env:BRANCH_NODE_URL", { BRANCH_NODE_URL: url });
}

export function speakCommand(os: NodeOs, text: string): OsCommand {
  if (os === "darwin") return { executable: "say", args: ["--", text] };
  if (os === "linux") return { executable: "spd-say", args: ["--wait", "--", text] };
  return ps("Add-Type -AssemblyName System.Speech;(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:BRANCH_NODE_TEXT)",
    { BRANCH_NODE_TEXT: text });
}

/** What a platform's node can really offer, given which programs it found. */
export const needs: Record<NodeOs, Partial<Record<string, readonly string[]>>> = {
  darwin: { camera: ["ffmpeg"], listen: ["ffmpeg"], screen: ["screencapture"], notify: ["osascript"],
    "clipboard-read": ["pbpaste"], "clipboard-write": ["pbcopy"], "open-url": ["open"], speak: ["say"], run: ["/usr/bin/sandbox-exec"] },
  linux: { camera: ["ffmpeg"], listen: ["ffmpeg"], screen: ["grim|scrot"], notify: ["notify-send"], location: ["/usr/libexec/geoclue-2.0/demos/where-am-i"],
    "clipboard-read": ["wl-paste|xclip"], "clipboard-write": ["wl-copy|xclip"], "open-url": ["xdg-open"], speak: ["spd-say"], run: ["bwrap"],
    input: ["xdotool", "xmessage", "wmctrl"] },
  win32: { screen: ["powershell.exe"], notify: ["powershell.exe"], "clipboard-read": ["powershell.exe"],
    "clipboard-write": ["powershell.exe"], "open-url": ["powershell.exe"], speak: ["powershell.exe"], input: ["powershell.exe"] },
};

/** computer-control: one owner input on this computer, already checked (src/devices/args.ts `input`). */
export interface NodeInput {
  action: "click" | "type" | "key" | "scroll";
  x?: number; y?: number; button: "left" | "right" | "middle"; count: number;
  text?: string; chord?: string; steps?: number;
}

/**
 * Windows: a fixed script reads the input from BRANCH_NODE_INPUT (JSON), so nothing the owner types
 * becomes script. The spot is a share of the virtual screen, measured the same DPI-unaware way the
 * screen picture above is taken, so the two always agree.
 */
export const windowsInputScript = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class BranchNodeInput{[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int x,int y);[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,int dx,int dy,int d,UIntPtr e);[DllImport(\"user32.dll\")]public static extern void keybd_event(byte vk,byte scan,uint f,UIntPtr e);}'",
  "$i=$env:BRANCH_NODE_INPUT|ConvertFrom-Json",
  "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen",
  "if($i.action -eq 'click' -or $i.action -eq 'scroll'){[void][BranchNodeInput]::SetCursorPos([int]($b.Left+[Math]::Min($b.Width-1,[Math]::Floor($i.x*$b.Width))),[int]($b.Top+[Math]::Min($b.Height-1,[Math]::Floor($i.y*$b.Height))));Start-Sleep -Milliseconds 30}",
  "if($i.action -eq 'click'){$f=@{left=@(2,4);right=@(8,16);middle=@(32,64)}[$i.button];for($n=0;$n -lt $i.count;$n++){[BranchNodeInput]::mouse_event($f[0],0,0,0,[UIntPtr]::Zero);[BranchNodeInput]::mouse_event($f[1],0,0,0,[UIntPtr]::Zero)}}",
  "if($i.action -eq 'scroll'){[BranchNodeInput]::mouse_event(2048,0,0,-120*$i.steps,[UIntPtr]::Zero)}",
  "if($i.action -eq 'type'){[System.Windows.Forms.SendKeys]::SendWait($i.sendKeys)}",
  "if($i.action -eq 'key'){$k=@($i.keys|ForEach-Object{[byte]$_});try{foreach($v in $k){[BranchNodeInput]::keybd_event($v,0,0,[UIntPtr]::Zero)}}finally{[array]::Reverse($k);foreach($v in $k){[BranchNodeInput]::keybd_event($v,0,2,[UIntPtr]::Zero)}}}",
].join(";");

/** Text as SendKeys reads it: its own symbols wrapped in braces, a new line as Enter and a tab as Tab. */
export function sendKeysText(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (symbol) => `{${symbol}}`).replace(/\r\n|\n|\r/g, "{ENTER}").replace(/\t/g, "{TAB}");
}

/** Windows: the input as the fixed script's one environment value. `keys` are virtual-key codes for a chord. */
export function windowsInputCommand(input: NodeInput, keys: number[]): OsCommand {
  const sendKeys = input.action === "type" ? sendKeysText(input.text ?? "") : "";
  // Encoded, so the C# inside (which needs double quotes) never meets Windows' argument quoting.
  return { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsInputScript, "utf16le").toString("base64")],
    env: { BRANCH_NODE_INPUT: JSON.stringify({ ...input, keys, sendKeys }) } };
}

/** Linux (X11): the screen's size in pixels, which `linuxInputCommand` needs for a spot. */
export const linuxScreenSizeCommand: OsCommand = { executable: "xdotool", args: ["getdisplaygeometry"] };
export function parseScreenSize(text: string): { width: number; height: number } | null {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** Linux (X11): the input as one xdotool command; text and keys are their own arguments, after "--". */
export function linuxInputCommand(input: NodeInput, size: { width: number; height: number } | null, chord: string | null): OsCommand {
  if (input.action === "type") return { executable: "xdotool", args: ["type", "--delay", "12", "--", input.text ?? ""] };
  if (input.action === "key") return { executable: "xdotool", args: ["key", "--clearmodifiers", "--", chord ?? ""] };
  if (!size) throw new Error("The size of this computer's screen could not be read.");
  const x = String(Math.min(size.width - 1, Math.floor((input.x ?? 0) * size.width)));
  const y = String(Math.min(size.height - 1, Math.floor((input.y ?? 0) * size.height)));
  const move = ["mousemove", "--sync", x, y];
  if (input.action === "scroll") {
    const steps = input.steps ?? 1;
    return { executable: "xdotool", args: [...move, "click", "--repeat", String(Math.abs(steps)), steps > 0 ? "5" : "4"] };
  }
  const button = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
  return { executable: "xdotool", args: [...move, "click", "--repeat", String(input.count), button] };
}

/**
 * computer-control: while the owner holds this computer from Branch, a window stays on top of everything saying so,
 * with a Stop that ends the hold here. Its title is fixed; the owner's name is its only text, passed as data.
 */
export const noticeTitle = "Branch: being used";
/** The notice's words: the owner's name, without control characters and kept short. */
export function noticeText(owner: string): string {
  const name = owner.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) || "its owner";
  return `Being used from Branch by ${name}`;
}
export const windowsNoticeScript = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "$f=New-Object System.Windows.Forms.Form",
  `$f.Text='${noticeTitle}'`,
  "$f.TopMost=$true",
  // Without a taskbar button the form is owned by WinForms' own hidden window, so Windows does not turn its first
  // showing into the "hidden" the notice's program was started with (windowsHide), as the screen banners already do.
  "$f.ShowInTaskbar=$false",
  "$f.ControlBox=$false",
  "$f.FormBorderStyle='FixedToolWindow'",
  "$f.StartPosition='Manual'",
  "$f.ClientSize=New-Object System.Drawing.Size(460,56)",
  "$s=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea",
  "$f.Location=New-Object System.Drawing.Point(($s.Left+[int](($s.Width-$f.Width)/2)),($s.Top+8))",
  "$l=New-Object System.Windows.Forms.Label",
  "$l.UseMnemonic=$false",
  "$l.Text=$env:BRANCH_NODE_NOTICE",
  "$l.Location=New-Object System.Drawing.Point(12,18)",
  "$l.Size=New-Object System.Drawing.Size(340,24)",
  "$b=New-Object System.Windows.Forms.Button",
  "$b.Text='Stop'",
  "$b.Location=New-Object System.Drawing.Point(364,12)",
  "$b.Size=New-Object System.Drawing.Size(84,32)",
  "$b.Add_Click({[Console]::Out.WriteLine('stop');$f.Close()})",
  "$f.Controls.Add($l)",
  "$f.Controls.Add($b)",
  "$f.Add_Shown({$f.Activate();[Console]::Out.WriteLine('shown')})",
  "[void]$f.ShowDialog()",
].join(";");

/** The notice on this computer's screen: a topmost window on Windows, xmessage (kept above by wmctrl) on Linux. */
export function noticeCommand(os: NodeOs, owner: string): OsCommand | null {
  if (os === "win32") return { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(windowsNoticeScript, "utf16le").toString("base64")], env: { BRANCH_NODE_NOTICE: noticeText(owner) } };
  if (os === "linux") return { executable: "xmessage", args: ["-title", noticeTitle, "-center", "-buttons", "Stop:10", "-default", "Stop", "-file", "-"],
    input: noticeText(owner) };
  return null;
}
/** Linux: keeps the notice above every other window (asked again until the window is there). */
export const linuxNoticeAboveCommand: OsCommand = { executable: "wmctrl", args: ["-r", noticeTitle, "-b", "add,above"] };
