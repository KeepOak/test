import { randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ContainerBackend, defaultSandboxProbe, defaultSandboxSpawn, sandboxBackendSettings, type SandboxRunResult } from "./sandbox-backends.js";
import { sourceGit } from "./self-development-evidence.js";
import { contractHash, sourceFolder } from "./self-development-contract.js";
import type { SelfDevelopmentDeps } from "./self-development.js";
import type { TestCopyReceipt } from "./self-development-test-copy.js";
import { dogfoodProbe } from "./continuous-qa-probe.js";

const JobInput = z.object({ id: z.string().uuid(), mode: z.enum(["tests", "preview", "dogfood"]), target: z.enum(["web", "desktop-copy"]).default("web") }).strict();
const IdInput = z.object({ id: z.string().uuid() }).strict();
type Job = { id: string; copyId: string; sha: string; mode: "tests" | "preview" | "dogfood"; target: "web" | "desktop-copy"; status: "running" | "passed" | "failed" | "cancelled" | "held";
  startedAt: string; finishedAt?: string; problem?: string; result?: SandboxRunResult };

// Runs only inside the isolated container. Port 38127 is never published on the owner's computer.
const startupProbe = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['dist/cli.js','start'],{cwd:'/work/source',env:{PATH:process.env.PATH,HOME:'/tmp',TMPDIR:'/tmp',BRANCH_DATA_DIR:'/work/data',BRANCH_WORKSPACE:'/work/workspace',BRANCH_PORT:'38127',BRANCH_GATEWAY:'off'},stdio:['ignore','pipe','pipe']});
let ended=false; child.once('exit',()=>{ended=true});
child.stdout.on('data',d=>process.stdout.write(d)); child.stderr.on('data',d=>process.stderr.write(d));
(async()=>{try{for(let i=0;i<60;i++){if(ended)throw Error('Preview engine exited before health answered');try{const r=await fetch('http://127.0.0.1:38127/api/health');if(r.ok){console.log('Confined preview answered health; provider access and native desktop UI remain untested.');return;}}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('Preview health did not answer');}catch(e){console.error(e.message);process.exitCode=1;}finally{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2000).unref();}})();`;

function command(copy: TestCopyReceipt, mode: "tests" | "preview" | "dogfood", target: "web" | "desktop-copy") {
  if (!copy.expectedTests.length || !copy.expectedTests.every((file) => /^tests\/[A-Za-z0-9._/-]+\.test\.mjs$/.test(file) && !file.split("/").includes("..")))
    throw new Error("The contract must name focused test files before the copy can run.");
  // Dependencies must be pre-provisioned in this isolated copy. Nothing installs or downloads them.
  const script = `const fs=require('node:fs'),{spawnSync}=require('node:child_process');process.chdir('/work/source');
if(Number(process.versions.node.split('.')[0])<24||!fs.existsSync('node_modules/typescript')){console.error('Held: this copy needs Node 24 and its own prepared dependencies. Nothing was installed.');process.exit(75);}
const env={PATH:process.env.PATH,HOME:'/tmp',TMPDIR:'/tmp',BRANCH_DATA_DIR:'/work/data',BRANCH_WORKSPACE:'/work/workspace',BRANCH_PORT:'0'};
const tests=spawnSync(process.execPath,${JSON.stringify(["scripts/review.mjs", "--jobs", "1", ...copy.expectedTests])},{env,stdio:'inherit'});if(tests.status!==0)process.exit(tests.status||1);
${mode !== "tests" ? `const preview=spawnSync(process.execPath,['-e',${JSON.stringify(mode === "dogfood" ? dogfoodProbe(copy, target) : startupProbe)}],{env,stdio:'inherit'});process.exit(preview.status===0?0:preview.status===75?75:1);` : ""}`;
  return { executable: "node", args: ["-e", script] };
}

/** Jobs are local-owner-only through SelfDevelopmentMerges; the app never falls back to a host runner. */
export class TestCopyJobs {
  private readonly jobs = new Map<string, { job: Job; controller: AbortController }>();
  constructor(private readonly deps: SelfDevelopmentDeps) {}
  verifiedReceipt(id: string): Promise<TestCopyReceipt> { return this.copy(IdInput.parse({ id }).id); }
  private async copy(id: string): Promise<TestCopyReceipt> {
    // From the source folder's real path, as the copy was made: a workspace reached through a link is not a replaced copy.
    const home = join(await realpath(resolve(this.deps.workspace, sourceFolder)), ".branch-test-copies", id);
    if (await realpath(home) !== home) throw new Error("The saved test copy was replaced by a link.");
    const copy = JSON.parse(await readFile(join(home, "receipt.json"), "utf8")) as TestCopyReceipt;
    const contract = this.deps.contracts.current(this.deps.owner, copy.sourceWorktree);
    if (!contract || contractHash(contract) !== copy.contractHash || JSON.stringify(contract.expectedTests) !== JSON.stringify(copy.expectedTests))
      throw new Error("The test copy no longer matches its source contract.");
    if (copy.id !== id || copy.folder !== join(home, "source") || copy.dataDirectory !== join(home, "data") || copy.workspace !== join(home, "workspace"))
      throw new Error("The saved test copy's isolated paths changed.");
    for (const path of [copy.folder, copy.dataDirectory, copy.workspace]) if (await realpath(path) !== path) throw new Error("A test-copy path was replaced by a link.");
    if (await sourceGit(this.deps, copy.folder, ["rev-parse", "HEAD"], AbortSignal.timeout(30_000)) !== copy.sha
      || await sourceGit(this.deps, copy.folder, ["status", "--porcelain=v1", "--untracked-files=all"], AbortSignal.timeout(30_000)))
      throw new Error("The saved test copy changed; prepare a fresh exact-commit copy.");
    return copy;
  }
  async start(input: unknown): Promise<Job> {
    const { id, mode, target } = JobInput.parse(input), copy = await this.copy(id);
    if ([...this.jobs.values()].some(({ job }) => job.status === "running")) throw new Error("A test-copy job is already running. Cancel it or wait for it to finish.");
    if (this.jobs.size >= 50) this.jobs.delete(this.jobs.keys().next().value!);
    const runCommand = command(copy, mode, target), controller = new AbortController();
    const job: Job = { id: randomUUID(), copyId: id, sha: copy.sha, mode, target, status: "running", startedAt: new Date().toISOString() };
    this.jobs.set(job.id, { job, controller });
    void this.run(job, copy, runCommand, controller).catch((error: unknown) => { job.status = "failed"; job.problem = String(error); });
    return { ...job };
  }
  status(input: unknown): Job {
    const { id } = IdInput.parse(input), found = this.jobs.get(id);
    if (!found) throw new Error("That test-copy job is no longer in this engine. Read its saved job receipt; it is not a passed run.");
    return { ...found.job };
  }
  cancel(input: unknown): Job {
    const { id } = IdInput.parse(input), found = this.jobs.get(id);
    if (!found) throw new Error("No such test-copy job.");
    found.controller.abort();
    return { ...found.job };
  }
  private async run(job: Job, copy: TestCopyReceipt, runCommand: ReturnType<typeof command>, controller: AbortController): Promise<void> {
    const spawn = defaultSandboxSpawn(), probe = defaultSandboxProbe(), name = `branch-test-copy-${job.id}`;
    let engine: string | null = null;
    const backend = new ContainerBackend(sandboxBackendSettings(this.deps.store, this.deps.owner), defaultSandboxProbe(), async (options, limits, signal) =>
      { engine = options.executable; return spawn({ ...options, args: [options.args[0]!, "--name", name, "--pull=never", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=256", "--tmpfs=/tmp:rw,nosuid,size=128m", ...options.args.slice(1)] }, limits, signal); });
    const stop = () => { if (engine) void probe(engine, ["rm", "--force", name]); };
    controller.signal.addEventListener("abort", stop, { once: true });
    try {
      const handle = await backend.prepare({ hostPath: resolve(copy.folder, "..") });
      try {
        job.result = await handle.run(runCommand, { timeoutMs: 900_000, maxMemoryMb: 2048, maxCpuSeconds: 900, maxOutputBytes: 65_536, network: false, job: true }, controller.signal);
        job.status = controller.signal.aborted ? "cancelled" : [75, 125].includes(job.result.exitCode ?? -1) ? "held" : job.result.status === "completed" && job.result.exitCode === 0 && !job.result.truncated ? "passed" : "failed";
      } finally { if (engine) await probe(engine, ["rm", "--force", name]); await handle.dispose(); }
    } catch (error) { job.status = controller.signal.aborted ? "cancelled" : "held"; job.problem = error instanceof Error ? error.message : String(error); }
    controller.signal.removeEventListener("abort", stop);
    job.finishedAt = new Date().toISOString();
    await writeFile(join(resolve(copy.folder, ".."), `job-${job.id}.json`), JSON.stringify(job, null, 2), { flag: "wx", mode: 0o600 });
  }
}
