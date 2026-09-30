import { constants, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { dataCopyName, dataCopyPattern } from "./data-copy.js";
import { backupFolder } from "./update-backup.js";
import { chunkBytes, publicRecipient, sha256, type CheckpointConfig } from "./github-checkpoint-contract.js";

const EntrySchema = z.object({ path: z.string().min(1).max(1000), kind: z.enum(["file", "directory"]), content: z.string().max(90 * 1024 * 1024).optional(), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const ArchiveSchema = z.object({ format: z.literal(1), name: z.string().max(120), entries: z.array(EntrySchema).max(5000) }).strict();
export const EnvelopeSchema = z.object({ format: z.literal(1), id: z.string().uuid(), repositoryID: z.number().int().positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.string().length(16), tag: z.string().length(24), wrappedKey: z.string().min(512).max(2800), digest: z.string().regex(/^[a-f0-9]{64}$/),
  chunks: z.array(z.object({ path: z.string().regex(/^chunks\/\d{4}\.bin$/), bytes: z.number().int().positive().max(chunkBytes), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(24),
}).strict();
export type Envelope = z.infer<typeof EnvelopeSchema>;
type Entry = z.infer<typeof EntrySchema>;
const aad = (value: Pick<Envelope, "id" | "repositoryID" | "fingerprint">) => Buffer.from(JSON.stringify([1, value.id, value.repositoryID, value.fingerprint]));

function safeRelative(path: string): string {
  if (path.length > 1000 || isAbsolute(path) || path.includes("\\") || path.includes(":")) throw new Error("Unsafe checkpoint archive path.");
  for (const part of path.split("/")) {
    if (!part || part === "." || part === ".." || /[\x00-\x1f<>"|?*]/.test(part) || /[ .]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error("Unsafe checkpoint archive path.");
  }
  return path;
}

async function stableFile(path: string, limit: number): Promise<Buffer> {
  const link = await lstat(path);
  if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1 || link.size > limit) throw new Error("Checkpoint file is linked, unsupported, or exceeds the approved size.");
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== link.ino || before.dev !== link.dev || before.size !== link.size) throw new Error("Checkpoint file changed while opening.");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const got = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!got.bytesRead) throw new Error("Checkpoint file changed while reading.");
      offset += got.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Checkpoint file changed while reading.");
    return bytes;
  } finally { await handle.close(); }
}

async function collect(root: string, folder: string, entries: Entry[], budget: { bytes: number; max: number; deadline: number }, seen: Set<string>): Promise<void> {
  const info = await lstat(folder), resolved = await realpath(folder), rel = relative(root, resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || (rel && (rel.startsWith(`..${sep}`) || isAbsolute(rel)))) throw new Error("Checkpoint folder escaped its finalized copy.");
  for await (const child of await opendir(folder)) {
    if (Date.now() > budget.deadline) throw new Error("Checkpoint archive exceeded its time budget; update held.");
    const path = join(folder, child.name), name = safeRelative(relative(root, path).split(sep).join("/"));
    const folded = name.normalize("NFC").toLowerCase();
    if (seen.has(folded) || entries.length >= 5000) throw new Error("Checkpoint has colliding paths or too many files.");
    seen.add(folded); const item = await lstat(path);
    if (item.isSymbolicLink()) throw new Error("Checkpoint contains a symbolic link; update held.");
    if (item.isDirectory()) { entries.push({ path: name, kind: "directory" }); await collect(root, path, entries, budget, seen); }
    else {
      const bytes = await stableFile(path, budget.max - budget.bytes); budget.bytes += bytes.length;
      entries.push({ path: name, kind: "file", content: bytes.toString("base64"), digest: sha256(bytes) });
      bytes.fill(0);
    }
  }
}

/** Only a finalized, named takeDataCopy directory is eligible; live owner files are never exported. */
export async function encryptDataCopy(dataDir: string, folder: { name: string; path: string }, config: CheckpointConfig): Promise<{ envelope: Envelope; chunks: Buffer[] }> {
  const expected = join(dataDir, backupFolder, folder.name);
  if (!dataCopyPattern.test(folder.name) || basename(folder.path) !== folder.name || await realpath(expected) !== await realpath(folder.path)) throw new Error("Remote checkpoint must use the exact finalized update data copy.");
  const entries: Entry[] = [], root = await realpath(expected);
  await collect(root, expected, entries, { bytes: 0, max: config.maxBytes, deadline: Date.now() + 30000 }, new Set());
  const plain = Buffer.from(JSON.stringify({ format: 1, name: folder.name, entries }));
  if (plain.length > 96 * 1024 * 1024) { plain.fill(0); throw new Error("Encrypted archive size limit exceeded; update held."); }
  const key = randomBytes(32), nonce = randomBytes(12);
  const identity = { format: 1 as const, id: randomUUID(), repositoryID: config.repositoryID, fingerprint: config.fingerprint };
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad(identity));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < encrypted.length; offset += chunkBytes) chunks.push(encrypted.subarray(offset, offset + chunkBytes));
    const envelope = EnvelopeSchema.parse({ ...identity, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      wrappedKey: publicEncrypt({ key: config.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"), digest: sha256(encrypted),
      chunks: chunks.map((part, n) => ({ path: `chunks/${String(n).padStart(4, "0")}.bin`, bytes: part.length, digest: sha256(part) })) });
    return { envelope, chunks };
  } finally { key.fill(0); plain.fill(0); }
}

function decodeArchive(plain: Buffer, config: CheckpointConfig): Entry[] {
  const archive = ArchiveSchema.parse(JSON.parse(plain.toString("utf8"))), seen = new Set<string>(); let total = 0;
  if (!dataCopyPattern.test(archive.name)) throw new Error("Unknown recovery archive format.");
  for (const entry of archive.entries) {
    safeRelative(entry.path); const folded = entry.path.normalize("NFC").toLowerCase();
    if (seen.has(folded)) throw new Error("Recovery archive path collision."); seen.add(folded);
    if (entry.kind === "directory") { if (entry.content !== undefined || entry.digest !== undefined) throw new Error("Invalid directory entry."); continue; }
    if (!entry.content || !entry.digest) { if (entry.content !== "" || !entry.digest) throw new Error("Missing recovery content."); }
    const bytes = Buffer.from(entry.content!, "base64"); total += bytes.length;
    if (bytes.toString("base64") !== entry.content || sha256(bytes) !== entry.digest || total > config.maxBytes) throw new Error("Recovery file integrity or size check failed.");
    bytes.fill(0);
  }
  return archive.entries;
}

export async function recoverDataCopy(dataDir: string, version: string, config: CheckpointConfig, envelope: Envelope, encrypted: Buffer, privateKeyFile: string, authorize: () => void): Promise<{ name: string; files: number }> {
  authorize();
  if (!isAbsolute(privateKeyFile)) throw new Error("Choose the exact absolute path to your recovery private key.");
  const pem = await stableFile(privateKeyFile, 16000), privateKey = createPrivateKey(pem); pem.fill(0);
  authorize();
  const recipient = publicRecipient(createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString());
  if (recipient.fingerprint !== config.fingerprint || envelope.fingerprint !== config.fingerprint || envelope.repositoryID !== config.repositoryID || sha256(encrypted) !== envelope.digest) throw new Error("Recovery identity or ciphertext mismatch.");
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope.wrappedKey, "base64"));
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(aad(envelope)); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const entries = decodeArchive(plain, config), name = dataCopyName(version, new Date());
    const parent = join(dataDir, backupFolder), staging = join(parent, `recovery-${randomUUID()}.partial`);
    await mkdir(parent, { recursive: true, mode: 0o700 }); await mkdir(staging, { mode: 0o700 });
    try {
      await stageEntries(staging, entries, authorize); authorize();
      // Never replace a known copy or the live data folder.
      try { await lstat(join(parent, name)); throw new Error("A local copy already has that name; retry recovery later."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(staging, join(parent, name)); return { name, files: entries.filter((entry) => entry.kind === "file").length };
    } catch (error) {
      await removeOwnStaging(parent, staging).catch(() => undefined);
      throw error;
    }
  } finally { key.fill(0); plain?.fill(0); }
}

async function removeOwnStaging(parent: string, staging: string): Promise<void> {
  const name = basename(staging), info = await lstat(staging);
  if (!/^recovery-[a-f0-9-]{36}\.partial$/.test(name) || !info.isDirectory() || info.isSymbolicLink()
    || await realpath(staging) !== join(await realpath(parent), name)) throw new Error("Unsafe recovery staging cleanup refused.");
  await rm(staging, { recursive: true, force: false });
}

async function stageEntries(folder: string, entries: Entry[], authorize: () => void): Promise<void> {
  const deadline = Date.now() + 30000;
  const check = () => { authorize(); if (Date.now() > deadline) throw new Error("Recovery staging exceeded its time budget."); };
  const directories = entries.filter((entry) => entry.kind === "directory").sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const entry of directories) { check(); await mkdir(join(folder, entry.path), { mode: 0o700 }); }
  for (const entry of entries.filter((entry) => entry.kind === "file")) {
    check();
    const bytes = Buffer.from(entry.content!, "base64");
    try { await writeFile(join(folder, entry.path), bytes, { flag: "wx", mode: 0o600 }); } finally { bytes.fill(0); }
  }
}
