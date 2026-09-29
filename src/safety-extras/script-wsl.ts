import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkRunner, wslHeldPlan, wslHeldRunner, wslHeldStart, wslProbe, wslReadiness } from "../integrations/wsl-held.js";
import { wslPath, type SandboxStart, type WallDeps } from "../sandbox-backends.js";

/** The trusted Linux runner is outside the only folder generated code may write. */
export async function scriptWslStart(staging: string, timeoutMs: number, unreadable: readonly string[], deps: WallDeps, interactive = true, scratchOnly = false): Promise<SandboxStart> {
  const missing = await wslReadiness(deps.probe ?? wslProbe);
  if (missing) throw new Error(missing);
  const runner = wslHeldRunner();
  await checkRunner(runner, staging);
  const plan = wslHeldPlan({ executable: { path: "node.exe", args: [] },
    args: ["--no-warnings", "--max-old-space-size=256", `${wslPath(staging)}/host.mjs`],
    cwd: staging, workspace: staging, env: {}, secrets: [], registry: false, timeoutMs });
  const planFile = join(staging, "held-plan.json");
  await writeFile(planFile, JSON.stringify({ ...plan, interactive, scratchOnly, unreadable: unreadable.map(wslPath) }), { mode: 0o600 });
  return wslHeldStart({ runner, planFile, cwd: staging });
}
