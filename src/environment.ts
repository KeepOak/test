import { hostname, platform, release, type as osType, version as osVersion } from "node:os";
import { z } from "zod";
import type { ToolDefinition } from "./contracts.js";

/**
 * What Branch knows about where it is running, for the model to know too. Asked "Which device are you on?" in the
 * owner's Telegram chat, the default Trunk said it could not see the device: Branch knows it and never said.
 *
 * One short line goes at the end of every task's system context (after everything that stays the same between turns, so
 * a service's prompt cache still holds): the computer's name, its operating system, that this is the owner's own
 * computer running Branch Agent and in what (the desktop app with its window shown or hidden, the background gateway,
 * or the command line), where the message came from, and the local date, hour and time zone. `environment.about` gives
 * the same, the time to the minute, and a little more on request. Nothing secret, no user name and no folder path.
 *
 * The line names the hour, not the minute: it sits in the part of every request a service's prompt cache keeps, and a
 * minute in it changed that part once a minute, so from one turn to the next the cache held nothing. The idea follows
 * Hermes Agent, whose system prompt stays static between turns (agent/memory_provider.py,
 * https://github.com/NousResearch/hermes-agent/blob/a9a54245b2311c705d29050b7f9868c015917aec/agent/memory_provider.py#L116-L126).
 */
export type Host = "desktop" | "gateway" | "command line";
/** How the engine is being run, from the process itself: never guessed from settings. */
export function currentHost(env: NodeJS.ProcessEnv = process.env, proc: object = process): Host {
  if (env.BRANCH_GATEWAY_CHILD === "1") return "gateway";
  if ((proc as { parentPort?: unknown }).parentPort) return "desktop"; // the desktop app's engine is its utility process
  return "command line";
}
/** Whether the desktop window is shown, as the app's main process last told the engine; null when nobody said. */
let windowShown: boolean | null = null;
export function setWindowShown(shown: boolean | null): void { windowShown = shown; }
export function windowState(): boolean | null { return windowShown; }

/** The operating system in words: "Windows 11 Home (10.0.26200)", "macOS 15.2 (Darwin 24.2.0)", "Linux 6.8". */
export function systemName(os = { platform: platform(), type: osType(), release: release(), version: safeVersion() }): string {
  if (os.platform === "win32") {
    const build = Number(os.release.split(".")[2] ?? 0);
    const name = os.version.replace(/^Windows\s+/i, "").trim();
    // os.version() says "Windows 10 Home" on Windows 11, whose builds start at 22000.
    const edition = name.replace(/^10\b/, build >= 22000 ? "11" : "10");
    return `Windows ${edition || (build >= 22000 ? "11" : "10")} (${os.release})`;
  }
  if (os.platform === "darwin") return `macOS (Darwin ${os.release})`;
  return `${os.type} ${os.release}`;
}
function safeVersion(): string { try { return osVersion(); } catch { return ""; } }

const appNames: Record<string, string> = { telegram: "Telegram", discord: "Discord", slack: "Slack", whatsapp: "WhatsApp",
  matrix: "Matrix", signal: "Signal", "signal-cli": "Signal", imessage: "iMessage", email: "email", sms: "SMS", teams: "Microsoft Teams" };
/** A chat app's name as people say it, from its kind ("whatsapp" → "WhatsApp"). */
export const chatAppName = (kind: string): string => appNames[kind] ?? kind;
export interface EnvironmentFacts {
  device: string;
  system: string;
  host: Host;
  window: "shown" | "hidden" | null;
  channel: string | null;
  /** To the minute, for `environment.about`. */
  time: string;
  /** The hour it is in, as "Tue, 29 Sept 2026, 20:00 to 21:00": all the system line says (see above). */
  hour: string;
  timeZone: string;
}
/** The clock the facts are read from; only a test sets another, to see two turns a minute apart. */
let clock = (): Date => new Date();
export function setEnvironmentClock(next: (() => Date) | null): void { clock = next ?? (() => new Date()); }
/** The facts as they are now. `channel` is the chat app a message came in on (null in the window, or unknown). */
export function environmentFacts(channel: string | null = null, now = clock()): EnvironmentFacts {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const format = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false });
  const time = format.format(now);
  const parts = format.formatToParts(now), part = (type: string) => parts.find((one) => one.type === type)?.value ?? "";
  const from = Number(part("hour")) % 24, pad = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  const hour = `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}, ${pad(from)} to ${pad((from + 1) % 24)}`;
  const host = currentHost(), shown = windowState();
  return { device: hostname(), system: systemName(), host, window: host === "desktop" && shown !== null ? (shown ? "shown" : "hidden") : null,
    channel, time, hour, timeZone };
}
const hostWords = (facts: EnvironmentFacts): string => facts.host === "gateway" ? "in the background gateway (no window)"
  : facts.host === "desktop" ? `in the desktop app${facts.window ? `, its window ${facts.window === "shown" ? "open" : "hidden"}` : ""}`
    : "from the command line";
/** The one line for the system context. */
export function environmentLine(facts: EnvironmentFacts): string {
  const via = facts.channel ? `This message came in on ${facts.channel}` : "This message came from Branch's own window or API";
  return `Where you are running: the owner's own computer "${facts.device}" (${facts.system}), in Branch Agent ${hostWords(facts)}. `
    + `${via}. Local time: ${facts.hour} (${facts.timeZone}). Use environment.about for the exact time and more.`;
}

/** The on-request tool: the same facts and a little more (processor, memory, uptime), nothing secret. */
export function environmentTool(channelOf: (runId: string) => string | null): ToolDefinition<Record<string, never>> {
  return {
    // skills.read: on the short list every chat has (src/channels/chat-permissions.ts), and like it only reads.
    // Not always open: the line in the system text already answers "which device are you on?", and every always-open
    // tool takes a place a task's own toolboxes need. It sits with how Branch is set up (the settings toolbox).
    name: "environment.about", permission: "skills.read", reach: "local",
    description: "This computer and how Branch runs on it: name, operating system, processor, memory, desktop app or background gateway, the chat app a message came in on, local time and time zone.",
    group: "settings",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => {
      void _input;
      const { cpus, totalmem, freemem, uptime, arch } = await import("node:os");
      const facts = environmentFacts(context.runId ? channelOf(context.runId) : null);
      const cores = cpus();
      return { ...facts, where: hostWords(facts), architecture: arch(), processor: cores[0]?.model?.trim() ?? null, cores: cores.length,
        memoryGb: Math.round(totalmem() / 2 ** 30), freeMemoryGb: Math.round(freemem() / 2 ** 30), upHours: Math.round(uptime() / 3600) };
    },
  };
}
