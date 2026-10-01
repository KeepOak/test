/* `node tests/fixtures/fixture-model-run.mjs run "..."`: runs `branch` (dist/cli.js) with these arguments against the
   tests' scripted model (tests/fixtures/fixture-model.mjs), for the build machine's one end-to-end task. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixtureModel } from "./fixture-model.mjs";

const { env } = await fixtureModel();
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ...env } });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
