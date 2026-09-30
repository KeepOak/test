import { createHash } from "node:crypto";
import type { Event, Run } from "./contracts.js";

export interface EventReplay { run: Run; events: Event[]; sha256: string; throughEventId: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

/** Playback data only; recorded approvals never enter the execution engine. */
export function parseEventReplay(text: unknown): EventReplay {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("Choose an event log no larger than 16 MiB");
  if (!text.endsWith("\n")) throw new Error("The event log is incomplete");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 2 || lines.length > 50002) throw new Error("Invalid event log length");
  const rows: unknown[] = lines.map((line) => JSON.parse(line));
  const header = rows[0], footer = rows.at(-1);
  if (!object(header) || header.type !== "header" || header.format !== "branch-run-event-log" || header.version !== 1)
    throw new Error("Unsupported event log format or version");
  if (!object(header.run) || typeof header.run.id !== "string" || !/^[a-f0-9-]{36}$/.test(header.run.id)
    || typeof header.run.prompt !== "string" || !integer(header.throughEventId)) throw new Error("Invalid event log header");
  if (!object(footer) || footer.type !== "footer" || footer.events !== rows.length - 2
    || footer.throughEventId !== header.throughEventId || typeof footer.sha256 !== "string") throw new Error("Invalid event log footer");
  const sha256 = createHash("sha256").update(lines.slice(0, -1).join("\n") + "\n").digest("hex");
  if (sha256 !== footer.sha256) throw new Error("The event log fingerprint does not match");
  const events = eventRows(rows.slice(1, -1), header.run.id, header.throughEventId);
  return { run: header.run as unknown as Run, events, sha256, throughEventId: header.throughEventId };
}

function eventRows(rows: unknown[], runId: string, through: number): Event[] {
  if (!rows.length && through !== 0) throw new Error("The event log is incomplete");
  let previous = 0;
  return rows.map((row, index) => {
    if (!object(row) || row.type !== "event" || !object(row.event)) throw new Error("Invalid event row");
    const event = row.event;
    if (!integer(event.id) || event.id <= previous || event.id > through || event.runId !== runId
      || typeof event.kind !== "string" || !event.kind || !object(event.data) || typeof event.createdAt !== "string")
      throw new Error("Invalid event sequence or task identity");
    previous = event.id;
    if (index === rows.length - 1 && previous !== through) throw new Error("The event log is incomplete");
    return event as unknown as Event;
  });
}
