import { homedir, tmpdir } from "node:os";
import { posix } from "node:path";
import type { WallNetwork } from "./sandbox.js";
import { protectedWorkspaceNames, secretHomePlaces } from "./sandbox-seatbelt.js";

// Bubblewrap only runs on Linux, so its arguments are POSIX paths on whatever computer builds them.
const { join } = posix;

/**
 * The Linux wall: bubblewrap, when this computer already has it. Branch never ships or installs it
 * (it is LGPL); it looks for the system's `bwrap` and says plainly what to do when it is missing or
 * when the system has switched off the private namespaces it relies on.
 *
 * The whole disk is visible read-only, the workspace and the temporary folder are writable, `.git`,
 * `.branch` and `.agents` are put back read-only, places where keys live are hidden behind empty
 * folders, and the program gets its own view of running programs and a fresh `/proc`. With the
 * network off it also gets a network of its own with nothing in it, and a small filter (written
 * here, in the classic BPF form the kernel reads) stops it opening anything but local sockets.
 * Tracing other programs is refused either way.
 *
 * The argument list follows Codex's `linux-sandbox/src/bwrap.rs` and Gemini CLI's
 * `packages/core/src/sandbox/linux/bwrapArgsBuilder.ts`; the filter's byte layout follows Gemini
 * CLI's `LinuxSandboxManager.ts` (both Apache-2.0, see THIRD_PARTY_NOTICES.md).
 */

export const bwrapMissing = "The wall around programs on Linux needs bubblewrap, which is not installed on this computer. Install the \"bubblewrap\" package with your system's package manager, or switch the wall off in Settings.";
export const namespacesOff = "The wall around programs on Linux needs private namespaces, which this computer has switched off for ordinary users. Your administrator can turn on unprivileged user namespaces, or switch the wall off in Settings.";

export interface BwrapInput {
  workspace: string;
  network: WallNetwork;
  /** A folder, bound writable, that holds Branch's door into the network (a local socket). */
  doorDir?: string | undefined;
  extraWrites?: readonly string[];
  unreadable?: readonly string[];
  home?: string;
  temp?: string;
  dataDir?: string | undefined;
  /** Places a program may read but never change (Branch's own program and updater). */
  readOnly?: readonly string[];
  /** The owner's user number, for the per-user runtime folder (`/run/user/<uid>`) hidden below. */
  uid?: number | undefined;
  /** The file descriptor the filter is read from; the starter opens it. */
  seccompFd?: number;
  /** What is at a path to be hidden: a folder, a file, or nothing (then nothing needs hiding). */
  kindOf?: (path: string) => "dir" | "file" | null;
  /**
   * Folders covered by an empty one before the workspace is bound, so only the workspace shows
   * inside them, then made read-only. Under WSL: `/mnt` (the Windows drives) and `/run/WSL`.
   */
  covered?: readonly string[];
  /** The name the system uses for a place, links followed; a hidden file is covered there, where bwrap can reach it. */
  canonical?: (path: string) => string;
}

/** The arguments for `bwrap`, ending with `--` and the program. */
export function bwrapArgs(input: BwrapInput, command: { executable: string; args: readonly string[] }): string[] {
  const home = input.home ?? homedir(), temp = input.temp ?? tmpdir();
  const args = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  // With no network, or only Branch's door, the program gets a network of its own with nothing in it.
  if (input.network !== "open") args.push("--unshare-net");
  args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc");
  // A private, empty temporary folder: the real one holds other programs' sockets (the ssh agent,
  // the screen, other runs' doors), and a socket file can be used even on a read-only disk.
  // Mount every empty parent before its children: TMPDIR can be inside a covered home, or the
  // home itself can be under /tmp. Mounting a parent later would erase an earlier child mount.
  const covered = [...new Set(input.covered ?? [])];
  const empty = [...new Set(["/tmp", temp, ...covered])].sort((a, b) => a.length - b.length);
  for (const path of empty) args.push("--tmpfs", path);
  args.push("--bind", input.workspace, input.workspace);
  if (input.doorDir) args.push("--bind", input.doorDir, input.doorDir);
  for (const path of input.extraWrites ?? []) args.push("--bind-try", path, path);
  for (const path of [...protectedWorkspaceNames.map((name) => join(input.workspace, name)), ...(input.readOnly ?? [])])
    args.push("--ro-bind-try", path, path);
  // Only the folder itself turns read-only; the workspace bound inside it stays writable.
  for (const path of covered) args.push("--remount-ro", path);
  const hidden = [...secretHomePlaces.map((place) => join(home, place)), ...(input.unreadable ?? []),
    ...(input.dataDir ? [input.dataDir] : []), ...socketPlaces(input.uid)];
  // An empty read-only folder over each folder, an empty file over each file; a missing one needs
  // nothing hidden (and bwrap could not make a place to hide it on a read-only disk anyway).
  const kindOf = input.kindOf ?? (() => "dir" as const), canonical = input.canonical ?? ((path: string) => path);
  const files = new Set<string>();
  for (const path of hidden) {
    const kind = kindOf(path);
    if (kind === "dir") args.push("--tmpfs", path, "--remount-ro", path);
    // A file reached through a link (`/var/run` is `/run`, or a socket that is itself a link) is covered where it really is.
    else if (kind === "file" && !files.has(canonical(path))) { files.add(canonical(path)); args.push("--ro-bind", "/dev/null", canonical(path)); }
  }
  if (input.seccompFd !== undefined) args.push("--seccomp", String(input.seccompFd));
  args.push("--chdir", input.workspace, "--", command.executable, ...command.args);
  return args;
}

/**
 * Where programs that act outside the wall listen: the desktop session's message bus and keyring
 * (which can start programs), and Docker. Covered like a hidden place, so nothing can be sent to them.
 */
function socketPlaces(uid: number | undefined): string[] {
  return [...(uid !== undefined ? [`/run/user/${uid}`] : []), "/run/docker.sock", "/var/run/docker.sock", "/run/podman"];
}

// ------------------------------------------------------------------ the filter

const arches: Record<string, { audit: number; ptrace: number; socket: number; x32: boolean }> = {
  x64: { audit: 0xc000003e, ptrace: 101, socket: 41, x32: true },
  arm64: { audit: 0xc00000b7, ptrace: 117, socket: 198, x32: false },
};
const LOAD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06;
const KILL = 0x80000000, ERRNO_EPERM = 0x00050000 | 1, ALLOW = 0x7fff0000, AF_UNIX = 1, AF_VSOCK = 40;
interface Op { code: number; k: number; jt?: string; jf?: string; label?: string }

/** Lays out the program: jumps name a label and become forward offsets here. */
function assemble(ops: Op[]): Buffer {
  const at = new Map(ops.flatMap((op, index) => (op.label ? [[op.label, index] as const] : [])));
  const offset = (from: number, label?: string): number => {
    if (!label) return 0;
    const to = at.get(label);
    if (to === undefined || to <= from) throw new Error(`Filter jump to ${label} is not forward`);
    return to - from - 1;
  };
  const out = Buffer.alloc(ops.length * 8);
  ops.forEach((op, index) => {
    out.writeUInt16LE(op.code, index * 8);
    out.writeUInt8(offset(index, op.jt), index * 8 + 2);
    out.writeUInt8(offset(index, op.jf), index * 8 + 3);
    out.writeUInt32LE(op.k >>> 0, index * 8 + 4);
  });
  return out;
}

/**
 * The filter a program behind the wall runs under. It refuses tracing other programs always and,
 * with no network, opening any socket that is not a local one; a link to a virtual machine's host
 * is refused either way. A call made for another processor
 * type ends the program, so the filter cannot be sidestepped that way.
 */
export function seccompFilter(options: { network: WallNetwork; arch?: string;
  /**
   * selfdev: a held command, which always has a network of its own with nothing in it but itself (bwrap's
   * `--unshare-net`), may open internet sockets there, so a test can start and reach its own local server.
   */
  ownNetwork?: boolean }): Buffer {
  const arch = arches[options.arch ?? process.arch];
  if (!arch) throw new Error(`The wall cannot filter system calls on this kind of processor (${options.arch ?? process.arch}). Switch the wall off in Settings.`);
  const ops: Op[] = [
    { code: LOAD, k: 4 },
    { code: JEQ, k: arch.audit, jt: "native", jf: "kill" },
    { code: LOAD, k: 0, label: "native" },
    ...(arch.x32 ? [{ code: JGE, k: 0x40000000, jt: "kill", jf: "plain" } as Op] : []),
    { code: JEQ, k: arch.ptrace, jt: "refuse", jf: "socket", ...(arch.x32 ? { label: "plain" } : {}) },
    { code: JEQ, k: arch.socket, jt: "family", jf: "allow", label: "socket" },
    { code: LOAD, k: 16, label: "family" },
    { code: JEQ, k: AF_UNIX, jt: "allow", jf: "vsock" },
    // A virtual machine's link to its host (WSL's way back to Windows) is never the program's to open, whatever the network.
    { code: JEQ, k: AF_VSOCK, jt: "refuse", jf: options.network === "none" && !options.ownNetwork ? "refuse" : "allow", label: "vsock" },
    { code: RET, k: ERRNO_EPERM, label: "refuse" },
    { code: RET, k: ALLOW, label: "allow" },
    { code: RET, k: KILL, label: "kill" },
  ];
  return assemble(ops);
}

/**
 * How the filter reaches bwrap: a fixed shell line opens the filter file on descriptor 9 and
 * replaces itself with bwrap. The file and every argument arrive as `$1` and `$@`, never inside
 * the line.
 */
export const seccompStarterScript = 'f="$1"; shift; exec "$@" 9< "$f"';
export function withSeccomp(bwrap: string, filterPath: string, args: readonly string[]): { executable: string; args: string[] } {
  return { executable: "/bin/sh", args: ["-c", seccompStarterScript, "branch-wall", filterPath, bwrap, ...args] };
}

// ------------------------------------------------------------------ the door inside

/**
 * With the network limited to Branch's door, the program has a network of its own with nothing in
 * it, so the door is a local socket in a folder both sides can see. This small Node program runs
 * inside the wall: it listens on the program's own `127.0.0.1:<port>`, passes each connection to the
 * socket, starts the real program and ends with its exit code. It is fixed text; the socket, the
 * port and the program arrive as arguments.
 */
export const doorBridgeSource = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const marker = args.indexOf("--");
if (marker < 2 || marker % 2 !== 0) process.exit(2);
const doors = [];
for (let at = 0; at < marker; at += 2) doors.push({ socketPath: args[at], port: Number(args[at + 1]) });
const [program, ...rest] = args.slice(marker + 1);
const servers = doors.map(({ socketPath }) => net.createServer((inside) => {
  const outside = net.connect(socketPath);
  inside.pipe(outside).pipe(inside);
  const end = () => { inside.destroy(); outside.destroy(); };
  inside.on("error", end); outside.on("error", end);
}));
let waiting = servers.length;
servers.forEach((server, index) => server.listen(doors[index].port, "127.0.0.1", () => {
  if (--waiting) return;
  const child = spawn(program, rest, { stdio: "inherit" });
  const done = (code) => { for (const each of servers) each.close(); process.exit(code); };
  child.on("exit", (code, signal) => done(code ?? (signal ? 128 : 1)));
  child.on("error", () => done(127));
}));
`;

/** Ports the door answers on inside the wall; the program has a network of its own, so they are fixed. */
export const insideDoorPorts = { http: 3128, socks: 1080 } as const;

/** Whether bwrap is here and namespaces work, asked of the system by the given runner. */
export async function bwrapAvailability(
  probe: (executable: string, args: string[]) => Promise<{ code: number | null; stderr: string; missing: boolean }>,
  locate: () => Promise<string | null>,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const path = await locate();
  if (!path) return { ok: false, reason: bwrapMissing };
  const answer = await probe(path, ["--unshare-user", "--ro-bind", "/", "/", "--", "/bin/true"]);
  if (answer.missing) return { ok: false, reason: bwrapMissing };
  if (answer.code !== 0) return { ok: false, reason: namespacesOff };
  return { ok: true, path };
}
