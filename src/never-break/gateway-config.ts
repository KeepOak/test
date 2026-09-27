import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { FeatureModeSchema } from "../feature-switches.js";

/**
 * The gateway's own settings, kept in the data folder beside the database but never inside it, so
 * the gateway can read them without opening anything the worker holds. A copy that is known to have
 * started cleanly is kept as `gateway.good.json` and put back when the current one fails; a change
 * the assistant suggests waits in `gateway.proposed.json` until the owner accepts it.
 */
export const gatewayFile = "gateway.json";
export const goodFile = "gateway.good.json";
export const proposedFile = "gateway.proposed.json";

/**
 * Environment names the gateway may pass to its worker; nothing else can be smuggled in. Integration
 * review: an open `BRANCH_*` pattern let a setting name the shell or git program the engine runs
 * (`BRANCH_BASH`, `BRANCH_GIT`), or a self-test report path it writes to (`BRANCH_SELF_TEST`), so
 * only these four, which change where things are and never what runs, are allowed.
 */
export const workerEnvNames = ["BRANCH_INTEGRATIONS", "BRANCH_WORKSPACE", "BRANCH_PROVIDER", "BRANCH_OSV_ENDPOINT"] as const;
const workerEnvName = z.string().refine((name) => (workerEnvNames as readonly string[]).includes(name),
  "Only these settings can be handed to the engine: " + workerEnvNames.join(", "));

export const GatewayConfigSchema = z.object({
  /** Off: `branch start` is the engine alone, as before. When needed / on: the gateway runs it. */
  mode: FeatureModeSchema.default("off"),
  /** How long a new worker may take to say it is ready. */
  startSeconds: z.number().int().min(2).max(600).default(90),
  /** How long a request waits for a worker that is restarting before it is told to try again. */
  holdSeconds: z.number().int().min(0).max(120).default(20),
  /** Crashes chained within `gapSeconds` of each other before the gateway slows right down. */
  maxQuickCrashes: z.number().int().min(1).max(50).default(4),
  gapSeconds: z.number().int().min(5).max(3600).default(300),
  /** After an update, how long the gateway watches the new version before the update counts as done. */
  watchSeconds: z.number().int().min(10).max(3600).default(300),
  /** Extra settings handed to the worker, such as where the integrations file is. */
  workerEnv: z.record(workerEnvName, z.string().max(4000)).default({}),
}).strict();
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export const defaultGatewayConfig = (): GatewayConfig => GatewayConfigSchema.parse({});

/**
 * Writes a whole file or nothing: a temporary copy is written and flushed to the disk, then renamed
 * over the old one, and the folder is flushed so the rename itself survives a power cut.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  if (process.platform === "win32") return; // Windows cannot open a folder to flush it
  const folder = await open(dirname(path), "r").catch(() => null);
  if (folder) { await folder.sync().catch(() => undefined); await folder.close(); }
}

async function readConfig(path: string): Promise<{ config: GatewayConfig | null; problem: string | null; missing: boolean }> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return { config: null, problem: null, missing: true }; }
  try { return { config: GatewayConfigSchema.parse(JSON.parse(text)), problem: null, missing: false }; }
  catch (error) { return { config: null, problem: plainProblem(error), missing: false }; }
}

const plainProblem = (error: unknown): string => {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join(".") || "the file"}: ${issue.message}`).join("; ").slice(0, 300);
  return error instanceof SyntaxError ? "the file is not readable JSON" : String(error).slice(0, 300);
};

export interface LoadedConfig {
  config: GatewayConfig;
  /** Set when the current file was unreadable and the last good one was put back. */
  restored: boolean;
  problem: string | null;
}

/**
 * The settings to run with. A missing file means the defaults. A broken one is replaced by the last
 * good copy, and the owner is told why; with no good copy either, the defaults are used and the
 * broken file is left where it is for the owner to look at.
 */
export async function loadGatewayConfig(dataDir: string): Promise<LoadedConfig> {
  const current = await readConfig(join(dataDir, gatewayFile));
  if (current.config) return { config: current.config, restored: false, problem: null };
  if (current.missing) return { config: defaultGatewayConfig(), restored: false, problem: null };
  return restoreGood(dataDir, `The gateway's settings could not be used (${current.problem})`);
}

/**
 * What going back to the good copy may change when the current settings could still be read: the
 * owner's switch is kept as it is now, and engine settings can only be taken away, never brought back
 * or changed, so a restore can never undo something the owner turned off or removed.
 */
export function restorable(good: GatewayConfig, current: GatewayConfig): GatewayConfig {
  const workerEnv = Object.fromEntries(Object.entries(good.workerEnv).filter(([name, value]) => current.workerEnv[name] === value));
  return { ...good, mode: current.mode, workerEnv };
}

/** Puts the last good settings back, for a broken file or a worker that will not start with them. */
export async function restoreGood(dataDir: string, why: string, current?: GatewayConfig): Promise<LoadedConfig> {
  const good = await readConfig(join(dataDir, goodFile));
  if (!good.config) return { config: current ?? defaultGatewayConfig(), restored: false, problem: `${why}; there was no earlier good copy, so the ${current ? "settings stay as they are" : "defaults are in use"}.` };
  const config = current ? restorable(good.config, current) : good.config;
  if (current && JSON.stringify(config) === JSON.stringify(current)) return { config: current, restored: false, problem: `${why}; the last settings that worked are the same as these.` };
  await writeAtomic(join(dataDir, gatewayFile), JSON.stringify(config, null, 2));
  return { config, restored: true, problem: `${why}; the last settings that worked were put back.` };
}

/** Called once a worker has come up healthy: these settings are now known to work. */
export async function promoteGood(dataDir: string, config: GatewayConfig): Promise<void> {
  await writeAtomic(join(dataDir, goodFile), JSON.stringify(config, null, 2));
}

export async function saveGatewayConfig(dataDir: string, config: GatewayConfig): Promise<void> {
  await writeAtomic(join(dataDir, gatewayFile), JSON.stringify(GatewayConfigSchema.parse(config), null, 2));
}

export async function sameAsGood(dataDir: string, config: GatewayConfig): Promise<boolean> {
  const good = await readConfig(join(dataDir, goodFile));
  return good.config !== null && JSON.stringify(good.config) === JSON.stringify(config);
}

/**
 * The switch as it is on disk, read at once, for the few places in the engine that behave differently
 * only when it is on. Anything unreadable counts as off, which is how Branch behaved before.
 */
export function neverBreakModeSync(dataDir: string): GatewayConfig["mode"] {
  try {
    const parsed = FeatureModeSchema.safeParse((JSON.parse(readFileSync(join(dataDir, gatewayFile), "utf8")) as { mode?: unknown }).mode);
    return parsed.success ? parsed.data : "off";
  } catch { return "off"; }
}

/* ---------- a change suggested by the assistant, waiting for the owner ---------- */

export const ProposalSchema = z.object({
  config: GatewayConfigSchema,
  why: z.string().max(500),
  proposedAt: z.iso.datetime(),
  /** What the dry run found: null while it has not been tried. */
  check: z.object({ ok: z.boolean(), detail: z.string().max(1000) }).nullable(),
}).strict();
export type Proposal = z.infer<typeof ProposalSchema>;

/** Tries settings on a throwaway gateway; answers whether it came up, in a sentence. */
export type DryRun = (config: GatewayConfig) => Promise<{ ok: boolean; detail: string }>;

/**
 * Records a suggested change. It is checked against the schema at once and tried on a throwaway
 * gateway, and it is never applied here: only `acceptProposal`, which the owner's own screen calls,
 * does that.
 */
export async function proposeConfig(dataDir: string, input: unknown, why: string, dryRun: DryRun): Promise<Proposal> {
  const { mode: _mode, workerEnv: _env, ...change } = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const merged = GatewayConfigSchema.safeParse({ ...(await loadGatewayConfig(dataDir)).config, ...change });
  const check = merged.success ? await dryRun(merged.data).catch((error: unknown) => ({ ok: false, detail: String(error).slice(0, 300) }))
    : { ok: false, detail: plainProblem(merged.error) };
  const proposal: Proposal = { config: merged.success ? merged.data : defaultGatewayConfig(), why: why.slice(0, 500),
    proposedAt: new Date().toISOString(), check };
  await writeAtomic(join(dataDir, proposedFile), JSON.stringify(proposal, null, 2));
  return proposal;
}

export async function readProposal(dataDir: string): Promise<Proposal | null> {
  try { return ProposalSchema.parse(JSON.parse(await readFile(join(dataDir, proposedFile), "utf8"))); }
  catch { return null; }
}

/** The owner said yes. A proposal whose dry run failed cannot be accepted. */
export async function acceptProposal(dataDir: string): Promise<GatewayConfig> {
  const proposal = await readProposal(dataDir);
  if (!proposal) throw new Error("There is no suggested change waiting.");
  if (!proposal.check?.ok) throw new Error(`This change did not start cleanly when it was tried, so it cannot be used: ${proposal.check?.detail ?? "it was never tried"}.`);
  // Only the timings the assistant may suggest are taken; the owner's switch and engine settings stay as they are now.
  const { config: current } = await loadGatewayConfig(dataDir);
  const accepted = { ...proposal.config, mode: current.mode, workerEnv: current.workerEnv };
  await saveGatewayConfig(dataDir, accepted);
  await rm(join(dataDir, proposedFile), { force: true });
  await journalChange(dataDir, { before: timingsOf(current), after: timingsOf(accepted), why: proposal.why,
    acceptedAt: new Date().toISOString(), rolledBackAt: null });
  return accepted;
}

/* ---------- the journal of accepted changes, so the owner can roll one back ---------- */

/**
 * Every change the owner accepted, with the timings before and after it, kept in `gateway.changes.json`
 * beside the settings (never inside the database the worker holds). Only timings are written: the
 * owner's switch and the engine's settings are never changed by a suggestion, so neither by rolling one back.
 */
export const changesFile = "gateway.changes.json";
const TimingsSchema = GatewayConfigSchema.omit({ mode: true, workerEnv: true });
type Timings = z.infer<typeof TimingsSchema>;
export const AcceptedChangeSchema = z.object({
  before: TimingsSchema, after: TimingsSchema, why: z.string().max(500),
  acceptedAt: z.iso.datetime(), rolledBackAt: z.iso.datetime().nullable(),
}).strict();
export type AcceptedChange = z.infer<typeof AcceptedChangeSchema>;
const keptChanges = 20;
const timingsOf = ({ mode: _mode, workerEnv: _env, ...timings }: GatewayConfig): Timings => TimingsSchema.parse(timings);

export async function readChanges(dataDir: string): Promise<AcceptedChange[]> {
  try { return z.array(AcceptedChangeSchema).parse(JSON.parse(await readFile(join(dataDir, changesFile), "utf8"))); }
  catch { return []; }
}
async function journalChange(dataDir: string, change: AcceptedChange): Promise<void> {
  await writeAtomic(join(dataDir, changesFile), JSON.stringify([...(await readChanges(dataDir)), change].slice(-keptChanges), null, 2));
}

/**
 * The owner rolls back the last change they accepted: its timings go back to what they were before it,
 * and the switch and engine settings stay as they are now. Refused when the timings are no longer what
 * that change made them (something else changed them since), so a roll back never undoes a later change.
 */
export async function rollbackAccepted(dataDir: string): Promise<GatewayConfig> {
  const changes = await readChanges(dataDir);
  const last = changes.at(-1);
  if (!last || last.rolledBackAt) throw new Error("There is no accepted change to roll back.");
  const { config: current } = await loadGatewayConfig(dataDir);
  if (JSON.stringify(timingsOf(current)) !== JSON.stringify(last.after))
    throw new Error("The gateway's settings changed after that change was accepted, so it cannot be rolled back as it was.");
  const back = GatewayConfigSchema.parse({ ...last.before, mode: current.mode, workerEnv: current.workerEnv });
  await saveGatewayConfig(dataDir, back);
  await writeAtomic(join(dataDir, changesFile), JSON.stringify([...changes.slice(0, -1), { ...last, rolledBackAt: new Date().toISOString() }], null, 2));
  return back;
}

export async function discardProposal(dataDir: string): Promise<void> {
  await rm(join(dataDir, proposedFile), { force: true });
}
