import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createBranch } from "./index.js";
import { startServer } from "./server.js";
import { joinGateway } from "./never-break/worker-link.js";

const profileId = process.env.BRANCH_PROFILE_GATEWAY;
const dataDir = process.env.BRANCH_DATA_DIR;
const workspace = process.env.BRANCH_PROFILE_WORKSPACE;
if (!profileId || !dataDir || !workspace || process.env.BRANCH_GATEWAY_CHILD !== "1")
  throw new Error("Profile workers must be started by their isolated gateway.");
const link = joinGateway();
if (!link) throw new Error("Profile worker has no supervisor channel.");
let app: Awaited<ReturnType<typeof createBranch>> | undefined;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let stopping = false;
link.onStop(async () => { stopping = true; await server?.close(); await app?.close(); });
for (const folder of ["config", "local", "tmp"]) await mkdir(join(process.env.HOME!, folder), { recursive: true, mode: 0o700 });
// No integrations loader or desktop credential bridge: configure this new install explicitly.
app = await createBranch({ dataDir, workspace, owner: `isolated-profile:${profileId}` });
if (stopping) { await app.close(); throw new Error("Supervisor stopped during startup."); }
server = await startServer(app, { dataDir, port: 0 });
if (stopping) { await server.close(); await app.close(); throw new Error("Supervisor stopped during startup."); }
link.ready(Number(new URL(server.url).port), "profile-isolation-v1");
