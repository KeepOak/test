/* A fresh engine for verify-setup-keep.cjs that behaves like an installed app for "Start with Windows", without ever
   reading or writing this computer's real sign-in list: the registry tool is an in-memory stand-in (the RunTool that
   src/install/autostart.ts already takes), which refuses any key other than the per-person Run key and never spawns.
     PORT=<port> node design/redesign/tools/verify-setup-keep-engine.mjs
   Prints the address and "Local session token (paste into browser): <hex>", like `branch start`. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../../../dist/index.js";
import { startServer } from "../../../dist/server.js";
import { runKey, runValueName } from "../../../dist/install/installer.js";

const port = Number(process.env.PORT ?? 0);
const root = mkdtempSync(join(tmpdir(), "branch-setup-keep-"));
const dataDir = join(root, "data");
const values = new Map();

/* reg.exe as the engine calls it: query / add / delete of one value under one key. */
async function standIn(file, args) {
  const [verb, key] = args;
  if (!file.toLowerCase().endsWith("reg.exe")) throw new Error(`the stand-in only plays reg.exe, not ${file}`);
  if (key !== runKey) throw new Error(`the stand-in refuses any key but the sign-in list: ${key}`);
  const name = args[args.indexOf("/v") + 1];
  if (name !== runValueName) throw new Error(`the stand-in refuses any value but Branch's own: ${name}`);
  if (verb === "query") {
    if (!values.has(name)) throw new Error("reg.exe failed: The system was unable to find the specified registry key or value.");
    return `\r\n${key}\r\n    ${name}    REG_SZ    ${values.get(name)}\r\n\r\n`;
  }
  if (verb === "add") { values.set(name, args[args.indexOf("/d") + 1]); return "The operation completed successfully.\r\n"; }
  if (verb === "delete") { values.delete(name); return "The operation completed successfully.\r\n"; }
  throw new Error(`the stand-in does not play reg.exe ${verb}`);
}

/* LOGIN_ITEM=1: a Mac-style login item stand-in instead (what src/desktop/login-item.ts hands in), which macOS keeps
   waiting for the person's approval once it is switched on. */
let loginOn = false;
const loginItem = { read: () => ({ enabled: loginOn, needsApproval: loginOn }), set(enabled) { loginOn = enabled; return this.read(); } };

const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
const installRoot = join(root, "Programs", "Branch Agent");
const server = await startServer(app, {
  dataDir, port, executable: join(installRoot, "Branch Agent.exe"), installRoot,
  autostartDeps: { run: standIn, systemRoot: "C:\\Windows" },
  ...(process.env.LOGIN_ITEM === "1" ? { loginItem } : {}),
});
console.log(`Branch (stand-in install) listening at ${server.url}`);
console.log(`Local session token (paste into browser): ${server.token}`);
console.log(`Data folder: ${dataDir}`);
const stop = async () => { await server.close(); await app.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
