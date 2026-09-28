import { z } from "zod";
import type { Store } from "./store.js";
import { poolId } from "./accounts/settings.js";
import { HelperAccountRefSchema, type HelperSelection } from "./delegation.js";

/**
 * models-ui (MODEL-051, owner 2026-09-27): the model and account each specialist answers with when a call names none.
 *
 * A helper's route is still chosen once per helper conversation and pinned there (src/delegation.ts keepHelperRoute), so
 * a default saved here only reaches helpers started after it; a conversation already pinned keeps its route. What a call
 * names itself comes first. A saved account is used only while the model it was saved with is the one the helper uses,
 * so it can never be handed to another connection. Nothing is saved by default: helpers keep the sub-task model, then
 * the conversation's.
 */
export const HelperDefaultSchema = z.object({ model: poolId, accountRef: HelperAccountRefSchema.optional() }).strict();
export type HelperDefault = z.infer<typeof HelperDefaultSchema>;
export const HelperDefaultsSchema = z.object({ specialists: z.record(z.string().uuid(), HelperDefaultSchema).default({}) }).strict();
const helperDefaultsKey = "helper-defaults";

export function helperDefaults(store: Store, owner: string): Record<string, HelperDefault> {
  const saved = HelperDefaultsSchema.safeParse(store.get("settings", owner, helperDefaultsKey)?.data ?? {});
  return saved.success ? saved.data.specialists : {};
}
export function saveHelperDefaults(store: Store, owner: string, specialists: Record<string, HelperDefault>): void {
  store.save("settings", owner, helperDefaultsKey, HelperDefaultsSchema.parse({ specialists }));
}
export function helperDefaultFor(store: Store, owner: string, specialist: string): HelperDefault | null {
  return helperDefaults(store, owner)[specialist] ?? null;
}

/**
 * What a helper call comes to once a specialist's saved default is added: the call's own model first, then the saved
 * one; the saved account only when the model in use is the one it was saved with. A default whose model is no longer
 * registered is left out, so the helper falls back as if nothing was saved.
 */
export function withHelperDefault(selection: HelperSelection, saved: HelperDefault | null, registered: (id: string) => boolean): HelperSelection {
  // A call that names an account keeps its own route whole: the saved model would not be that account's.
  if (!saved || !registered(saved.model) || (selection.accountRef && !selection.model)) return selection;
  const model = selection.model ?? saved.model;
  const accountRef = selection.accountRef ?? (model === saved.model ? saved.accountRef : undefined);
  return { model, ...(accountRef ? { accountRef } : {}) };
}
