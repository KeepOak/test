import { token, origin } from "../core/api.js";

const MAX_LINE = 2 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
/** Bounded NDJSON frames. Unlike the upstream WebSocket client, this accepts only Branch's already masked task view. */
export async function readStageStream(sid, signal, current, changed) {
  const auth = token.get(), headers = { accept: "application/x-ndjson", "x-branch-origin": origin.setup ? "setup" : "window" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  const response = await fetch(`/api/panels/live?stream=1&session=${encodeURIComponent(sid)}`, { cache: "no-store", headers, signal });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("application/x-ndjson") || !response.body)
    throw new Error("Live stream unavailable");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", total = 0;
  try {
    while (current() && !signal.aborted) {
      const { value, done } = await reader.read();
      if (!current() || signal.aborted) return;
      if (done) { if (pending.trim()) throw new Error("Incomplete live frame"); return; }
      total += value.byteLength;
      if (total > MAX_TOTAL) throw new Error("Live stream limit");
      pending += decoder.decode(value, { stream: true });
      let split;
      while ((split = pending.indexOf("\n")) >= 0) {
        if (split > MAX_LINE) throw new Error("Live frame limit");
        const line = pending.slice(0, split); pending = pending.slice(split + 1);
        if (!line) continue;
        const view = JSON.parse(line);
        if (!view || typeof view !== "object" || !(view.runId === null || typeof view.runId === "string")
          || !(view.browser === null || typeof view.browser === "object")) throw new Error("Invalid live frame");
        if (current() && !signal.aborted) changed(view);
      }
      if (pending.length > MAX_LINE) throw new Error("Live frame limit");
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
