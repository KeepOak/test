/**
 * A Trunk's commands stay in its own folder (src/trunks/shell-fence.ts). A command runs where the Trunk's turn works,
 * `.branch-agents/<id>`. A command whose words reach another Trunk's folder, `.branch-agents` itself or a folder above
 * it is refused before it starts, on every computer. On macOS and Linux with the wall on, the system also hides the
 * other Trunks' folders. What this does not catch (a path a program builds for itself) is said in the refusal itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { BranchShell, registerShell } from "../dist/integrations/shell.js";
import { fencedFolders, fenceRefusal, trunkFence } from "../dist/trunks/shell-fence.js";
import { saveWallSettings } from "../dist/sandbox.js";

const ada = "0a0a0a0a-1111-4111-8111-aaaaaaaaaaaa", bob = "0b0b0b0b-2222-4222-8222-bbbbbbbbbbbb";

async function fixture(t) {
  // The name the system gives the folder (macOS's /var is /private/var), which is where a command says it runs.
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-trunk-fence-")));
  const workspace = join(root, "workspace"), home = join(workspace, ".branch-agents");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  await mkdir(join(home, ada), { recursive: true });
  await mkdir(join(home, bob), { recursive: true });
  await writeFile(join(home, ada, "notes.txt"), "ada's own notes");
  await writeFile(join(home, bob, "secret.txt"), "bob's secret");
  const shell = new BranchShell({ executables: { node: { path: process.execPath } } });
  await shell.ready(); registerShell(app.registry, shell);
  // A process let go a moment ago can still hold its working folder for a few milliseconds on Windows.
  t.after(async () => { await shell.close(); await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const base = app.runtime.context({ runId: "fence-run" });
  const as = (id) => ({ ...base, agent: `trunk:${id}`, workspace: join(home, id) });
  const run = (context, args) => app.registry.execute("shell.execute", { executable: "node", args }, context);
  return { app, workspace, home, base, as, run };
}
const read = (path) => ["-e", `process.stdout.write(require('fs').readFileSync('${path}','utf8'))`];

test("a Trunk's command runs in its own folder and reads its own files", async (t) => {
  const f = await fixture(t);
  const result = await f.run(f.as(ada), ["-e", "process.stdout.write(process.cwd() + '|' + require('fs').readFileSync('notes.txt','utf8'))"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const [cwd, text] = result.stdout.split("|");
  assert.equal(cwd.toLowerCase(), join(f.home, ada).toLowerCase(), "its own folder is where it starts");
  assert.equal(text, "ada's own notes");
});

test("a Trunk whose folder does not exist yet still runs a command, in that folder", async (t) => {
  const f = await fixture(t);
  const fresh = "0c0c0c0c-3333-4333-8333-cccccccccccc";
  assert.equal(existsSync(join(f.home, fresh)), false);
  const result = await f.run(f.as(fresh), ["-e", "process.stdout.write(process.cwd())"]);
  assert.equal(result.stdout.toLowerCase(), join(f.home, fresh).toLowerCase());
});

test("a Trunk's command that reaches another Trunk's folder is refused, however the path is written", async (t) => {
  const f = await fixture(t);
  const attempts = [
    read(`../${bob}/secret.txt`), // inside a script string
    ["../" + bob + "/secret.txt"], // relative
    [join(f.home, bob, "secret.txt")], // absolute
    [".."], // .branch-agents itself, which lists every Trunk
    ["../.."], // the workspace above it
    ["--dir=.."], // joined to a flag
    read(`${bob.toUpperCase()}/x`), // another Trunk's id, in any case
  ];
  for (const args of attempts) {
    await assert.rejects(f.run(f.as(ada), args), (error) => {
      assert.match(error.message, /A Trunk's commands stay in its own folder/);
      assert.match(error.message, /not a sandbox/, "and says plainly what the check is");
      return true;
    }, JSON.stringify(args));
  }
});

test("a helper a Trunk starts works in the Trunk's folder and is fenced too, whatever name it carries", async (t) => {
  const f = await fixture(t);
  const helper = { ...f.as(ada), agent: "researcher", depth: 1 }; // a delegated specialist keeps the folder, not the mark
  const here = await f.run(helper, ["-e", "process.stdout.write(process.cwd())"]);
  assert.equal(here.stdout.toLowerCase(), join(f.home, ada).toLowerCase());
  await assert.rejects(f.run(helper, read(`../${bob}/secret.txt`)), /A Trunk's commands stay in its own folder/);
  await assert.rejects(f.run({ ...helper, agent: undefined }, [".."]), /A Trunk's commands stay in its own folder/);
});

test("ordinary script text with slashes runs", async (t) => {
  const f = await fixture(t);
  for (const script of ["console.log(4 / 2)", "// a comment\nconsole.log(2)", "console.log('a' + '/' + 'b')"]) {
    const result = await f.run(f.as(ada), ["-e", script]);
    assert.equal(result.exitCode, 0, `${script}: ${result.stderr}`);
  }
});

test("the owner's own turn, and a Trunk's own subfolder, are not fenced", async (t) => {
  const f = await fixture(t);
  const owner = await f.run(f.base, read(`.branch-agents/${bob}/secret.txt`));
  assert.equal(owner.stdout, "bob's secret", "the owner's command reads any Trunk's folder, as before");
  await mkdir(join(f.home, ada, "sub"), { recursive: true });
  const own = await f.run(f.as(ada), read("./sub/../notes.txt"));
  assert.equal(own.stdout, "ada's own notes");
});

test("the fence names the other Trunks' folders, for the wall too, and only for a Trunk's own folder", async (t) => {
  const f = await fixture(t);
  const fence = trunkFence(f.as(ada));
  assert.deepEqual(fence.siblings.map((path) => path.toLowerCase()), [join(f.home, bob).toLowerCase()]);
  assert.ok(fencedFolders(f.as(ada)).some((path) => path.toLowerCase() === join(f.home, bob).toLowerCase()));
  assert.equal(trunkFence(f.base), null, "the owner's turn");
  assert.equal(trunkFence({ ...f.as(ada), workspace: f.workspace }), null, "a Trunk working elsewhere (a coding fork) is not fenced");
  assert.equal(fenceRefusal(fence, join(f.home, ada), ["hello", "-v", "1/2", "4 // 2", "/"]), null, "ordinary words pass");
});

test("behind the wall a Trunk's program cannot read the other Trunks' folders",
  { skip: process.platform === "win32" && "the wall is macOS and Linux only; on Windows the word check is the only layer" }, async (t) => {
    const f = await fixture(t);
    saveWallSettings(f.app.store, f.app.runtime.owner, { mode: "on", network: "none" });
    const context = f.as(ada);
    const { osSandbox } = f.app.runtime.wallFor("shell.execute", { executable: "node", args: [] }, context, null);
    assert.ok(osSandbox, "the wall is on");
    assert.ok(osSandbox.unreadable.includes(join(f.home, bob)), "the other Trunk's folder is hidden");
    assert.ok(!osSandbox.unreadable.includes(join(f.home, ada)), "its own is not");
  });

test("a call that names no workspace is in no Trunk's folder, so nothing is fenced and nothing throws", () => {
  // The wall is asked about with a context that has no workspace yet (os-sandbox W2/W3 on macOS and Linux).
  assert.equal(trunkFence({}), null);
  assert.deepEqual(fencedFolders({}), []);
});
