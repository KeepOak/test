/**
 * Owner ruling (2026-09-30): Full access asks about nothing but the commands Hermes Agent asks about. This is Hermes
 * Agent's dangerous-command list (`DANGEROUS_PATTERNS` and `HARDLINE_PATTERNS` in `tools/approval_detection.py`,
 * https://github.com/NousResearch/hermes-agent at a9a54245, Copyright (c) 2025 Nous Research, MIT; see
 * THIRD_PARTY_NOTICES.md), ported to JavaScript regular expressions. The list is not widened: rows about Hermes's own
 * gateway, updater and config files are left out (Branch's own files are held by src/never-break instead), and no row
 * was added. Hermes refuses its hardline rows even under `--yolo`; here every row is a question, because the owner asked
 * for these to be asked about, never refused. Hermes's default `smart` mode lets a second model approve some of them;
 * asking every time is its `manual` mode.
 *
 * Detection follows Hermes's approach in a smaller form: each row is tried against the command as written, as a shell
 * joins its words, with every `;`, `&&`, `||`, `|` and `&` turned into a new line (so a row anchored to the start of a
 * command sees `git status; rm -rf ~`), and against the text a shell carrier (`bash -c`, `powershell -Command`,
 * `cmd /c`) is handed. Separators inside quotes are split too, so quoted prose can ask where Hermes would not: an
 * extra question, never a missed one.
 */

const cmdPos = String.raw`(?:^|[\n\`]|\$\()\s*(?:sudo\s+(?:-[^\s]+\s+)*)?(?:env\s+(?:\w+=\S*\s+)*)?(?:(?:exec|nohup|setsid|time)\s+)*\s*`;
const rmFlags = String.raw`${cmdPos}rm\s+(-[^\s]*\s+)*`;
const rmPath = (alt: string): string => String.raw`(?:["'](?:${alt})["']|(?:${alt})(?:\s|$|[)\`;|&]))`;
const systemDirs = String.raw`/home|/home/\*|/root|/root/\*|/etc|/etc/\*|/usr|/usr/\*|/var|/var/\*|/bin|/bin/\*|/sbin|/sbin/\*|/boot|/boot/\*|/lib|/lib/\*`;
const pkgOpts = String.raw`(?:-[^\s]+(?:\s+[^-\s][^\s]*)?\s+)*`;
const shells = "bash|sh|zsh|ksh|dash";

const sshPath = String.raw`(?:~|\$home|\$\{home\})/\.ssh(?:/|$)`;
const projectEnv = String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'\`]+/)*\.env(?:\.[^/\s"'\`]+)*)`;
const projectConfig = String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'\`]+/)*config\.yaml)`;
const shellRc = String.raw`(?:~|\$home|\$\{home\})/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b`;
const credentialFiles = String.raw`(?:~|\$home|\$\{home\})/\.(?:netrc|pgpass|npmrc|pypirc)\b`;
const systemConfig = String.raw`(?:/etc/|/private/(?:etc|var|tmp|home)/)`;
const sensitiveTarget = String.raw`(?:${systemConfig}|/dev/sd|${sshPath}|${shellRc}|${credentialFiles})`;
const userSensitive = String.raw`(?:${sshPath}|${shellRc}|${credentialFiles})`;
const projectSensitive = String.raw`(?:${projectEnv}|${projectConfig})`;
const commandTail = String.raw`(?:\s*(?:&&|\|\||;).*)?$`;
const boundary = String.raw`(?=[\s;&|<>"']|$)`;

/** Hermes's hardline rows: refused there under every mode, asked about here. */
const hardline: readonly (readonly [string, string])[] = [
  [rmFlags + rmPath(String.raw`/(?:(?:\.\.?)?/)*(?:\.\.?)?\**|/ \*`), "recursive delete of root filesystem"],
  [rmFlags + rmPath(systemDirs), "recursive delete of system directory"],
  [rmFlags + rmPath(String.raw`(?:~|\$\{?HOME\}?)(?:/?|/\*)?`), "recursive delete of home directory"],
  [cmdPos + String.raw`mkfs(\.[a-z0-9]+)?\b`, "format filesystem (mkfs)"],
  [cmdPos + String.raw`dd\b[^\n]*\bof=/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*`, "dd to raw block device"],
  [String.raw`>\s*/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b`, "redirect to raw block device"],
  [String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, "fork bomb"],
  [cmdPos + String.raw`kill\s+(-[^\s]+\s+)*-1\b`, "kill all processes"],
  [cmdPos + String.raw`(shutdown|reboot|halt|poweroff)\b`, "system shutdown/reboot"],
  [cmdPos + String.raw`init\s+[06]\b`, "init 0/6 (shutdown/reboot)"],
  [cmdPos + String.raw`systemctl\s+(poweroff|reboot|halt|kexec)\b`, "systemctl poweroff/reboot"],
  [cmdPos + String.raw`telinit\s+[06]\b`, "telinit 0/6 (shutdown/reboot)"],
];

/** Hermes's dangerous rows, in its order, less the ones about Hermes itself. */
const dangerous: readonly (readonly [string, string])[] = [
  [String.raw`\brm\s+(-[^\s]*\s+)*/`, "delete in root path"],
  [String.raw`\brm\s+-[^\s]*r`, "recursive delete"],
  [String.raw`\brm\s+--recursive\b`, "recursive delete (long flag)"],
  [String.raw`\brm\s+(?!--(?:\s|$))(?:(?!\s--(?:\s|$))[^\n"';|&])*\s(?:-[a-z]*r[a-z]*\b|--recursive\b)`, "recursive delete (flags after operands)"],
  [String.raw`\bcmd(?:\.exe)?\s+/(?:c|k)\s+.*\b(?:del|erase|rd|rmdir)\b`, "Windows cmd destructive delete"],
  [String.raw`\b(?:powershell|pwsh)(?:\.exe)?\b(?:\s+-\S+)*\s+(?:-(?:command|c)\s+)?["']?(?:remove-item|rmdir|erase|del|rd|ri|rm)\b`, "Windows PowerShell destructive delete"],
  [String.raw`\b(?:powershell|pwsh)(?:\.exe)?\b.*\s-(?:encodedcommand|enc|e)\b`, "PowerShell encoded command execution"],
  [String.raw`\bremove-item\b[^\n;|&]*\s-(?:recurse|force)\b`, "PowerShell destructive delete (Remove-Item)"],
  [String.raw`\b(?:del|erase|rd|rmdir)\s+(?:/[a-z]\s+)*/[sq]\b`, "Windows destructive delete (recursive/quiet switch)"],
  [String.raw`\b(?:iwr|invoke-webrequest|invoke-restmethod|irm|curl|wget)\b[^\n]*\|\s*(?:iex|invoke-expression)\b`, "pipe remote content to PowerShell (iwr | iex)"],
  [String.raw`\b(?:iex|invoke-expression)\s*\(\s*(?:iwr|invoke-webrequest|invoke-restmethod|irm)\b`, "execute remote content via Invoke-Expression"],
  [String.raw`\btaskkill\b[^\n]*\s/f\b`, "force kill processes (taskkill /F)"],
  [String.raw`\bstop-process\b[^\n]*\s-force\b`, "force kill processes (Stop-Process -Force)"],
  [String.raw`\bformat-volume\b`, "format filesystem (Format-Volume)"],
  [String.raw`\bclear-disk\b`, "wipe disk (Clear-Disk)"],
  [String.raw`\bdiskpart\b`, "disk partitioning (diskpart)"],
  [String.raw`\bformat(?:\.com)?\s+[a-z]:`, "format drive (format.com)"],
  [String.raw`\bcipher\s+/w\b`, "wipe free space (cipher /w)"],
  [String.raw`\bicacls\b[^\n]*\s/grant\b[^\n]*\b(?:everyone|todos|jeder|tout\s+le\s+monde|\*s-1-1-0)\b`, "grant Everyone access (icacls)"],
  [String.raw`\bicacls\b[^\n]*\s/reset\b`, "reset ACLs recursively (icacls /reset)"],
  [String.raw`\bvssadmin\b[^\n]*\bdelete\s+shadows\b`, "delete volume shadow copies (vssadmin)"],
  [String.raw`\bwbadmin\b[^\n]*\bdelete\b`, "delete backups (wbadmin)"],
  [String.raw`\bbcdedit\b[^\n]*\s/set\b`, "modify boot configuration (bcdedit /set)"],
  [String.raw`\breg(?:\.exe)?\s+delete\b`, "registry delete (reg delete)"],
  [String.raw`\bremove-itemproperty\b[^\n]*\s-force\b`, "registry value delete (Remove-ItemProperty -Force)"],
  [String.raw`\bstop-service\b[^\n]*\s-force\b`, "force stop service (Stop-Service -Force)"],
  [String.raw`\bsc(?:\.exe)?\s+(?:stop|delete)\b`, "stop/delete service (sc)"],
  [String.raw`\busers[\\/][^\\/\s]+[\\/]\.ssh\b`, "access to SSH keys (Windows path)"],
  [String.raw`\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b`, "world/other-writable permissions"],
  [String.raw`\bchmod\s+--recursive\b.*(777|666|o\+[rwx]*w|a\+[rwx]*w)`, "recursive world/other-writable (long flag)"],
  [String.raw`\bchown\s+(-[^\s]*)?R\s+root`, "recursive chown to root"],
  [String.raw`\bchown\s+--recur[a-z]*\b.*root`, "recursive chown to root (long flag)"],
  [cmdPos + String.raw`mkfs\b`, "format filesystem"],
  [cmdPos + String.raw`dd\s+.*if=`, "disk copy"],
  [String.raw`>\s*/dev/sd`, "write to block device"],
  [String.raw`\bDROP\s+(TABLE|DATABASE)\b`, "SQL DROP"],
  [String.raw`\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)`, "SQL DELETE without WHERE"],
  [String.raw`\bTRUNCATE\s+(TABLE)?\s*\w`, "SQL TRUNCATE"],
  [String.raw`>\s*${systemConfig}`, "overwrite system config"],
  [String.raw`\bsystemctl\s+(-[^\s]+\s+)*(stop|restart|disable|mask)\b`, "stop/restart system service"],
  [String.raw`\bkill\s+-9\s+-1\b`, "kill all processes"],
  [String.raw`\bpkill\s+-9\b`, "force kill processes"],
  [String.raw`\bkillall\s+(-[^\s]*\s+)*-(9|KILL|SIGKILL)\b`, "force kill processes (killall -KILL)"],
  [String.raw`\bkillall\s+(-[^\s]*\s+)*-s\s+(KILL|SIGKILL|9)\b`, "force kill processes (killall -s KILL)"],
  [String.raw`\bkillall\s+(-[^\s]*\s+)*-r\b`, "kill processes by regex (killall -r)"],
  [String.raw`\b(curl|wget)\b.*\|\s*(?:[/\w]*/)?(?:${shells})(?:\s|$|-c)`, "pipe remote content to shell"],
  [String.raw`\b(?:${shells})\s+<\s*<?\s*\(\s*(curl|wget)\b`, "execute remote script via process substitution"],
  [String.raw`(?:\beval\b|\bsource\b|\.)\s*(?:\$\(\s*|\`\s*)(?:curl|wget)\b`, "execute remote content via command substitution"],
  [String.raw`(?<![\d.])(?:169\.254\.169\.254|100\.100\.100\.200)(?![\d.])|(?<![\w.-])metadata\.google\.internal(?![\w.-])|fd00:ec2::254`, "cloud metadata endpoint access (instance credentials)"],
  [String.raw`\b(base64|base32|base16)\s+(?:-[dD]|--decode)\b.*\|\s*\b(?:${shells})\b`, "pipe decoded content to shell (possible command obfuscation)"],
  [String.raw`\bxxd\s+-r\b.*\|\s*\b(?:${shells})\b`, "pipe xxd-decoded content to shell (possible command obfuscation)"],
  [String.raw`\becho\b[^|]*\|\s*\btr\b[^|]*\|\s*\b(?:${shells})\b`, "pipe tr-transformed output to shell (possible command obfuscation)"],
  [String.raw`\bopenssl\b.*\b(?:base64|enc)\b[^|]*\s+-[dD]\b[^|]*\|\s*\b(?:${shells})\b`, "pipe openssl-decoded content to shell (possible command obfuscation)"],
  [String.raw`\btee\b.*["']?${sensitiveTarget}`, "overwrite system file via tee"],
  [String.raw`>>?\s*["']?${sensitiveTarget}`, "overwrite system file via redirection"],
  [String.raw`\btee\b.*["']?${projectSensitive}["']?${boundary}`, "overwrite project env/config via tee"],
  [String.raw`>>?\s*["']?${projectSensitive}["']?${boundary}`, "overwrite project env/config via redirection"],
  [String.raw`\bxargs\s+.*\brm\b`, "xargs with rm"],
  [String.raw`\bfind\b.*-exec(?:dir)?\s+(/\S*/)?rm\b`, "find -exec/-execdir rm"],
  [cmdPos + String.raw`find\s[^;|&\n]*(?<!\S)-(?:\{[^}\s]*(?:delete|exec(?:dir)?)[^}\s]*\}|(?:del(?:ete?)?|exec(?:dir)?)[*?\[])`, "find dynamic shell word may expand to destructive flag"],
  [String.raw`\bfind\b.*-delete\b`, "find -delete"],
  [String.raw`\b(?:rg|sort|ag|man)\b[^;|&\n]*(?<!\S)--(?:pre|hostname-bin|compress-program|pager|html)(?:\{|[*?\[])`, "dynamic shell word may expand to arbitrary program execution flag"],
  [String.raw`\bdocker\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(?:-h|--host)[=\s]+\S+`, "docker with remote daemon redirect (-H/--host)"],
  [String.raw`\bdocker\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(?:-c|--context)[=\s]+\S+`, "docker with daemon redirect (--context: alternate daemon)"],
  [String.raw`\bdocker\s+context\s+use\b`, "docker context use (switches default daemon for future commands)"],
  [String.raw`\bpodman\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(?:--url|--connection|--identity)[=\s]+\S+`, "podman with remote daemon redirect (--url/--connection/--identity)"],
  [String.raw`\bpodman\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(?:-r\b|--remote\b)`, "podman remote mode (-r/--remote: remote daemon)"],
  [String.raw`\b(?:docker_host|docker_context|container_host|container_connection)=\S+`, "docker/podman daemon redirect via environment (DOCKER_HOST/CONTAINER_HOST)"],
  [String.raw`\bdocker(?:-compose|\s+compose)\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(restart|stop|kill|down)\b`, "docker compose restart/stop/kill/down (container lifecycle)"],
  [String.raw`\bdocker\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(restart|stop|kill)\b`, "docker restart/stop/kill (container lifecycle)"],
  [String.raw`\bkill\b.*\$\(\s*(pgrep|pidof)\b`, "kill process via pgrep/pidof expansion"],
  [String.raw`\bkill\b.*\`\s*(pgrep|pidof)\b`, "kill process via backtick pgrep/pidof expansion"],
  [String.raw`\b(cp|mv|install)\b.*\s${systemConfig}`, "copy/move file into system config path"],
  [String.raw`\b(cp|mv|install)\b.*\s["']?${projectSensitive}["']?${commandTail}`, "overwrite project env/config file"],
  [String.raw`\b(cp|mv|install)\b.*\s["']?${sensitiveTarget}[^\s"']*["']?${commandTail}`, "copy/move file into sensitive credential/SSH/shell-rc path"],
  [String.raw`\bsed\s+-[^\s]*i.*(?:${userSensitive})[^\s"']*`, "in-place edit of sensitive credential/SSH/shell-rc path"],
  [String.raw`\bsed\s+--in-place\b.*(?:${userSensitive})[^\s"']*`, "in-place edit of sensitive credential/SSH/shell-rc path (long flag)"],
  [String.raw`\b(?:perl|ruby)\b.*(?:^|\s)-[^\s]*i\b.*(?:${userSensitive})[^\s"']*`, "in-place edit of sensitive credential/SSH/shell-rc path (perl/ruby)"],
  [String.raw`\bsed\s+-[^\s]*i.*\s${systemConfig}`, "in-place edit of system config"],
  [String.raw`\bsed\s+--in-place\b.*\s${systemConfig}`, "in-place edit of system config (long flag)"],
  [String.raw`\b(?:${shells})\s+<<`, "shell execution via heredoc"],
  [String.raw`\bgit\s+reset\s+--h(?:a(?:r(?:d)?)?)?\b`, "git reset --hard (destroys uncommitted changes)"],
  [String.raw`\bgit\s+push\b.*--forc[a-z]*\b`, "git force push (rewrites remote history)"],
  [String.raw`\bgit\s+push\b.*-f\b`, "git force push short flag (rewrites remote history)"],
  [String.raw`\bgit\s+clean\s+-[^\s]*f`, "git clean with force (deletes untracked files)"],
  [String.raw`\bgit\s+branch\s+(?-i:-D)\b`, "git branch force delete"],
  [String.raw`\bgit\s+branch\b[^;|&\n]*?(?:-d\b|--delete\b)[^;|&\n]*?(?:-f\b|--force\b)`, "git branch force delete (long flags)"],
  [String.raw`\bgit\s+branch\b[^;|&\n]*?(?:-f\b|--force\b)[^;|&\n]*?(?:-d\b|--delete\b)`, "git branch force delete (long flags, force-first)"],
  [String.raw`\bchmod\s+\+x\b.*[;&|]+\s*\./`, "chmod +x followed by immediate execution"],
  [String.raw`\bsudo\b[^;|&\n]*?\s+(?:-s\b|--st[a-z]*\b|-a\b|--a[a-z]*\b)`, "sudo with privilege flag (stdin/askpass/shell/list)"],
  [String.raw`\bsudo\b[^;|&\n]*?\s+-[a-z]*[sa][a-z]*\b`, "sudo with combined-flag privilege escalation"],
  [cmdPos + String.raw`npm\s+${pkgOpts}(?:uninstall|unlink|remove|rm|r|un)\b`, "package manager uninstall"],
  [cmdPos + String.raw`pnpm\s+${pkgOpts}(?:uninstall|remove|rm|un)\b`, "package manager uninstall"],
  [cmdPos + String.raw`yarn\s+${pkgOpts}(?:global\s+)?(?:uninstall|remove)\b`, "package manager uninstall"],
  [cmdPos + String.raw`pip(?:3)?\s+${pkgOpts}uninstall\b`, "package manager uninstall"],
  [cmdPos + String.raw`brew\s+${pkgOpts}(?:uninstall|remove|rm)\b`, "package manager uninstall"],
];

/** Hermes compiles every row case-insensitive and dot-all. */
const compiled = [...hardline, ...dangerous].map(([pattern, description]) => [new RegExp(pattern, "is"), description] as const);

/** The text a shell carrier runs: `bash -c "..."`, `powershell -Command '...'`, `cmd /c "..."`. */
const carrier = /\b(?:bash|sh|zsh|ksh|dash|pwsh|powershell|cmd)(?:\.exe)?\b[^"'\n]*?\s(?:-c|-command|\/c|\/k)\s+(["'])([\s\S]*?)\1/gi;

/** The forms of one command the rows are tried against (see the file's note). */
export function commandVariants(command: string, joined: string): string[] {
  const split = (text: string): string => text.replace(/&&|\|\||[;|&]/g, "\n");
  const carried = [...command.matchAll(carrier)].map((match) => match[2] ?? "");
  return [...new Set([command, joined, split(command), split(joined), ...carried, ...carried.map(split)])];
}

/** What Hermes Agent's list says this command is, or null when it is on none of its rows. */
export function dangerousCommand(command: string, joined = command): string | null {
  for (const variant of commandVariants(command, joined))
    for (const [pattern, description] of compiled) if (pattern.test(variant)) return description;
  return null;
}
