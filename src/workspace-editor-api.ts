import { createHash } from "node:crypto";
import { errorText } from "./request-errors.js";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { shippedUnlessChosen } from "./ship-on.js";
import { FeatureModeSchema } from "./feature-switches.js";
import type { WorkspaceFiles } from "./files.js";
import type { Store } from "./store.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48

/**
 * The code editor in the window (A0098): list a folder, open a text file, save it. Every path goes
 * through the same checks as the assistant's own file tools (inside the workspace, no secret-looking
 * names, nothing `.branchignore` hides, nothing the assistant may only read), and a save is the
 * assistant's own `files.write`, so the bytes before it are kept and it can be put back.
 *
 * A save names the version it was opened from (a checksum). When the file changed on disk since
 * then, the save is refused with 409 rather than quietly overwriting someone else's change.
 *
 * The owner's three-way switch, off by default: off refuses every route but the switch itself;
 * "when needed" and "on" both let the editor work ("on" also opens the editor in the Files tab).
 */
export class WorkspaceEditorApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const WorkspaceEditorSettingsSchema = z.object({ mode: FeatureModeSchema.default("off") }).strict();
export type WorkspaceEditorSettings = z.infer<typeof WorkspaceEditorSettingsSchema>;
const KEY = "workspace-editor";
// The owner's rule (ships on, 2026-09-26): a save goes through the ordinary file tool and can be undone; none of (a)–(f).
export const workspaceEditorShipsAs = "when-needed" as const;

export interface EditorHost {
  files: WorkspaceFiles;
  store: Store;
  owner: string;
  /** The assistant's own tool runner, so a save is recorded and can be undone like any other write. */
  runTool: (name: string, args: unknown) => Promise<unknown>;
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>;
  /** Branch's own guard (src/never-break/protected.ts): a reason when this path may not be read or changed. */
  guard?: (path: string, readOnly: boolean) => string | null;
}

export const handlesWorkspaceEditorPath = (path: string): boolean => /^\/api\/workspace-editor(\/|$)/.test(path);
export const checksum = (text: string): string => createHash("sha256").update(text).digest("hex");

export function workspaceEditorSettings(store: Pick<Store, "get">, owner: string): WorkspaceEditorSettings {
  const saved = WorkspaceEditorSettingsSchema.safeParse(store.get("settings", owner, KEY)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, KEY, saved.data, { mode: workspaceEditorShipsAs }) : WorkspaceEditorSettingsSchema.parse({});
}

const pathParam = z.string().trim().min(1).max(500);
const SaveSchema = z.object({
  path: pathParam,
  content: z.string().max(32768),
  /** The checksum the file had when it was opened; null for a file that does not exist yet. */
  opened: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
}).strict();

export async function workspaceEditorApi(host: EditorHost, request: IncomingMessage, path: string, url: URL): Promise<unknown> {
  if (path === "/api/workspace-editor/settings") {
    if (request.method !== "POST") return workspaceEditorSettings(host.store, host.owner);
    const value = WorkspaceEditorSettingsSchema.parse(await host.readBody(request, 1024));
    recordedWrite(host.store, host.owner, byCard(KEY), [KEY], () => host.store.save("settings", host.owner, KEY, value));
    return value;
  }
  if (workspaceEditorSettings(host.store, host.owner).mode === "off")
    throw new WorkspaceEditorApiError(403, "The code editor is switched off. Turn it on in Settings → Advanced.");
  if (request.method === "GET" && path === "/api/workspace-editor/list")
    return listFolder(host.files, url.searchParams.get("path") || ".");
  if (request.method === "GET" && path === "/api/workspace-editor/read") {
    const target = pathParam.parse(url.searchParams.get("path") ?? "");
    guarded(host, target, true);
    return openFile(host.files, target);
  }
  if (request.method === "POST" && path === "/api/workspace-editor/save")
    return saveFile(host, SaveSchema.parse(await host.readBody(request, 128 * 1024)));
  throw new WorkspaceEditorApiError(404, "Endpoint not found");
}

async function listFolder(files: WorkspaceFiles, folder: string): Promise<unknown> {
  const listed = await files.list(pathParam.parse(folder)).catch((error: unknown) => refuse(error));
  const prefix = folder === "." ? "" : `${folder.replace(/\/+$/, "")}/`;
  return {
    path: folder,
    entries: listed.entries.map((entry) => ({ ...entry, path: `${prefix}${entry.name}`, readOnly: Boolean(files.readOnly(`${prefix}${entry.name}`)) })),
  };
}

/** A file the editor can show: text, within the size limit, and readable by the assistant. */
async function readText(files: WorkspaceFiles, path: string): Promise<string | null> {
  try {
    const { content } = await files.read(path);
    if (content.includes("\u0000")) throw new WorkspaceEditorApiError(415, "This is not a text file, so it cannot be edited here.");
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return refuse(error);
  }
}

async function openFile(files: WorkspaceFiles, path: string): Promise<unknown> {
  const content = await readText(files, path);
  if (content === null) throw new WorkspaceEditorApiError(404, "There is no file with that name.");
  const readOnly = files.readOnly(path);
  return { path, content, opened: checksum(content), readOnly: Boolean(readOnly), ...(readOnly ? { why: readOnly } : {}) };
}

function guarded(host: EditorHost, path: string, readOnly: boolean): void {
  const refusal = host.guard?.(path, readOnly);
  if (refusal) throw new WorkspaceEditorApiError(403, refusal);
}

async function saveFile(host: EditorHost, input: z.infer<typeof SaveSchema>): Promise<unknown> {
  guarded(host, input.path, false);
  const readOnly = host.files.readOnly(input.path);
  if (readOnly) throw new WorkspaceEditorApiError(403, readOnly);
  const current = await readText(host.files, input.path);
  const now = current === null ? null : checksum(current);
  if (now !== input.opened)
    throw new WorkspaceEditorApiError(409, current === null
      ? "The file was removed since you opened it. Copy your text, then open it again."
      : "The file changed since you opened it. Open it again to see the change before saving.");
  await host.runTool("files.write", { path: input.path, content: input.content }).catch((error: unknown) => refuse(error));
  return { path: input.path, bytes: Buffer.byteLength(input.content), opened: checksum(input.content) };
}

/** The file tools' refusals, as answers with the right status and the tools' own plain words. */
function refuse(error: unknown): never {
  if (error instanceof WorkspaceEditorApiError) throw error;
  const message = errorText(error);
  if (/32 KiB/.test(message)) throw new WorkspaceEditorApiError(413, "This file is larger than 32 KiB, so it cannot be edited here.");
  if (/ENOENT|not a directory|ENOTDIR/i.test(message)) throw new WorkspaceEditorApiError(404, "There is nothing with that name.");
  throw new WorkspaceEditorApiError(403, message.replace(/\/[^\s"']+/g, "").slice(0, 200) || "That path cannot be used.");
}
