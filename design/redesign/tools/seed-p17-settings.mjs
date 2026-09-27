// Seeds what verify-p17-settings.cjs needs before the engine starts: a made-up home folder holding a Claude Code setup
// (tests/move-in-fixtures.mjs, never a real ~/.claude), and one update in the engine's activation journal, so the
// never-break journal has a row. Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<fresh dir> MOVE_IN_HOME=<fresh dir> node design/redesign/tools/seed-p17-settings.mjs
// then start the engine with two offline model connections, pointing moving in at that home:
//   BRANCH_DATA_DIR=<same> BRANCH_MOVE_IN_HOME=<same home> BRANCH_WORKSPACE=<fresh dir> \
//   BRANCH_MODEL_PRESETS='[{"id":"one","name":"One","provider":"demo"},{"id":"two","name":"Two","provider":"demo"}]' \
//   BRANCH_PORT=<port> node dist/cli.js start
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { claudeHome } from "../../../tests/move-in-fixtures.mjs";
import { ActivationJournal } from "../../../dist/never-break/activation.js";

const dataDir = process.env.BRANCH_DATA_DIR, home = process.env.MOVE_IN_HOME;
if (!dataDir || !home) { console.error("Set BRANCH_DATA_DIR and MOVE_IN_HOME."); process.exit(2); }
await mkdir(resolve(dataDir), { recursive: true });
await claudeHome(resolve(home));
const journal = new ActivationJournal(join(resolve(dataDir), "activation.sqlite"));
journal.activated(journal.stage({ kind: "update", fromVersion: "0.0.1", toVersion: "0.0.2", target: join(resolve(dataDir), "app"), previous: null,
  candidate: null, launcher: null, executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] }));
journal.close();
console.log(JSON.stringify({ dataDir: resolve(dataDir), home: resolve(home) }));
