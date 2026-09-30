/**
 * Every Beta install is tried for real before the owner gets the app back. The new version, as installed beside the
 * one running (the staged copy), is started on its own: its engine, on a fresh folder of its own in the update area
 * (never the owner's data), with a stand-in model that only answers; its window, hidden, on a session of its own. The
 * window must load, a message must be answered, Settings must open, and the page must throw no error on the way.
 *
 * Anything else, and the version is not used: the swap never happens, the running version stays, and the owner is
 * told which step failed in plain words (Updater.install, keptAfter). This runs for every Beta install, whatever the
 * never-break switch says. The same steps drive a browser page in the tests (tests/beta-smoke.test.mjs) and the new
 * version's own hidden Electron window in the app (beta-smoke-window.ts, reached through `--branch-smoke=<report>`).
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Completion, Provider } from "../contracts.js";

export const smokeFlag = "--branch-smoke";
/** The report path a `--branch-smoke=<report>` start was asked to write, or null for an ordinary start. */
export function smokeReportPath(argv: readonly string[]): string | null {
  const arg = argv.find((one) => one.startsWith(`${smokeFlag}=`));
  return arg ? arg.slice(smokeFlag.length + 1) || null : null;
}

/** A stand-in model: it answers every message with the same words and never calls a tool or a service. */
export const smokeAnswer = "Branch answered the try-out message.";
export class SmokeStandIn implements Provider {
  readonly name = "update-try-out-stand-in";
  audio(): null { return null; }
  async complete(): Promise<Completion> { return { content: smokeAnswer, toolCalls: [] }; }
}

export const SmokeSteps = ["engine", "window", "answer", "settings", "errors"] as const;
export type SmokeStep = (typeof SmokeSteps)[number];
const StepSchema = z.object({ step: z.enum(SmokeSteps), ok: z.boolean(), detail: z.string().max(400) }).strict();
export const SmokeReportSchema = z.object({ ok: z.boolean(), version: z.string().max(80), steps: z.array(StepSchema).max(10) }).strict();
export type SmokeReport = z.infer<typeof SmokeReportSchema>;

/** Each step, as the owner reads it when it fails. */
const failedWords: Record<SmokeStep, string> = {
  engine: "its engine did not start",
  window: "its window did not load",
  answer: "a test message got no answer",
  settings: "Settings did not open",
  errors: "its window showed an error",
};
/** The owner's sentence for a try-out: which step failed and what it said, or null when every step passed. */
export function smokeFailure(report: SmokeReport | null, reason = "it did not finish its try-out"): string | null {
  if (!report) return `The new Beta version was not used: ${reason}. You are still on the version you had, and nothing was changed.`;
  const failed = report.steps.find((one) => !one.ok) ?? (report.ok ? null : { step: "engine" as const, detail: "no step passed" });
  const missing = SmokeSteps.find((step) => !report.steps.some((one) => one.step === step));
  if (!failed && !missing && report.ok) return null;
  const words = failed ? `${failedWords[failed.step]} (${failed.detail})` : `${failedWords[missing!]} (the try-out stopped before it)`;
  return `The new Beta version was not used: when Branch tried it, ${words}. You are still on the version you had, and nothing was changed.`;
}

/** A page to drive: a browser tab in the tests, the new version's hidden window in the app. */
export interface SmokePage {
  goto(url: string): Promise<void>;
  /** Runs a script in the page and answers what it returned. */
  run<T>(script: string): Promise<T>;
  /** Every error the page threw so far, in words. */
  errors(): string[];
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(page: SmokePage, script: string, timeoutMs: number): Promise<boolean> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await pause(100))
    if (await page.run<boolean>(script).catch(() => false)) return true;
  return false;
}
async function step(steps: SmokeReport["steps"], name: SmokeStep, work: () => Promise<string>): Promise<boolean> {
  try { steps.push({ step: name, ok: true, detail: (await work()).slice(0, 400) }); return true; }
  catch (error) { steps.push({ step: name, ok: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 400) }); return false; }
}

const shown = (selector: string) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.getClientRects().length > 0; })()`;
const answered = `(document.getElementById("conversation")?.textContent ?? "").includes(${JSON.stringify(smokeAnswer)})`;
const send = `(() => { const box = document.getElementById("prompt"), form = document.getElementById("composer");
  if (!box || !form) return false; box.value = "Say hello: this is Branch trying a new version.";
  box.dispatchEvent(new Event("input", { bubbles: true })); form.requestSubmit(); return true; })()`;
const openSettings = `(() => { const go = document.querySelector('#side [data-act="view"][data-v="settings"]'); if (!go) return false; go.click(); return true; })()`;

/** The window's steps, on an engine that is already up at `url` (answered with `token`). */
export async function smokeWindow(page: SmokePage, input: { url: string; token: string; timeoutMs?: number }): Promise<SmokeReport["steps"]> {
  const steps: SmokeReport["steps"] = [], wait = input.timeoutMs ?? 30_000;
  const loaded = await step(steps, "window", async () => {
    await page.goto(input.url);
    await page.run(`sessionStorage.setItem("branch-token", ${JSON.stringify(input.token)}), true`);
    await page.goto(input.url);
    if (!await until(page, shown("#app #side"), wait)) throw new Error("the side list never showed");
    return "the window loaded and signed in";
  });
  if (loaded) await step(steps, "answer", async () => {
    if (!await until(page, send, wait)) throw new Error("the message box never showed");
    if (!await until(page, answered, wait)) throw new Error("the stand-in model's answer never showed");
    return "the stand-in model's answer showed";
  });
  if (loaded) await step(steps, "settings", async () => {
    if (!await until(page, openSettings, wait) || !await until(page, shown(".settings .set-page"), wait)) throw new Error("the Settings page never showed");
    return "Settings opened";
  });
  const errors = page.errors();
  steps.push({ step: "errors", ok: errors.length === 0, detail: errors.length ? errors.join("; ").slice(0, 400) : "no page errors" });
  return steps;
}

/** How the new version's own try-out is started: its program and, for an unpackaged copy, the app folder. */
export interface StagedApp { executable: string; args: string[] }

/**
 * Starts the staged copy with `--branch-smoke=<report>` in a folder of its own under `folder` (removed afterwards)
 * and reads its report. Answers the owner's sentence when it failed, or null when it passed.
 */
export async function runStagedSmoke(app: StagedApp, folder: string, env: NodeJS.ProcessEnv, timeoutMs = 180_000): Promise<string | null> {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const report = join(folder, "try-out.json");
  try {
    const ended = await exited(app, [`${smokeFlag}=${report}`], { ...smokeEnv(env), BRANCH_DESKTOP_HOME: join(folder, "home") }, timeoutMs);
    const read = SmokeReportSchema.safeParse(JSON.parse(await readFile(report, "utf8").catch(() => "null")));
    return smokeFailure(read.success ? read.data : null, `it did not finish its try-out (${ended})`);
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  }
}

/** Nothing of the running install reaches the try-out: none of Branch's own settings, and never Node mode. */
export const smokeEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !/^(BRANCH_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/.test(name)));

function exited(app: StagedApp, extra: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(app.executable, [...app.args, ...extra], { env, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("it took too long and was stopped"); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); resolve(`it could not be started: ${error.message}`); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve(signal ? `it was ended by ${signal}` : `it exited with code ${code}`); });
  });
}
