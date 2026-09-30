import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { assertRealScreenAllowed } from "../integrations/real-screen-guard.js";

export const PortalWatchSchema = z.object({ frames: z.number().int().min(1).max(20).default(10), intervalMs: z.number().int().min(200).max(2000).default(1000) }).strict();
const grant = z.object({ session: z.string().regex(/^\/org\/freedesktop\/portal\/desktop\/session\/[a-zA-Z0-9_]+\/branch_[a-f0-9]{32}$/), portalOwner: z.string().regex(/^:[0-9]+\.[0-9]+$/), sourceType: z.literal(2), serial: z.string().regex(/^[1-9][0-9]{0,19}$/), opaqueId: z.string().max(256), nodeId: z.number().int().positive(), persistMode: z.literal(0) }).strict();
const event = z.discriminatedUnion("kind", [z.object({ kind: z.literal("grant"), grant }).strict(), z.object({ kind: z.literal("frame"), grant, width: z.literal(1280), height: z.literal(720), png: z.string().max(4_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(), z.object({ kind: z.literal("end") }).strict()]);
export type PortalEvent = z.infer<typeof event>;

/** Dedicated prepared helper, same bounded owner grant for every streamed frame; no reconnect or node-ID fallback. */
export async function portalWindowWatch(terms: z.infer<typeof PortalWatchSchema>, signal: AbortSignal, authorize: () => void, emit: (value: PortalEvent) => Promise<void>): Promise<void> {
  authorize(); assertRealScreenAllowed(); signal.throwIfAborted();
  if (process.platform !== "linux") throw new Error("Window portal capture is available only on Linux.");
  const executable = process.env.BRANCH_PORTAL_WINDOW_CAPTURE, expected = process.env.BRANCH_PORTAL_WINDOW_CAPTURE_SHA256;
  if (!executable || !isAbsolute(executable) || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Hold: prepare and hash-pin the WINDOW portal helper first. Nothing was installed.");
  const metadata = await stat(executable);
  if (!metadata.isFile() || metadata.size > 50_000_000 || metadata.mode & 0o022 || createHash("sha256").update(await readFile(executable)).digest("hex") !== expected) throw new Error("Prepared portal helper is unsafe or changed.");
  authorize(); signal.throwIfAborted();
  const child = spawn(executable, [JSON.stringify(PortalWatchSchema.parse(terms))], { detached: true, stdio: ["ignore", "pipe", "pipe"], cwd: tmpdir(), env: portalEnvironment() });
  let alive = true, buffer = "", bytes = 0, errors = "", approved: string | undefined, frames = 0, ended = false, failed: Error | undefined;
  const stop = () => { if (alive && child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} setTimeout(() => { if (alive) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} } }, 500).unref(); } };
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => { alive = false; code === 0 ? resolve() : reject(new Error(errors || "Portal helper stopped.")); }); });
  void closed.catch(() => undefined);
  const watchdog = setInterval(() => { try { authorize(); } catch (error) { failed = error instanceof Error ? error : new Error(String(error)); stop(); } }, 250);
  const timeout = setTimeout(() => { failed = new Error("Portal selection/watch deadline exceeded."); stop(); }, 120_000);
  signal.addEventListener("abort", stop, { once: true });
  child.once("exit", () => { alive = false; });
  child.stderr!.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString("utf8")).slice(0, 1000); });
  try {
    // Async iteration applies backpressure; the producer has at most one queued appsink frame.
    for await (const chunk of child.stdout!) {
      authorize(); signal.throwIfAborted(); bytes += chunk.length; buffer += chunk.toString("utf8");
      if (bytes > 85_000_000 || buffer.length > 4_100_000) throw new Error("Portal output bound exceeded.");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const value = event.parse(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); authorize(); signal.throwIfAborted();
        if (value.kind === "grant") { if (approved || ended) throw new Error("Portal grant replayed."); approved = JSON.stringify(value.grant); }
        else if (value.kind === "frame") { if (!approved || ended || JSON.stringify(value.grant) !== approved || ++frames > terms.frames) throw new Error("Portal source grant changed."); const png = Buffer.from(value.png, "base64"); if (png.length > 3_000_000 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Invalid bounded PNG."); }
        else { if (!approved || ended || frames !== terms.frames) throw new Error("Incomplete portal watch."); ended = true; }
        await emit(value);
      }
    }
    await closed; if (failed) throw failed; if (buffer.trim() || !ended) throw new Error("Portal watch ended without its exact grant receipt.");
  } finally { clearInterval(watchdog); clearTimeout(timeout); signal.removeEventListener("abort", stop); stop(); await closed.catch(() => undefined); }
}
function portalEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir(),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
    ...(process.env.XDG_SESSION_TYPE ? { XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE } : {}) };
}