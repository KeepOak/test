/**
 * dogfood-ux-3: which path "Show in folder" may reveal (src/desktop/show-in-folder-ipc.ts). Kept apart from Electron so it
 * can be checked on its own: only a path the engine lists as a file the assistant kept, exactly as the engine lists it.
 */
export interface KeptFile { path: string }
export type KeptFiles = () => Promise<readonly KeptFile[]>;

/** The path to reveal: the engine's own entry for the file named, or null when the engine keeps no such file. */
export async function keptPath(asked: unknown, kept: KeptFiles): Promise<string | null> {
  if (typeof asked !== "string" || !asked || asked.length > 1024) return null;
  return (await kept()).find((file) => file.path === asked)?.path ?? null;
}
