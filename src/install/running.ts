import { processAlive } from "./process-alive.js";
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * One note on disk saying "the engine is already running here". The app window reads it before
 * starting anything: if a background engine answers on that port with the saved session token, the
 * window joins it instead of starting a second copy of everything.
 */
export const runningFileName = "running.json";
export const sessionTokenFileName = "session-token";

export const RunningSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  url: z.string().max(200),
  mode: z.enum(["app", "daemon"]),
  version: z.string().max(40),
  startedAt: z.iso.datetime(),
}).strict();
export type RunningInstance = z.infer<typeof RunningSchema>;

export interface AttachDeps {
  /** Answers whether a process with that id still exists. */
  alive?: (pid: number) => boolean;
  fetch?: typeof fetch;
  /**
   * Asked before anything is sent to the note's address (src/engine-proof.ts): the key to send there once the program
   * at it has proved it is the engine holding `token`, or null when it has not, and then the engine is not joined.
   * The desktop app passes it; without it the saved key itself is sent.
   */
  prove?: (url: string, token: string) => Promise<string | null>;
}
export interface Attachment {
  url: string;
  token: string;
  instance: RunningInstance;
  /**
   * The version the running Branch **answered** with, which is not always the one written in
   * `running.json`: that file is written by whatever started, and a swap that half happened can leave
   * it describing a version that is not the one now answering on the port.
   */
  version: string;
}

/**
 * The note is written whole or not at all: a copy beside it, renamed over it. Written in place, a window starting at that
 * moment read an empty file, took it for no engine and started a second one beside it (or a joined window relaunched).
 */
export async function writeRunning(
  dataDir: string, instance: Omit<RunningInstance, "startedAt"> & { startedAt?: string },
): Promise<void> {
  const value = RunningSchema.parse({ ...instance, startedAt: instance.startedAt ?? new Date().toISOString() });
  const path = join(dataDir, runningFileName);
  const next = `${path}.${randomBytes(6).toString("hex")}.next`;
  await writeFile(next, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    await renameSoon(next, path);
  } catch (error) {
    await rm(next, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Windows refuses a rename over a file another program has open for a moment; it is tried again briefly. */
async function renameSoon(from: string, to: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try { return await rename(from, to); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (tries >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}
export async function clearRunning(dataDir: string): Promise<void> {
  await rm(join(dataDir, runningFileName), { force: true });
}
export async function readRunning(dataDir: string): Promise<RunningInstance | null> {
  try {
    return RunningSchema.parse(JSON.parse(await readFile(join(dataDir, runningFileName), "utf8")));
  } catch { return null; }
}
async function savedToken(dataDir: string): Promise<string | null> {
  try {
    const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8")).trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch { return null; }
}
const stillAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  // Keep this attachment probe's existing permission-error behavior; classify only a proved Linux PID.
  return process.platform !== "linux" || processAlive(pid);
};

/**
 * Returns the running engine to join, or null. A note left behind by a crash is removed: the process
 * must still exist and the port must answer as this very app, with the session token from disk.
 */
export async function attachToRunning(dataDir: string, deps: AttachDeps = {}): Promise<Attachment | null> {
  const instance = await readRunning(dataDir);
  if (!instance) return null;
  const alive = deps.alive ?? stillAlive;
  if (!alive(instance.pid)) { await clearRunning(dataDir); return null; }
  const token = await savedToken(dataDir);
  if (!token) return null;
  const call = deps.fetch ?? globalThis.fetch;
  try {
    const send = deps.prove ? await deps.prove(instance.url, token) : token;
    if (!send) return null;
    const response = await call(`${instance.url}/api/state`, {
      headers: { authorization: `Bearer ${send}` }, signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { version?: unknown };
    if (typeof body?.version !== "string") return null;
    return { url: instance.url, token, instance, version: body.version };
  } catch { return null; }
}
