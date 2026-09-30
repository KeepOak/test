import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "./gateway.js";
import { ActivationJournal, fingerprintTree, type LedgerLine } from "./activation.js";
import { performRollback } from "./rollback.js";
import { defaultGatewayConfig, saveGatewayConfig, writeAtomic } from "./gateway-config.js";

export interface RecoveryDrill {
  kind: "isolated-update-rollback"; startedAt: string; finishedAt: string;
  ok: boolean; detail: string; ledger: LedgerLine[];
}
const reportName = "gateway-drill.json";
const running = new Set<string>();

export async function lastRecoveryDrill(dataDir: string): Promise<RecoveryDrill | null> {
  try { return JSON.parse(await readFile(join(dataDir, reportName), "utf8")) as RecoveryDrill; }
  catch { return null; }
}

/** Runs production activation/rollback and supervision on disposable fixture programs, never the owner's engine. */
export async function runRecoveryDrill(dataDir: string): Promise<RecoveryDrill> {
  if (running.has(dataDir)) throw new Error("A recovery drill is already running");
  running.add(dataDir);
  const startedAt = new Date().toISOString();
  let root: string | null = null;
  let outcome: Pick<RecoveryDrill, "ok" | "detail" | "ledger">;
  try {
    root = await mkdtemp(join(tmpdir(), "branch-recovery-drill-"));
    outcome = await exerciseRollback(root);
  } catch (error) {
    outcome = { ok: false, detail: error instanceof Error ? error.message : String(error), ledger: [] };
  } finally {
    try { if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    finally { running.delete(dataDir); }
  }
  const report: RecoveryDrill = { kind: "isolated-update-rollback", startedAt,
    finishedAt: new Date().toISOString(), ...outcome };
  await writeAtomic(join(dataDir, reportName), JSON.stringify(report));
  return report;
}

async function exerciseRollback(root: string): Promise<Pick<RecoveryDrill, "ok" | "detail" | "ledger">> {
  const target = join(root, "program"), candidate = join(root, "candidate"), dataDir = join(root, "data");
  await mkdir(target); await mkdir(candidate);
  await writeFile(join(candidate, "worker.cjs"), "process.exit(23);\n");
  await writeFile(join(target, "worker.cjs"), goodWorker);
  await saveGatewayConfig(dataDir, { ...defaultGatewayConfig(), mode: "on", startSeconds: 2 });
  const journal = new ActivationJournal(join(root, "activation.sqlite"));
  let gateway = null as Gateway | null, crashed = false, ready = false;
  const start = async () => {
    ready = false;
    gateway = new Gateway({ dataDir, script: join(target, "worker.cjs"), args: [], port: 0,
      presence: false, version: "recovery-drill", env: workerEnvironment(),
      onWorker: (event) => { if (event.kind === "crash") crashed = true; else ready = true; } });
    await gateway.start();
  };
  try {
    const id = journal.stage({ kind: "update", fromVersion: "drill-good", toVersion: "drill-bad",
      target, previous: await fingerprintTree(target), candidate: await fingerprintTree(candidate),
      launcher: null, executableName: "worker.cjs", understood: 0, databases: [], backups: [] });
    await rename(target, `${target}.previous`); await rename(candidate, target);
    journal.activated(id);
    await start(); await waitFor(() => crashed, "The deliberately bad worker did not fail.");
    journal.step(id, "detected deliberately bad candidate", true, "The supervisor observed a worker crash.");
    const rollback = await performRollback(journal.entry(id), { journal, by: `drill-${process.pid}`,
      observe: async () => ({ current: await fingerprintTree(target), previous: await fingerprintTree(`${target}.previous`),
        store: null, runnerKnows: 0 }), stop: async () => { await gateway?.stop(); },
      restart: async () => { await start(); await waitFor(() => ready, "The restored fixture did not become ready."); } });
    const ok = rollback.ok && ready && journal.entry(id)?.state === "rolled-back";
    return { ok, ledger: journal.ledger(id), detail: ok
      ? "The bad fixture failed, the real rollback restored the fingerprinted previous program, and the real gateway started it. This isolated drill does not prove an installed update or saved-work migration."
      : rollback.message };
  } finally { try { await gateway?.stop(); } finally { journal.close(); } }
}

async function waitFor(done: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!done()) throw new Error(failure);
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}

// No provider, tools, network or owner settings: fixture readiness uses the real gateway IPC contract.
const goodWorker = `
process.on('message', message => { if (message.type === 'stop') process.exit(0); });
process.send({ type: 'ready', contract: 1, accepts: [1, 1], port: 1, version: 'drill-good', pid: process.pid });
setInterval(() => {}, 1000);
`;
