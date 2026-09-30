// Pure offline playback validation. No API requests, approvals or tool calls.
export async function readEventLog(file) {
  if (!file || file.size > 16 * 1024 * 1024) throw new Error("Choose an event log no larger than 16 MiB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw new Error("The event log is incomplete");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 2 || lines.length > 50002) throw new Error("Invalid event log length");
  const rows = lines.map((line) => JSON.parse(line)), header = rows[0], footer = rows.at(-1);
  if (header?.type !== "header" || header.format !== "branch-run-event-log" || header.version !== 1)
    throw new Error("Unsupported event log format or version");
  if (!header.run || typeof header.run.id !== "string" || !/^[a-f0-9-]{36}$/.test(header.run.id)
    || typeof header.run.prompt !== "string" || !Number.isSafeInteger(header.throughEventId) || header.throughEventId < 0)
    throw new Error("Invalid event log header");
  if (footer?.type !== "footer" || footer.events !== rows.length - 2 || footer.throughEventId !== header.throughEventId)
    throw new Error("Invalid event log footer");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines.slice(0, -1).join("\n") + "\n"));
  const hash = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (hash !== footer.sha256) throw new Error("The event log fingerprint does not match");
  let previous = 0;
  const events = rows.slice(1, -1).map((row) => {
    const event = row?.event;
    if (row?.type !== "event" || !event || !Number.isSafeInteger(event.id) || event.id <= previous
      || event.id > header.throughEventId || event.runId !== header.run.id || typeof event.kind !== "string" || !event.kind
      || !event.data || typeof event.data !== "object" || Array.isArray(event.data) || typeof event.createdAt !== "string")
      throw new Error("Invalid event sequence or task identity");
    previous = event.id;
    return event;
  });
  if (previous !== header.throughEventId) throw new Error("The event log is incomplete");
  return { text, run: header.run, events, hash };
}
