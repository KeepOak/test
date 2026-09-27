import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FeatureModeSchema, optionalFields } from "../feature-switches.js";
import type { ToolRegistry } from "../registry.js";
import {
  acceptProposal, discardProposal, GatewayConfigSchema, loadGatewayConfig, proposeConfig, readChanges, readProposal, rollbackAccepted,
  saveGatewayConfig, type DryRun, type GatewayConfig,
} from "./gateway-config.js";
import { readState } from "./gateway-state.js";
import { lastActivation, recentActivations } from "./activation.js";
import { runAsNode } from "../child-env.js";

/**
 * The owner's side of the gateway: the switch, what the gateway last said, and changes the
 * assistant has suggested, which only the owner can accept. The assistant's side is one tool that
 * suggests a change; it never writes the settings itself (see protected.ts).
 */
export class NeverBreakApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const handlesNeverBreakPath = (path: string): boolean => path === "/api/never-break" || path.startsWith("/api/never-break/");

type Read = (request: IncomingMessage) => Promise<unknown>;

export async function neverBreakView(dataDir: string): Promise<Record<string, unknown>> {
  const loaded = await loadGatewayConfig(dataDir);
  const state = await readState(dataDir);
  return {
    mode: loaded.config.mode, config: loaded.config, problem: loaded.problem,
    underGateway: process.env.BRANCH_GATEWAY_CHILD === "1",
    lastExit: state ? (state.phase === "exited" ? "clean" : "running") : "never",
    recentCrashes: state?.crashes.length ?? 0,
    proposal: await readProposal(dataDir),
    /** The last change the owner accepted, with the timings before and after it, while it can still be rolled back. */
    accepted: (await readChanges(dataDir)).at(-1) ?? null,
  };
}

/** When this process started: a failed update settled before it belongs to an earlier start. */
const thisStart = new Date(Date.now() - process.uptime() * 1000);

export interface NeverBreakExtras {
  /** Takes a copy of the saved work for an update's check (the process that holds the database). */
  snapshot?: () => Promise<string>;
  /** The Telegram setup card's state, and saving its switch and token. */
  telegram?: { view: () => Record<string, unknown>; save: (input: unknown) => Promise<void> };
}

export async function neverBreakApi(dataDir: string, request: IncomingMessage, path: string, readBody: Read,
  extras: NeverBreakExtras = {}): Promise<unknown> {
  if (path === "/api/never-break/telegram" && extras.telegram) return telegramApi(request, readBody, extras.telegram);
  const snapshot = extras.snapshot;
  if (request.method === "GET" && path === "/api/never-break") return neverBreakView(dataDir);
  // Q55: what the newest update did, so Settings can say what a failed one left running. The owner's
  // alone: a short-lived key is refused it (src/short-lived-keys.ts), and so is a household person
  // (src/household-routes.ts), before this is reached.
  if (request.method === "GET" && path === "/api/never-break/last-update") return { last: lastActivation(dataDir, thisStart) };
  // p17: the journal of updates tried, kept or rolled back, for Settings › Gateway › Never break. The owner's alone,
  // like last-update: a short-lived key and a household person are refused it before this is reached.
  if (request.method === "GET" && path === "/api/never-break/journal") return { entries: recentActivations(dataDir) };
  if (request.method !== "POST") throw new NeverBreakApiError(405, "Use GET or POST here.");
  if (path === "/api/never-break") {
    const body = z.object({ mode: FeatureModeSchema }).strict().safeParse(await readBody(request));
    if (!body.success) throw new NeverBreakApiError(400, "Choose off, when needed or on.");
    const { config } = await loadGatewayConfig(dataDir);
    await saveGatewayConfig(dataDir, { ...config, mode: body.data.mode });
    return { ...(await neverBreakView(dataDir)), note: "This takes effect the next time Branch starts." };
  }
  if (path === "/api/never-break/proposal/accept") {
    try { await acceptProposal(dataDir); } catch (error) { throw new NeverBreakApiError(409, (error as Error).message); }
    return { ...(await neverBreakView(dataDir)), note: "Saved. It takes effect the next time Branch starts." };
  }
  if (path === "/api/never-break/proposal/discard") { await discardProposal(dataDir); return neverBreakView(dataDir); }
  // The owner rolls back the last change they accepted (the journal in gateway-config.ts); timings only.
  if (path === "/api/never-break/rollback") {
    if (!z.object({}).strict().safeParse(await readBody(request)).success) throw new NeverBreakApiError(400, "Send an empty body to roll back.");
    try { await rollbackAccepted(dataDir); } catch (error) { throw new NeverBreakApiError(409, (error as Error).message); }
    return { ...(await neverBreakView(dataDir)), note: "Rolled back. It takes effect the next time Branch starts." };
  }
  // The window asks the engine that holds the database for a copy, before it tries an update on it.
  if (path === "/api/never-break/snapshot" && snapshot) return { folder: await snapshot() };
  throw new NeverBreakApiError(404, "Not found");
}

async function telegramApi(request: IncomingMessage, readBody: Read, telegram: NonNullable<NeverBreakExtras["telegram"]>): Promise<unknown> {
  if (request.method === "GET") return telegram.view();
  if (request.method !== "POST") throw new NeverBreakApiError(405, "Use GET or POST here.");
  try { await telegram.save(await readBody(request)); }
  catch (error) {
    const said = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(" ") : (error as Error).message;
    throw new NeverBreakApiError(400, said);
  }
  return { ...telegram.view(), note: "Saved. Branch connects the bot the next time it starts." };
}

/** The assistant may suggest a change to the gateway's settings; the owner decides. */
export function registerNeverBreak(registry: ToolRegistry, dataDir: string, dryRun: DryRun): void {
  registry.register({
    name: "gateway.propose", permission: "gateway.propose", group: "settings",
    description: "Suggest a change to the settings of Branch's gateway (the part that keeps Branch running). The change is checked and tried on a throwaway copy, then waits for the owner to accept it in Settings. It is never applied by this tool.",
    parameters: z.object({
      // The switch and the engine's settings are the owner's alone; only timings can be suggested.
      change: optionalFields(GatewayConfigSchema.omit({ mode: true, workerEnv: true })),
      why: z.string().trim().min(1).max(500),
    }).strict(),
    execute: async ({ change, why }) => {
      const proposal = await proposeConfig(dataDir, change, why, dryRun);
      return { waitingForOwner: true, tried: proposal.check,
        said: proposal.check?.ok ? "The change started cleanly on a throwaway copy and now waits for the owner in Settings."
          : "The change did not start cleanly, so the owner will see it cannot be used." };
    },
  });
}

/**
 * Starts a throwaway gateway, with these settings, on an empty data folder of its own, and answers
 * whether its engine came up. Nothing of the owner's is read or written; the folder is removed after.
 */
export function gatewayDryRun(script: string, env: NodeJS.ProcessEnv = process.env): DryRun {
  return async (config: GatewayConfig) => {
    const root = await mkdtemp(join(tmpdir(), "branch-gateway-try-"));
    try {
      const dataDir = join(root, "data");
      // The owner's chat-app settings stay out: a throwaway engine must not read the owner's bots.
      const { BRANCH_INTEGRATIONS: _left, ...workerEnv } = config.workerEnv;
      await saveGatewayConfig(dataDir, { ...config, workerEnv, mode: "on" });
      return await tryGateway(script, { ...cleanEnv(env), BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: join(root, "workspace"), BRANCH_PORT: "0" },
        (config.startSeconds + 10) * 1000);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  };
}

const cleanEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...env };
  for (const name of ["BRANCH_GATEWAY_CHILD", "BRANCH_GATEWAY_CONTRACT", "BRANCH_INTEGRATIONS", "BRANCH_SELF_TEST", "BRANCH_RESUME", "NODE_TEST_CONTEXT"]) delete copy[name];
  return copy;
};

async function tryGateway(script: string, env: NodeJS.ProcessEnv, limitMs: number): Promise<{ ok: boolean; detail: string }> {
  const child = spawn(process.execPath, [script, "start"], { env: { ...env, ...runAsNode(process.execPath) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const deadline = Date.now() + limitMs;
  try {
    while (Date.now() < deadline && child.exitCode === null) {
      const url = /Branch gateway listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      const health = url ? await fetch(`${url}/gateway/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json() as Promise<{ worker?: { state?: string } }>).catch(() => null) : null;
      if (health?.worker?.state === "ready") return { ok: true, detail: "A throwaway gateway started its engine with these settings." };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, detail: `A throwaway gateway did not get its engine going with these settings. ${output.trim().split("\n").slice(-3).join(" ").slice(0, 400)}` };
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 20_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
