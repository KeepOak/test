/**
 * Which published package a command line would download and run.
 *
 * `npx some-server`, `uvx some-server` and `pipx run some-server` fetch whatever is published under
 * that name and run it at once. That is the moment a known-malicious package would get in, so the
 * malware check (src/security-audit/malware-check.ts) looks the name up first. This file only reads
 * the command line; it never runs anything.
 *
 * The approach — find the first real argument, honour `--from`/`--package`, split name from version,
 * and give up quietly on anything that is not a plain registry name — is adapted from Goose's
 * `crates/goose/src/agents/extension_malware_check.rs` (Apache-2.0, Block, Inc.).
 */

export type Ecosystem = "npm" | "PyPI";
export interface PackageRef {
  ecosystem: Ecosystem;
  name: string;
  /** An exact version when the command names one; null means "whatever is newest". */
  version: string | null;
}

const programName = (command: string): string =>
  (command.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(cmd|exe|ps1|bat)$/, "");

/** Options of npx/uvx/pipx that take the next argument as their value. */
export const npmValued = new Set([
  "-p", "--package", "-c", "--call", "--registry", "--cache", "--userconfig", "-w", "--workspace",
  "--prefix", "--loglevel", "--node-options", "--script-shell", "--globalconfig", "--include", "--omit",
]);
export const uvValued = new Set([
  "--from", "--with", "--with-editable", "--with-requirements", "--python", "-p", "--index", "--index-url",
  "--extra-index-url", "--default-index", "--find-links", "-f", "--cache-dir", "--directory", "--project",
  "--config-file", "--env-file", "--constraints", "-c", "--overrides", "--python-preference", "--color", "-i", "-w",
  "--refresh-package", "--reinstall-package", "--upgrade-package", "--exclude-newer", "--exclude-newer-package",
  "--index-strategy", "--keyring-provider", "--resolution", "--prerelease", "--fork-strategy", "--link-mode",
  "--python-platform", "--allow-insecure-host", "--build-constraints", "--with-executables-from", "--torch-backend",
  "--config-setting", "-C", "--no-build-isolation-package", "--no-build-package", "--no-binary-package",
  "--build-constraint",
]);
const pipxValued = new Set(["--spec", "--python", "--pip-args", "--index-url", "-i", "--editable", "-e", "--backend"]);

/** The value of a named option (`--from x` or `--from=x`) that appears before the first real argument. */
function optionValue(args: string[], names: string[], valued: Set<string>): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--" || !argument.startsWith("-")) return null;
    const [flag, inline] = argument.includes("=") ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)] : [argument, null];
    if (names.includes(flag!)) return inline ?? args[index + 1] ?? null;
    if (inline === null && valued.has(flag!)) index += 1;
  }
  return null;
}

export function firstArgument(args: readonly string[], valued: Set<string>): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") return args[index + 1] ?? null;
    if (!argument.startsWith("-")) return argument;
    if (!argument.includes("=") && valued.has(argument)) index += 1;
  }
  return null;
}

const exact = /^v?\d+(\.\d+)*([-.+][0-9A-Za-z.-]+)?$/;

/** `react@18.3.1`, `@scope/pkg@1.2.3`, `eslint`. A git address, a path or a range is not checked. */
export function npmPackage(token: string): PackageRef | null {
  const at = token.lastIndexOf("@");
  const [name, spec] = at > 0 ? [token.slice(0, at), token.slice(at + 1)] : [token, ""];
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return null;
  return { ecosystem: "npm", name: name.toLowerCase(), version: exact.test(spec) ? spec.replace(/^v/, "") : null };
}

/** PyPI names compare with case, dots, dashes and underscores folded together. */
export const pypiName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

/** `black`, `black==24.1.0`, `black[jupyter]==24.1.0`, `ruff@0.5.0`. Anything looser is checked by name only. */
export function pypiPackage(token: string): PackageRef | null {
  const hit = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(\[[^\]]*\])?\s*(.*)$/.exec(token.trim());
  if (!hit) return null;
  const rest = hit[3]!.trim();
  if (rest && !/^(==|===|~=|!=|<=|>=|<|>|@|;|\()/.test(rest)) return null;
  const pinned = /^(?:===?|@)\s*(v?\d[0-9A-Za-z.+!_-]*)$/.exec(rest);
  return { ecosystem: "PyPI", name: pypiName(hit[1]!), version: pinned && exact.test(pinned[1]!) ? pinned[1]!.replace(/^v/, "") : null };
}

function npmLaunch(args: string[]): PackageRef | null {
  if (optionValue(args, ["-c", "--call"], npmValued) !== null) return null;
  const token = optionValue(args, ["-p", "--package"], npmValued) ?? firstArgument(args, npmValued);
  return token ? npmPackage(token) : null;
}
function uvLaunch(args: string[]): PackageRef | null {
  const token = optionValue(args, ["--from"], uvValued) ?? firstArgument(args, uvValued);
  return token ? pypiPackage(token) : null;
}
function pipxLaunch(args: string[]): PackageRef | null {
  const token = optionValue(args, ["--spec"], pipxValued) ?? firstArgument(args, pipxValued);
  return token ? pypiPackage(token) : null;
}

/**
 * `cmd /c npx …`, the usual way Windows settings start an npx server: the program after `/c` (or
 * `/k`), with cmd's own switches before it skipped. Anything else comes back unchanged.
 */
function unwrapCmd(command: string, args: readonly string[]): [string, string[]] {
  if (programName(command) !== "cmd") return [command, [...args]];
  const at = args.findIndex((argument) => /^\/[ck]$/i.test(argument));
  if (at < 0 || !args[at + 1]) return [command, [...args]];
  // `cmd /c "npx -y pkg"` hands the whole line over as one argument; it is only read, never run.
  const inner = at + 2 === args.length ? args[at + 1]!.trim().split(/\s+/) : args.slice(at + 1);
  return [inner[0]!, inner.slice(1)];
}

/** The package a command line would fetch and run, or null when it is not that kind of command. */
export function packageOfLaunch(command: string, args: readonly string[]): PackageRef | null {
  const [inner, innerArgs] = unwrapCmd(command, args);
  const program = programName(inner), rest = innerArgs;
  if (program === "npx" || program === "bunx") return npmLaunch(rest);
  if ((program === "pnpm" || program === "yarn") && rest[0] === "dlx") return npmLaunch(rest.slice(1));
  if (program === "npm" && (rest[0] === "exec" || rest[0] === "x")) return npmLaunch(rest.slice(1));
  if (program === "uvx") return uvLaunch(rest);
  if (program === "uv" && rest[0] === "tool" && rest[1] === "run") return uvLaunch(rest.slice(2));
  if (program === "pipx" && rest[0] === "run") return pipxLaunch(rest.slice(1));
  return null;
}

/** True for a command that downloads what it runs, whether or not the package could be named. */
export const downloadsWhatItRuns = (command: string, wrapped: readonly string[]): boolean => {
  const [inner, args] = unwrapCmd(command, wrapped);
  const program = programName(inner);
  return ["npx", "bunx", "uvx"].includes(program)
    || (program === "pipx" && args[0] === "run")
    || (["pnpm", "yarn"].includes(program) && args[0] === "dlx")
    || (program === "npm" && ["exec", "x"].includes(args[0] ?? ""))
    || (program === "uv" && args[0] === "tool" && args[1] === "run");
};
