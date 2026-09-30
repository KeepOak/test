import { z } from "zod";
import { checkedInUse } from "../hot-update/live-folder.js";
import type { LiveOutcome } from "../hot-update/live-build.js";
import type { LiveHooks, LiveApplied } from "./updater.js";
import { WindowUpdateDeferred, type WindowUpdate } from "./live-window-ipc.js";
import type { DesktopControlHost } from "./gateway-control.js";

const part = z.enum(["window", "engine", "gateway"]);
const path = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_.@+-]+(\/[A-Za-z0-9_.@+-]+)*$/)
  .refine((value) => value.split("/").every((piece) => piece !== "." && piece !== ".."));
export const GatewayLiveSchema = z.object({ tier: z.enum(["window", "engine", "gateway"]),
  commit: z.string().regex(/^[a-f0-9]{40}$/), digest: z.string().regex(/^[a-f0-9]{64}$/), version: z.string().max(80),
  changed: z.array(z.object({ path, part }).strict()).max(30000) }).strict();
export const GatewayWindowSchema = z.union([z.object({ engine: z.literal(true) }).strict(),
  z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), styles: z.array(path).max(30000), reload: z.boolean() }).strict()]);

/** Paths/manifest sent by a shell cannot choose the broker's files; it checks its own live folder again. */
export async function applyGatewayLive(appRoot: string, hooks: LiveHooks, args: unknown, onStage: (stage: string) => void): Promise<LiveApplied> {
  const update = GatewayLiveSchema.parse(args);
  const checked = await checkedInUse(appRoot, { commit: update.commit, digest: update.digest, version: update.version, at: new Date().toISOString() });
  if (!checked || checked.manifest.version !== update.version) throw new Error("The live build did not match the checked update.");
  const outcome = { tier: update.tier, version: update.version, parts: new Set(update.changed.map((file) => file.part)),
    dir: checked.dir, manifest: checked.manifest, digest: update.digest, changed: update.changed };
  return hooks.apply(outcome, { onStage });
}

export function gatewayLiveRequest(outcome: Exclude<LiveOutcome, { tier: "shell" | "none" }>): z.infer<typeof GatewayLiveSchema> {
  return GatewayLiveSchema.parse({ tier: outcome.tier, version: outcome.version, commit: outcome.manifest.commit, digest: outcome.digest, changed: outcome.changed });
}

/** Every renderer operation is awaited by the broker; loss/refusal defers adoption and retains the old build. */
export async function tellGatewayWindow(control: Pick<DesktopControlHost, "current">, update: WindowUpdate): Promise<void> {
  const shell = control.current();
  if (!shell) throw new WindowUpdateDeferred("The window is not open yet.");
  try {
    if (await shell.call("window-update", GatewayWindowSchema.parse(update), 180000) !== true) throw new Error("The window did not acknowledge the checked update.");
  } catch (error) { throw new WindowUpdateDeferred(error instanceof Error ? error.message : String(error)); }
}

/** The broker's own tell: an adoption begun with no shell joined has no window to tell (the next one opens on it). */
export async function tellAdoptionWindow(control: AdoptionControl, update: WindowUpdate): Promise<void> {
  if (!control.windowless?.()) await tellGatewayWindow(control, update);
}
/** After a failed adoption: the shell that was joined puts its previous window back; with none joined there is none. */
export async function recoverAdoptionWindow(control: AdoptionControl): Promise<void> {
  if (control.windowless?.()) return;
  const shell = control.current();
  if (!shell || await shell.call("window-recover", undefined, 30000) !== true) throw new Error("The previous window did not restore and draw.");
}

/** The broker's view of its shell during an adoption: `windowless` when no shell was joined as the adoption began. */
export type AdoptionControl = Pick<DesktopControlHost, "current"> & { windowless?: () => boolean };

/**
 * One adoption owns one renderer acknowledgment chain, even if a successor shell connects meanwhile. An adoption that
 * began with no shell joined (the gateway updating itself with no window) has no renderer to acknowledge it: the next
 * window opens on the files served then. A shell that was there and refused or left still fails it.
 */
export function gatewayApplyOwner(control: Pick<DesktopControlHost, "current">): {
  control: AdoptionControl; apply<T>(action: () => Promise<T>): Promise<T>;
} {
  let busy = false, recipient: ReturnType<DesktopControlHost["current"]> = null;
  return { control: { current: () => busy ? recipient : control.current(), windowless: () => busy && recipient === null }, apply: async (action) => {
    if (busy) throw new WindowUpdateDeferred("A checked update is already being applied.");
    busy = true; recipient = control.current();
    try { return await action(); } finally { busy = false; recipient = null; }
  } };
}
