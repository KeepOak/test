import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountHome, bwrapArgs, seccompFilter, withSeccomp } from "../dist/sandbox-bwrap.js";
import { wallReport } from "../dist/sandbox-backends.js";
import { heldCover } from "../dist/integrations/wsl-held.js";

const command = { executable: "/bin/true", args: [] };
const mounted = (args, flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
const ancestor = (parent, child) => child.startsWith(`${parent}/`);

for (const [name, input] of Object.entries({
  "home under /tmp": { home: "/tmp/run/home", temp: "/tmp/run/tmp", covered: ["/run", "/tmp/run/home"] },
  "temporary folder under home": { home: "/home/o", temp: "/home/o/tmp", covered: ["/run", "/home/o"] },
  "nested covers supplied child first": { home: "/home/o", temp: "/run/user/1000/tmp", covered: ["/run/user/1000", "/run", "/home/o"] },
  "alternating temporary and covered ancestors": { home: "/tmp/run/home", temp: "/tmp/run/home/covered/tmp", covered: ["/tmp/run/home/covered", "/tmp/run/home"] },
  "duplicate covered and temporary folders": { home: "/tmp/run/home", temp: "/tmp/run/home", covered: ["/tmp/run/home", "/tmp", "/tmp/run/home"] },
  "alternate HOME and separate account home": { home: "/tmp/run/home", systemHome: "/home/account", temp: "/tmp/run/tmp", covered: ["/run", "/tmp/run/home"] },
})) test(`nested Linux mount arguments: ${name}`, () => {
  const workspace = join(input.home, "work");
  const args = bwrapArgs({ ...input, workspace, network: "none", held: true, kindOf: () => null }, command);
  const folders = mounted(args, "--tmpfs");
  const covered = [...new Set([...input.covered, ...(input.systemHome ? [input.systemHome] : [])])];
  assert.deepEqual(new Set(folders), new Set(["/tmp", input.temp, ...covered]));
  assert.equal(folders.length, new Set(folders).size, "a duplicate must not cover an earlier mount");
  for (const parent of folders) for (const child of folders) if (ancestor(parent, child))
    assert.ok(folders.indexOf(parent) < folders.indexOf(child), `${parent} must be mounted before ${child}`);
  assert.deepEqual(mounted(args, "--remount-ro"), covered, "every cover remains read-only");
  assert.ok(args.lastIndexOf("--tmpfs") < args.indexOf("--bind"), "the workspace is restored after every empty mount");
  assert.ok(args.indexOf("--remount-ro") > args.lastIndexOf("--ro-bind-try"), "protect covers after restoring allowed paths");
  assert.ok(args.includes("--unshare-net"), "network isolation is retained");
});

test("an ordinary Linux wall hides secrets under both configured and account homes", () => {
  const kinds = { "/tmp/fake-home/.ssh": "dir", "/home/account/.netrc": "file" };
  const args = bwrapArgs({ home: "/tmp/fake-home", systemHome: "/home/account", workspace: "/work", network: "none",
    kindOf: (path) => kinds[path] ?? null }, command).join(" ");
  assert.ok(args.includes("--tmpfs /tmp/fake-home/.ssh --remount-ro /tmp/fake-home/.ssh"));
  assert.ok(args.includes("--ro-bind /dev/null /home/account/.netrc"));
  assert.ok(!args.includes("--tmpfs /home/account "), "an ordinary wall does not hide the whole account home");
  const held = bwrapArgs({ home: "/tmp/fake-home", systemHome: "/home/account", workspace: "/work", network: "none",
    held: true, covered: ["/tmp/fake-home"], kindOf: (path) => kinds[path] ?? null }, command).join(" ");
  assert.ok(!held.includes("/.ssh") && !held.includes("/.netrc"), "both homes already hide secrets; no mask is recreated below read-only covers");
});

test("uncertain account homes and restored parents fail closed", () => {
  const base = { home: "/tmp/fake-home", systemHome: "/home/account", workspace: "/work", network: "none", held: true, covered: ["/tmp/fake-home"], kindOf: () => null };
  for (const systemHome of [null, "", "relative", "/", "/home/..", "/bad\0home"])
    assert.throws(() => bwrapArgs({ ...base, systemHome }, command), /could not determine.*home folder safely/);
  for (const restore of [{ workspace: "/home" }, { readOnly: ["/home/account"] }, { extraWrites: ["/home"] }, { doorDir: "/home" }])
    assert.throws(() => bwrapArgs({ ...base, ...restore }, command), /would expose a protected/);
  const aliased = { ...base, readOnly: ["/linked-home"], canonical: (path) => path === "/linked-home" ? "/home/account" : path };
  assert.throws(() => bwrapArgs(aliased, command), /would expose a protected/);
  assert.throws(() => accountHome(() => { throw new Error("account lookup failed"); }), /could not determine.*home folder safely/);
});

test("held mode covers a missing configured HOME and refuses restored secret descendants", () => {
  const base = { home: "/tmp/not-present", systemHome: "/home/account", workspace: "/work", network: "none", held: true,
    covered: ["/mnt", "/run"], kindOf: () => null };
  const args = bwrapArgs(base, command);
  for (const home of [base.home, base.systemHome]) {
    assert.ok(mounted(args, "--tmpfs").includes(home));
    assert.ok(mounted(args, "--remount-ro").includes(home));
  }
  for (const restore of [{ readOnly: ["/home/account/.ssh"] }, { extraWrites: ["/home/account/.aws/credentials"] },
    { workspace: "/home/account/.config" }, { unreadable: ["/home/account/private"], readOnly: ["/home/account/private/file"] }])
    assert.throws(() => bwrapArgs({ ...base, ...restore }, command), /would expose a protected/);
});

test("only the fresh door may be restored below a covered runtime-socket root", () => {
  const runtime = "/run/user/1000", temp = `${runtime}/held-scratch`, doorDir = `${temp}/branch-wall-fixture`;
  const base = { home: "/home/environment", systemHome: "/home/account", workspace: "/work", network: "per-site", held: true,
    uid: 1000, covered: ["/run"], temp, doorDir, kindOf: () => null };
  const args = bwrapArgs(base, command).join(" ");
  assert.ok(args.includes(`--bind ${doorDir} ${doorDir}`), "the generated private door is restored");
  assert.ok(args.includes("--unshare-net"), "the network remains isolated");
  for (const unsafe of [{ workspace: doorDir }, { readOnly: [doorDir] }, { extraWrites: [doorDir] }, { doorDir: runtime },
    { doorDir: "/run/user" }, { temp: "/tmp/unrelated" }, { unreadable: [runtime] }, { dataDir: temp }])
    assert.throws(() => bwrapArgs({ ...base, ...unsafe }, command), /would expose a protected/);
});

test("held tool restores follow a symlinked account home with alternate HOME", { skip: process.platform === "win32" && "heldCover uses POSIX paths" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-account-alias-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "missing-home"), actualHome = join(root, "actual-home"), systemHome = join(root, "account-alias");
  const prefix = join(actualHome, ".nvm", "versions", "node", "fixture");
  for (const path of [join(prefix, "bin"), join(prefix, "lib")]) await mkdir(path, { recursive: true });
  await writeFile(join(prefix, "bin", "node"), "fixture");
  await symlink(actualHome, systemHome, "junction");
  const aliasBin = join(systemHome, ".nvm", "versions", "node", "fixture", "bin");
  const view = await heldCover({ home, systemHome, programs: [join(aliasBin, "node")], searchPath: aliasBin, workspace: join(root, "work") });
  assert.equal(view.refusal, null);
  assert.ok(view.covered.includes(actualHome));
  assert.deepEqual(view.restored.sort(), [join(prefix, "bin"), join(prefix, "lib")].sort());
});

const linuxReady = process.platform === "linux" && (await wallReport()).available;
const bwrap = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"].find(existsSync);
const layouts = {
  "home and scratch under /tmp": (root) => ({ home: join(root, "home"), temp: join(root, "scratch"), workspace: join(root, "work") }),
  "scratch and workspace under covered home": (root) => ({ home: join(root, "home"), temp: join(root, "home", "scratch"), workspace: join(root, "home", "work") }),
  "child-first covers with scratch and workspace inside": (root) => ({ home: join(root, "home"), temp: join(root, "home", "nested", "scratch"), workspace: join(root, "home", "nested", "work"), nested: join(root, "home", "nested") }),
  "different configured and account homes": (root) => ({ home: join(root, "environment-home"), systemHome: join(root, "account-home"), temp: join(root, "scratch"), workspace: join(root, "work") }),
  "configured HOME inside account home": (root) => ({ home: join(root, "account-home", "environment-home"), systemHome: join(root, "account-home"), temp: join(root, "scratch"), workspace: join(root, "work") }),
  "missing configured HOME": (root) => ({ home: join(root, "not-created"), systemHome: join(root, "account-home"), temp: join(root, "scratch"), workspace: join(root, "work"), missingHome: true }),
};

/** Only disposable fixtures are read or written. The program still gets the real network and syscall wall. */
async function fixture(root, layout) {
  const paths = { ...layout(root), outside: join(root, "outside.txt") };
  paths.tools = join(paths.systemHome ?? paths.home, "tools");
  for (const path of [...(paths.missingHome ? [] : [paths.home]), paths.temp, paths.workspace, paths.tools, join(paths.workspace, ".git")]) await mkdir(path, { recursive: true });
  for (const [path, contents] of [[paths.outside, "outside"], ...(paths.missingHome ? [] : [[join(paths.home, "private.txt"), "private"]]),
    [join(paths.temp, "other-run.txt"), "other-run"], [join(paths.tools, "program.txt"), "program"], [join(paths.workspace, ".git", "config"), "protected"]]) await writeFile(path, contents);
  if (paths.nested) await writeFile(join(paths.nested, "private.txt"), "nested-private");
  if (paths.systemHome) await writeFile(join(paths.systemHome, "private.txt"), "account-private");
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
      nestedPrivate: p.nested ? fs.existsSync(p.nested + '/private.txt') : false,
      account: p.systemHome ? write(p.systemHome + '/blocked.txt') : null,
      accountPrivate: p.systemHome ? fs.existsSync(p.systemHome + '/private.txt') : false
    }));`;
  return { executable: process.execPath, args: ["-e", script] };
}

for (const [name, layout] of Object.entries(layouts)) test(`real Linux nested mounts: ${name}`,
  { skip: !linuxReady && "needs Linux bubblewrap with user namespaces" }, async (t) => {
    const root = await mkdtemp("/tmp/branch-nested-wall-");
    t.after(() => rm(root, { recursive: true, force: true }));
    const paths = await fixture(root, layout);
    const covered = [...(paths.nested ? [paths.nested] : []), ...(paths.missingHome ? [] : [paths.home])];
    const filter = join(root, "filter.bpf");
    await writeFile(filter, seccompFilter({ network: "none" }));
    const args = bwrapArgs({ ...paths, network: "none", held: true, covered, readOnly: [paths.tools], seccompFd: 9,
      kindOf: () => null }, inspect(paths));
    const start = withSeccomp(bwrap, filter, args);
    const result = JSON.parse(execFileSync(start.executable, start.args, { encoding: "utf8", timeout: 20_000,
      env: { PATH: "/usr/bin:/bin", HOME: paths.home, TMPDIR: paths.temp }, cwd: paths.workspace }));
    assert.deepEqual(result, { workspace: "written", protected: "EROFS", home: "EROFS", temp: "written", tools: "EROFS",
      program: "program", homePrivate: false, otherTemp: false, outside: false, nested: paths.nested ? "EROFS" : null, nestedPrivate: false,
      account: paths.systemHome ? "EROFS" : null, accountPrivate: false });
    assert.equal(await readFile(join(paths.workspace, "inside.txt"), "utf8"), "written");
    for (const [path, original] of [[paths.outside, "outside"], ...(paths.missingHome ? [] : [[join(paths.home, "private.txt"), "private"]]),
      [join(paths.temp, "other-run.txt"), "other-run"], [join(paths.tools, "program.txt"), "program"], [join(paths.workspace, ".git", "config"), "protected"]])
      assert.equal(await readFile(path, "utf8"), original, `${path} stays unchanged on the host`);
    assert.equal(existsSync(join(paths.temp, "scratch.txt")), false, "temporary writes stay inside the wall");
    assert.equal(existsSync(join(paths.home, "blocked.txt")), false);
    if (paths.missingHome) assert.equal(existsSync(paths.home), false, "the missing configured HOME was created only inside the wall");
    if (paths.systemHome) {
      assert.equal(await readFile(join(paths.systemHome, "private.txt"), "utf8"), "account-private");
      assert.equal(existsSync(join(paths.systemHome, "blocked.txt")), false);
    }
  });

test("real Linux held tools are narrowly restored from the account home with alternate HOME",
  { skip: !linuxReady && "needs Linux bubblewrap with user namespaces" }, async (t) => {
    const root = await mkdtemp("/tmp/branch-account-tools-");
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "environment-home"), systemHome = join(root, "account-home"), workspace = join(root, "work"), temp = join(root, "scratch");
    const prefix = join(systemHome, ".nvm", "versions", "node", "fixture"), program = join(prefix, "bin", "node");
    for (const path of [home, workspace, temp, join(prefix, "bin"), join(prefix, "lib"), join(prefix, "share"), join(systemHome, ".ssh")])
      await mkdir(path, { recursive: true });
    await copyFile("/bin/sh", program);
    const originalProgram = await readFile(program);
    await writeFile(join(prefix, "lib", "module.txt"), "module\n");
    await writeFile(join(prefix, "share", "private.txt"), "private-share");
    await writeFile(join(systemHome, ".ssh", "fake-key"), "fake-fixture-key");
    const view = await heldCover({ home, systemHome, programs: [program], searchPath: join(prefix, "bin"), workspace });
    assert.equal(view.refusal, null);
    assert.deepEqual(view.restored.sort(), [join(prefix, "bin"), join(prefix, "lib")].sort());
    const filter = join(root, "filter.bpf");
    await writeFile(filter, seccompFilter({ network: "none" }));
    const script = 'set -e; /bin/cat "$1/lib/module.txt"; test ! -e "$1/share/private.txt"; test ! -e "$2/.ssh/fake-key"; '
      + 'if echo PWNED > "$1/bin/node"; then exit 99; fi; echo written > inside.txt; echo tool-ok';
    const args = bwrapArgs({ home, systemHome, workspace, temp, held: true, network: "none", covered: view.covered,
      readOnly: view.restored, kindOf: () => null, seccompFd: 9 }, { executable: program, args: ["-c", script, "held-tool", prefix, systemHome] });
    const start = withSeccomp(bwrap, filter, args);
    const stdout = execFileSync(start.executable, start.args, { encoding: "utf8", timeout: 20_000,
      env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: temp }, cwd: workspace });
    assert.equal(stdout, "module\ntool-ok\n");
    assert.deepEqual(await readFile(program), originalProgram, "the real tool copy remains unchanged");
    assert.equal(await readFile(join(workspace, "inside.txt"), "utf8"), "written\n");
    assert.equal(await readFile(join(systemHome, ".ssh", "fake-key"), "utf8"), "fake-fixture-key");
  });

test("real ordinary Linux wall keeps both homes readable but masks their fake secrets",
  { skip: !linuxReady && "needs Linux bubblewrap with user namespaces" }, async (t) => {
    const root = await mkdtemp("/tmp/branch-ordinary-homes-");
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "environment-home"), systemHome = join(root, "account-home"), workspace = join(root, "work"), temp = join(root, "scratch");
    for (const path of [workspace, temp, join(home, ".ssh"), join(systemHome, ".ssh")]) await mkdir(path, { recursive: true });
    for (const folder of [home, systemHome]) {
      await writeFile(join(folder, "visible.txt"), "visible");
      await writeFile(join(folder, ".ssh", "fake-key"), "fake-fixture-key");
    }
    const filter = join(root, "filter.bpf");
    await writeFile(filter, seccompFilter({ network: "none" }));
    const script = `const fs=require('node:fs'); console.log(JSON.stringify(${JSON.stringify([home, systemHome])}.map(h=>({
      visible:fs.readFileSync(h+'/visible.txt','utf8'), secret:fs.existsSync(h+'/.ssh/fake-key'), keys:fs.readdirSync(h+'/.ssh'),
      write:(()=>{try{fs.writeFileSync(h+'/.ssh/new-key','bad');return 'written'}catch(e){return e.code}})()
    }))));`;
    // Restore the fake homes from /tmp only for this fixture, matching the ordinary read-only root view.
    const args = bwrapArgs({ home, systemHome, workspace, temp, network: "none", readOnly: [home, systemHome], seccompFd: 9,
      kindOf: (path) => [join(home, ".ssh"), join(systemHome, ".ssh")].includes(path) ? "dir" : null },
    { executable: process.execPath, args: ["-e", script] });
    const start = withSeccomp(bwrap, filter, args);
    const result = JSON.parse(execFileSync(start.executable, start.args, { encoding: "utf8", timeout: 20_000,
      env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: temp }, cwd: workspace }));
    assert.deepEqual(result, [home, systemHome].map(() => ({ visible: "visible", secret: false, keys: [], write: "EROFS" })));
    for (const folder of [home, systemHome]) {
      assert.equal(await readFile(join(folder, ".ssh", "fake-key"), "utf8"), "fake-fixture-key");
      assert.equal(existsSync(join(folder, ".ssh", "new-key")), false);
    }
  });
