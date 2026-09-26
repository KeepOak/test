import { lockdownActive } from "./lockdown.js";
import { readPolicy, type Policy } from "./policy.js";
import { policyChangeLooser, type ToolLister } from "./preset-moves.js";
import type { Store } from "./store.js";

/**
 * Q257: the approval settings saved around the settings kit (POST /api/policy, POST /api/approvals/categories)
 * are held to the kit's own two rules. Under Lockdown the saved policy is Lockdown's ask-everything one and it puts
 * the owner's back when it ends, so a change now would loosen Lockdown or be lost: it is refused (409), whatever
 * else the request says. A change that makes Branch less careful needs the owner's separate yes, `confirmLoosening`,
 * exactly as the kit asks for it (src/settings-kit/changes.ts).
 */
export const lockdownSettingsRefusal = "Lockdown is on, so settings cannot be changed from here. Turn it off first.";

/** Takes the owner's yes to loosening off a request body, so the strict schema behind it never sees the word. */
export function withoutConfirm(body: unknown): { confirmLoosening: boolean; input: unknown } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { confirmLoosening: false, input: body };
  const { confirmLoosening, ...input } = body as Record<string, unknown>;
  if (confirmLoosening !== undefined && typeof confirmLoosening !== "boolean") throw new Error("confirmLoosening is true or false");
  return { confirmLoosening: confirmLoosening === true, input };
}

/** How the settings kit's owner gives that yes; a typed command says its own way (src/terminal-commands.ts). */
export const tickToConfirm = 'Tick "Yes, make it less careful" to go ahead.';

/** Why saving `after` in place of the owner's policy is refused, or null when it may be saved. */
export function policyChangeRefusal(store: Store, owner: string, after: Policy, confirmLoosening: boolean, tools: ToolLister | undefined,
  howToConfirm = tickToConfirm): string | null {
  if (lockdownActive(store, owner)) return lockdownSettingsRefusal;
  if (confirmLoosening) return null;
  const looser = policyChangeLooser(readPolicy(store, owner), after, tools);
  return looser ? `This makes Branch less careful: ${looser}. ${howToConfirm}` : null;
}
