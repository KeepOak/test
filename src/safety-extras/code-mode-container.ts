import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cleanChildEnvironment } from "../child-env.js";
import type { SandboxStart } from "../sandbox-backends.js";

/** Windows uses an already installed Docker engine and already local Linux image.
 * No host execution fallback, image pull, credentials, network or Docker socket mount. */
export function containerScript(staging: string, image: string): { start: SandboxStart; close(): Promise<void> } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/.test(image) || staging.includes(","))
    throw new Error("Code mode needs a valid local Docker image and a scratch path without commas.");
  const name = `branch-code-${randomUUID()}`;
  const env = cleanChildEnvironment();
  const start = { executable: "docker", cwd: staging, env, args: [
    "run", "--rm", "--interactive", "--pull=never", "--name", name,
    "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=32", "--memory=256m", "--cpus=1", "--user=65534:65534",
    "--workdir=/work", "--mount", `type=bind,source=${staging},target=/work,readonly`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--env", "BRANCH_SCRIPT_RPC_STDOUT=1",
    "--entrypoint=node", image, "--no-warnings", "--max-old-space-size=128", "/work/host.mjs",
  ] };
  let removing: Promise<void> | undefined;
  return { start, close: () => removing ??= removeContainer(name, staging, env) };
}

function removeContainer(name: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["rm", "--force", name], { cwd, env, shell: false, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    child.once("error", () => { clearTimeout(timer); resolve(); });
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}
