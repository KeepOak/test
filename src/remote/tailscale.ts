import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * Reaching Branch from a phone uses Tailscale, a private network the owner already runs on both
 * devices. Branch never opens itself to the internet or to the local coffee-shop network: it listens
 * only on the private address Tailscale gives this computer, and only while the switch is on.
 */
const statusSchema = z.object({
  BackendState: z.string().optional(),
  Self: z.object({
    HostName: z.string().optional(),
    DNSName: z.string().optional(),
    TailscaleIPs: z.array(z.string()).optional(),
  }).optional(),
}).loose();

export interface TailnetAddress {
  present: boolean;
  running: boolean;
  /** The private address of this computer inside the tailnet, or null. */
  address: string | null;
  /** The name other devices can use, such as "desk-pc.tail1234.ts.net". */
  hostname: string | null;
  message: string;
}
export type ProbeTailscale = () => Promise<TailnetAddress>;

/** Tailscale hands out addresses in 100.64.0.0/10 only; anything else is refused on purpose. */
export function isTailnetAddress(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export function readStatus(json: string): TailnetAddress {
  const parsed = statusSchema.safeParse(JSON.parse(json));
  if (!parsed.success) return absent("Tailscale answered in a way this version does not understand.");
  const self = parsed.data.Self ?? {};
  const running = (parsed.data.BackendState ?? "") === "Running";
  const address = (self.TailscaleIPs ?? []).find(isTailnetAddress) ?? null;
  const hostname = (self.DNSName ?? "").replace(/\.$/, "") || self.HostName || null;
  if (!running) return { present: true, running: false, address: null, hostname, message: "Tailscale is installed but not signed in. Open Tailscale and connect, then try again." };
  if (!address) return { present: true, running: true, address: null, hostname, message: "Tailscale is connected but has not given this computer a private address yet." };
  return { present: true, running: true, address, hostname, message: `Tailscale is connected as ${hostname ?? address}.` };
}

/**
 * find-computers: the owner's other computers on the tailnet that Tailscale says are online, each with its private
 * address. Only what `tailscale status --json` reports under Peer; at most `peerLimit`, so a large tailnet cannot turn
 * one look into hundreds of probes.
 */
export interface TailnetPeer { hostName: string; os: string; address: string }
export const peerLimit = 32;
const peerSchema = z.object({
  HostName: z.string().max(200).optional(),
  DNSName: z.string().max(300).optional(),
  OS: z.string().max(40).optional(),
  TailscaleIPs: z.array(z.string().max(64)).max(16).optional(),
  Online: z.boolean().optional(),
}).loose();
const peersSchema = z.object({ BackendState: z.string().optional(), Peer: z.record(z.string(), z.unknown()).optional() }).loose();

export function readPeers(json: string): TailnetPeer[] {
  const parsed = peersSchema.safeParse(JSON.parse(json));
  if (!parsed.success || parsed.data.BackendState !== "Running") return [];
  const peers: TailnetPeer[] = [];
  for (const value of Object.values(parsed.data.Peer ?? {})) {
    const peer = peerSchema.safeParse(value);
    if (!peer.success || peer.data.Online !== true) continue;
    const address = (peer.data.TailscaleIPs ?? []).find(isTailnetAddress);
    if (!address) continue;
    const hostName = peer.data.HostName || (peer.data.DNSName ?? "").split(".")[0] || address;
    peers.push({ hostName, os: peer.data.OS ?? "", address });
    if (peers.length >= peerLimit) break;
  }
  return peers;
}
const absent = (message: string): TailnetAddress =>
  ({ present: false, running: false, address: null, hostname: null, message });
const notInstalled = "Tailscale is not installed on this computer. Install it on this computer and on your phone, sign both in, then switch this on again.";
const noAnswer = "Tailscale did not answer in time. Open Tailscale and check that it is connected, then try again.";

/**
 * How long Branch waits for Tailscale in all, across every place its program is looked for.
 * `tailscale status` answers from the Tailscale service on this computer in well under a second, so
 * three seconds leaves a busy computer room to spare while never holding up for long what waits on
 * the answer, such as Branch's own start before its door listens. No answer in time confirms nothing.
 */
export const tailscaleBudgetMs = 3000;

/**
 * Where Tailscale's program is looked for, in order: the places Tailscale installs it on this system
 * first, and the bare name, which is searched for on PATH, last. On a Mac the app's own program comes
 * first; with only the app installed it is the one there is.
 */
export function tailscaleCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin")
    return [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale",
      "tailscale",
    ];
  if (platform === "win32")
    return [
      `${programFiles(env["ProgramFiles"], "C:\\Program Files")}\\Tailscale\\tailscale.exe`,
      `${programFiles(env["ProgramFiles(x86)"], "C:\\Program Files (x86)")}\\Tailscale IPN\\tailscale.exe`,
      "tailscale",
    ];
  return ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale", "tailscale"];
}

/** A Program Files folder this computer names, when that is a whole path on a drive; the usual one otherwise. */
const programFiles = (named: string | undefined, usual: string): string =>
  named && /^[a-z]:\\/i.test(named) ? named.replace(/\\+$/, "") : usual;

/**
 * Runs one program and gives back what it printed. When `stop` fires, the program is killed outright
 * with SIGKILL, which it cannot ignore, and its output is let go of, so nothing it left running can
 * keep that output open. (`execFile` does not use its `killSignal` for an abort signal, so the kill
 * is done here; `killSignal` covers `execFile`'s own kill, when the output grows past its limit.)
 */
function run(file: string, args: string[], stop: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, maxBuffer: 1048576, killSignal: "SIGKILL" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
    stop.addEventListener("abort", () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill("SIGKILL");
    }, { once: true });
  });
}

/** What the first program found printed for `status --json`; once `stop` has fired, no further place is tried. */
async function firstStatus(places: readonly string[], stop: AbortSignal): Promise<string | null> {
  for (const file of places) {
    if (stop.aborted) break;
    try {
      const printed = await run(file, ["status", "--json"], stop);
      JSON.parse(printed); // a program that printed something else is passed over, as before
      return printed;
    } catch { continue; }
  }
  return null;
}

/**
 * find-computers: `tailscale status --json` as printed, run the one safe way (fixed arguments, hidden, killed when
 * `budgetMs` runs out), or null when no program answered in time. Both the address probe below and the list of the
 * owner's other computers read this.
 */
export type TailscaleStatus = () => Promise<string | null>;
export function makeTailscaleStatus(
  options: { candidates?: readonly string[]; budgetMs?: number } = {},
): TailscaleStatus {
  return () => new Promise<string | null>((resolve) => {
    const stop = new AbortController();
    const deadline = setTimeout(() => { resolve(null); stop.abort(); }, options.budgetMs ?? tailscaleBudgetMs);
    const answered = (answer: string | null): void => { clearTimeout(deadline); resolve(answer); };
    const places = options.candidates ?? tailscaleCandidates(process.platform, process.env);
    firstStatus(places, stop.signal).then(answered, () => answered(null));
  });
}

/**
 * A way to ask Tailscale where this computer sits on the private network: the places in `candidates`
 * are tried in order until a program there answers, all within `budgetMs`. When that time is up, the
 * program still running is killed, nothing further is tried, and the answer is that nothing was
 * confirmed. Anything arriving after that changes nothing, as the answer has already been given.
 */
export function makeProbeTailscale(
  options: { candidates?: readonly string[]; budgetMs?: number } = {},
): ProbeTailscale {
  const places = options.candidates ?? tailscaleCandidates(process.platform, process.env);
  return () => new Promise<TailnetAddress>((resolve) => {
    const stop = new AbortController();
    let settled = false;
    const deadline = setTimeout(() => { settled = true; resolve(absent(noAnswer)); stop.abort(); }, options.budgetMs ?? tailscaleBudgetMs);
    firstStatus(places, stop.signal).then((json) => {
      if (settled) return;
      clearTimeout(deadline);
      if (json === null) { resolve(absent(notInstalled)); return; }
      try { resolve(readStatus(json)); } catch { resolve(absent(notInstalled)); }
    }, () => { clearTimeout(deadline); resolve(absent(notInstalled)); });
  });
}

/** Asks Tailscale where this computer sits on the private network. */
export const probeTailscale: ProbeTailscale = makeProbeTailscale();
