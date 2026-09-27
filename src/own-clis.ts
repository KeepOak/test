/**
 * Command-line tools on this computer (Customize › Tools › Command-line tools).
 *
 * Finding them runs nothing: each name on a short allowlist is looked up in the PATH folders the default command
 * settings already trust (`programFolders`: full addresses only, never the workspace, where the assistant can write),
 * the way `which` and `where` do, by reading the folders. A tool the owner allows is kept in the store and added to the
 * programs `shell.execute` may start, beside the launch settings file's own list, from the next command on.
 *
 * Allowing a tool loosens nothing else: every command it runs is still weighed by the owner's approval settings, which
 * ask about a command nobody has decided on (src/policy.ts `unmatched`). Adding one by its path refuses a batch file,
 * anything that is not a file, and anything inside the workspace, and each program is checked again when it is used.
 */
import { statSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, win32 } from "node:path";
import { z } from "zod";
import { audit } from "./audit.js";
import { readPolicy } from "./policy.js";
import type { Store } from "./store.js";
import { inWorkspace, locateProgram, programFolders } from "./integrations/default-shell.js";

/** The tools looked for. Only these names are ever looked up; none of them is started to find it. */
export const knownClis = ["git", "gh", "node", "npm", "npx", "python", "python3", "pip", "uv", "winget", "az", "aws", "gcloud",
  "kubectl", "helm", "docker", "terraform", "dotnet", "go", "cargo", "rustc", "java", "deno", "bun", "pwsh", "ffmpeg", "make"] as const;
const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
export const AddCliSchema = z.union([
  z.object({ name: alias }).strict(),
  z.object({ path: z.string().trim().min(1).max(1000) }).strict(),
]);
export const RemoveCliSchema = z.object({ name: alias }).strict();

export interface OwnCli { name: string; path: string; args: string[]; addedAt: string }
const Saved = z.object({ programs: z.array(z.custom<OwnCli>()).max(16).default([]) }).strict();
const key = "shell-own-programs";
const maxPrograms = 16;

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const batch = (path: string): boolean => /\.(cmd|bat)$/i.test(path);

export interface OwnClisDeps {
  store: Store; owner: () => string; workspace: () => string;
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
}

export class OwnClis {
  /** The aliases the launch settings file (or the default programs) already gives commands; set when the shell starts. */
  private launch: string[] = [];
  constructor(private readonly deps: OwnClisDeps) {}
  private get env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }
  private get platform(): NodeJS.Platform { return this.deps.platform ?? process.platform; }

  /** The shell the launch made: its own aliases are noted, and the owner's programs are handed to it for each command. */
  attach(shell: { extra: () => Record<string, { path: string; args: string[] }> }, launchNames: readonly string[]): void {
    this.launch = [...launchNames];
    shell.extra = () => this.executables();
  }

  saved(): OwnCli[] {
    const kept = Saved.safeParse(this.deps.store.get("settings", this.deps.owner(), key)?.data ?? {});
    return kept.success ? kept.data.programs : [];
  }
  private save(programs: OwnCli[]): void {
    this.deps.store.save("settings", this.deps.owner(), key, { programs });
  }
  private safe(path: string): boolean {
    const absolute = this.platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
    return absolute && !batch(path) && isFile(path) && !inWorkspace(this.deps.workspace(), path, this.platform);
  }

  /** The owner's programs as `shell.execute` wants them. One that stopped being a safe file is left out. */
  executables(): Record<string, { path: string; args: string[] }> {
    const out: Record<string, { path: string; args: string[] }> = {};
    for (const program of this.saved()) if (this.safe(program.path)) out[program.name] = { path: program.path, args: program.args };
    return out;
  }

  /** Each allowlisted tool found on this computer, by its full address; nothing is run to find it. */
  found(): { name: string; path: string; allowed: boolean }[] {
    const lookIn = { ...this.env, PATH: programFolders(this.env, this.platform, [this.deps.workspace()]).join(delimiter) };
    const allowed = new Set([...this.launch, ...this.saved().map((program) => program.name)]);
    const out: { name: string; path: string; allowed: boolean }[] = [];
    for (const name of knownClis) {
      const at = locateProgram(name, lookIn, this.platform);
      if (at && !batch(at.path)) out.push({ name, path: at.path, allowed: allowed.has(name) });
    }
    return out;
  }

  list(): { found: ReturnType<OwnClis["found"]>; programs: OwnCli[]; launch: string[] } {
    return { found: this.found(), programs: this.saved(), launch: [...this.launch] };
  }

  add(input: unknown): { program: OwnCli; said: string } {
    const wanted = AddCliSchema.parse(input);
    const program = "name" in wanted ? this.byName(wanted.name) : this.byPath(wanted.path);
    const programs = this.saved();
    if (this.launch.includes(program.name) || programs.some((entry) => entry.name === program.name))
      throw new Error(`${program.name} is already one of the programs commands may run.`);
    if (programs.length >= maxPrograms) throw new Error(`Branch keeps at most ${maxPrograms} programs of your own. Remove one first.`);
    this.save([...programs, program]);
    const owner = this.deps.owner();
    audit(this.deps.store, owner, { action: "policy.changed", actor: owner, subject: `Command-line tool allowed: ${program.name} (${program.path})`,
      reason: "You allowed a command-line tool from Customize", source: "owner", outcome: "added" });
    return { program, said: this.saidOnAdd(program.name) };
  }
  private byName(name: string): OwnCli {
    const at = this.found().find((entry) => entry.name === name);
    if (!at) throw new Error(`${name} was not found on this computer.`);
    const located = locateProgram(name, { ...this.env, PATH: programFolders(this.env, this.platform, [this.deps.workspace()]).join(delimiter) }, this.platform)!;
    return { name, path: located.path, args: located.args, addedAt: new Date().toISOString() };
  }
  private byPath(path: string): OwnCli {
    if (!this.safe(path)) throw new Error("Give the full address of a program file outside the workspace. A .cmd or .bat file cannot be added.");
    const name = basename(path, extname(path)).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z]+/, "").slice(0, 30);
    if (!alias.safeParse(name).success) throw new Error("That program's name cannot be used as a command name.");
    return { name, path, args: [], addedAt: new Date().toISOString() };
  }
  /** What the owner is told: approvals still ask unless their own settings let unknown commands run. */
  private saidOnAdd(name: string): string {
    return readPolicy(this.deps.store, this.deps.owner()).unmatchedCommands === "allow"
      ? `${name} is allowed. Your approval settings decide which of its commands run without asking.`
      : `${name} is allowed. It asks before every command until you say which it may run.`;
  }

  remove(input: unknown): { removed: string } {
    const { name } = RemoveCliSchema.parse(input);
    const programs = this.saved();
    if (!programs.some((program) => program.name === name)) throw new Error(`${name} is not one of your own programs.`);
    this.save(programs.filter((program) => program.name !== name));
    const owner = this.deps.owner();
    audit(this.deps.store, owner, { action: "policy.changed", actor: owner, subject: `Command-line tool removed: ${name}`,
      reason: "You removed a command-line tool from Customize", source: "owner", outcome: "removed" });
    return { removed: name };
  }
}
