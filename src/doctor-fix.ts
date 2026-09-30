import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";

/**
 * Setting-up problems, in plain words, with the repair offered rather than described. Each check says
 * what was tried, what it found, and what would put it right; with `--fix` the ones that can be put
 * right from here are put right, and the rest come with a step a person can follow.
 */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  summary: string;
  /** What to do about it, in plain language. */
  fix?: string;
  /** True when this run repaired it. */
  repaired?: boolean;
}
export interface DoctorFixReport {
  ok: boolean;
  fixMode: boolean;
  checkedAt: string;
  checks: DoctorCheck[];
  repaired: string[];
}
export interface DoctorDeps {
  /** Runs a command; returns its output, or throws. */
  run?: (file: string, args: string[]) => Promise<string>;
  /** Answers whether a port can be listened on. */
  portFree?: (port: number) => Promise<boolean>;
}
export interface DoctorOptions {
  fix: boolean;
  /** Unattended update checks cannot launch package installers. Manual --fix keeps the existing repair behavior. */
  browserRepair?: "manual";
  port: number;
  workspace: string;
  /** True when Branch is already listening on that address, so it is in use by design. */
  portIsOurs?: boolean;
  browsersInstalled?: () => Promise<boolean>;
  /** Which system the advice is for; defaults to this computer's. */
  platform?: NodeJS.Platform;
  /** mac3/security-check: the security self-check's counts, when the caller can run it. */
  security?: () => Promise<{ critical: number; warn: number; checks: number }>;
}

const runCommand = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 300000, maxBuffer: 8 * 1048576, shell: process.platform === "win32" },
      (error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim().slice(0, 300))) : resolve(stdout))));

export const portIsFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/** How to get Git on each kind of computer; Branch never runs these itself. */
export function gitInstallAdvice(platform: NodeJS.Platform): string {
  if (platform === "darwin")
    return "Open the Terminal app, type xcode-select --install and press Return, then follow the steps on screen and reopen Branch. Branch cannot install it for you because macOS asks you to agree first.";
  if (platform === "linux")
    return "Install Git with your system's software tool (on Ubuntu: sudo apt install git), then reopen Branch. Branch cannot install it for you because it needs your password.";
  return "Download Git for Windows from git-scm.com, run the installer, accept every default, then close and reopen Branch. Branch cannot install it for you because the installer asks questions.";
}

async function checkGit(options: DoctorOptions, deps: DoctorDeps): Promise<DoctorCheck> {
  const run = deps.run ?? runCommand;
  try {
    const version = (await run("git", ["--version"])).trim();
    return { name: "Git", ok: true, summary: `${version} is installed, so Branch can look after versions of your files.` };
  } catch {
    return {
      name: "Git", ok: false,
      summary: "Git is not installed. Branch still works; keeping versions of code files and the Git screen do not.",
      fix: gitInstallAdvice(options.platform ?? process.platform),
    };
  }
}

async function checkBrowser(options: DoctorOptions, deps: DoctorDeps): Promise<DoctorCheck> {
  const installed = options.browsersInstalled ?? defaultBrowserCheck;
  if (await installed())
    return { name: "Web browsing", ok: true, summary: "The private browser Branch uses to read pages is installed." };
  const fix = "Branch needs a small private browser to read web pages. Run: npx playwright install chromium --only-shell";
  if (!options.fix || options.browserRepair === "manual")
    return { name: "Web browsing", ok: false, summary: "The private browser Branch uses to read pages is missing.", fix };
  try {
    await (deps.run ?? runCommand)("npx", ["playwright", "install", "chromium", "--only-shell"]);
    return { name: "Web browsing", ok: true, repaired: true, summary: "The private browser was missing, so it was downloaded just now." };
  } catch (error) {
    return { name: "Web browsing", ok: false, summary: `The download did not finish: ${(error as Error).message}`, fix };
  }
}
async function defaultBrowserCheck(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    await access(path, constants.X_OK);
    // mac7/install-torture: a download cut off part-way can leave an empty file that is still marked
    // runnable. That is not a browser, and calling it one turns a plain "it is missing" into a crash.
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch { return false; }
}

async function checkPort(options: DoctorOptions, deps: DoctorDeps): Promise<DoctorCheck> {
  const free = deps.portFree ?? portIsFree;
  if (options.portIsOurs)
    return { name: "Address on this computer", ok: true, summary: `Branch is using address ${options.port} on this computer, which is what we want.` };
  if (await free(options.port))
    return { name: "Address on this computer", ok: true, summary: `Branch can use address ${options.port} on this computer.` };
  const alternatives: number[] = [];
  for (let port = options.port + 1; port < options.port + 20 && alternatives.length < 3; port++)
    if (await free(port)) alternatives.push(port);
  return {
    name: "Address on this computer", ok: false,
    summary: `Something else is already using address ${options.port} on this computer, so Branch cannot open its window there.`,
    fix: alternatives.length
      ? `Close the other program, or start Branch with a different address: set BRANCH_PORT to ${alternatives.join(", ")} or another free number.`
      : "Close the other program using that address, or restart the computer and try again.",
  };
}

async function checkWorkspace(options: DoctorOptions): Promise<DoctorCheck> {
  try {
    await access(options.workspace, constants.W_OK);
    return { name: "Your files folder", ok: true, summary: `Branch can write to ${options.workspace}.` };
  } catch {
    return {
      name: "Your files folder", ok: false,
      summary: `Branch cannot write to ${options.workspace}.`,
      fix: "Check the folder exists and is not read-only or inside a synced folder that is paused. Then start Branch again.",
    };
  }
}

/** mac3/security-check: one line summing up the security self-check; its own command does the repairs. */
async function checkSecurity(run: NonNullable<DoctorOptions["security"]>): Promise<DoctorCheck> {
  try {
    const { critical, warn, checks } = await run();
    if (critical + warn === 0) return { name: "Security", ok: true, summary: `All ${checks} security checks passed.` };
    return {
      name: "Security", ok: false, summary: `${critical} urgent and ${warn} other security problem${critical + warn === 1 ? "" : "s"} found.`,
      fix: "Run `branch security audit` to see them, and `branch security audit --fix` to put right what Branch can.",
    };
  } catch (error) {
    return { name: "Security", ok: false, summary: `The security check could not run: ${(error as Error).message}`, fix: "Run `branch security audit` to try again." };
  }
}

/** Runs every setting-up check; with `fix` on, repairs what can be repaired from here. */
export async function doctorFix(options: DoctorOptions, deps: DoctorDeps = {}): Promise<DoctorFixReport> {
  const checks = [
    await checkGit(options, deps), await checkBrowser(options, deps),
    await checkPort(options, deps), await checkWorkspace(options),
    ...(options.security ? [await checkSecurity(options.security)] : []),
  ];
  return {
    ok: checks.every((check) => check.ok), fixMode: options.fix, checkedAt: new Date().toISOString(),
    checks, repaired: checks.filter((check) => check.repaired).map((check) => check.name),
  };
}

/** The report as lines a person can read straight from the terminal. */
export function doctorText(report: DoctorFixReport): string {
  const lines = [report.ok ? "Everything Branch needs is in place." : "Some things need attention:"];
  for (const check of report.checks) {
    lines.push(`${check.ok ? "OK  " : "FIX "} ${check.name}: ${check.summary}`);
    if (check.fix) lines.push(`     → ${check.fix}`);
  }
  if (!report.fixMode && !report.ok) lines.push("Run `branch doctor --fix` to let Branch repair what it can.");
  return lines.join("\n");
}
