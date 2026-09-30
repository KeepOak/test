import { z } from "zod";
import type { Store } from "./store.js";
import type { ModelRouter } from "./models.js";
import { poolId } from "./accounts/settings.js";
import { HelperAccountRefSchema } from "./delegation.js";
import { accountsServiceFor } from "./accounts/service.js";
import { helperDefaults, saveHelperDefaults, type HelperDefault } from "./helper-defaults.js";

/* models-ui (MODEL-051): GET/POST /api/helper-defaults, the owner's; the window's Customize › Specialists card reads and
   saves it (public/app/places/customize17.js). */
/** The connections a helper may be put on, each with the accounts of its own list (named as Settings › Accounts names them). */
export function helperChoices(models: ModelRouter) {
  const service = accountsServiceFor(models);
  return [...models.presets.values()].map((preset) => {
    const found = service?.poolFor(preset) ?? null;
    const pool = found ? service!.pool(found.pool) : null;
    const accounts = (pool?.accounts ?? []).filter((account) => !account.disabled)
      .map((account) => ({ id: account.id, label: service!.presentation(found!.pool, account, found!.kind).label }));
    return { model: preset.id, name: preset.name, pool: found?.pool ?? null, accounts };
  });
}

const SaveSchema = z.object({ specialist: z.string().uuid(), model: poolId.nullable(), accountRef: HelperAccountRefSchema.nullable().optional() }).strict();
/**
 * Saves one specialist's default; a null model clears it. Refused before anything is saved when the model is not
 * registered or the account is not one of that model's own list.
 */
export function saveHelperDefault(store: Store, owner: string, models: ModelRouter, input: unknown): Record<string, HelperDefault> {
  const asked = SaveSchema.parse(input);
  if (!store.get("specialists", owner, asked.specialist)) throw Object.assign(new Error("There is no specialist with that id"), { status: 404 });
  const next = { ...helperDefaults(store, owner) };
  if (asked.model === null) delete next[asked.specialist];
  else {
    const choice = helperChoices(models).find((one) => one.model === asked.model);
    if (!choice) throw new Error(`Unknown helper model: ${asked.model}`);
    const ref = asked.accountRef ?? null;
    if (ref && (ref.pool !== choice.pool || !choice.accounts.some((account) => account.id === ref.account)))
      throw new Error("That account is not one of this model connection's accounts");
    next[asked.specialist] = { model: asked.model, ...(ref ? { accountRef: ref } : {}) };
  }
  saveHelperDefaults(store, owner, next);
  return next;
}


export function helperDefaultsView(store: Store, owner: string, models: ModelRouter) {
  return { specialists: helperDefaults(store, owner), choices: helperChoices(models) };
}
