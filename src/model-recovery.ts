import { ProviderStreamError } from "./contracts.js";
import { NoConfiguredModelError } from "./no-model.js";
import { fallbackEligible, outOfCredit, ProviderHttpError } from "./provider-retry.js";

export type ModelRecovery = "setup" | "account" | "unavailable";

/** Called only after the current permitted route cannot continue; no provider text is interpreted here. */
export function modelRecoveryFor(error: unknown): ModelRecovery | null {
  for (let depth = 0; error instanceof ProviderStreamError && depth < 4; depth++) {
    if (error.estimatedOutput > 0 || error.usage !== undefined) return null;
    error = error.cause;
  }
  if (error instanceof NoConfiguredModelError) return "setup";
  if (error instanceof ProviderHttpError && ([401, 403].includes(error.status)
    || ["model_not_found", "model_not_available", "unsupported_model"].some((code) => code === error.code))) return "account";
  if (outOfCredit(error)) return "account";
  return fallbackEligible(error) ? "unavailable" : null;
}
