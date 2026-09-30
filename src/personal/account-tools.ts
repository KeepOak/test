import { z } from "zod";
import type { ToolDefinition } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolContext } from "../contracts.js";
import type { SignIn } from "./signin.js";
import { PersonalAccountId } from "./accounts.js";

/** Add account routing to existing service tools without sending the routing field to their API schemas. */
export function accountTools(registry: Pick<ToolRegistry, "register">, signIn: SignIn): Pick<ToolRegistry, "register"> {
  const prefix = signIn.service === "google" ? "gmail" : signIn.service === "microsoft" ? "outlook" : "spotify";
  registry.register({ name: `${prefix}.accounts`, description: "List this service's account IDs and labels and the selected account. Returns no credentials.",
    permission: "personal.read", reach: "local", parameters: z.object({}).strict(), execute: async () => signIn.accounts.list() });
  const accountFor = (permission: string, account?: string): string => {
    if (permission !== "personal.read" && account === undefined && signIn.accounts.list().accounts.length > 1)
      throw new Error("Specify the account ID for this change so confirmation cannot target another selected account.");
    return signIn.accounts.resolve(account);
  };
  return {
    register<T>(definition: ToolDefinition<T>): void {
      if (!(definition.parameters instanceof z.ZodObject)) throw new Error("Account tools need object arguments.");
      const parameters = definition.parameters.safeExtend({ account: PersonalAccountId.optional().describe("Account ID from Settings Accounts; omitted reads use the selected account. Specify it for writes when several accounts exist.") });
      registry.register<T & { account?: string }>({ ...definition, parameters: parameters as z.ZodType<T & { account?: string }>,
        ...(definition.target ? { target: (input: T & { account?: string }, context: ToolContext) =>
          signIn.inAccount(accountFor(definition.permission, input.account), () => {
            const target = definition.target!(input, context);
            return target === null ? null : `Account ${signIn.accountId()}: ${target}`;
          }) } : {}),
        execute: async (input, context) => {
          const { account, ...args } = input as Record<string, unknown>;
          const id = accountFor(definition.permission, account as string | undefined);
          const result = await signIn.withAccount(id, () => definition.execute(definition.parameters.parse(args), context));
          return result && typeof result === "object" && !Array.isArray(result) ? { ...result, account: id } : result;
        },
      });
    },
  };
}
