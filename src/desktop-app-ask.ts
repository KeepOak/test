/**
 * unhold-control: "Ask before opening an app it hasn't used" (Settings › Computer & browser, "Once per
 * app, per Trunk").
 *
 * While the owner has it on, a `desktop.open` of a program the Trunk doing the work has never opened
 * is put to the owner first, whatever the approval rules would have let through. The question is a
 * once-only one (src/runtime.ts `checkPolicy`): no kept yes answers it and it offers no standing
 * rule, so the owner's approval preset is never touched. What stands in for the yes is the record of
 * the programs each Trunk has opened: once a Trunk has opened a program, that Trunk is not asked about
 * it again, and another Trunk still is. The owner's own assistant (work no Trunk set going) counts as
 * one Trunk of its own. A file opened with whatever usually opens it is not a program chosen by name,
 * so it is not held here; the approval rules decide it as before.
 *
 * It only ever makes things stricter: it turns an "allow" into a question, never a refusal or a
 * question into a yes. Lockdown refuses `desktop.open` before it is weighed at all.
 *
 * rw4: it ships on. A stricter guard is not one of the things that ship off (spending, sending, deleting,
 * the microphone or camera, heavy work), so with nothing saved it reads as on; an owner who switched it
 * off keeps it off, because that choice is saved as `{ on: false }`.
 */
import { z } from "zod";
import type { Store } from "./store.js";

export const AppAskSettingsSchema = z.object({ on: z.boolean().default(true) }).strict();
export type AppAskSettings = z.infer<typeof AppAskSettingsSchema>;
const settingsKey = "desktop-app-ask";
const usedKey = (trunk: string): string => `desktop-apps-used:${trunk}`;
const UsedSchema = z.object({ apps: z.array(z.string().max(100)).max(500).default([]) }).strict();

/** The Trunk a call is for, as it is kept here: its id, or "branch" for the owner's own assistant. */
export const trunkKey = (trunk: string | undefined): string => (trunk && trunk.trim() ? trunk.trim().slice(0, 100) : "branch");
/** A program's name as it is compared: the plain name the tool was given, in lower case. */
const appName = (app: string): string => app.trim().toLowerCase();

type SettingsStore = Pick<Store, "get" | "save">;

export function appAskSettings(store: Pick<Store, "get">, owner: string): AppAskSettings {
  const saved = AppAskSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  // A damaged record is read as the stricter of the two, as the wall around programs is.
  return saved.success ? saved.data : { on: true };
}
export function saveAppAskSettings(store: SettingsStore, owner: string, input: unknown): AppAskSettings {
  const value = AppAskSettingsSchema.parse(input ?? {});
  store.save("settings", owner, settingsKey, { ...value });
  return value;
}

/** The programs one Trunk has opened. */
export function appsUsed(store: Pick<Store, "get">, owner: string, trunk: string | undefined): string[] {
  const saved = UsedSchema.safeParse(store.get("settings", owner, usedKey(trunkKey(trunk)))?.data ?? {});
  return saved.success ? saved.data.apps : [];
}
/** Written once the program has really started for that Trunk, so a refused or failed open is asked about again. */
export function noteAppOpened(store: SettingsStore, owner: string, trunk: string | undefined, app: string): void {
  const name = appName(app);
  const apps = appsUsed(store, owner, trunk);
  if (!name || apps.includes(name)) return;
  store.save("settings", owner, usedKey(trunkKey(trunk)), { apps: [...apps, name].slice(-500) });
}

export const newAppHoldReason = "It has not opened this app before, and you asked to be asked first.";

/** The hold for one call: set when the switch is on and this Trunk has never opened this program. */
export function newAppHold(store: Pick<Store, "get">, owner: string, tool: string, args: unknown, trunk: string | undefined): { reason: string; onceOnly: true } | null {
  if (tool !== "desktop.open") return null;
  const app = (args as { app?: unknown } | null)?.app;
  if (typeof app !== "string" || !appName(app)) return null;
  if (!appAskSettings(store, owner).on) return null;
  return appsUsed(store, owner, trunk).includes(appName(app)) ? null : { reason: newAppHoldReason, onceOnly: true };
}
