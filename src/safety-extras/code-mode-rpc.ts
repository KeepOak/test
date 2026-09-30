import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const rpcMarker = "@@branch-script-rpc@@";
export const maxFrameBytes = 65_536;
export const maxOutputBytes = 65_536;
export const maxPendingRequests = 50;

/** Incremental framing rejects oversized unterminated lines before readline can buffer them. */
export function readFrames(stream: NodeJS.ReadableStream, onLine: (line: string) => void, stop: () => void): void {
  let pending = Buffer.alloc(0);
  let stopped = false;
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk: Buffer | string) => {
    if (stopped) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (const fragment of decoder.write(data).split(/(?<=\n)/)) {
      pending = Buffer.concat([pending, Buffer.from(fragment)]);
      if (pending.length > maxFrameBytes) { pending = Buffer.alloc(0); stopped = true; stop(); return; }
      if (fragment.endsWith("\n")) { onLine(pending.toString("utf8").trimEnd()); pending = Buffer.alloc(0); }
    }
  });
}

export function stopScript(child: ChildProcess): void {
  try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
  catch { child.kill("SIGKILL"); }
}

export function boundedReply(reply: Record<string, unknown>): string {
  const text = JSON.stringify(reply);
  if (Buffer.byteLength(text) <= maxFrameBytes) return text;
  return JSON.stringify({ id: reply.id, ok: false, error: "Tool result exceeds the code-mode reply limit. Request a smaller result." });
}
