import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { PosixExec } from "../integrations/desktop-script-posix.js";
import { assertRealScreenAllowed } from "../integrations/real-screen-guard.js";

const bounds = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().positive().max(8192), h: z.number().int().positive().max(8192) }).strict();
export const NativeWindowSchema = z.object({ id: z.string().regex(/^[1-9][0-9]{0,18}$/), pid: z.number().int().positive(), title: z.string().max(1000), program: z.string().max(500), bounds }).strict();
export const NativeDisplaySchema = z.object({ id: z.string().regex(/^[1-9][0-9]{0,18}$/), bounds }).strict();
export const NativeWatchSchema = z.object({
  target: z.discriminatedUnion("kind", [z.object({ kind: z.literal("window"), window: NativeWindowSchema }).strict(), z.object({ kind: z.literal("display"), display: NativeDisplaySchema }).strict()]),
  exclude: z.array(NativeWindowSchema).max(32).default([]), frames: z.number().int().min(1).max(20).default(5), intervalMs: z.number().int().min(200).max(2000).default(1000),
}).strict();
export type NativeWatch = z.infer<typeof NativeWatchSchema>;
const listing = z.object({ protocol: z.literal(1), platform: z.enum(["darwin", "x11"]), windows: z.array(NativeWindowSchema).max(2048), displays: z.array(NativeDisplaySchema).max(32) }).strict();
const frame = listing.extend({ before: z.array(NativeWindowSchema).max(2048), width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192), method: z.enum(["native-window", "native-filter"]), target: NativeWatchSchema.shape.target, exclude: z.array(NativeWindowSchema).max(32) }).strict();

/** Prepared, hash-pinned helper only. Never build/download a helper as part of screen access. */
export async function nativeWindowAction(platform: string, env: NodeJS.ProcessEnv, exec: PosixExec, input: { action: "list" } | { action: "capture"; watch: NativeWatch; outPath: string }, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (platform !== "darwin" && platform !== "linux") throw new Error("Native window watch is available only on Mac or Linux X11.");
  if (platform === "linux" && (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY || !env.DISPLAY)) throw new Error("Wayland and headless sessions are unsupported: no whole-screen or XWayland fallback was taken.");
  if (platform === "linux" && input.action === "capture" && (input.watch.target.kind !== "window" || input.watch.exclude.length)) throw new Error("X11 supports window-only capture. Arbitrary display-window exclusion is unsupported; no pixels were captured.");
  const executable = env.BRANCH_NATIVE_WINDOW_CAPTURE, expected = env.BRANCH_NATIVE_WINDOW_CAPTURE_SHA256;
  if (!executable || !isAbsolute(executable) || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Hold: prepare and hash-pin the native window helper before watching. Nothing was installed.");
  const info = await stat(executable);
  if (!info.isFile() || info.size > 50_000_000 || (info.mode & 0o022)) throw new Error("Native helper must be a bounded regular file writable only by its owner.");
  if (createHash("sha256").update(await readFile(executable)).digest("hex") !== expected) throw new Error("Native helper changed; owner preparation is required again.");
  assertRealScreenAllowed(); signal.throwIfAborted();
  const result = await exec(executable, [JSON.stringify(input.action === "list" ? { action: "list" } : { action: "capture", target: input.watch.target, exclude: input.watch.exclude, outPath: input.outPath })], signal);
  if (result.status !== "completed" || result.exitCode !== 0) throw new Error(result.stderr.slice(0, 1000) || "Native capture was refused.");
  const answer = (input.action === "list" ? listing : frame).parse(JSON.parse(result.stdout));
  if (answer.platform !== (platform === "darwin" ? "darwin" : "x11")) throw new Error("Native helper returned the wrong platform.");
  if (input.action === "capture") {
    const captured = frame.parse(answer);
    if (JSON.stringify(captured.target) !== JSON.stringify(input.watch.target) || JSON.stringify(captured.exclude) !== JSON.stringify(input.watch.exclude)) throw new Error("Native target or exclusion terms changed.");
    if (captured.method !== (input.watch.target.kind === "display" ? "native-filter" : "native-window")) throw new Error("Helper returned an unapproved capture method.");
  }
  return answer;
}