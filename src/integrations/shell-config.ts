import { basename, isAbsolute, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { z } from 'zod';

// The last five are for macOS and Linux shells; a Windows computer does not normally have them.
const safeKey = z.enum(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'CI', 'NO_COLOR',
  'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL']);
const argument = z.string().max(4000).refine(value => !value.includes('\0'), 'NUL is not permitted');
export const ShellConfigSchema = z.object({
  executables: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/), z.object({
    path: z.string().min(1).max(1000).refine(isAbsolute, 'Executable path must be absolute'),
    args: z.array(argument).max(40).default([]),
  }).strict()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16, 'Configure 1-16 executable aliases'),
  inheritEnv: z.array(safeKey).max(12).default(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']),
  env: z.partialRecord(safeKey, z.string().max(4000).refine(value => !value.includes('\0'))).default({}),
  // selfdev: up to 30 minutes, as long as a coding assistant's own command may run (a build and its tests).
  timeoutMs: z.number().int().min(100).max(1_800_000).default(30000),
  /** A command using more memory than this (sampled about once a second) is stopped. */
  maxMemoryMb: z.number().int().min(16).max(16384).default(1024),
  /** A command using more processor time than this is stopped. */
  maxCpuSeconds: z.number().int().min(1).max(7200).default(60),
  maxOutputBytes: z.number().int().min(256).max(8192).default(8192),
  /** Point commands at a dead address so ones that respect proxy settings cannot reach the internet. */
  netless: z.boolean().default(false),
  /** Use a Windows job so the operating system itself enforces the limits, where that is possible. */
  useJobObject: z.boolean().default(true),
}).strict();
export type ShellConfig = z.infer<typeof ShellConfigSchema>;
export const ShellInputSchema = z.object({
  executable: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/),
  args: z.array(argument).max(80).default([]),
  cwd: z.string().min(1).max(500).default('.'),
  timeoutMs: z.number().int().min(100).max(1_800_000).optional(),
  /** Names of the active project's secrets to expose to the program as environment variables. */
  secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(8).default([]),
  /** Run this one command with no way out to the internet, on top of whatever the settings say. */
  netless: z.boolean().optional(),
}).strict();
export type ShellInput = z.infer<typeof ShellInputSchema>;

/**
 * "No internet" for a command, as far as a desktop app can manage it without asking for
 * administrator rights: every well-behaved tool is pointed at a dead address on this computer, so
 * it fails at once instead of reaching a website. A program that ignores proxy settings and opens
 * its own connection is not stopped by this, which is why it is described as best effort.
 */
export const deadProxy = 'http://127.0.0.1:9';
export function netlessEnvironment(): NodeJS.ProcessEnv {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY'];
  const result: NodeJS.ProcessEnv = { NO_PROXY: '', no_proxy: '' };
  for (const name of names) { result[name] = deadProxy; result[name.toLowerCase()] = deadProxy; }
  return result;
}

export function shellEnvironment(config: ShellConfig, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // libuv may supply the host PATH on Windows when it is absent; explicitly clear it.
  const result: NodeJS.ProcessEnv = { PATH: '' };
  for (const key of config.inheritEnv) {
    const entry = Object.entries(source).find(([name]) => process.platform === 'win32' ? name.toUpperCase() === key : name === key);
    if (entry?.[1]) result[key] = entry[1];
  }
  return { ...result, ...config.env };
}

/** How a full address begins, in the owner's words: from the drive on Windows, from `/` elsewhere. */
export const fromTheTop = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'starting from the drive' : 'starting with /';

/**
 * The command line a person would expect on each computer: PowerShell on Windows (unchanged), zsh
 * on macOS, and on Linux the one the person chose (`$SHELL`) or bash. This only suggests a program;
 * nothing runs until the owner adds it to the list of programs commands may be run with.
 */
export function defaultShellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): { path: string; args: string[] } {
  if (platform === 'win32')
    return { path: `${env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoProfile', '-NonInteractive', '-Command', '-'] };
  if (platform === 'darwin') return { path: '/bin/zsh', args: ['-f'] };
  const chosen = env.SHELL;
  const usable = chosen && isAbsolute(chosen) && /^(bash|zsh|sh|dash|ksh)$/.test(basename(chosen));
  return { path: usable ? chosen : '/bin/bash', args: [] };
}

/**
 * One argument written so the named shell reads it back unchanged. For a person composing a line to
 * send to a kept-open command line; commands Branch Agent starts itself never go through a shell.
 */
export function quoteForShell(shell: string, value: string): string {
  if (value.includes('\0')) throw new Error('NUL is not permitted');
  const name = basename(shell.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (name === 'powershell' || name === 'pwsh') return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
  if (name === 'cmd') throw new Error('cmd.exe has no safe way to quote an argument; use PowerShell');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Names macOS and Linux programs need from the host that a Windows computer does not have. */
export function posixEnvironment(names: readonly string[], source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform === 'win32') return {};
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name]) result[name] = source[name];
  return result;
}

export async function validateExecutables(config: ShellConfig): Promise<void> {
  for (const executable of Object.values(config.executables)) {
    if (executable.path.includes('\0') || /\.(cmd|bat)$/i.test(executable.path))
      throw new Error('Configure a native executable; Windows npm may use node.exe with a fixed npm-cli.js argument');
    if (!(await stat(executable.path)).isFile()) throw new Error('Configured executable is not a file');
  }
}

/**
 * Q12: the one answer to "where does this command run". A command's `cwd` is read from the
 * workspace itself, never from the active project's folder. `shell.execute` runs there, and the
 * self-development contract (src/self-development-contract.ts) judges exactly the same folder.
 */
export function commandFolder(workspace: string, cwd: string | undefined): string {
  return resolve(workspace, cwd ?? '.');
}
