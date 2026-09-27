import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

/**
 * What this computer can actually run. Memory and processor cores come from Node itself; the
 * graphics card is asked for once — through Windows, through `system_profiler` on a Mac, through
 * `nvidia-smi` or `lspci` on Linux — and then remembered, because that question is slow and the
 * answer does not change while the app is open.
 */
export interface GraphicsCard {
  name: string;
  /** Video memory in bytes, or null when the computer does not report a believable figure. */
  memoryBytes: number | null;
  /**
   * True when the graphics share the computer's own memory rather than having their own, as on a
   * Mac with Apple silicon. The figure to plan with is then the computer's memory, not a card's.
   */
  sharedMemory?: boolean;
}
export interface Hardware {
  totalMemoryBytes: number;
  cores: number;
  graphics: GraphicsCard | null;
  /** Plain-language summary for the screen, for example "16 GB memory, 8 cores, NVIDIA RTX 3060". */
  summary: string;
}

const gigabyte = 1024 ** 3;
const megabyte = 1024 ** 2;
export const gb = (bytes: number): number => Math.round((bytes / gigabyte) * 10) / 10;

type Exec = (file: string, args: string[], options: { timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }>;
const run = promisify(execFile);
/** Reads the small text files Linux keeps about a graphics card; tests hand in their own. */
export interface SysfsReader { list(dir: string): Promise<string[]>; read(path: string): Promise<string> }
const realSysfs: SysfsReader = { list: (dir) => readdir(dir), read: (path) => readFile(path, "utf8") };
/** Asks this computer for its graphics card once; anything unexpected simply means "no card reported". */
export async function readGraphicsCard(exec: Exec = run, platform: string = process.platform, sysfs: SysfsReader = realSysfs): Promise<GraphicsCard | null> {
  const options = { timeout: 10000, windowsHide: true };
  try {
    if (platform === "win32") return await windowsGraphicsCard(exec, options);
    if (platform === "darwin")
      return parseMacDisplays((await exec("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], options)).stdout);
    if (platform === "linux") return await linuxGraphicsCard(exec, options, sysfs);
    return null;
  } catch {
    return null;
  }
}

/**
 * Wave mac5 (local models): Windows' `AdapterRAM` is a 32-bit figure, so any card with more than
 * 4 GB was reported as 4 GB or less. NVIDIA's own tool is asked first, as on Linux; otherwise the
 * name still comes from WMI as before, and the memory from the driver's 64-bit registry value
 * (`HardwareInformation.qwMemorySize`) when it is there, falling back to `AdapterRAM` when it is not.
 */
async function windowsGraphicsCard(exec: Exec, options: { timeout: number; windowsHide: boolean }): Promise<GraphicsCard | null> {
  // Integration review: by its full path, so a program of that name in Branch's own folder is never run.
  const system32 = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "nvidia-smi.exe");
  const nvidia = await exec(system32, nvidiaQuery, options).then((out) => parseNvidiaSmi(out.stdout), () => null);
  if (nvidia) return nvidia;
  const script = "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json -Compress";
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], options);
  const parsed = JSON.parse(stdout.trim() || "null") as { Name?: unknown; AdapterRAM?: unknown } | null;
  if (!parsed || typeof parsed.Name !== "string" || !parsed.Name.trim()) return null;
  const ram = typeof parsed.AdapterRAM === "number" && parsed.AdapterRAM > 0 ? parsed.AdapterRAM : null;
  const wide = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsRegistryScript], options)
    .then((out) => parseWindowsRegistryMemory(out.stdout), () => null);
  return { name: parsed.Name.trim().slice(0, 120), memoryBytes: wide && wide > (ram ?? 0) ? wide : ram };
}

const nvidiaQuery = ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"];
/** The display adapters' class key; each driver writes its real memory size under it as a 64-bit number. */
export const windowsRegistryScript = "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue"
  + " | ForEach-Object { $_.'HardwareInformation.qwMemorySize' } | Where-Object { $_ } | ForEach-Object { [uint64]$_ }"
  + " | Measure-Object -Maximum | Select-Object -ExpandProperty Maximum";
/** The largest figure the registry script printed, or null. */
export function parseWindowsRegistryMemory(output: string): number | null {
  const value = Number(output.trim().split(/\r?\n/).pop() ?? "");
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * NVIDIA's own tool first, because it knows the video memory; `lspci` at least knows the name.
 * For an AMD card, `rocm-smi` and then the driver's own file under /sys give the memory.
 */
async function linuxGraphicsCard(exec: Exec, options: { timeout: number; windowsHide: boolean }, sysfs: SysfsReader): Promise<GraphicsCard | null> {
  try {
    const { stdout } = await exec("nvidia-smi", nvidiaQuery, options);
    const card = parseNvidiaSmi(stdout);
    if (card) return card;
  } catch { /* no NVIDIA driver here: ask lspci instead */ }
  const card = parseLspci((await exec("lspci", [], options)).stdout);
  if (!card || !/\b(AMD|ATI|Radeon)\b/i.test(card.name)) return card;
  const rocm = await exec("rocm-smi", ["--showmeminfo", "vram", "--json"], options)
    .then((out) => parseRocmSmi(out.stdout), () => null);
  return { ...card, memoryBytes: rocm ?? await amdSysfsMemory(sysfs) };
}

/** `rocm-smi --showmeminfo vram --json`: the largest "VRAM Total Memory (B)" of any card. */
export function parseRocmSmi(output: string): number | null {
  try {
    const cards = Object.values(JSON.parse(output) as Record<string, Record<string, unknown>>);
    const sizes = cards.map((card) => Number(card?.["VRAM Total Memory (B)"])).filter((n) => Number.isFinite(n) && n > 0);
    return sizes.length ? Math.max(...sizes) : null;
  } catch { return null; }
}

/** The amdgpu driver's `mem_info_vram_total`, in bytes, for the biggest card. */
async function amdSysfsMemory(sysfs: SysfsReader): Promise<number | null> {
  const cards = (await sysfs.list("/sys/class/drm").catch(() => [] as string[])).filter((name) => /^card\d+$/.test(name));
  let best: number | null = null;
  for (const name of cards) {
    const value = Number((await sysfs.read(`/sys/class/drm/${name}/device/mem_info_vram_total`).catch(() => "")).trim());
    if (Number.isFinite(value) && value > 0 && value > (best ?? 0)) best = value;
  }
  return best;
}

/** The first line of `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(output: string): GraphicsCard | null {
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  const match = line ? /^(.+?),\s*(\d+(?:\.\d+)?)\s*$/.exec(line) : null;
  if (!match || !match[1]!.trim()) return null;
  const mib = Number(match[2]);
  return { name: match[1]!.trim().slice(0, 120), memoryBytes: mib > 0 ? Math.round(mib * megabyte) : null };
}

/** The first display controller `lspci` lists. It never says how much memory a card has. */
export function parseLspci(output: string): GraphicsCard | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\S+\s+(?:VGA compatible controller|3D controller|Display controller)(?:\s*\[[0-9a-f]+\])?:\s*(.+)$/i.exec(line.trim());
    if (match && match[1]!.trim()) return { name: match[1]!.replace(/\s*\(rev [0-9a-f]+\)\s*$/i, "").trim().slice(0, 120), memoryBytes: null };
  }
  return null;
}

const macDisplays = z.object({
  SPDisplaysDataType: z.array(z.object({
    _name: z.string().optional(),
    sppci_model: z.string().optional(),
    sppci_bus: z.string().optional(),
    spdisplays_vendor: z.string().optional(),
    spdisplays_vram: z.string().optional(),
    spdisplays_vram_shared: z.string().optional(),
    _spdisplays_vram: z.string().optional(),
  }).loose()).default([]),
}).loose();

/**
 * The graphics from `system_profiler SPDisplaysDataType -json`. A Mac with Apple silicon reports no
 * video memory at all, because its graphics use the computer's own memory; that is said, not guessed.
 * A card with memory of its own is preferred over a built-in one when a Mac has both.
 */
export function parseMacDisplays(output: string): GraphicsCard | null {
  const parsed = macDisplays.safeParse(JSON.parse(output || "null"));
  if (!parsed.success) return null;
  const cards = parsed.data.SPDisplaysDataType.map((entry) => {
    const name = (entry.sppci_model ?? entry._name ?? "").trim().slice(0, 120);
    const memoryBytes = macMemory(entry.spdisplays_vram ?? entry._spdisplays_vram);
    const apple = /apple/i.test(entry.spdisplays_vendor ?? "") || /^apple /i.test(name);
    const sharedMemory = memoryBytes === null && (apple || Boolean(entry.spdisplays_vram_shared));
    return { name, memoryBytes, sharedMemory };
  }).filter((card) => card.name);
  const chosen = cards.find((card) => card.memoryBytes) ?? cards[0];
  if (!chosen) return null;
  return chosen.sharedMemory ? chosen : { name: chosen.name, memoryBytes: chosen.memoryBytes };
}

/** "8 GB", "1536 MB" as `system_profiler` writes them. */
function macMemory(text: string | undefined): number | null {
  const match = text ? /^(\d+(?:\.\d+)?)\s*(GB|MB)$/i.exec(text.trim()) : null;
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2]!.toUpperCase() === "GB" ? gigabyte : megabyte));
}

let remembered: Hardware | null = null;
let asking: Promise<Hardware> | null = null;
let askGraphics: () => Promise<GraphicsCard | null> = () => readGraphicsCard();
/** Replaces how the graphics card is asked for, so a test never starts the computer's own tool. */
export function useGraphicsReader(reader: () => Promise<GraphicsCard | null>): void {
  askGraphics = reader;
  forgetHardware();
}
/**
 * This computer's memory, cores and graphics card. The slow part is asked once and kept — and two
 * screens opening at the same moment share the one question rather than each starting a program.
 */
export async function readHardware(options: { refresh?: boolean } = {}): Promise<Hardware> {
  if (remembered && !options.refresh) return remembered;
  if (asking && !options.refresh) return asking;
  asking = (async () => {
    const graphics = await askGraphics();
    return (remembered = describeHardware({ totalMemoryBytes: totalmem(), cores: cpus().length || 1, graphics }));
  })().finally(() => { asking = null; });
  return asking;
}
/** Forgets the remembered graphics card, so the next read asks the computer again. Used by tests. */
export function forgetHardware(): void {
  remembered = null;
  asking = null;
}
/** Adds the plain-language summary to raw numbers. Pure, so a test can hand it any computer. */
export function describeHardware(input: Omit<Hardware, "summary">): Hardware {
  const card = !input.graphics
    ? "no separate graphics card found"
    : input.graphics.sharedMemory
      ? `${input.graphics.name} graphics, which share that memory`
      : `${input.graphics.name}${input.graphics.memoryBytes ? ` (${gb(input.graphics.memoryBytes)} GB)` : ""}`;
  return { ...input, summary: `${gb(input.totalMemoryBytes)} GB memory, ${input.cores} processor cores, ${card}` };
}

export type LocalSize = "small" | "medium" | "large";
export interface LocalRecommendation {
  size: LocalSize;
  /** The name to type into Ollama, for example "llama3.2:3b". */
  model: string;
  /** Roughly how much space the download takes, in bytes. */
  downloadBytes: number;
  /** Roughly how much memory it needs free while it answers, in bytes. */
  needsMemoryBytes: number;
  /** True when this computer has room for it. */
  fits: boolean;
  /** What to expect, in plain words. */
  expectation: string;
  /** Why it was or was not suggested for this computer. */
  note: string;
}

/** The three sizes offered, smallest first, with what a person can expect from each. */
const catalogue: Omit<LocalRecommendation, "fits" | "note">[] = [
  {
    size: "small", model: "qwen2.5:3b", downloadBytes: 2 * gigabyte, needsMemoryBytes: 6 * gigabyte,
    expectation: "Fast, and good for notes, tidying text and short answers. It will get long reasoning wrong.",
  },
  {
    size: "medium", model: "qwen2.5:7b", downloadBytes: 5 * gigabyte, needsMemoryBytes: 10 * gigabyte,
    expectation: "A steady all-rounder: a few seconds a reply, sensible with everyday questions and short documents, and it uses tools reliably.",
  },
  {
    size: "large", model: "qwen2.5:14b", downloadBytes: 9 * gigabyte, needsMemoryBytes: 24 * gigabyte,
    expectation: "Slower, but much better at reasoning and longer documents. Expect to wait on a computer with no graphics card.",
  },
];

/**
 * Which local models this computer can run. A model needs its working memory free, and a graphics
 * card with enough video memory makes it comfortably faster, which the note says in plain words.
 */
export function recommendModels(hardware: Omit<Hardware, "summary">): LocalRecommendation[] {
  const vram = hardware.graphics?.memoryBytes ?? 0;
  const shared = hardware.graphics?.sharedMemory === true;
  return catalogue.map((entry) => {
    const fits = hardware.totalMemoryBytes >= entry.needsMemoryBytes;
    const onCard = vram >= entry.needsMemoryBytes / 2;
    const note = !fits
      ? `Needs about ${gb(entry.needsMemoryBytes)} GB of memory; this computer has ${gb(hardware.totalMemoryBytes)} GB, so it would crawl.`
      : shared
        ? `Fits, and the graphics share this computer's memory, so they can do most of the work and it should feel quick.`
        : onCard
          ? `Fits, and your graphics card can take most of the work, so it should feel quick.`
          : `Fits in memory. Without enough video memory it runs on the processor, so replies come a word at a time.`;
    return { ...entry, fits, note };
  });
}

/**
 * The one to suggest first, and so the one a first task runs on: the medium model (qwen2.5:7b) whenever it fits, since
 * it finishes a real first task with tools and the small one does not; the small one only when nothing bigger fits.
 * The large one is there to pick, never suggested: on most computers it answers too slowly for a first task.
 */
export function bestRecommendation(hardware: Omit<Hardware, "summary">): LocalRecommendation {
  const all = recommendModels(hardware);
  return all.find((entry) => entry.size === "medium" && entry.fits) ?? all[0]!;
}
