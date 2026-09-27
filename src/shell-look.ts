import { z } from "zod";
import { validationText } from "./request-errors.js";
import { optionalFields } from "./feature-switches.js"; // Q65
import { currentPerson } from "./people/context.js";
import { startedWithShortLivedKey } from "./key-context.js";
import type { Store } from "./store.js";

/**
 * phase2/shell: two switches for the window's frame (docs/configuration.md, "The Trunks strip").
 *
 *   strip    the narrow strip at the left edge (at the foot on a phone) with this computer, your
 *            other computers and your Trunks, each with its own face. A look-and-layout change the
 *            owner asked for (critique #9), so it ships on; switching it off gives the 0.18 window back.
 *   faces3d  procedural 3D stand-ins for the faces of Trunks that ask for one (critique #46). Ships
 *            off: pixel and flat faces are the default, and 3D only draws while this is on.
 *
 *   GET  /api/shell-look   the switches (anyone at the window, a household person included: they only say what to draw)
 *   POST /api/shell-look   { strip?, faces3d? } the owner's alone, at the window
 */
export const ShellLookSettingsSchema = z.object({
  strip: z.enum(["off", "on"]).default("on"),
  faces3d: z.enum(["off", "on"]).default("off"),
}).strict();
export type ShellLook = z.infer<typeof ShellLookSettingsSchema>;
const key = "shell-look";

export const handlesShellLookPath = (path: string): boolean => path === "/api/shell-look";

export class ShellLookError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function readShellLook(store: Pick<Store, "get">, owner: string): ShellLook {
  const saved = ShellLookSettingsSchema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return saved.success ? saved.data : ShellLookSettingsSchema.parse({});
}

/** Only the owner, in the owner's own profile and with this computer's own key. */
function requireOwnerHere(store: Store): void {
  if (startedWithShortLivedKey() || currentPerson())
    throw new ShellLookError(403, "How the window is framed can only be changed by the owner, in the app window.");
  try { store.profiles.requireOwner("How the window is framed"); } catch (error) { throw new ShellLookError(400, (error as Error).message); }
}

export function saveShellLook(store: Store, owner: string, input: unknown): ShellLook {
  requireOwnerHere(store);
  // Q65: only the switch that was sent; `.partial()` put the other back to its default.
  const change = optionalFields(ShellLookSettingsSchema).parse(input);
  const next = ShellLookSettingsSchema.parse({ ...readShellLook(store, owner), ...change });
  store.save("settings", owner, key, next);
  return next;
}

export async function shellLookApi(store: Store, owner: string, method: string, readBody: () => Promise<unknown>): Promise<ShellLook> {
  if (method === "GET") return readShellLook(store, owner);
  if (method !== "POST") throw new ShellLookError(405, "Use GET or POST");
  try {
    return saveShellLook(store, owner, await readBody());
  } catch (error) {
    if (error instanceof ShellLookError) throw error;
    if (error instanceof z.ZodError) throw new ShellLookError(400, validationText(error));
    throw error;
  }
}
