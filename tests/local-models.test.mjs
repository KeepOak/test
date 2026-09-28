import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import {
  LmStudioClient, OllamaClient, assertOnThisComputer, contextLengthOf, localEmbedder,
  localModelSupportsImages,
} from "../dist/local-models.js";
import { LocalRuntimes } from "../dist/local-runtimes.js";
import { describeHardware, gb, parseLspci, parseMacDisplays, parseNvidiaSmi, parseRocmSmi, readGraphicsCard, recommendModels, useGraphicsReader } from "../dist/local-hardware.js";
import { useMemoryReaders } from "../dist/local-fit.js";
import { chooseRoute, classifyTask, looksPersonal, routeForTask, routingSettings, saveRoutingSettings } from "../dist/local-routing.js";
import { ModelRouter } from "../dist/models.js";
import { Store } from "../dist/store.js";

/** A throwaway folder. Cleaning up is the caller's job, after whatever holds the folder is closed. */
async function scratch(label) {
  const base = join(tmpdir(), "Codex-session-files");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `branch-${label}-`));
}
/** Serves a fake runtime and shuts it down properly; `fetch` keeps sockets alive, so cut them. */
function closer(t, server) {
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
}

/**
 * A stand-in for Ollama on this computer. It speaks the same routes with the same shapes, so the
 * newline-delimited progress stream is genuinely parsed rather than mocked away.
 */
async function fakeOllama(t, options = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      calls.push({ method: request.method, path: request.url, body });
      const json = (value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url === "/api/version") return options.down ? response.destroy() : json({ version: "0.5.7" });
      if (request.url === "/api/tags") return json({ models: [
        { name: "llama3.2:3b", size: 2_000_000_000, modified_at: "2026-09-01T00:00:00Z", details: { family: "llama", families: ["llama"], parameter_size: "3B" } },
        { name: "llava:7b", size: 4_700_000_000, modified_at: "2026-09-02T00:00:00Z", details: { family: "llama", families: ["llama", "clip"], parameter_size: "7B" } },
      ] });
      if (request.url === "/api/show") return json({
        details: { family: "llama", families: ["llama"], parameter_size: "3B" },
        model_info: { "general.architecture": "llama", "llama.context_length": 131072 },
        capabilities: ["completion"],
      });
      if (request.url === "/api/delete") return json({});
      if (request.url === "/api/embeddings") return json({ embedding: [0.1, 0.2, 0.3, body.prompt.length / 100] });
      if (request.url === "/api/pull") {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        const lines = options.pullLines ?? [
          { status: "pulling manifest" },
          { status: "downloading", total: 1000, completed: 250 },
          { status: "downloading", total: 1000, completed: 1000 },
          { status: "verifying sha256 digest" },
          { status: "success" },
        ];
        // Two lines per chunk, and one line split across chunks, so the reader must reassemble.
        const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
        response.write(text.slice(0, 40));
        setTimeout(() => response.end(text.slice(40)), 10);
        return;
      }
      response.writeHead(404).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closer(t, server);
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

// ------------------------------------------------------------------ L1: downloads with progress

test("L1 a model is downloaded with progress reports that end at 100 per cent", async (t) => {
  const fake = await fakeOllama(t);
  const client = new OllamaClient(fake.url);
  const seen = [];
  const last = await client.pull("llama3.2:3b", (progress) => seen.push(progress));
  assert.ok(seen.length >= 4, `expected several progress reports, got ${seen.length}`);
  assert.ok(seen.every((entry) => entry.event === "model.download.progress"), "every report is named model.download.progress");
  assert.equal(seen[0].status, "pulling manifest");
  const quarter = seen.find((entry) => entry.completed === 250);
  assert.equal(quarter.percent, 25, "a quarter downloaded reads as 25 per cent");
  assert.equal(last.done, true);
  assert.equal(last.percent, 100);
  assert.equal(fake.calls.find((call) => call.path === "/api/pull").body.model, "llama3.2:3b");
});

test("L1 a download that fails reports the reason instead of pretending it finished", async (t) => {
  const fake = await fakeOllama(t, { pullLines: [{ status: "pulling manifest" }, { error: "model 'nope' not found" }] });
  const client = new OllamaClient(fake.url);
  const seen = [];
  await assert.rejects(() => client.pull("nope", (progress) => seen.push(progress)), /not found/);
  assert.equal(seen.at(-1).done, true);
  assert.match(seen.at(-1).error, /not found/);
});

test("L1 installed models are listed, described and removed", async (t) => {
  const fake = await fakeOllama(t);
  const client = new OllamaClient(fake.url);
  assert.equal(await client.version(), "0.5.7");
  const models = await client.list();
  assert.deepEqual(models.map((model) => model.name), ["llava:7b", "llama3.2:3b"], "biggest first");
  assert.equal(models.find((model) => model.name === "llava:7b").canSeePictures, true);
  assert.equal(models.find((model) => model.name === "llama3.2:3b").canSeePictures, false);
  const details = await client.show("llama3.2:3b");
  assert.equal(details.contextLength, 131072);
  assert.equal(details.parameterSize, "3B");
  assert.deepEqual(await client.remove("llama3.2:3b"), { removed: "llama3.2:3b" });
  assert.ok(fake.calls.some((call) => call.method === "DELETE" && call.path === "/api/delete"));
});

test("L1 the manager starts a download in the background and reports how it is going", async (t) => {
  const fake = await fakeOllama(t);
  const runtimes = new LocalRuntimes({ ollamaBaseUrl: fake.url, lmStudioBaseUrl: fake.url });
  const started = runtimes.start("llama3.2:3b");
  assert.equal(started.done, false, "the route returns at once, long before the download finishes");
  for (let tries = 0; tries < 100 && !runtimes.progress()[0].finishedAt; tries++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const finished = runtimes.progress()[0];
  assert.equal(finished.percent, 100);
  assert.equal(finished.done, true);
  assert.ok(finished.finishedAt, "a finished download says when it finished");
});

test("L1 an address that is not on this computer is refused before any request", () => {
  assert.throws(() => new OllamaClient("http://evil.example.com:11434"), /not on this computer/);
  assert.throws(() => assertOnThisComputer("http://127.0.0.1:11434/?key=secret"), /plain/);
  assert.equal(assertOnThisComputer("http://localhost:11434").hostname, "localhost");
});

test("L1 LM Studio is listed, loaded and unloaded through its version 1 routes", async (t) => {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      seen.push({ path: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/api/v1/models") return response.end(JSON.stringify({ models: [
        { type: "llm", key: "qwen/qwen3-8b", size_bytes: 5_000_000_000, max_context_length: 40960, quantization: { name: "Q4_K_M" },
          capabilities: { vision: false, trained_for_tool_use: true }, loaded_instances: [{ id: "qwen/qwen3-8b", config: { context_length: 16384 } }] },
        { type: "embedding", key: "nomic-embed", loaded_instances: [] },
      ] }));
      if (request.url === "/api/v1/models/load") return response.end(JSON.stringify({ type: "llm", instance_id: "qwen/qwen3-8b", status: "loaded", load_config: { context_length: 16384 } }));
      if (request.url === "/api/v1/models/unload") return response.end(JSON.stringify({ instance_id: body.instance_id }));
      if (request.url === "/api/v1/models/download") return response.end(JSON.stringify({ job_id: "job_1", status: "downloading", total_size_bytes: 100 }));
      if (request.url === "/api/v1/models/download/status/job_1") return response.end(JSON.stringify({ job_id: "job_1", status: "completed", total_size_bytes: 100, downloaded_bytes: 100 }));
      response.writeHead(404).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closer(t, server);
  const client = new LmStudioClient(`http://127.0.0.1:${server.address().port}`);
  const listed = await client.list();
  assert.equal(listed.running, true);
  assert.equal(listed.models.length, 1, "embedding models are not offered as a chat model");
  assert.equal(listed.models[0].loaded, true);
  assert.equal(listed.models[0].canUseTools, true);
  assert.deepEqual(listed.models[0].instances, [{ id: "qwen/qwen3-8b", contextLength: 16384 }]);
  assert.deepEqual(await client.load("qwen/qwen3-8b", 16384), { loaded: "qwen/qwen3-8b", instanceId: "qwen/qwen3-8b", contextLength: 16384 });
  assert.deepEqual(seen.find((call) => call.path === "/api/v1/models/load").body, { model: "qwen/qwen3-8b", context_length: 16384 });
  assert.deepEqual(await client.unload("qwen/qwen3-8b"), { unloaded: "qwen/qwen3-8b" });
  assert.deepEqual(seen.find((call) => call.path === "/api/v1/models/unload").body, { instance_id: "qwen/qwen3-8b" });
  const job = await client.download("https://huggingface.co/unsloth/Qwen3-4B-GGUF", "Q4_K_M");
  assert.deepEqual(job, { jobId: "job_1", status: "downloading", totalBytes: 100, downloadedBytes: 0 });
  assert.deepEqual(seen.find((call) => call.path === "/api/v1/models/download").body, { model: "https://huggingface.co/unsloth/Qwen3-4B-GGUF", quantization: "Q4_K_M" });
  assert.equal((await client.downloadStatus("job_1")).status, "completed");
  assert.ok(!seen.some((call) => call.path === "/v1/chat/completions"), "no one-word question is used to load a model any more");
  await assert.rejects(() => client.downloadStatus("../../etc"), /Invalid|match/i);
});

test("L1 an older LM Studio without the version 1 routes is still listed", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/api/v0/models") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: "qwen2.5-7b", state: "loaded", max_context_length: 32768 }] }));
    }
    response.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closer(t, server);
  const listed = await new LmStudioClient(`http://127.0.0.1:${server.address().port}`).list();
  assert.equal(listed.running, true);
  assert.equal(listed.models[0].name, "qwen2.5-7b");
  assert.equal(listed.models[0].loaded, true);
});

// ---------------------------------------------------- L2: recommendations from the hardware

test("L2 a small computer is offered small models and told why the big ones would crawl", () => {
  const small = recommendModels({ totalMemoryBytes: 8 * 1024 ** 3, cores: 4, graphics: null });
  assert.deepEqual(small.map((entry) => entry.fits), [true, false, false]);
  assert.match(small[0].expectation, /fast/i);
  assert.match(small[2].note, /crawl/);
  assert.match(small[0].note, /word at a time/, "no graphics card is said plainly");
});

test("L2 a large computer with a graphics card is offered every size", () => {
  const machine = {
    totalMemoryBytes: 64 * 1024 ** 3, cores: 16,
    graphics: { name: "NVIDIA GeForce RTX 4090", memoryBytes: 24 * 1024 ** 3 },
  };
  const big = recommendModels(machine);
  assert.deepEqual(big.map((entry) => entry.fits), [true, true, true]);
  assert.match(big[2].expectation, /reasoning/i);
  assert.match(big[0].note, /graphics card/);
  assert.match(describeHardware(machine).summary, /64 GB memory, 16 processor cores, NVIDIA GeForce RTX 4090/);
  assert.equal(gb(8 * 1024 ** 3), 8);
});

test("L2 asking Windows for the graphics card never throws, whatever comes back", async () => {
  const ok = await readGraphicsCard(async () => ({ stdout: '{"Name":"Intel Iris Xe","AdapterRAM":1073741824}' }), "win32");
  assert.deepEqual(ok, { name: "Intel Iris Xe", memoryBytes: 1073741824 });
  assert.equal(await readGraphicsCard(async () => { throw new Error("powershell is not here"); }, "win32"), null);
  assert.equal(await readGraphicsCard(async () => ({ stdout: "not json" }), "win32"), null);
  assert.equal(await readGraphicsCard(async () => ({ stdout: "{}" }), "sunos"), null, "nothing is asked where there is no known way");
});

test("L2 Windows reads real video memory, not the 4 GB-capped WMI figure", async () => {
  const asked = [];
  // No NVIDIA driver: WMI gives the name and a capped figure, the registry the real 16 GB.
  const amd = await readGraphicsCard(async (file, args) => {
    asked.push([file, ...args]);
    if (/System32\\nvidia-smi\.exe$/i.test(file)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    if (args.at(-1).startsWith("Get-CimInstance")) return { stdout: '{"Name":"AMD Radeon RX 7800 XT","AdapterRAM":4293918720}' };
    return { stdout: "17163091968\r\n" };
  }, "win32");
  assert.deepEqual(amd, { name: "AMD Radeon RX 7800 XT", memoryBytes: 17163091968 });
  assert.deepEqual(asked[0], ["C:\\Windows\\System32\\nvidia-smi.exe", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  assert.match(asked[2].at(-1), /HardwareInformation\.qwMemorySize/);
  // With NVIDIA's tool present, its figure is used and nothing else is asked.
  const nvidia = await readGraphicsCard(async () => ({ stdout: "NVIDIA GeForce RTX 4090, 24564" }), "win32");
  assert.deepEqual(nvidia, { name: "NVIDIA GeForce RTX 4090", memoryBytes: 24564 * 1024 ** 2 });
  // A registry with nothing useful leaves the WMI figure as it was.
  const plain = await readGraphicsCard(async (file, args) => {
    if (/System32\\nvidia-smi\.exe$/i.test(file)) throw new Error("no");
    return args.at(-1).startsWith("Get-CimInstance") ? { stdout: '{"Name":"Intel Iris Xe","AdapterRAM":1073741824}' } : { stdout: "" };
  }, "win32");
  assert.deepEqual(plain, { name: "Intel Iris Xe", memoryBytes: 1073741824 });
});

test("L2 Linux reads an AMD card's memory from rocm-smi, then from the driver's own file", async () => {
  const amdLine = "03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 [Radeon RX 6800] (rev c1)";
  const noNvidia = (rocm) => async (file, args) => {
    if (file === "nvidia-smi") throw new Error("ENOENT");
    if (file === "lspci") return { stdout: amdLine };
    if (file === "rocm-smi") { assert.deepEqual(args, ["--showmeminfo", "vram", "--json"]); if (rocm) return { stdout: rocm }; throw new Error("ENOENT"); }
    throw new Error(`unexpected ${file}`);
  };
  const viaRocm = await readGraphicsCard(noNvidia(JSON.stringify({ card0: { "VRAM Total Memory (B)": "17163091968", "VRAM Total Used Memory (B)": "1" } })), "linux");
  assert.equal(viaRocm.memoryBytes, 17163091968);
  const sysfs = { list: async () => ["card0", "card0-DP-1", "renderD128"], read: async (path) => { assert.equal(path, "/sys/class/drm/card0/device/mem_info_vram_total"); return "8573157376\n"; } };
  const viaSysfs = await readGraphicsCard(noNvidia(null), "linux", sysfs);
  assert.equal(viaSysfs.memoryBytes, 8573157376);
  assert.equal(parseRocmSmi("not json"), null);
});

// Captured on the owner's Mac mini (Apple M4) with `system_profiler SPDisplaysDataType -json`,
// trimmed to the fields that matter and with the monitors' serial numbers left out.
const appleSiliconSample = JSON.stringify({ SPDisplaysDataType: [{
  _name: "Apple M4", spdisplays_mtlgpufamilysupport: "spdisplays_metal4",
  spdisplays_ndrvs: [{ _name: "C27G4Z", _spdisplays_pixels: "1920 x 1080", spdisplays_main: "spdisplays_yes" }],
  spdisplays_vendor: "sppci_vendor_Apple", sppci_bus: "spdisplays_builtin", sppci_cores: "10",
  sppci_device_type: "spdisplays_gpu", sppci_model: "Apple M4",
}] });
// The shape an Intel Mac with a separate card writes: two entries, each with its own memory figure.
const intelMacSample = JSON.stringify({ SPDisplaysDataType: [
  { _name: "Intel UHD Graphics 630", sppci_model: "Intel UHD Graphics 630", spdisplays_vendor: "Intel", spdisplays_vram_shared: "1536 MB", sppci_bus: "spdisplays_builtin" },
  { _name: "AMD Radeon Pro 5500M", sppci_model: "AMD Radeon Pro 5500M", spdisplays_vendor: "sppci_vendor_amd", spdisplays_vram: "8 GB", sppci_bus: "spdisplays_pcie_device" },
] });

test("L2 a Mac's graphics are read from system_profiler, and Apple silicon is said to share memory", async () => {
  const apple = parseMacDisplays(appleSiliconSample);
  assert.deepEqual(apple, { name: "Apple M4", memoryBytes: null, sharedMemory: true });
  assert.deepEqual(parseMacDisplays(intelMacSample), { name: "AMD Radeon Pro 5500M", memoryBytes: 8 * 1024 ** 3 });
  assert.equal(parseMacDisplays('{"SPDisplaysDataType":[]}'), null);
  assert.equal(parseMacDisplays('{"SPDisplaysDataType":"nonsense"}'), null);
  const asked = [];
  const card = await readGraphicsCard(async (file, args) => { asked.push([file, ...args]); return { stdout: appleSiliconSample }; }, "darwin");
  assert.deepEqual(card, apple);
  assert.deepEqual(asked, [["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"]]);
  assert.equal(await readGraphicsCard(async () => ({ stdout: "not json" }), "darwin"), null);

  const mac = { totalMemoryBytes: 16 * 1024 ** 3, cores: 10, graphics: apple };
  assert.equal(describeHardware(mac).summary, "16 GB memory, 10 processor cores, Apple M4 graphics, which share that memory");
  const advice = recommendModels(mac);
  assert.deepEqual(advice.map((entry) => entry.fits), [true, true, false]);
  assert.match(advice[0].note, /share this computer's memory/);
  assert.doesNotMatch(advice[1].note, /word at a time/, "Apple silicon is not treated as having no graphics");
  assert.match(advice[2].note, /crawl/);
});

test("L2 Linux asks nvidia-smi first and falls back to lspci", async () => {
  assert.deepEqual(parseNvidiaSmi("NVIDIA GeForce RTX 3060, 12288\n"), { name: "NVIDIA GeForce RTX 3060", memoryBytes: 12288 * 1024 ** 2 });
  assert.equal(parseNvidiaSmi("No devices were found"), null);
  // The real line from the Linux check machine (a virtual one), and a typical desktop one.
  const vm = "00:00.0 Host bridge: Intel Corporation 440FX - 82441FX PMC [Natoma] (rev 02)\n00:01.0 VGA compatible controller: Cirrus Logic GD 5446\n";
  assert.deepEqual(parseLspci(vm), { name: "Cirrus Logic GD 5446", memoryBytes: null });
  assert.deepEqual(parseLspci("01:00.0 3D controller: NVIDIA Corporation TU117M [GeForce GTX 1650 Mobile] (rev a1)"),
    { name: "NVIDIA Corporation TU117M [GeForce GTX 1650 Mobile]", memoryBytes: null });
  assert.equal(parseLspci("00:1f.3 Audio device: Intel Corporation"), null);

  const asked = [];
  const withNvidia = await readGraphicsCard(async (file, args) => { asked.push([file, ...args]); return { stdout: "NVIDIA RTX A4000, 16376" }; }, "linux");
  assert.equal(withNvidia.name, "NVIDIA RTX A4000");
  assert.deepEqual(asked, [["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]]);
  const fallback = await readGraphicsCard(async (file) => {
    if (file === "nvidia-smi") throw Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" });
    return { stdout: vm };
  }, "linux");
  assert.deepEqual(fallback, { name: "Cirrus Logic GD 5446", memoryBytes: null });
  assert.equal(await readGraphicsCard(async () => { throw new Error("nothing here"); }, "linux"), null);
});

test("L2 this computer's own graphics are read without an error", { skip: process.platform !== "linux" }, async () => {
  // Linux only: nvidia-smi and lspci only read, so the real ones are safe to ask on the check machine.
  const card = await readGraphicsCard();
  assert.ok(card === null || (typeof card.name === "string" && card.name.length > 0));
});

// ----------------------------------------------------------------- L3: per-task routing rules

const rules = (over = {}) => ({
  enabled: true, localForPrivate: true, cloudForHard: true, costCeilingDollars: 0.02,
  localPreset: null, cloudPreset: null, ...over,
});

test("L3 a short private task stays on this computer and a long tool-heavy one goes to the cloud", () => {
  const inputs = { localPreset: "here", cloudPreset: "cloud", localUp: true, cloudCost: 0.0001 };
  const privateTask = classifyTask("Tidy this note: my bank account number is 4111 1111 1111 1111");
  assert.equal(privateTask.personal, true);
  assert.equal(privateTask.simple, true);
  const kept = chooseRoute(rules(), privateTask, inputs);
  assert.equal(kept.preset, "here");
  assert.equal(kept.kind, "local");
  assert.match(kept.reason, /personal details/);

  const hard = classifyTask("Please search the web and then refactor the reporting module " + "context ".repeat(1200));
  assert.equal(hard.long, true);
  assert.equal(hard.toolHeavy, true);
  const sent = chooseRoute(rules(), hard, inputs);
  assert.equal(sent.preset, "cloud");
  assert.equal(sent.kind, "cloud");
});

test("L3 a simple task that would cost too much in the cloud uses the free model here", () => {
  const shape = classifyTask("Write me a haiku about rain");
  const dear = chooseRoute(rules({ costCeilingDollars: 0.001 }), shape, {
    localPreset: "here", cloudPreset: "cloud", localUp: true, cloudCost: 0.05,
  });
  assert.equal(dear.kind, "local");
  assert.match(dear.reason, /cost about \$0\.0500/);
  const cheap = chooseRoute(rules(), shape, { localPreset: "here", cloudPreset: "cloud", localUp: true, cloudCost: 0.0001 });
  assert.equal(cheap.kind, "unchanged", "a cheap simple task is left alone");
});

test("L3 a private task never falls back to the cloud; a cheap one may when the model here is down", () => {
  const shape = classifyTask("Summarise this: my passport number and my address");
  const down = chooseRoute(rules(), shape, { localPreset: "here", cloudPreset: "cloud", localUp: false, cloudCost: 0.0001 });
  assert.deepEqual([down.preset, down.kind, down.private], ["here", "local", true], "it stays here and fails honestly");
  assert.match(down.reason, /not sent anywhere else/);
  const nowhere = chooseRoute(rules(), shape, { localPreset: null, cloudPreset: "cloud", localUp: false, cloudCost: 0.0001 });
  assert.deepEqual([nowhere.preset, nowhere.kind, nowhere.private], [null, "refused", true]);
  assert.match(nowhere.reason, /no model is set up here/);
  const hard = classifyTask("Search the web and refactor: my passport number " + "context ".repeat(1200));
  assert.equal(chooseRoute(rules(), hard, { localPreset: "here", cloudPreset: "cloud", localUp: true, cloudCost: 1 }).preset, "here",
    "a private task stays here even when it is long or tool-heavy");
  const cheap = classifyTask("Write me a haiku about rain");
  const fallback = chooseRoute(rules({ costCeilingDollars: 0.001 }), cheap, { localPreset: "here", cloudPreset: "cloud", localUp: false, cloudCost: 0.05 });
  assert.deepEqual([fallback.preset, fallback.private], ["cloud", undefined], "a task kept here only to save money may still go to the cloud");
  assert.match(fallback.reason, /not answering/);
});

test("L3 routing off changes nothing, and the personal-details test catches what people paste", () => {
  const shape = classifyTask("my password is hunter2");
  assert.equal(chooseRoute(rules({ enabled: false }), shape, { localPreset: "here", cloudPreset: "cloud", localUp: true, cloudCost: 1 }).preset, null);
  assert.equal(looksPersonal("write to me at sam@example.com"), true);
  assert.equal(looksPersonal("call 07700 900123 tomorrow"), true);
  assert.equal(looksPersonal("what is the capital of Peru"), false);
});

test("L3 routing reads the owner's saved rules and picks presets that really exist", async (t) => {
  const root = await scratch("routing");
  const store = new Store(join(root, "branch.sqlite"));
  t.after(async () => { store.close(); await discardTemp(root); });
  const local = { name: "openai-compatible", embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1", apiKey: "local" }), complete: async () => ({ content: "", toolCalls: [] }) };
  const cloud = { name: "anthropic", complete: async () => ({ content: "", toolCalls: [] }) };
  const models = new ModelRouter(store, [
    { id: "cloud", name: "Cloud", provider: cloud, model: "claude-3-5-sonnet" },
    { id: "here", name: "On this computer", provider: local, model: "llama3.2" },
  ]);
  assert.equal(models.runsLocally("here"), true);
  assert.equal(models.runsLocally("cloud"), false);
  assert.equal(routingSettings(store, "owner").enabled, false, "off until the owner turns it on");
  assert.equal(routeForTask(store, models, "owner", { prompt: "my password is hunter2" }).preset, null);
  saveRoutingSettings(store, "owner", { enabled: true });
  const choice = routeForTask(store, models, "owner", { prompt: "my password is hunter2" });
  assert.equal(choice.preset, "here");
  assert.equal(models.plan("owner", "session", { preset: choice.preset }).choice.local, true, "the pane can say it runs here");
});

// ----------------------------------------------------- L4: reading passages on this computer

test("L4 a local connection reads passages through Ollama's own route", async (t) => {
  const fake = await fakeOllama(t);
  assert.equal(localEmbedder({ endpoint: "https://api.openai.com/v1" }, "text-embedding-3-small"), null, "a cloud address is not local");
  assert.equal(localEmbedder({ endpoint: fake.url + "/v1" }, "text-embedding-3-small"), null, "only Ollama's own port counts");
  const chosen = localEmbedder({ endpoint: "http://127.0.0.1:11434/v1" }, "text-embedding-3-small");
  assert.equal(chosen.model, "nomic-embed-text", "the cloud default is swapped for one that exists here");
  assert.equal(localEmbedder({ endpoint: "http://127.0.0.1:11434/v1" }, "mxbai-embed-large").model, "mxbai-embed-large");
  const direct = new OllamaClient(fake.url);
  const vectors = await direct.embed(["hello", "a longer passage"], "nomic-embed-text", AbortSignal.timeout(5000));
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0].length, 4);
  assert.notEqual(vectors[0][3], vectors[1][3], "each passage gets its own vector");
  const asked = fake.calls.filter((call) => call.path === "/api/embeddings");
  assert.equal(asked.length, 2);
  assert.equal(asked[0].body.model, "nomic-embed-text");
});

test("L4 the document library uses the local reader when the connected model runs here", async (t) => {
  const root = await scratch("local-docs");
  // The library recognises Ollama by its address, so this preset points at where Ollama listens.
  const provider = {
    name: "openai-compatible",
    embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1", apiKey: "local" }),
    complete: async () => ({ content: "ok", toolCalls: [] }),
  };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "here", name: "On this computer", provider, model: "llama3.2" }],
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(app.documents.view("local").meaningSearch, true, "meaning search is available through the local model");
  assert.equal(app.runtime.models.plan("local", "").choice.local, true);
});

// --------------------------------------------------------------- L5/L6: health, routes, docs

test("L5 the health report has a section for models on this computer", async (t) => {
  const root = await scratch("local-health");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const token = (await readFile(join(root, "data", "session-token"), "utf8")).trim();
  const report = await (await fetch(server.url + "/api/health", { headers: { authorization: `Bearer ${token}`, origin: server.url } })).json();
  const section = report.items.find((entry) => entry.name === "Models on this computer");
  assert.ok(section, "the report names the section");
  assert.match(section.summary, /Ollama/);
});

test("L5 the routes answer: what is here, and a preview of which model would take a task", async (t) => {
  // The route asks for the graphics card; a stand-in answers so no real system_profiler, nvidia-smi or lspci runs.
  const asked = [];
  useGraphicsReader(async () => { asked.push("graphics"); return { name: "Stand-in card", memoryBytes: 4 * 1024 ** 3 }; });
  // Free memory too, so no vm_stat or sysctl runs for the one-click part of the same answer.
  useMemoryReaders({ platform: "win32", free: () => 2 * 1024 ** 3, run: async () => { throw new Error("no programs in tests"); } });
  t.after(() => { useGraphicsReader(() => readGraphicsCard()); useMemoryReaders(null); });
  const root = await scratch("local-routes");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const token = (await readFile(join(root, "data", "session-token"), "utf8")).trim();
  const call = (path, body) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, origin: server.url, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const view = await (await call("/api/local-models")).json();
  assert.match(view.hardware.summary, /Stand-in card \(4 GB\)/);
  assert.deepEqual(asked, ["graphics"]);
  assert.equal(view.recommendations.length, 3);
  assert.equal(view.routing.enabled, false);
  assert.equal(view.ollama.downloadPage, "https://ollama.com/download");

  const saved = await (await call("/api/local-models/routing", { enabled: true })).json();
  assert.equal(saved.enabled, true);
  const preview = await (await call("/api/local-models/routing/preview", { prompt: "email me at sam@example.com" })).json();
  assert.equal(preview.shape.personal, true);
  assert.equal(preview.choice.preset, null, "with only the demonstration model there is nothing local to pick");

  const refused = await call("/api/local-models/pull", { model: "../etc/passwd" });
  assert.equal(refused.status, 400, "a model name that is not a model name is refused");
});

test("L6 nothing new was added to package.json", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@modelcontextprotocol/sdk", "playwright", "yaml", "zod"]);
});

test("L6 pictures and context length are read from what the runtime reports", () => {
  assert.equal(localModelSupportsImages("llava:7b"), true);
  assert.equal(localModelSupportsImages("qwen2.5:7b", ["llama", "clip"]), true);
  assert.equal(localModelSupportsImages("qwen2.5:7b", [], ["vision"]), true);
  assert.equal(localModelSupportsImages("llama3.2:3b", ["llama"]), false);
  assert.equal(contextLengthOf({ "llama.context_length": 8192, "general.parameter_count": 3 }), 8192);
  assert.equal(contextLengthOf(undefined), null);
});

test("local-runtime health is red, not optional, when a connection answers from this computer and nothing runs here", async () => {
  const nothing = async () => { throw new Error("connection refused"); };
  const runtimes = new LocalRuntimes({ ollamaBaseUrl: "http://127.0.0.1:9", lmStudioBaseUrl: "http://127.0.0.1:9", fetch: nothing });
  const optional = await runtimes.health();
  assert.equal(optional.ok, true, "with no connection here, a missing runtime is only optional");
  const needed = await runtimes.health(true);
  assert.equal(needed.ok, false);
  assert.match(needed.summary, /answers from this computer, but no model is running here/);
});
