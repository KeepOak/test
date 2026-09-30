import { UsageSchema, type Completion } from "../contracts.js";

/** A successful call's selected account and provider-reported tokens, never estimated tokens. */
export function accountCallReceipt(pool: string, account: string | null, label: string | null, model: string, completion: Completion, binding = "selected") {
  const parsed = UsageSchema.safeParse(completion.usage);
  return { pool, account, label, model, usage: parsed.success ? parsed.data : null,
    tokenBasis: parsed.success ? "reported" : "unreported", accountBinding: account ? binding : "unbound" };
}
