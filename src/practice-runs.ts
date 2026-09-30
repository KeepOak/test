import { z } from "zod";
import type { Store } from "./store.js";

const key = "practice-runs";
const Input = z.object({ enabled: z.boolean() }).strict();

/** Availability only: ordinary tasks still run normally unless their own dryRun flag is set. */
export function practiceRunsEnabled(store: Pick<Store, "get">, owner: string): boolean {
  return store.get("settings", owner, key)?.data.enabled !== false;
}

export function savePracticeRuns(store: Pick<Store, "get" | "save">, owner: string, raw: unknown): boolean {
  const { enabled } = Input.parse(raw);
  store.save("settings", owner, key, { enabled });
  return enabled;
}
