import { randomBytes } from "node:crypto";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { LaunchFileSchema } from "../integrations/bootstrap.js";
import { readIntegrationFacts } from "../security-audit/integration-facts.js";

/**
 * R17-S14: the launch settings file (BRANCH_INTEGRATIONS) shown as a card instead of only as JSON.
 *
 * The card reads everything the security check already reads, in the same careful way, and lets the
 * owner change four things without opening the file: how long a command may run, how much of its
 * output is kept, whether commands are cut off from the internet, and which sites the browser may
 * open. The whole file is checked with the same schema the launch uses before anything is written,
 * the write replaces the file in one step, and the change applies from the next start.
 *
 * When this start left sections of the file out (it sits in a workspace folder the owner has not
 * trusted), the card names them, and nothing in them is counted as set up.
 */
const origin = z.string().max(200).refine((value) => {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && url.origin === value; } catch { return false; }
}, "Write each site as its address without a path, like https://example.com");

export const LaunchFileChangeSchema = z.object({
  commandTimeoutSeconds: z.number().int().min(1).max(120).optional(),
  commandOutputBytes: z.number().int().min(256).max(8192).optional(),
  commandsOffline: z.boolean().optional(),
  browserSites: z.array(origin).min(1).max(64).optional(),
}).strict();

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});

export async function launchFileView(path: string | null, leftOut: readonly string[] = []) {
  if (!path) return { path: null, problem: null, facts: null, editable: null };
  const facts = await readIntegrationFacts(path);
  if (facts.problem) return { path, problem: facts.problem, facts: null, editable: null };
  const raw = record(JSON.parse(await readFile(path, "utf8")));
  const shell = raw.shell === undefined ? null : record(raw.shell);
  const browser = raw.browser === undefined ? null : record(raw.browser);
  const used = (section: string): boolean => !leftOut.includes(section);
  return {
    path, problem: null,
    facts: {
      servers: used("mcp") ? facts.mcp.length : 0, hooks: used("hooks") ? facts.hooks.length : 0,
      chatApps: used("channels") ? facts.channels.map((channel) => channel.type) : [],
      programs: used("shell") ? facts.shell?.executables.map((one) => one.alias) ?? [] : [],
      keyLikeValues: facts.keyLikeValues,
      leftOut: [...leftOut],
    },
    editable: {
      commands: shell && {
        commandTimeoutSeconds: Math.round((typeof shell.timeoutMs === "number" ? shell.timeoutMs : 30000) / 1000),
        commandOutputBytes: typeof shell.maxOutputBytes === "number" ? shell.maxOutputBytes : 8192,
        commandsOffline: shell.netless === true,
      },
      browserSites: browser ? facts.browser?.allowedOrigins ?? [] : null,
    },
  };
}

/** The file with the change written in, checked as a whole. */
function patched(raw: Json, change: z.infer<typeof LaunchFileChangeSchema>): Json {
  const next: Json = { ...raw };
  const commands = change.commandTimeoutSeconds ?? change.commandOutputBytes ?? change.commandsOffline;
  if (commands !== undefined) {
    if (raw.shell === undefined) throw new Error("The launch settings file has no command section, so there is nothing to change there.");
    next.shell = { ...record(raw.shell),
      ...(change.commandTimeoutSeconds !== undefined ? { timeoutMs: change.commandTimeoutSeconds * 1000 } : {}),
      ...(change.commandOutputBytes !== undefined ? { maxOutputBytes: change.commandOutputBytes } : {}),
      ...(change.commandsOffline !== undefined ? { netless: change.commandsOffline } : {}) };
  }
  if (change.browserSites) {
    if (raw.browser === undefined) throw new Error("The launch settings file has no browser section, so there is nothing to change there.");
    // A list of websites replaces "any website": the browser takes one or the other.
    const { anyWebsite: _any, ...browser } = record(raw.browser);
    next.browser = { ...browser, allowedOrigins: change.browserSites };
  }
  LaunchFileSchema.parse(next);
  return next;
}

export async function saveLaunchFile(path: string | null, input: unknown, leftOut: readonly string[] = []) {
  if (!path) throw new Error("Branch was started without a launch settings file, so there is nothing to change.");
  const change = LaunchFileChangeSchema.parse(input);
  const facts = await readIntegrationFacts(path);
  if (facts.problem) throw new Error(facts.problem);
  const next = patched(record(JSON.parse(await readFile(path, "utf8"))), change);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(text) > 65536) throw new Error("The launch settings file would be larger than Branch reads.");
  await replaceFile(await realpath(path), text);
  return { ...(await launchFileView(path, leftOut)), savedForNextStart: true };
}

/**
 * Replaces the file in one step. A link the owner made stays a link: the file it points at is the
 * one written. The spare copy has a name nobody can guess and is only ever created new, so a link
 * planted beside the file cannot turn the write towards another file.
 */
async function replaceFile(target: string, text: string): Promise<void> {
  const mode = (await stat(target)).mode & 0o777;
  const temporary = `${target}.${randomBytes(8).toString("hex")}.saving`;
  try {
    await writeFile(temporary, text, { mode, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
