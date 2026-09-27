/**
 * Reading a launch line the way the program it starts would read it, for the workspace guard (src/mcp-workspace-guard.ts).
 * Nothing here runs anything or touches a file: it only says what a line would run.
 * - `launches` unwraps a program that starts another: `cmd /c …`, `bash -c "…"` (sh, zsh, dash, ksh, ash, fish),
 *   `powershell`/`pwsh -Command …` or `-EncodedCommand …` (decoded from UTF-16LE base64), `wsl [--|-e] …` and
 *   `python -m pip|uv|…`. The command string a shell is given is kept as text, so the guard can read it too.
 * - `entryOf` finds the program or script an interpreter runs, stepping over the options that take a value first
 *   (`node -r x <entry>`, `python -X opt <entry>`, `npx --registry r <entry>`).
 * - `inlineCode`, `packageSources` and `folderValues` pick out the code, package sources and folder-changing options.
 */
import { basename } from "node:path";
import { firstArgument, npmValued, uvValued } from "./security-audit/package-launch.js";

/** One program in a launch line. `module`: run by an interpreter (`python -m pip`), so not looked up as a program. */
export interface Launch { command: string; args: readonly string[]; module: boolean; texts: string[]; folders: string[] }

/** The app's own program runs as Node (`runAsNode`, src/child-env.ts), so it is judged as node. */
export const programName = (command: string): string =>
  command === process.execPath ? "node" : basename(command).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
export const isPython = (name: string): boolean => name === "py" || /^python(\d+(\.\d+)*)?w?$/.test(name);
/** `--config=<file>` names a file as surely as `<file>` does. */
export const valueOf = (arg: string): string | undefined => /^--?[^=\s]+=([\s\S]+)$/.exec(arg)?.[1];

const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
const nodeLike = new Set(["node", "bun", "tsx"]);
/** Node options that take the next argument as their value (`node -r x srv.js`). */
const nodeValued = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions",
  "--inspect-port", "--debug-port", "--title", "--env-file", "--env-file-if-exists", "--input-type", "--watch-path",
  "--redirect-warnings", "--diagnostic-dir", "--report-dir", "--report-directory", "--report-filename", "--report-signal",
  "--heapsnapshot-signal", "--cpu-prof-dir", "--cpu-prof-name", "--heap-prof-dir", "--heap-prof-name", "--icu-data-dir",
  "--openssl-config", "--tls-keylog", "--disable-warning", "--localstorage-file", "--stack-trace-limit", "--dns-result-order",
  "--experimental-sea-config", "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--run", "--preload",
  "--cwd", "--config", "-c", "--tsconfig"]);
const pythonValued = new Set(["--check-hash-based-pycs"]);
/** Programs that fetch and run a package, and the options that say where from. */
const packageRunners = new Set(["npx", "npm", "pnpm", "pnpx", "bunx", "yarn", "uvx", "uv", "pip", "pip3", "pipx"]);
const packageOptions = ["--package", "-p", "--prefix", "--from", "--with", "-w", "--with-editable", "--spec"];
const editableRunners = new Set(["pip", "pip3", "uv", "uvx", "pipx"]);
/** Options that move a runner into another folder, where it then finds and runs what is there. */
const folderOptions: Record<string, string[]> = {
  npm: ["-C", "--prefix", "-w", "--workspace"], npx: ["-C", "--prefix", "-w", "--workspace"],
  pnpm: ["-C", "--dir"], pnpx: ["-C", "--dir"], yarn: ["--cwd"], bun: ["--cwd"], bunx: ["--cwd"],
  uv: ["--directory", "--project"], uvx: ["--directory", "--project"],
};

/** Every value given to one of `options`: `--opt=value`, `--opt value`, or `-ovalue` for a one-letter option. */
export function optionValues(args: readonly string[], options: readonly string[]): string[] {
  const values: string[] = [];
  args.forEach((arg, at) => {
    const option = options.find((known) => arg === known || arg.startsWith(`${known}=`) || (known.length === 2 && arg.startsWith(known)));
    if (!option) return;
    const rest = arg.slice(option.length).replace(/^=/, "");
    values.push(rest || (args[at + 1] ?? ""));
  });
  return values;
}

/**
 * The words of a command line, split the way the shell that reads it does: quoted and unquoted pieces next to each other
 * make one word (`work"sp"ace`, `'wo'rk`). With `posix` (sh, bash …), a backslash outside single quotes escapes the next
 * character, and inside double quotes escapes `"`, `\`, `$` and a backtick; elsewhere (cmd, PowerShell) a backslash is
 * part of a path.
 */
function words(line: string, posix: boolean): string[] {
  const all: string[] = [];
  let word: string | null = null;
  for (let at = 0; at < line.length; at++) {
    const letter = line[at]!;
    if (/\s/.test(letter)) { if (word !== null) all.push(word); word = null; continue; }
    word ??= "";
    if (posix && letter === "\\") { word += line[++at] ?? ""; continue; }
    if (letter !== '"' && letter !== "'") { word += letter; continue; }
    for (at++; at < line.length && line[at] !== letter; at++) {
      if (posix && letter === '"' && line[at] === "\\" && '"\\$`'.includes(line[at + 1] ?? "")) at++;
      word += line[at] ?? "";
    }
  }
  if (word !== null) all.push(word);
  return all;
}
/** A command line as a program and its arguments; PowerShell's `&` and `.` and a shell's `exec` or cmd's `call` step aside. */
function fromLine(line: string, posix: boolean): string[] {
  const all = words(line, posix);
  while (all.length && ["&", ".", "exec", "call"].includes(all[0]!.toLowerCase())) all.shift();
  return all;
}
/** cmd reads `^x` as `x` outside quotes; PowerShell reads `` `x `` as `x`. */
const uncaret = (text: string): string => text.replace(/\^([\s\S])/g, "$1");
const unbacktick = (text: string): string => text.replace(/`([\s\S])/g, "$1");

/**
 * A command string a launch is given: kept as text as written, as its escapes read (cmd's `^`, PowerShell's backtick),
 * and as the words its shell makes of it joined up again, so a name split by quotes or escapes reads whole. Returns the
 * program and arguments it runs.
 */
function commandLine(own: Launch, text: string, how: "posix" | "cmd" | "powershell"): string[] {
  const read = how === "cmd" ? uncaret(text) : how === "powershell" ? unbacktick(text) : text;
  const argv = fromLine(read, how === "posix");
  own.texts.push(...new Set([text, read, words(read, how === "posix").join(" ")]));
  return argv;
}

/** Node (and bun, tsx): the inline code (-e/--eval/-p/--print, `-pe`) or the entry, whichever comes first. `bun run x` runs x. */
function readNode(args: readonly string[], bun = false): { code?: string; entry?: string | undefined } {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") return { entry: args[at + 1] };
    const joined = /^(?:--eval|--print|-e|-p)=([\s\S]*)$/.exec(arg);
    if (joined) return { code: joined[1]! };
    if (/^(?:--eval|--print|-[a-zA-Z]*[ep][a-zA-Z]*)$/.test(arg)) return { code: args[at + 1] ?? "" };
    if (arg === "-") return {};
    if (!arg.startsWith("-")) return bun && arg === "run" ? readNode(args.slice(at + 1)) : { entry: arg };
    if (!arg.includes("=") && nodeValued.has(arg)) at++;
  }
  return {};
}

/**
 * Python: `-c code`, `-m module …` or the script, whichever comes first. Letters in a cluster are switches up to c or m
 * (`-Ic`, `-cCODE`, `-mpip`); W, X and Q take the rest of the cluster, or the next argument, as their value.
 */
function readPython(args: readonly string[]): { code?: string; module?: string | undefined; rest?: readonly string[]; entry?: string | undefined } {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") return { entry: args[at + 1] };
    if (arg === "-") return {};
    if (!arg.startsWith("-")) return { entry: arg };
    if (arg.startsWith("--")) { if (pythonValued.has(arg)) at++; continue; }
    for (let letter = 1; letter < arg.length; letter++) {
      const which = arg[letter]!, attached = arg.slice(letter + 1);
      if (which === "c") return { code: attached || (args[at + 1] ?? "") };
      if (which === "m") return { module: attached || args[at + 1], rest: args.slice(attached ? at + 1 : at + 2) };
      if ("WXQ".includes(which)) { if (!attached) at++; break; }
    }
  }
  return {};
}

/** The command string a POSIX shell (or fish) is given with -c (`-lc`, `-ec` …) or `--command`; none for a script. */
function readShell(args: readonly string[]): string | undefined {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg.startsWith("--command=")) return arg.slice("--command=".length);
    if (arg === "--command" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) return args[at + 1] ?? "";
    if (arg === "--" || !/^[-+]/.test(arg)) return undefined;
    if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(arg)) at++;
  }
  return undefined;
}

const psValued = ["executionpolicy", "ex", "ep", "windowstyle", "w", "version", "v", "configurationname", "config",
  "outputformat", "o", "of", "inputformat", "in", "if", "psconsolefile", "custompipename", "settingsfile", "encodedarguments", "ea"];
/**
 * PowerShell: the command it runs (-Command/-c and its prefixes, -CommandWithArgs, or -EncodedCommand decoded from
 * UTF-16LE base64), and -WorkingDirectory. Windows PowerShell reads a bare first argument as a command; pwsh as a file.
 */
function readPowershell(name: string, args: readonly string[]): { text?: string; folders: string[] } {
  const folders: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const found = /^(?:--?|\/)([a-z]+)$/i.exec(args[at]!);
    if (!found) return name === "pwsh" ? { folders } : { text: args.slice(at).join(" "), folders };
    const said = found[1]!.toLowerCase();
    const is = (full: string): boolean => said.length >= 2 && full.startsWith(said);
    if (said === "c" || is("command") || said === "cwa" || said === "commandwithargs") return { text: args.slice(at + 1).join(" "), folders };
    if (said === "e" || said === "ec" || is("encodedcommand")) return { text: Buffer.from(args[at + 1] ?? "", "base64").toString("utf16le"), folders };
    if (said === "f" || is("file")) return { folders };
    if (said === "wd" || is("workingdirectory")) folders.push(args[++at] ?? "");
    else if (psValued.includes(said)) at++;
  }
  return { folders };
}

const wslValued = new Set(["-d", "--distribution", "-u", "--user", "--shell-type", "--distribution-id"]);
/** wsl: the command after `--`, `-e`/`--exec`, or its options; and `--cd`, the folder it starts in. */
function readWsl(args: readonly string[]): { inner?: readonly string[]; folders: string[] } {
  const folders: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--" || arg === "-e" || arg === "--exec") return { inner: args.slice(at + 1), folders };
    if (arg === "--cd") folders.push(args[++at] ?? "");
    else if (wslValued.has(arg)) at++;
    else if (!arg.startsWith("-")) return { inner: args.slice(at), folders };
  }
  return { folders };
}

/** cmd: what follows /c, /k or /r: one argument is a command line; several are a program and its arguments. */
function readCmd(args: readonly string[]): { rest?: string[] } {
  const at = args.findIndex((arg) => /^\/[ckr]/i.test(arg));
  if (at < 0) return {};
  const attached = args[at]!.slice(2);
  return { rest: [...(attached ? [attached] : []), ...args.slice(at + 1)] };
}

/** The program a launch starts inside itself, if any, filling in the text and folders the outer one is given. */
function innerOf(name: string, own: Launch): { argv: readonly string[]; module: boolean } | null {
  const run = (argv: readonly string[]) => ({ argv, module: false });
  if (name === "cmd") {
    const { rest } = readCmd(own.args);
    if (!rest) return null;
    return run(rest.length === 1 ? commandLine(own, rest[0]!, "cmd") : rest.map(uncaret));
  }
  if (shells.has(name)) {
    const text = readShell(own.args);
    return text === undefined ? null : run(commandLine(own, text, "posix"));
  }
  if (name === "powershell" || name === "pwsh") {
    const { text, folders } = readPowershell(name, own.args);
    own.folders.push(...folders);
    return text === undefined ? null : run(commandLine(own, text, "powershell"));
  }
  if (name === "wsl") {
    const { inner, folders } = readWsl(own.args);
    own.folders.push(...folders);
    if (inner?.length === 1 && /\s/.test(inner[0]!)) return run(commandLine(own, inner[0]!, "posix"));
    return inner ? run(inner) : null;
  }
  if (isPython(name)) {
    const { module, rest } = readPython(own.args);
    return module ? { argv: [module, ...(rest ?? [])], module: true } : null;
  }
  return null;
}

/** The launch and every program it starts inside itself, outermost first (at most six deep). */
export function launches(command: string, args: readonly string[], module = false, depth = 0): Launch[] {
  const own: Launch = { command, args, module, texts: [], folders: [] };
  const inner = innerOf(module ? command.toLowerCase() : programName(command), own);
  if (!inner || !inner.argv[0] || depth >= 5) return [own];
  return [own, ...launches(inner.argv[0], inner.argv.slice(1), inner.module, depth + 1)];
}

/** The name a launch is judged by. */
export const nameOf = (launch: Launch): string => (launch.module ? launch.command.toLowerCase() : programName(launch.command));

/** The program or script an interpreter runs, past the options that take a value. */
export function entryOf(name: string, args: readonly string[]): string | undefined {
  if (nodeLike.has(name)) return readNode(args, name === "bun").entry;
  if (isPython(name)) return readPython(args).entry;
  if (name === "npx" || name === "bunx") return firstArgument(args, npmValued) ?? undefined;
  if (name === "uvx") return firstArgument(args, uvValued) ?? undefined;
  return undefined;
}

/** The text of a `data:` URL (what `node --import data:text/javascript,…` runs), or null for anything else. */
function dataText(text: string): string | null {
  const found = /^data:([^,]*),([\s\S]*)$/i.exec(text);
  if (!found) return null;
  if (/;base64$/i.test(found[1]!)) return Buffer.from(found[2]!, "base64").toString("utf8");
  try { return decodeURIComponent(found[2]!); } catch { return found[2]!; }
}

/** Every piece of inline code a launch runs: -e/-c and the like, `deno eval`, `npx -c`, and any `data:` URL. */
export function inlineCode(name: string, args: readonly string[]): string[] {
  const code = args.flatMap((arg) => [arg, valueOf(arg)]).flatMap((text) => {
    const data = text === undefined ? null : dataText(text);
    return data === null ? [] : [data];
  });
  const own = nodeLike.has(name) ? readNode(args, name === "bun").code : isPython(name) ? readPython(args).code : undefined;
  if (own !== undefined) code.push(own);
  if (name === "deno" && args.includes("eval")) code.push(...args.slice(args.indexOf("eval") + 1).filter((arg) => !arg.startsWith("-")));
  if (name === "npx" || name === "npm") code.push(...optionValues(args, ["-c", "--call"]));
  return code;
}

/** Where a package runner is told to take its package from. */
export function packageSources(name: string, args: readonly string[]): string[] {
  if (!packageRunners.has(name)) return [];
  return optionValues(args, editableRunners.has(name) ? [...packageOptions, "-e", "--editable"] : packageOptions);
}

/** The folders a runner is told to move into (npm -C, pnpm --dir, yarn/bun --cwd, uv --directory …). */
export const folderValues = (name: string, args: readonly string[]): string[] => optionValues(args, folderOptions[name] ?? []);
/** The settings file deno is told to read (it can map imports to code anywhere). */
export const denoConfig = (name: string, args: readonly string[]): string[] => (name === "deno" ? optionValues(args, ["--config", "-c"]) : []);
