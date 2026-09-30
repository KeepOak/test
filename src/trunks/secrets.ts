import { z } from "zod";
import { audit } from "../audit.js";
import type { Store } from "../store.js";
import { secretNameSchema } from "../locker.js";

/**
 * RES-260: a Trunk's own secrets. Each Trunk keeps them in a locker project of its own (`t-<trunk id>`), which is
 * reserved (src/projects.ts), so no project the owner makes can share it and the generic secrets routes never reach it.
 *
 * When a command a Trunk runs asks for secrets by name (src/index.ts secretsFor):
 *   - its own turns get a name from its own secrets first;
 *   - a name it does not keep comes from the owner's active project only when the Trunk uses the owner's keys
 *     (`keys.copyFromOwner`, as it ships), and is refused by name otherwise;
 *   - a helper it set going never reads its own secrets (it gets the owner's, on the same rule, or nothing);
 *   - another Trunk, and the owner's own conversations, never read them at all.
 * Values never leave the locker except into a command's environment; the owner sets and removes them here, by name.
 */
export const trunkSecretsProject = (trunkId: string): string => `t-${trunkId}`;

export interface TrunkSecretsWork {
  /** The Trunk whose work this is, or null for the owner's own. */
  trunk: string | null;
  /** True for a helper a task set going (its origin has a parent run). */
  helper: boolean;
  /** Whether that Trunk also uses the owner's keys. */
  copyFromOwner: boolean;
}

/** Which project each asked name comes from, or a refusal naming what this work may not have. */
export function secretSources(work: TrunkSecretsWork, names: readonly string[], own: readonly string[], ownerProject: string):
  { plan: Record<string, string[]>; refused: string[] } {
  if (!work.trunk) return { plan: names.length ? { [ownerProject]: [...names] } : {}, refused: [] };
  const mine = work.helper ? [] : names.filter((name) => own.includes(name));
  const rest = names.filter((name) => !mine.includes(name));
  if (rest.length && !work.copyFromOwner) return { plan: {}, refused: rest };
  const plan: Record<string, string[]> = {};
  if (mine.length) plan[trunkSecretsProject(work.trunk)] = mine;
  if (rest.length) plan[ownerProject] = rest;
  return { plan, refused: [] };
}

export const trunkSecretRefusal = (names: readonly string[]): string =>
  `${names.join(", ")} ${names.length === 1 ? "is" : "are"} not among this Trunk's own secrets, and it does not use yours. `
  + "The owner adds one on the Trunk's page, or lets it use your keys.";

const ChangeSchema = z.union([
  z.object({ name: secretNameSchema, value: z.string().min(1).max(8192) }).strict(),
  z.object({ name: secretNameSchema, remove: z.literal(true) }).strict(),
]);

/** The owner's view and changes of one Trunk's secrets: names and dates only, never a value. */
export function trunkSecretsRoute(store: Store, owner: string, trunk: { id: string; name: string }) {
  const project = trunkSecretsProject(trunk.id);
  return {
    list: () => ({ secrets: store.secrets.list(owner, project).map(({ name, createdAt }) => ({ name, createdAt })) }),
    change: async (body: unknown) => {
      const asked = ChangeSchema.parse(body);
      if ("remove" in asked) {
        const removed = store.secrets.remove(owner, project, asked.name);
        audit(store, owner, { action: "policy.changed", actor: owner, subject: `Trunk "${trunk.name}": secret ${asked.name}`,
          reason: "Taken away from the Trunk's own secrets", outcome: removed ? "removed" : "nothing to remove" });
        return { removed };
      }
      await store.secrets.put(owner, project, asked.name, asked.value);
      audit(store, owner, { action: "policy.changed", actor: owner, subject: `Trunk "${trunk.name}": secret ${asked.name}`,
        reason: "Kept among the Trunk's own secrets; only its own turns use it", outcome: "saved" });
      return { saved: asked.name };
    },
  };
}
