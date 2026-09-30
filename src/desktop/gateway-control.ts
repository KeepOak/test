import { createServer, connect, type Socket } from "node:net";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Link } from "./engine-link.js";
import { writeAtomic } from "../never-break/gateway-config.js";

const shape = z.object({ pid: z.number().int().positive(), address: z.string().min(1).max(4096), key: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const packet = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("call"), id: z.number().int().nonnegative(), method: z.string().max(40), args: z.unknown().optional() }).strict(),
  z.object({ kind: z.literal("reply"), id: z.number().int().nonnegative(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(2000).optional() }).strict(),
]);
const challenge = z.object({ hello: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const answer = z.object({ proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type ControlRole = "broker" | "shell";
const descriptor = (dataDir: string, role: ControlRole): string =>
  join(dataDir, "desktop-control", role === "shell" ? "shell-authority.json" : "authority.json");
const proof = (key: string, side: string, nonce: string): string => createHmac("sha256", key).update(`${side}:${nonce}`).digest("hex");
const matches = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
type Handlers = Record<string, (args: unknown) => unknown>;

/** Bounded JSON lines on a local named pipe/socket, with no HTTP route or renderer access. */
function lines(socket: Socket, received: (message: unknown) => void): (value: unknown) => void {
  let buffer = "";
  socket.setEncoding("utf8"); socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { received(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
  });
  return (value) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
}

function channel(socket: Socket, send: (value: unknown) => void, handlers: Handlers): Link {
  const link = new Link(send);
  for (const [name, handler] of Object.entries(handlers)) link.handle(name, handler);
  socket.once("close", () => link.close("The desktop broker connection ended."));
  return link;
}

function accept(socket: Socket, key: string, handlers: Handlers, ready: (link: Link) => void): void {
  const nonce = randomBytes(32).toString("hex"); let link: Link | null = null;
  const late = setTimeout(() => socket.destroy(), 5000); late.unref();
  socket.once("close", () => clearTimeout(late));
  const send = lines(socket, (message) => {
    if (link) { link.receive(packet.parse(message)); return; }
    const auth = answer.parse(message);
    if (!matches(auth.proof, proof(key, "shell", nonce))) { socket.destroy(); return; }
    clearTimeout(late); send({ proof: proof(key, "broker", nonce) });
    link = channel(socket, send, handlers); ready(link);
  });
  send({ hello: nonce });
}

export interface DesktopControlHost {
  close(): Promise<void>;
  current(): Link | null;
}

/** Only trusted main processes that can read this data folder can prove either side of the private channel. */
export async function serveDesktopControl(dataDir: string, handlers: Handlers, role: ControlRole = "broker"): Promise<DesktopControlHost> {
  const suffix = randomBytes(16).toString("hex"), key = randomBytes(32).toString("hex");
  const address = process.platform === "win32" ? `\\\\.\\pipe\\branch-desktop-${suffix}` : join(tmpdir(), `branch-desktop-${suffix}.sock`);
  const sockets = new Set<Socket>(); let current: Link | null = null;
  const server = createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    accept(socket, key, handlers, (link) => { current = link; socket.once("close", () => { if (current === link) current = null; }); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, () => { server.off("error", reject); resolve(); }); });
  try { await writeAtomic(descriptor(dataDir, role), JSON.stringify({ pid: process.pid, address, key })); }
  catch (error) { server.close(); throw error; }
  return { current: () => current, close: async () => {
    current = null; for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let owned = false;
    try { owned = shape.parse(JSON.parse(await readFile(descriptor(dataDir, role), "utf8"))).key === key; } catch { /* preserve unknown or replacement authority */ }
    if (owned) await rm(descriptor(dataDir, role), { force: true });
    if (process.platform !== "win32") await rm(address, { force: true });
  } };
}

export interface DesktopControlClient { pid: number; link: Link; close(): void }
export async function connectDesktopControl(dataDir: string, handlers: Handlers = {}, role: ControlRole = "broker"): Promise<DesktopControlClient> {
  const saved = shape.parse(JSON.parse(await readFile(descriptor(dataDir, role), "utf8")));
  process.kill(saved.pid, 0); // Refuse stale descriptors before connecting to their address.
  const socket = connect(saved.address);
  return new Promise((resolve, reject) => {
    let nonce: string | null = null, link: Link | null = null;
    const late = setTimeout(() => { socket.destroy(); reject(new Error("The background desktop broker did not prove itself.")); }, 5000); late.unref();
    socket.once("error", (error) => { clearTimeout(late); reject(error); });
    socket.once("close", () => { clearTimeout(late); if (!link) reject(new Error("The background desktop broker refused the private connection.")); });
    const send = lines(socket, (message) => {
      if (link) { link.receive(packet.parse(message)); return; }
      if (!nonce) { nonce = challenge.parse(message).hello; send({ proof: proof(saved.key, "shell", nonce) }); return; }
      if (!matches(answer.parse(message).proof, proof(saved.key, "broker", nonce))) { socket.destroy(); return; }
      clearTimeout(late); link = channel(socket, send, handlers);
      resolve({ pid: saved.pid, link, close: () => { link?.close(); socket.destroy(); } });
    });
  });
}
