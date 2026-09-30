import { z } from "zod";
import type { MessageBoxOptions } from "electron";

const inventory = z.object({ tools: z.array(z.object({ name: z.string(), permission: z.string(), readiness: z.string().optional() })) });

/** Registered GitHub tools mean the owner configured a connection; no token or remote is read here. */
export function githubCheckpointConnected(value: unknown): boolean {
  return inventory.parse(value).tools.some((tool) => tool.name === "github.checks" && tool.permission === "github.manage");
}

export async function updateGitHubConnected(url: string, call: typeof fetch): Promise<boolean> {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/")
    throw new Error("The local engine address is not safe for a checkpoint offer.");
  const response = await call(`${origin.origin}/api/tools`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Branch could not read its GitHub connection. The update is waiting.");
  return githubCheckpointConnected(await response.json());
}

export function checkpointQuestion(version: string): MessageBoxOptions {
  return { type: "question", title: "Keep a checkpoint before updating?",
    message: `Before updating to ${version}, would you like to prepare a GitHub checkpoint?`,
    detail: "Prepare opens an unsent request in your conversation. Choose the project folder, GitHub remote and branch, review the files, then approve any send. Opening the request does not save or upload a checkpoint.",
    buttons: ["Prepare checkpoint", "Update without checkpoint", "Cancel update"], defaultId: 0, cancelId: 2, noLink: true };
}

/** Choices apply to one exact release/channel in this desktop session, never to future releases. */
export class UpdateCheckpointChoice {
  private skipped: string | null = null;
  private held: string | null = null;
  needed(key: string, automatic: boolean): boolean { return this.skipped !== key && !(automatic && this.held === key); }
  paused(key: string): boolean { return this.held === key; }
  decide(key: string, response: number): void {
    if (response === 1) { this.skipped = key; this.held = null; }
    else { this.held = key; this.skipped = null; }
  }
}
