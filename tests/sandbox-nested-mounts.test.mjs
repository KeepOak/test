import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { bwrapArgs, seccompFilter, withSeccomp } from "../dist/sandbox-bwrap.js";
import { wallReport } from "../dist/sandbox-backends.js";

const command = { executable: "/bin/true", args: [] };
const mounted = (args, flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
const ancestor = (parent, child) => child.startsWith(`${parent}/`);

for (const [name, input] of Object.entries({
  "home under /tmp": { home: "/tmp/run/home", temp: "/tmp/run/tmp", covered: ["/run", "/tmp/run/home"] },
  "temporary folder under home": { home: "/home/o", temp: "/home/o/tmp", covered: ["/run", "/home/o"] },
  "nested covers supplied child first": { home: "/home/o", temp: "/run/user/1000/tmp", covered: ["/run/user/1000", "/run", "/home/o"] },
  "alternating temporary and covered ancestors": { home: "/tmp/run/home", temp: "/tmp/run/home/covered/tmp", covered: ["/tmp/run/home/covered", "/tmp/run/home"] },
  "duplicate covered and temporary folders": { home: "/tmp/run/home", temp: "/tmp/run/home", covered: ["/tmp/run/home", "/tmp", "/tmp/run/home"] },
})) test(`nested Linux mount arguments: ${name}`, () => {
  const workspace = join(input.home, "work");
  const args = bwrapArgs({ ...input, workspace, network: "none", kindOf: () => null }, command);
  const folders = mounted(args, "--tmpfs");
  assert.deepEqual(new Set(folders), new Set(["/tmp", input.temp, ...input.covered]));
  assert.equal(folders.length, new Set(folders).size, "a duplicate must not cover an earlier mount");
  for (const parent of folders) for (const child of folders) if (ancestor(parent, child))
    assert.ok(folders.indexOf(parent) < folders.indexOf(child), `${parent} must be mounted before ${child}`);
  assert.deepEqual(mounted(args, "--remount-ro"), [...new Set(input.covered)], "every cover remains read-only");
  assert.ok(args.lastIndexOf("--tmpfs") < args.indexOf("--bind"), "the workspace is restored after every empty mount");
  assert.ok(args.indexOf("--remount-ro") > args.lastIndexOf("--ro-bind-try"), "protect covers after restoring allowed paths");
  assert.ok(args.includes("--unshare-net"), "network isolation is retained");
});

const linuxReady = process.platform === "linux" && (await wallReport()).available;
const bwrap = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"].find(existsSync);
const layouts = {
  "home and scratch under /tmp": (root) => ({ home: join(root, "home"), temp: join(root, "scratch"), workspace: join(root, "work") }),
  "scratch and workspace under covered home": (root) => ({ home: join(root, "home"), temp: join(root, "home", "scratch"), workspace: join(root, "home", "work") }),
  "child-first covers with scratch and workspace inside": (root) => ({ home: join(root, "home"), temp: join(root, "home", "nested", "scratch"), workspace: join(root, "home", "nested", "work"), nested: join(root, "home", "nested") }),
};

/** Only disposable fixtures are read or written. The program still gets the real network and syscall wall. */
async function fixture(root, layout) {
  const paths = { ...layout(root), outside: join(root, "outside.txt") };
  paths.tools = join(paths.home, "tools");
  for (const path of [paths.home, paths.temp, paths.workspace, paths.tools, join(paths.workspace, ".git")]) await mkdir(path, { recursive: true });
  for (const [path, contents] of [[paths.outside, "outside"], [join(paths.home, "private.txt"), "private"],
    [join(paths.temp, "other-run.txt"), "other-run"], [join(paths.tools, "program.txt"), "program"], [join(paths.workspace, ".git", "config"), "protected"]]) await writeFile(path, contents);
  if (paths.nested) await writeFile(join(paths.nested, "private.txt"), "nested-private");
  return paths;
}

function inspect(paths) {
  const script = `const fs = require('node:fs'); const p = ${JSON.stringify(paths)};
    const write = path => { try { fs.writeFileSync(path, 'written'); return 'written'; } catch (error) { return error.code; } };
    console.log(JSON.stringify({
      workspace: write(p.workspace + '/inside.txt'), protected: write(p.workspace + '/.git/config'),
      home: write(p.home + '/blocked.txt'), temp: write(p.temp + '/scratch.txt'), tools: write(p.tools + '/program.txt'),
      program: fs.readFileSync(p.tools + '/program.txt', 'utf8'), homePrivate: fs.existsSync(p.home + '/private.txt'),
      otherTemp: fs.existsSync(p.temp + '/other-run.txt'), outside: fs.existsSync(p.outside),
      nested: p.nested ? write(p.nested + '/blocked.txt') : null,
      nestedPrivate: p.nested ? fs.existsSync(p.nested + '/private.txt') : false
    }));`;
  return { executable: process.execPath, args: ["-e", script] };
}

for (const [name, layout] of Object.entries(layouts)) test(`real Linux nested mounts: ${name}`,
  { skip: !linuxReady && "needs Linux bubblewrap with user namespaces" }, async (t) => {
    const root = await mkdtemp("/tmp/branch-nested-wall-");
    t.after(() => rm(root, { recursive: true, force: true }));
    const paths = await fixture(root, layout);
    const covered = [...(paths.nested ? [paths.nested] : []), paths.home];
    const filter = join(root, "filter.bpf");
    await writeFile(filter, seccompFilter({ network: "none" }));
    const args = bwrapArgs({ ...paths, network: "none", covered, readOnly: [paths.tools], seccompFd: 9,
      kindOf: () => null }, inspect(paths));
    const start = withSeccomp(bwrap, filter, args);
    const result = JSON.parse(execFileSync(start.executable, start.args, { encoding: "utf8", timeout: 20_000,
      env: { PATH: "/usr/bin:/bin", HOME: paths.home, TMPDIR: paths.temp }, cwd: paths.workspace }));
    assert.deepEqual(result, { workspace: "written", protected: "EROFS", home: "EROFS", temp: "written", tools: "EROFS",
      program: "program", homePrivate: false, otherTemp: false, outside: false, nested: paths.nested ? "EROFS" : null, nestedPrivate: false });
    assert.equal(await readFile(join(paths.workspace, "inside.txt"), "utf8"), "written");
    for (const [path, original] of [[paths.outside, "outside"], [join(paths.home, "private.txt"), "private"],
      [join(paths.temp, "other-run.txt"), "other-run"], [join(paths.tools, "program.txt"), "program"], [join(paths.workspace, ".git", "config"), "protected"]])
      assert.equal(await readFile(path, "utf8"), original, `${path} stays unchanged on the host`);
    assert.equal(existsSync(join(paths.temp, "scratch.txt")), false, "temporary writes stay inside the wall");
    assert.equal(existsSync(join(paths.home, "blocked.txt")), false);
  });
