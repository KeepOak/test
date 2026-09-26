/**
 * Wave mac5: one-click local models. Every program, disk, memory reader and network call here is a
 * stand-in: nothing is installed, started, downloaded or opened, and no window appears. Pure logic
 * takes `platform`, so Windows, macOS and Linux are all checked on every machine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Store } from "../dist/store.js";
import { ModelRouter } from "../dist/models.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { OllamaClient, sizedModelName } from "../dist/local-models.js";
import { readGraphicsCard, useGraphicsReader } from "../dist/local-hardware.js";
import {
  chooseContext, judgeFit, parseMemAvailable, parseVmStat, readAppleGraphicsLimit, readFreeMemory, useMemoryReaders,
} from "../dist/local-fit.js";
import { findVariant, localCatalogue, lookUpOllama, offers, searchHuggingFace } from "../dist/local-catalogue.js";
import { RuntimeLauncher, candidatePaths, findRuntime, startPlan } from "../dist/local-launch.js";
import { assertRoomOnDisk, downloadFile, freeDiskBytes, modelsFolder, resolveUrl } from "../dist/local-files.js";
import { assertLocalRuntimeAllowed, libraryFetch, localRuntimeFetch } from "../dist/local-policy.js";
import {
  forgetLocalConnection, localConnectionId, registerLocalConnection, restoreLocalConnections, savedLocalConnections,
} from "../dist/local-connections.js";
import { localModelsMode, saveLocalModelsMode } from "../dist/local-jobs.js";
import { OneClick } from "../dist/local-oneclick.js";
import { saveOneButtonMode } from "../dist/local-one-button.js";
import { LocalManager } from "../dist/local-manage.js";
import { startLocalModels } from "../dist/local-kit.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const GB = 1024 ** 3;
const home = { mac: "/Users/sam", linux: "/home/sam", win: "C:\\Users\\sam" };
const at = {
  darwin: { platform: "darwin", arch: "arm64", home: home.mac, env: { PATH: "/usr/bin:/opt/homebrew/bin" } },
  intelMac: { platform: "darwin", arch: "x64", home: home.mac, env: { PATH: "/usr/bin" } },
  linux: { platform: "linux", arch: "x64", home: home.linux, env: { PATH: "/usr/bin:/usr/local/bin" } },
  win32: { platform: "win32", arch: "x64", home: home.win, env: { Path: "C:\\Windows;C:\\Tools", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" } },
};

async function scratch(label) {
  const base = join(tmpdir(), "branch-session-files");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `branch-${label}-`));
}
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const room = (over = {}) => ({ totalMemoryBytes: 16 * GB, freeMemoryBytes: 10 * GB, graphicsLimitBytes: null, cores: 8,
  graphics: { name: "Apple M4", memoryBytes: null, sharedMemory: true }, summary: "", ...over });

// ------------------------------------------------------------------ memory, graphics limit, fit

const vmStatSample = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    11097.
Pages active:                                 285490.
Pages inactive:                               280940.
Pages speculative:                              3363.
Pages throttled:                                   0.
Pages wired down:                             227452.
Pages purgeable:                                2112.
File-backed pages:                            213802.
Anonymous pages:                              355991.
Pages occupied by compressor:                 205727.
`;

test("M1 free memory is read the way each system reports it", async () => {
  const used = (285490 + 280940 + 3363 + 227452 + 205727 - 2112 - 213802) * 16384;
  assert.equal(parseVmStat(vmStatSample, 16 * GB), 16 * GB - used);
  assert.equal(parseVmStat("nonsense", 16 * GB), null);
  assert.equal(parseMemAvailable("MemTotal: 4000000 kB\nMemAvailable:    2048000 kB\n"), 2048000 * 1024);
  const asked = [];
  const mac = await readFreeMemory({ platform: "darwin", total: () => 16 * GB, free: () => GB,
    run: async (file, args) => { asked.push([file, ...args]); return { stdout: vmStatSample }; } });
  assert.equal(mac, 16 * GB - used);
  assert.deepEqual(asked, [["/usr/bin/vm_stat"]]);
  const linux = await readFreeMemory({ platform: "linux", total: () => 4 * GB, free: () => GB,
    readText: async (path) => { assert.equal(path, "/proc/meminfo"); return "MemAvailable: 3145728 kB\n"; } });
  assert.equal(linux, 3 * GB);
  const windows = await readFreeMemory({ platform: "win32", total: () => 32 * GB, free: () => 20 * GB,
    run: async () => { throw new Error("nothing should run on Windows"); } });
  assert.equal(windows, 20 * GB);
  const broken = await readFreeMemory({ platform: "darwin", total: () => 8 * GB, free: () => 2 * GB, run: async () => { throw new Error("no"); } });
  assert.equal(broken, 2 * GB, "a failed reading falls back to what Node says");
});

test("M1 the Apple graphics ceiling is read only on a Mac, and only when it was set", async () => {
  const asked = [];
  const run = (answer) => async (file, args) => { asked.push([file, ...args]); return { stdout: answer }; };
  assert.equal(await readAppleGraphicsLimit({ platform: "darwin", run: run("0\n") }), null, "0 means the system default");
  assert.equal(await readAppleGraphicsLimit({ platform: "darwin", run: run("12288\n") }), 12288 * 1024 ** 2);
  assert.deepEqual(asked[0], ["/usr/sbin/sysctl", "-n", "iogpu.wired_limit_mb"]);
  assert.equal(await readAppleGraphicsLimit({ platform: "linux", run: async () => { throw new Error("asked"); } }), null);
  assert.equal(await readAppleGraphicsLimit({ platform: "win32", run: async () => { throw new Error("asked"); } }), null);
});

test("M1 fit is judged on free memory and the room for words, in three plain answers", () => {
  const arch = { layers: 36, kvHeads: 8, headDim: 128 };
  const mac = room();
  assert.equal(judgeFit(mac, 5 * GB, arch, 8192).fit, "well");
  assert.match(judgeFit(mac, 5 * GB, arch, 8192).note, /graphics/);
  // The same model with a huge room for words no longer fits well.
  assert.notEqual(judgeFit(mac, 5 * GB, arch, 131072).fit, "well");
  // Installed memory is plenty but little is free: tight, with the advice to close apps.
  const busy = judgeFit(room({ freeMemoryBytes: 3 * GB }), 5 * GB, arch, 8192);
  assert.equal(busy.fit, "tight");
  assert.match(busy.note, /Closing other apps/);
  assert.equal(judgeFit(room({ totalMemoryBytes: 8 * GB, freeMemoryBytes: 6 * GB }), 18 * GB, arch, 8192).fit, "no");
  // A card with its own memory: fits on the card, or spills into free memory.
  const pc = room({ graphics: { name: "RTX 3060", memoryBytes: 12 * GB }, totalMemoryBytes: 32 * GB, freeMemoryBytes: 20 * GB });
  assert.equal(judgeFit(pc, 5 * GB, arch, 8192).fit, "well");
  const split = judgeFit(pc, 15 * GB, arch, 8192);
  assert.equal(split.fit, "tight");
  assert.equal(split.where, "split");
  // No card: runs on the processor, and says so.
  assert.match(judgeFit(room({ graphics: null }), 2 * GB, arch, 4096).note, /processor/);
  // A graphics ceiling the owner set is respected on a Mac.
  assert.equal(judgeFit(room({ freeMemoryBytes: 14 * GB, graphicsLimitBytes: 4 * GB }), 5 * GB, arch, 8192).fit, "tight");
});

test("M1 the room for words is the largest that fits well, never above what the model allows", () => {
  const arch = { layers: 36, kvHeads: 8, headDim: 128 };
  assert.equal(chooseContext(room({ freeMemoryBytes: 60 * GB, totalMemoryBytes: 64 * GB }), 5 * GB, arch, 40960).context, 32768);
  assert.equal(chooseContext(room({ freeMemoryBytes: 60 * GB, totalMemoryBytes: 64 * GB }), 5 * GB, arch, 8192).context, 8192);
  const small = chooseContext(room({ freeMemoryBytes: 7 * GB }), 5 * GB, arch, 40960);
  assert.ok(small.context < 32768 && small.report.fit === "well", `got ${small.context}`);
  assert.equal(chooseContext(room({ totalMemoryBytes: 4 * GB, freeMemoryBytes: 2 * GB }), 9 * GB, arch, 40960).report.fit, "no");
});

// ------------------------------------------------------------------ catalogue and search

test("C1 the curated list has several sizes per model, real hashes, and says which cannot use tools", () => {
  const list = localCatalogue();
  assert.ok(list.length >= 8);
  assert.ok(list.filter((entry) => entry.variants.length >= 2).length >= 8, "most models come in more than one size");
  for (const entry of list) for (const variant of entry.variants) {
    assert.ok(variant.ollama || variant.gguf || variant.mlx, `${entry.id} ${variant.quant} can be fetched somehow`);
    if (variant.gguf) assert.match(variant.gguf.sha256, /^[a-f0-9]{64}$/);
  }
  const gemma = offers(room(), "ollama").find((offer) => offer.id === "gemma3-4b");
  assert.equal(gemma.tools, false);
  assert.match(gemma.warning, /cannot use tools/);
  assert.equal(offers(room(), "ollama").find((offer) => offer.id === "qwen3-8b").warning, null);
  assert.throws(() => findVariant("qwen3-8b", "Q2_K"), /not on Branch's list/);
});

test("C1 the list travels with the built program, which ships without the data folder", async () => {
  const built = JSON.parse(await readFile(new URL("../dist/local-models.json", import.meta.url), "utf8"));
  const source = JSON.parse(await readFile(new URL("../data/local-models.json", import.meta.url), "utf8"));
  assert.deepEqual(built, source);
});

test("C1 each size is judged for this computer and this program", () => {
  const small = offers(room({ totalMemoryBytes: 8 * GB, freeMemoryBytes: 5 * GB }), "ollama");
  const big = offers(room({ totalMemoryBytes: 64 * GB, freeMemoryBytes: 50 * GB }), "ollama");
  const fitOf = (list, id, quant) => list.find((o) => o.id === id).variants.find((v) => v.quant === quant).fit;
  assert.equal(fitOf(small, "llama3.2-3b", "Q4_K_M"), "well");
  assert.equal(fitOf(small, "qwen3-30b-a3b", "Q8_0"), "no");
  assert.equal(fitOf(big, "qwen3-30b-a3b", "Q4_K_M"), "well");
  assert.equal(big.find((o) => o.id === "qwen3-8b").suggested, "Q8_0");
  assert.equal(small.find((o) => o.id === "llama3.2-3b").suggested, "Q8_0", "the biggest size that fits well is suggested");
  // MLX offers only the sizes that exist for it; llama.cpp has the F16 of Qwen3 8B, Ollama does not.
  assert.ok(offers(room(), "mlx").every((o) => o.variants.every((v) => v.quant !== "F16")));
  assert.ok(offers(room(), "llama-cpp").find((o) => o.id === "qwen3-8b").variants.some((v) => v.quant === "F16"));
  assert.ok(!offers(room(), "ollama").find((o) => o.id === "qwen3-8b").variants.some((v) => v.quant === "F16"));
});

test("C2 searching uses Hugging Face for three programs and an exact lookup for Ollama", async () => {
  const asked = [];
  const fake = async (url, init) => {
    asked.push(String(url));
    if (String(url).startsWith("https://huggingface.co/api/models?")) return json([{ id: "unsloth/Qwen3-4B-GGUF", downloads: 9 }, { id: "../../etc", downloads: 1 }]);
    if (String(url).includes("/manifests/8b")) {
      assert.equal(init.headers.accept, "application/vnd.docker.distribution.manifest.v2+json");
      return json({ layers: [{ mediaType: "application/vnd.ollama.image.model", size: 5 * GB }, { mediaType: "application/vnd.ollama.image.license", size: 10 }] });
    }
    return new Response("{}", { status: 404 });
  };
  const hits = await searchHuggingFace("qwen3 4b", "llama-cpp", fake);
  assert.deepEqual(hits.map((hit) => hit.name), ["unsloth/Qwen3-4B-GGUF"], "a name that is not a repository is dropped");
  assert.equal(asked[0], "https://huggingface.co/api/models?search=qwen3%204b&filter=gguf&sort=downloads&limit=20");
  await searchHuggingFace("qwen3", "mlx", fake);
  assert.match(asked[1], /&filter=mlx&/);
  const found = await lookUpOllama("qwen3:8b", fake);
  assert.equal(found[0].bytes, 5 * GB);
  assert.equal(asked[2], "https://registry.ollama.ai/v2/library/qwen3/manifests/8b");
  assert.deepEqual(await lookUpOllama("nothing:here", fake), []);
  await assert.rejects(() => searchHuggingFace("x; rm -rf /", "mlx", fake), /letters/);
});

// ------------------------------------------------------------------ finding and starting programs

test("R1 each program is looked for where each system keeps it", () => {
  assert.deepEqual(candidatePaths("ollama", at.win32).slice(0, 2), ["C:\\Users\\sam\\AppData\\Local\\Programs\\Ollama\\ollama.exe", "C:\\Windows\\ollama.exe"]);
  assert.ok(candidatePaths("ollama", at.darwin).includes("/Applications/Ollama.app/Contents/Resources/ollama"));
  assert.deepEqual(candidatePaths("ollama", at.linux), ["/usr/bin/ollama", "/usr/local/bin/ollama", "/usr/local/bin/ollama", "/usr/bin/ollama"]);
  assert.equal(candidatePaths("lm-studio", at.win32)[0], "C:\\Users\\sam\\.lmstudio\\bin\\lms.exe");
  assert.equal(candidatePaths("lm-studio", at.darwin)[0], "/Users/sam/.lmstudio/bin/lms");
  assert.deepEqual(candidatePaths("llama-cpp", at.win32), ["C:\\Windows\\llama-server.exe", "C:\\Tools\\llama-server.exe"]);
  assert.ok(candidatePaths("mlx", at.darwin).length > 0, "MLX is looked for on Apple silicon");
  assert.deepEqual(candidatePaths("mlx", at.intelMac), [], "and nowhere else");
  assert.deepEqual(candidatePaths("mlx", at.linux), []);
  assert.deepEqual(candidatePaths("mlx", at.win32), []);
});

test("R1 starting a program is an exact argument list, and Linux's Ollama service is left to the owner", () => {
  assert.deepEqual(startPlan("ollama", "/usr/bin/ollama", {}, at.darwin), { commands: [], serve: ["/usr/bin/ollama", "serve"], instead: null, env: {} });
  assert.deepEqual(startPlan("ollama", "C:\\o\\ollama.exe", {}, at.win32).serve, ["C:\\o\\ollama.exe", "serve"]);
  const service = startPlan("ollama", "/usr/bin/ollama", {}, at.linux, "known");
  assert.equal(service.serve, null);
  assert.match(service.instead, /sudo systemctl start ollama/);
  assert.deepEqual(startPlan("lm-studio", "/h/lms", {}, at.linux).commands, [["/h/lms", "daemon", "up"], ["/h/lms", "server", "start", "--port", "1234"]]);
  assert.deepEqual(startPlan("llama-cpp", "llama-server", { file: "/d/m.gguf", context: 16384 }, at.linux).serve,
    ["llama-server", "-m", "/d/m.gguf", "-c", "16384", "--host", "127.0.0.1", "--port", "8080", "--jinja"], "the pure plan falls back to the usual port");
  assert.deepEqual(startPlan("llama-cpp", "llama-server", { file: "/d/m.gguf", port: 51000 }, at.linux).serve.slice(-3), ["--port", "51000", "--jinja"]);
  assert.deepEqual(startPlan("mlx", "mlx_lm.server", { repo: "/d/mlx/x", context: 8192 }, at.darwin).serve,
    ["mlx_lm.server", "--model", "/d/mlx/x", "--host", "127.0.0.1", "--port", "8081"]);
  assert.match(startPlan("llama-cpp", "llama-server", {}, at.linux).instead, /Choose a model/);
});

function fakeLauncher(installed, platform = "darwin") {
  const ran = [], spawned = [], stopped = [];
  const launcher = new RuntimeLauncher({
    at: at[platform],
    exists: async (path) => installed.some((name) => path.endsWith(name)),
    run: async (file, args) => { ran.push([file, ...args]); if (file === "systemctl") return { stdout: "not-found\n" }; return { stdout: "" }; },
    spawn: (file, args) => { spawned.push([file, ...args]); return { pid: 1, stop: () => stopped.push(file) }; },
    freePort: async () => 48081,
  });
  return { launcher, ran, spawned, stopped };
}

test("R2 Branch starts only what is installed, and stops only what it started", async () => {
  const none = fakeLauncher([]);
  const missing = await none.launcher.start("ollama");
  assert.equal(missing.started, false);
  assert.match(missing.message, /not installed.*ollama\.com/);
  assert.deepEqual(none.spawned, [], "nothing is started, and nothing is installed");
  assert.equal(await findRuntime("ollama", at.darwin, async () => false), null);

  const mac = fakeLauncher(["/opt/homebrew/bin/ollama", "/.lmstudio/bin/lms"]);
  assert.equal((await mac.launcher.start("ollama")).started, true);
  assert.deepEqual(mac.spawned, [["/opt/homebrew/bin/ollama", "serve"]]);
  assert.equal(mac.launcher.owns("ollama"), true);
  assert.equal((await mac.launcher.start("lm-studio")).started, true);
  assert.deepEqual(mac.ran, [["/Users/sam/.lmstudio/bin/lms", "daemon", "up"], ["/Users/sam/.lmstudio/bin/lms", "server", "start", "--port", "1234"]]);
  assert.deepEqual(await mac.launcher.stopRuntime("llama-cpp"), { stopped: false }, "not started by Branch, so not stopped");
  assert.deepEqual(await mac.launcher.stopRuntime("ollama"), { stopped: true });
  assert.deepEqual(mac.stopped, ["/opt/homebrew/bin/ollama"]);
  await mac.launcher.start("ollama");
  mac.launcher.stopAll();
  assert.equal(mac.launcher.owns("ollama"), false);

  const linux = fakeLauncher(["/usr/bin/ollama"], "linux");
  await linux.launcher.start("ollama");
  assert.deepEqual(linux.ran, [["systemctl", "is-active", "ollama"], ["systemctl", "is-enabled", "ollama"]],
    "a running service is asked about first, because Ollama's own installer starts one");
  assert.deepEqual(linux.spawned, [["/usr/bin/ollama", "serve"]], "no service known, so Branch starts it for this person");
});

// ------------------------------------------------------------------ disk, downloads, network rules

test("D1 models go where each program keeps them, and the disk is checked first", async () => {
  assert.equal(modelsFolder("ollama", at.darwin, "/d"), "/Users/sam/.ollama/models");
  assert.equal(modelsFolder("ollama", { ...at.linux, env: { OLLAMA_MODELS: "/big/models" } }, "/d"), "/big/models");
  assert.equal(modelsFolder("ollama", at.win32, "C:\\d"), "C:\\Users\\sam\\.ollama\\models");
  assert.equal(modelsFolder("lm-studio", at.win32, "C:\\d"), "C:\\Users\\sam\\.lmstudio\\models");
  assert.equal(modelsFolder("llama-cpp", at.win32, "C:\\data"), "C:\\data\\local-models\\gguf");
  assert.equal(modelsFolder("mlx", at.darwin, "/data"), "/data/local-models/mlx");

  const asked = [];
  const statfs = async (path) => { asked.push(path); if (path !== "C:\\") throw new Error("ENOENT"); return { bavail: 10n, bsize: 1024n ** 3n }; };
  assert.equal(await freeDiskBytes("C:\\Users\\sam\\.ollama\\models", "win32", statfs), 10 * GB);
  assert.deepEqual(asked, ["C:\\Users\\sam\\.ollama\\models", "C:\\Users\\sam\\.ollama", "C:\\Users\\sam", "C:\\Users", "C:\\"]);
  const posixStat = async () => ({ bavail: 6, bsize: GB });
  await assert.rejects(() => assertRoomOnDisk("/x", 5 * GB, "linux", posixStat), /Not enough disk space.*5 GB more.*6 GB is free/);
  assert.deepEqual(await assertRoomOnDisk("/x", 3 * GB, "darwin", posixStat), { freeBytes: 6 * GB });
});

/** A stand-in for Hugging Face: a redirect to its file store, which honours Range. */
function fakeLibrary(content, options = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), range: init.headers?.range ?? null, redirect: init.redirect });
    if (String(url).startsWith("https://huggingface.co/")) return new Response(null, { status: 302, headers: { location: options.to ?? "https://cas-bridge.xethub.hf.co/file?sig=1" } });
    const from = init.headers?.range ? Number(/bytes=(\d+)-/.exec(init.headers.range)[1]) : 0;
    const part = content.subarray(from);
    const range = from ? { "content-range": `bytes ${from}-${content.length - 1}/${content.length}` } : {};
    return new Response(part, { status: from ? 206 : 200, headers: range });
  };
  return { fetch, calls };
}

test("D2 a download carries on from the part already saved, and is checked against its hash", async (t) => {
  const root = await scratch("download");
  t.after(() => discardTemp(root));
  const content = Buffer.from("x".repeat(3000) + "y".repeat(2000));
  const sha256 = createHash("sha256").update(content).digest("hex");
  const target = join(root, "gguf", "model.gguf");
  await mkdir(join(root, "gguf"), { recursive: true });
  await writeFile(`${target}.partial`, content.subarray(0, 3000));
  const library = fakeLibrary(content);
  const progress = [];
  const done = await downloadFile({ url: resolveUrl("unsloth/Qwen3-4B-GGUF", "model.gguf"), target, bytes: content.length, sha256, fetch: library.fetch, onProgress: (p) => progress.push(p) });
  assert.equal(done, target);
  assert.deepEqual(await readFile(target), content);
  assert.equal(library.calls[0].url, "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/model.gguf");
  assert.equal(library.calls[0].redirect, "manual", "each redirect is followed by hand, and checked");
  assert.equal(library.calls[1].range, "bytes=3000-", "only the rest was asked for");
  assert.deepEqual(progress.at(-1), { completed: 5000, total: 5000 });
  await assert.rejects(() => stat(`${target}.partial`), /ENOENT/);
  // Already there: nothing is fetched again.
  const again = fakeLibrary(content);
  await downloadFile({ url: resolveUrl("a/b", "model.gguf"), target, bytes: content.length, sha256, fetch: again.fetch });
  assert.equal(again.calls.length, 0);
});

test("D2 a file that does not match its hash is thrown away, and other hosts are refused", async (t) => {
  const root = await scratch("download-bad");
  t.after(() => discardTemp(root));
  const content = Buffer.from("not what was published");
  const target = join(root, "bad.gguf");
  await assert.rejects(() => downloadFile({ url: resolveUrl("a/b", "bad.gguf"), target, bytes: content.length, sha256: "0".repeat(64), fetch: fakeLibrary(content).fetch }), /did not match/);
  await assert.rejects(() => stat(`${target}.partial`), /ENOENT/);
  await assert.rejects(() => stat(target), /ENOENT/);
  await assert.rejects(() => downloadFile({ url: resolveUrl("a/b", "bad.gguf"), target, bytes: content.length, fetch: fakeLibrary(content, { to: "https://evil.example.com/x" }).fetch }), /only come from Hugging Face/);
  assert.throws(() => resolveUrl("a/b", "../../etc/passwd"), /not a file name/);
  assert.throws(() => resolveUrl("not a repo", "x.gguf"), /Hugging Face repository/);
});

test("N1 local runtimes follow the owner's network rules, apart from the blanket local refusal", async () => {
  const url = new URL("http://127.0.0.1:11434/api/tags");
  assert.doesNotThrow(() => assertLocalRuntimeAllowed(new NetworkPolicy({}), url), "the ordinary policy refuses local addresses; this one does not");
  assert.throws(() => assertLocalRuntimeAllowed(new NetworkPolicy({ blockedHosts: ["127.0.0.1"] }), url), /blocked list/);
  assert.throws(() => assertLocalRuntimeAllowed(new NetworkPolicy({ allowedHosts: ["api.openai.com"] }), url), /not on the allowed list/);
  assert.throws(() => assertLocalRuntimeAllowed(new NetworkPolicy({ blockedPaths: ["127.0.0.1/api/"] }), url), /blocked list/);
  assert.doesNotThrow(() => assertLocalRuntimeAllowed(new NetworkPolicy({ allowedPaths: ["127.0.0.1/api/"] }), url));
  assert.throws(() => assertLocalRuntimeAllowed(new NetworkPolicy({}), new URL("http://192.168.1.5:11434/")), /not on this computer/);
  let reached = 0;
  const guarded = localRuntimeFetch(new NetworkPolicy({ blockedHosts: ["127.0.0.1"] }), async () => { reached++; return json({}); }, "http://127.0.0.1:11434");
  await assert.rejects(() => guarded("http://127.0.0.1:11434/api/tags"), /blocked/);
  assert.equal(reached, 0, "a refused call sends nothing");
  await assert.rejects(() => libraryFetch(null)("https://huggingface.co/api/models"), /will not reach the internet/);
  await assert.rejects(() => libraryFetch(new NetworkPolicy({ blockedHosts: ["huggingface.co"] }), async () => json({}))("https://huggingface.co/api/models"), /blocked/);
});

// ------------------------------------------------------------------ a fake Ollama and LM Studio

/** Answers for 127.0.0.1:11434 and :1234 without opening a port, so a real runtime is never touched. */
function fakeRuntimes(options = {}) {
  const calls = [];
  const state = { ollamaUp: options.ollamaUp ?? true, models: [], loaded: [], studioStatus: 0, studioModels: options.studioModels ?? [] };
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ port: url.port, path: url.pathname, method: init.method ?? "GET", body });
    if (url.port === "11434") return ollama(url.pathname, body);
    if (url.port === "1234") return studio(url.pathname, body);
    if (url.port === "48081" && options.mlxUp) {
      if (url.pathname === "/v1/models") return json({ data: [{ id: options.mlxUp() }] });
      if (url.pathname === "/v1/chat/completions") return json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
    }
    throw new Error(`nothing listens on ${url.host}`);
  };
  function ollama(path, body) {
    if (!state.ollamaUp) throw new TypeError("fetch failed");
    if (path === "/api/version") return json({ version: "0.12.0" });
    if (path === "/api/tags") return json({ models: state.models });
    if (path === "/api/pull") {
      state.models.push({ name: body.model, size: 5 * GB, details: { family: "qwen3" }, capabilities: ["completion", "tools"] });
      const lines = [{ status: "pulling manifest" }, { status: "downloading", total: 100, completed: 50 }, { status: "downloading", total: 100, completed: 100 }, { status: "success" }];
      return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    }
    if (path === "/api/create") { state.models.push({ name: body.model, size: 5 * GB }); return json({ status: "success" }); }
    if (path === "/api/generate") {
      if (body.keep_alive === 0) state.loaded = state.loaded.filter((name) => name !== body.model);
      else state.loaded.push(body.model);
      return json({ done: true });
    }
    if (path === "/api/ps") return json({ models: state.loaded.map((name) => ({ name, size: 6 * GB, size_vram: 6 * GB, context_length: 16384 })) });
    if (path === "/api/chat") return json({ message: { content: "OK" }, done: true });
    if (path === "/api/delete") { state.models = state.models.filter((m) => m.name !== body.model); return json({}); }
    return json({}, 404);
  }
  function studio(path, body) {
    if (!options.studioUp) throw new TypeError("fetch failed");
    if (path === "/api/v1/models") return json({ models: state.studioModels });
    if (path === "/api/v1/models/download") return json({ job_id: "job_7", status: "downloading", total_size_bytes: 200, downloaded_bytes: 0 });
    if (path === "/api/v1/models/download/status/job_7") {
      state.studioStatus += 100;
      const finished = state.studioStatus >= 200;
      if (finished && !state.studioModels.length) state.studioModels.push({ type: "llm", key: "qwen/qwen3-4b", loaded_instances: [] });
      return json({ job_id: "job_7", status: finished ? "completed" : "downloading", total_size_bytes: 200, downloaded_bytes: Math.min(200, state.studioStatus) });
    }
    if (path === "/api/v1/models/load") return json({ instance_id: body.model, load_config: { context_length: body.context_length } });
    if (path === "/api/v1/models/unload") return json({ instance_id: body.instance_id });
    if (path === "/v1/chat/completions") return json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
    return json({}, 404);
  }
  return { fetch, calls, state };
}

async function world(t, { runtimes, installed = ["/opt/homebrew/bin/ollama"], free = 100, mode = "when-needed", machine = room({ freeMemoryBytes: 14 * GB }) } = {}) {
  const root = await scratch("oneclick");
  const store = new Store(join(root, "branch.sqlite"));
  t.after(async () => { store.close(); await discardTemp(root); });
  const models = new ModelRouter(store, [{ id: "demo", name: "Demo", provider: { name: "demo", complete: async () => ({ content: "", toolCalls: [] }) }, model: "demo" }]);
  if (mode) saveLocalModelsMode(store, "owner", { mode });
  const fake = fakeLauncher(installed);
  const deps = {
    store, owner: "owner", models, policy: new NetworkPolicy({}), fetch: runtimes.fetch, dataDir: join(root, "data"),
    launcher: fake.launcher, library: async () => { throw new Error("no internet in tests"); }, room: async () => machine,
    statfs: async () => ({ bavail: free, bsize: GB }), sleep: async () => {}, now: () => new Date("2026-09-17T10:00:00Z"),
  };
  return { root, store, models, fake, deps, oneClick: new OneClick(deps) };
}
async function settle(oneClick, id) {
  for (let tries = 0; tries < 400; tries++) {
    const job = oneClick.jobs.get(id);
    if (job.finishedAt) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the setup never finished");
}

test("O1 one click with Ollama: start it, download, size the room for words, load, connect", async (t) => {
  const runtimes = fakeRuntimes({ ollamaUp: false });
  const w = await world(t, { runtimes });
  // Ollama answers only once Branch has started it.
  const launcherStart = w.fake.launcher.start.bind(w.fake.launcher);
  w.fake.launcher.start = async (...args) => { const out = await launcherStart(...args); runtimes.state.ollamaUp = true; return out; };
  const job = await w.oneClick.begin({ model: "qwen3-8b", quant: "Q4_K_M" });
  assert.equal(job.stage, "checking");
  assert.equal(job.runtime, "ollama", "the installed program is picked");
  const done = await settle(w.oneClick, job.id);
  assert.equal(done.stage, "done", done.message);
  assert.deepEqual(w.fake.spawned, [["/opt/homebrew/bin/ollama", "serve"]]);
  const create = runtimes.calls.find((call) => call.path === "/api/create").body;
  assert.equal(create.from, "qwen3:8b-q4_K_M");
  assert.equal(create.parameters.num_ctx, done.context);
  assert.equal(create.model, sizedModelName("qwen3:8b-q4_K_M", done.context));
  const warm = runtimes.calls.find((call) => call.path === "/api/generate").body;
  assert.equal(warm.options.num_ctx, done.context);
  assert.ok(runtimes.calls.some((call) => call.path === "/api/chat"), "a small question was asked before connecting");
  const saved = savedLocalConnections(w.store, "owner");
  assert.equal(saved.length, 1);
  assert.equal(done.connectionId, saved[0].id);
  assert.match(saved[0].name, /runs on this computer/);
  assert.equal(w.models.presets.get(saved[0].id).model, create.model);
  assert.equal(w.models.runsLocally(saved[0].id), true);
  assert.equal(done.percent, 100);
});

test("O1 the switch, a missing program, a full disk and a model too big each stop it in plain words", async (t) => {
  const runtimes = fakeRuntimes();
  const off = await world(t, { runtimes, mode: null });
  assert.equal(localModelsMode(off.store, "owner"), "off", "it ships off");
  await assert.rejects(() => off.oneClick.begin({ model: "qwen3-8b", quant: "Q4_K_M" }), /switched off/);

  const bare = await world(t, { runtimes, installed: [] });
  const needs = await bare.oneClick.begin({ model: "qwen3-8b", quant: "Q4_K_M" });
  assert.equal(needs.needsRuntime, true);
  assert.ok(needs.runtimes.some((runtime) => runtime.installPage === "https://ollama.com/download"));
  assert.deepEqual(bare.fake.spawned, []);

  const full = await world(t, { runtimes, free: 3 });
  const job = await full.oneClick.begin({ model: "qwen3-8b", quant: "Q4_K_M" });
  const failed = await settle(full.oneClick, job.id);
  assert.equal(failed.stage, "failed");
  assert.match(failed.message, /Not enough disk space/);
  assert.ok(!runtimes.calls.some((call) => call.path === "/api/pull"), "nothing was downloaded");

  const tiny = await world(t, { runtimes, machine: room({ totalMemoryBytes: 8 * GB, freeMemoryBytes: 6 * GB }) });
  await assert.rejects(() => tiny.oneClick.begin({ model: "qwen3-30b-a3b", quant: "Q8_0" }), /Won't fit/);
  const forced = await tiny.oneClick.begin({ model: "qwen3-30b-a3b", quant: "Q8_0", force: true, runtime: "ollama" });
  assert.equal(forced.stage, "checking", "the owner can still insist");
  await settle(tiny.oneClick, forced.id);
  const noMlx = await tiny.oneClick.begin({ model: "qwen3-8b", quant: "Q4_K_M", runtime: "mlx" });
  assert.equal(noMlx.needsRuntime, true);
  assert.equal(noMlx.runtimes[0].installPage, "https://github.com/ml-explore/mlx-lm");
});

test("O2 a setup interrupted by Branch closing carries on when it opens again", async (t) => {
  const runtimes = fakeRuntimes();
  const w = await world(t, { runtimes });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const blocking = { ...w.deps, fetch: async (input, init) => { if (String(input).endsWith("/api/pull")) { await gate; throw new Error("the connection closed"); } return runtimes.fetch(input, init); } };
  const first = new OneClick(blocking);
  const job = await first.begin({ model: "llama3.2-3b", quant: "Q4_K_M" });
  first.closeAll();
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(first.jobs.get(job.id).finishedAt, null, "closing is not the owner stopping it");

  const reopened = new OneClick(w.deps);
  assert.equal(await reopened.resume(), 1);
  const done = await settle(reopened, job.id);
  assert.equal(done.stage, "done", done.message);
  assert.equal(runtimes.calls.filter((call) => call.path === "/api/pull").length, 1, "Ollama itself resumes its partial download");
});

test("O2 the owner can stop a setup, and it is not picked up again", async (t) => {
  const runtimes = fakeRuntimes();
  const w = await world(t, { runtimes });
  const slow = { ...w.deps, fetch: async (input, init) => {
    if (String(input).endsWith("/api/pull")) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    return runtimes.fetch(input, init);
  } };
  const oneClick = new OneClick(slow);
  const job = await oneClick.begin({ model: "llama3.2-3b", quant: "Q4_K_M" });
  for (let i = 0; i < 100 && oneClick.jobs.get(job.id).stage !== "downloading"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(oneClick.stop(job.id), { stopped: true });
  const stopped = await settle(oneClick, job.id);
  assert.equal(stopped.stage, "stopped");
  assert.equal(await new OneClick(w.deps).resume(), 0);
});

test("O5 the one button sets up the exact model the owner named, not a size from Branch's own list", async (t) => {
  const runtimes = fakeRuntimes();
  const w = await world(t, { runtimes });
  saveOneButtonMode(w.store, "owner", { mode: "when-needed" });
  const answer = await w.oneClick.buttonGo({ name: "llama3.1:8b" }, { source: "owner" });
  assert.equal(answer.chose, null, "no size was chosen for the owner");
  assert.equal(answer.job.label, "llama3.1:8b");
  const done = await settle(w.oneClick, answer.job.id);
  assert.equal(done.stage, "done", done.message);
  assert.equal(runtimes.calls.find((call) => call.path === "/api/pull").body.model, "llama3.1:8b");
  await assert.rejects(() => w.oneClick.buttonGo({ name: "../etc" }, { source: "owner" }), /Ollama would recognise/);
});

test("O3 one click with LM Studio uses its download job, then loads with the fitted room", async (t) => {
  const runtimes = fakeRuntimes({ studioUp: true });
  const w = await world(t, { runtimes, installed: ["/.lmstudio/bin/lms"] });
  const job = await w.oneClick.begin({ model: "qwen3-4b", quant: "Q4_K_M", runtime: "lm-studio" });
  const done = await settle(w.oneClick, job.id);
  assert.equal(done.stage, "done", done.message);
  const download = runtimes.calls.find((call) => call.path === "/api/v1/models/download").body;
  assert.deepEqual(download, { model: "https://huggingface.co/unsloth/Qwen3-4B-GGUF", quantization: "Q4_K_M" });
  const load = runtimes.calls.find((call) => call.path === "/api/v1/models/load").body;
  assert.deepEqual(load, { model: "qwen/qwen3-4b", context_length: done.context });
  assert.deepEqual(w.fake.spawned, [], "LM Studio was already running");
  assert.equal(savedLocalConnections(w.store, "owner")[0].id, "local-lm-studio-qwen3-4b");
});

test("O4 one click with MLX on Apple silicon: fetch the folder, start its server with it, connect",
  { skip: process.platform === "win32" && "a Mac's POSIX folders cannot sit on a Windows temporary folder" }, async (t) => {
  let served = null;
  const runtimes = fakeRuntimes({ mlxUp: () => served });
  const w = await world(t, { runtimes, installed: ["/opt/homebrew/bin/mlx_lm.server"] });
  const files = { "config.json": Buffer.from("{}"), "model.safetensors": Buffer.from("weights".repeat(100)), "README.md": Buffer.from("skip me") };
  const library = async (url, init = {}) => {
    const text = String(url);
    if (text === "https://huggingface.co/api/models/mlx-community/Qwen3-4B-4bit/tree/main")
      return json(Object.entries(files).map(([path, data]) => ({ type: "file", path, size: data.length,
        ...(path.endsWith(".safetensors") ? { lfs: { oid: createHash("sha256").update(data).digest("hex"), size: data.length } } : {}) })));
    const name = /resolve\/main\/(.+)$/.exec(text)?.[1];
    if (name && files[name]) return new Response(files[name]);
    return new Response("{}", { status: 404 });
  };
  const deps = { ...w.deps, library, launcher: w.fake.launcher };
  const start = w.fake.launcher.start.bind(w.fake.launcher);
  w.fake.launcher.start = async (id, model) => { const out = await start(id, model); served = model.repo; return out; };
  const oneClick = new OneClick(deps);
  const job = await oneClick.begin({ model: "qwen3-4b", quant: "Q4_K_M", runtime: "mlx" });
  const done = await settle(oneClick, job.id);
  assert.equal(done.stage, "done", done.message);
  const folder = join(w.deps.dataDir, "local-models", "mlx", "mlx-community--Qwen3-4B-4bit");
  assert.deepEqual(await readFile(join(folder, "model.safetensors")), files["model.safetensors"]);
  await assert.rejects(() => stat(join(folder, "README.md")), /ENOENT/, "only what the model needs is fetched");
  assert.deepEqual(w.fake.spawned, [["/opt/homebrew/bin/mlx_lm.server", "--model", folder, "--host", "127.0.0.1", "--port", "48081"]], "on the fresh port Branch picked");
  const saved = savedLocalConnections(w.store, "owner")[0];
  assert.equal(saved.runtime, "mlx");
  assert.equal(saved.model, folder);
  assert.equal(w.models.runsLocally(saved.id), true);
});

// ------------------------------------------------------------------ connections, managing, start-up

test("K1 a local connection is written down, rebuilt at start, and forgotten on request", async (t) => {
  const runtimes = fakeRuntimes();
  const w = await world(t, { runtimes });
  const deps = { models: w.models, store: w.store, owner: "owner", policy: new NetworkPolicy({}), fetch: runtimes.fetch };
  assert.equal(localConnectionId("ollama", "qwen3:8b-q4_K_M-branch16k"), "local-ollama-qwen3-8b-q4-k-m-branch16k");
  await assert.rejects(() => registerLocalConnection(deps, { runtime: "ollama", model: "x:y", contextLength: 8192, label: "X" }, async () => { throw new Error("no answer"); }), /no answer/);
  assert.deepEqual(savedLocalConnections(w.store, "owner"), [], "a model that does not answer is not kept");
  const record = await registerLocalConnection(deps, { runtime: "ollama", model: "qwen3:8b", contextLength: 8192, label: "Qwen3 8B" });
  const fresh = new ModelRouter(w.store, [{ id: "demo", name: "Demo", provider: { name: "demo", complete: async () => ({ content: "", toolCalls: [] }) }, model: "demo" }]);
  assert.deepEqual(restoreLocalConnections({ ...deps, models: fresh }), [record.id]);
  const reply = await fresh.presets.get(record.id).provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 4, signal: AbortSignal.timeout(2000) });
  assert.equal(reply.content, "OK", "the rebuilt connection answers although the ordinary rules refuse local addresses");
  const blocked = new ModelRouter(w.store, [{ id: "demo", name: "Demo", provider: { name: "demo", complete: async () => ({}) }, model: "demo" }]);
  restoreLocalConnections({ ...deps, models: blocked, policy: new NetworkPolicy({ blockedHosts: ["127.0.0.1"] }) });
  await assert.rejects(() => blocked.presets.get(record.id).provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 4, signal: AbortSignal.timeout(2000) }), /blocked/);
  assert.deepEqual(forgetLocalConnection({ ...deps, models: fresh }, record.id), { removed: true });
  assert.equal(fresh.presets.has(record.id), false);
});

test("K2 what is loaded is listed, taken out of memory, and removed with the space it frees", async (t) => {
  const runtimes = fakeRuntimes({ studioUp: true, studioModels: [{ type: "llm", key: "google/gemma-3-4b", size_bytes: 3 * GB, loaded_instances: [{ id: "gemma-a", config: { context_length: 8192 } }] }] });
  const w = await world(t, { runtimes });
  const job = await w.oneClick.begin({ model: "qwen3-8b", quant: "Q4_K_M", runtime: "ollama" });
  const done = await settle(w.oneClick, job.id);
  const manager = new LocalManager(w.deps);
  const loaded = await manager.loaded();
  assert.deepEqual(loaded.map((m) => [m.runtime, m.instanceId]), [["ollama", sizedModelName("qwen3:8b-q4_K_M", done.context)], ["lm-studio", "gemma-a"]]);
  await manager.unload({ runtime: "lm-studio", id: "gemma-a" });
  assert.deepEqual(runtimes.calls.find((c) => c.path === "/api/v1/models/unload").body, { instance_id: "gemma-a" });
  await manager.unload({ runtime: "ollama", id: loaded[0].instanceId });
  assert.equal(runtimes.calls.filter((c) => c.path === "/api/generate").at(-1).body.keep_alive, 0);
  assert.deepEqual(await manager.loaded().then((list) => list.filter((m) => m.runtime === "ollama")), []);
  await assert.rejects(() => manager.unload({ runtime: "llama-cpp", id: "x" }), /did not start/);

  const disk = await manager.onDisk();
  assert.equal(disk.find((m) => m.name === "qwen3:8b-q4_K_M").connectionId, done.connectionId);
  const removed = await manager.remove({ runtime: "ollama", id: "qwen3:8b-q4_K_M" });
  assert.equal(removed.freedBytes, 5 * GB);
  assert.match(removed.message, /about 5 GB is free again/);
  const deleted = runtimes.calls.filter((c) => c.path === "/api/delete").map((c) => c.body.model);
  assert.deepEqual(deleted, [sizedModelName("qwen3:8b-q4_K_M", done.context), "qwen3:8b-q4_K_M"], "the sized copy goes too");
  assert.deepEqual(savedLocalConnections(w.store, "owner"), [], "and so does its connection");
  await assert.rejects(() => manager.remove({ runtime: "lm-studio", id: "google/gemma-3-4b" }), /Delete it in LM Studio/);

  const folder = modelsFolder("llama-cpp", w.fake.launcher.at, w.deps.dataDir);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "tiny.gguf"), Buffer.alloc(2048));
  assert.equal((await manager.remove({ runtime: "llama-cpp", id: "tiny.gguf" })).freedBytes, 2048);
  await assert.rejects(() => stat(join(folder, "tiny.gguf")), /ENOENT/);
  await assert.rejects(() => manager.remove({ runtime: "llama-cpp", id: "../branch.sqlite" }), /not a model Branch downloaded|not on this computer/);
});

test("K3 at start, off restores nothing; when needed restores; on also wakes the program", async (t) => {
  const runtimes = fakeRuntimes({ ollamaUp: false });
  const w = await world(t, { runtimes, mode: null });
  w.store.save("settings", "owner", "local-model-connections", { connections: [{ id: "local-ollama-qwen3-8b", name: "Qwen3 8B (runs on this computer)", runtime: "ollama", model: "qwen3:8b", contextLength: 8192 }] });
  const base = { store: w.store, owner: "owner", models: w.models, policy: new NetworkPolicy({}), dataDir: w.deps.dataDir, fetch: runtimes.fetch, library: async () => json([]) };
  const spawned = [];
  const launcher = { at: at.darwin, exists: async (p) => p.endsWith("/opt/homebrew/bin/ollama"), run: async () => ({ stdout: "" }), spawn: (f, a) => { spawned.push([f, ...a]); return { pid: 1, stop() {} }; } };
  const off = await startLocalModels({ ...base, launcher });
  assert.equal(w.models.presets.has("local-ollama-qwen3-8b"), false);
  off.close();
  saveLocalModelsMode(w.store, "owner", { mode: "when-needed" });
  const needed = await startLocalModels({ ...base, launcher });
  assert.equal(w.models.presets.has("local-ollama-qwen3-8b"), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(spawned, []);
  needed.close();
  saveLocalModelsMode(w.store, "owner", { mode: "on" });
  const on = await startLocalModels({ ...base, launcher });
  for (let i = 0; i < 100 && !spawned.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(spawned, [["/opt/homebrew/bin/ollama", "serve"]]);
  on.close();
});

test("K4 the routes: off by default, the switch saves, and changes refuse while it is off", async (t) => {
  useGraphicsReader(async () => ({ name: "Stand-in", memoryBytes: 8 * GB }));
  useMemoryReaders({ platform: "linux", readText: async () => "MemAvailable: 8388608 kB\n", run: async () => { throw new Error("no programs in tests"); } });
  t.after(() => { useGraphicsReader(() => readGraphicsCard()); useMemoryReaders(null); });
  const root = await scratch("oneclick-routes");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const token = (await readFile(join(root, "data", "session-token"), "utf8")).trim();
  const call = async (path, body) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, origin: server.url, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const view = (await call("/api/local-models")).body;
  assert.equal(view.mode, "off");
  assert.equal(view.oneClick.room.freeMemoryBytes, 8 * GB);
  assert.ok(view.oneClick.offers.length >= 8);
  assert.deepEqual(view.oneClick.loaded, [], "nothing is asked of the runtimes while it is off");
  for (const [path, body] of [["/api/local-models/setup", { model: "qwen3-8b", quant: "Q4_K_M" }], ["/api/local-models/search", { runtime: "mlx", query: "qwen" }],
    ["/api/local-models/runtime/start", { runtime: "ollama" }]]) {
    // The older /pull, /stop, /remove and /load keep working while off (integration review; see V2 in local-models-review).
    const refused = await call(path, body);
    assert.equal(refused.status, 400, path);
    assert.match(refused.body.error, /switched off/, path);
  }
  assert.equal((await call("/api/local-models/offers", { runtime: "llama-cpp" })).status, 200, "looking at what fits is allowed");
  assert.equal((await call("/api/local-models/switch", { mode: "sometimes" })).status, 400);
  assert.deepEqual((await call("/api/local-models/switch", { mode: "when-needed" })).body, { mode: "when-needed" });
  const bad = await call("/api/local-models/setup", { model: "../../etc", quant: "Q4_K_M" });
  assert.equal(bad.status, 400, "a bad request is refused before anything is looked for or started");
  assert.equal((await call("/api/local-models/setup/stop", { id: "not-an-id" })).status, 400);
  // Redesign: the old screen (public/local-oneclick.js, drawOneClick) is replaced by the new window's Settings › On this
  // computer (public/app/settings/pages/local.js), which draws the one-click offers and starts a setup.
  const served = await fetch(server.url + "/app/settings/pages/local.js");
  assert.equal(served.status, 200, "the screen's own file is served");
  const html = await served.text();
  assert.match(html, /oneClick\?\.offers/, "it draws the one-click offers");
  assert.match(html, /api\("local-models\/setup", \{ model: /, "and starts a setup through the route");
});
