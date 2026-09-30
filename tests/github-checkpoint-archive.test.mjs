/* SELF-053: the update's data copy leaves only as AES-256-GCM ciphertext with an RSA-wrapped key, and comes back only
   with the owner's matching private key, into a new local copy (src/install/github-checkpoint-archive.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { encryptDataCopy, recoverDataCopy } from "../dist/install/github-checkpoint-archive.js";
import { publicRecipient } from "../dist/install/github-checkpoint-contract.js";
import { dataCopyName } from "../dist/install/data-copy.js";
import { backupFolder } from "../dist/install/update-backup.js";

const pair = () => generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

test("an exported data copy is ciphertext only, and recovers whole only with the matching private key", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-gh-checkpoint-"));
  t.after(() => discardTemp(dataDir));
  const name = dataCopyName("1.2.3", new Date()), folder = join(dataDir, backupFolder, name);
  await mkdir(join(folder, "memory"), { recursive: true });
  await writeFile(join(folder, "branch.db"), "secret-database-bytes");
  await writeFile(join(folder, "memory", "notes-about-ada.md"), "private note");
  const keys = pair(), recipient = publicRecipient(keys.publicKey);
  const config = { format: 1, owner: "local", repository: "ada/branch-checkpoints", repositoryID: 42, project: "default", tokenSecret: "GITHUB_TOKEN",
    publicKey: recipient.publicKey, fingerprint: recipient.fingerprint, maxBytes: 1024 * 1024, enrollment: randomUUID(), approvedAt: new Date().toISOString() };
  const { envelope, chunks } = await encryptDataCopy(dataDir, { name, path: folder }, config);
  const sent = Buffer.concat([Buffer.from(JSON.stringify(envelope)), ...chunks]).toString("latin1");
  for (const plain of ["secret-database-bytes", "private note", "notes-about-ada", "branch.db"]) assert.ok(!sent.includes(plain), `${plain} never leaves in the clear`);
  await assert.rejects(encryptDataCopy(dataDir, { name, path: dataDir }, config), /exact finalized update data copy/, "only the finalized copy can be exported");
  const keyFile = join(dataDir, "recovery.pem"), wrongFile = join(dataDir, "wrong.pem");
  await writeFile(keyFile, keys.privateKey); await writeFile(wrongFile, pair().privateKey);
  await assert.rejects(recoverDataCopy(dataDir, "1.2.3", config, envelope, Buffer.concat(chunks), wrongFile, () => undefined), /mismatch/);
  await new Promise((resolve) => setTimeout(resolve, 1100)); // a new copy name, never the one already there
  const back = await recoverDataCopy(dataDir, "1.2.3", config, envelope, Buffer.concat(chunks), keyFile, () => undefined);
  assert.equal(back.files, 2);
  assert.notEqual(back.name, name, "recovery makes a new local copy and never replaces one");
  assert.equal(await readFile(join(dataDir, backupFolder, back.name, "memory", "notes-about-ada.md"), "utf8"), "private note");
  assert.ok((await readdir(join(dataDir, backupFolder))).includes(name), "the original copy is untouched");
});
