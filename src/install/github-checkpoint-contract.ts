import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { backupFolder } from "./update-backup.js";

export const checkpointBranch = "branch-update-checkpoints";
export const chunkBytes = 4 * 1024 * 1024;
export const ConfigSchema = z.object({
  format: z.literal(1), owner: z.string().min(1).max(200), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  repositoryID: z.number().int().positive(), project: z.string().min(1).max(200), tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  publicKey: z.string().max(16000), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), maxBytes: z.number().int().min(1024).max(64 * 1024 * 1024),
  enrollment: z.string().uuid(), approvedAt: z.string().datetime(),
}).strict();
export type CheckpointConfig = z.infer<typeof ConfigSchema>;
export const ProposalSchema = ConfigSchema.pick({ repository: true, project: true, tokenSecret: true, publicKey: true, maxBytes: true });
export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const checkpointHome = (dataDir: string) => join(dataDir, backupFolder, "github-checkpoint");

async function checkHome(dataDir: string): Promise<void> {
  for (const path of [join(dataDir, backupFolder), checkpointHome(dataDir)]) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Checkpoint authorization folder is unsafe; update held.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function configBytes(path: string, expected: Awaited<ReturnType<typeof lstat>>): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 24000 || before.ino !== expected.ino || before.dev !== expected.dev) throw new Error("Checkpoint authorization changed while opening; update held.");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Checkpoint authorization changed while reading.");
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Checkpoint authorization changed while reading.");
    return bytes;
  } finally { await handle.close(); }
}

export function publicRecipient(pem: string): { publicKey: string; fingerprint: string } {
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(pem.trim())) throw new Error("Supply only an SPKI recovery public key, never a private key.");
  const key = createPublicKey(pem), bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < 3072 || bits > 16384) throw new Error("Choose an RSA recovery public key of 3072–16384 bits.");
  return { publicKey: key.export({ type: "spki", format: "pem" }).toString(),
    fingerprint: sha256(key.export({ type: "spki", format: "der" })) };
}

/** Protected updater-owned sidecar, excluded from takeDataCopy and ordinary database restores. */
export async function readCheckpointConfig(dataDir: string): Promise<CheckpointConfig | null> {
  await checkHome(dataDir);
  const path = join(checkpointHome(dataDir), "authorization.json");
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 24000) throw new Error("Checkpoint authorization is unsafe; update held.");
  const config = ConfigSchema.parse(JSON.parse((await configBytes(path, info)).toString("utf8")));
  const key = publicRecipient(config.publicKey);
  if (key.fingerprint !== config.fingerprint) throw new Error("Checkpoint recipient changed; update held.");
  if (["keepoak/branch-agent", "stabrea/branch-agent"].includes(config.repository.toLowerCase()))
    throw new Error("Use a dedicated private backup repository, not Branch's source repository.");
  return config;
}

export async function saveCheckpointConfig(dataDir: string, config: CheckpointConfig | null): Promise<void> {
  await checkHome(dataDir);
  const home = checkpointHome(dataDir);
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Disabled is an explicit owner action; no model/settings-kit writer is registered for this sidecar.
  if (!config) {
    const { unlink } = await import("node:fs/promises");
    await unlink(join(home, "authorization.json")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return;
  }
  const temporary = join(home, `${randomUUID()}.partial`);
  await writeFile(temporary, JSON.stringify(ConfigSchema.parse(config)), { flag: "wx", mode: 0o600 });
  await rename(temporary, join(home, "authorization.json"));
}
