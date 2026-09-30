import { mkdir, lstat, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Gateway } from "./never-break/gateway.js";

const ProfileId = z.string().uuid();
const Choice = z.object({ credentials: z.literal("fresh"), history: z.literal("keep-in-original"), sharing: z.literal("none") }).strict();
const Binding = z.object({ profileId: ProfileId, choices: Choice, createdAt: z.iso.datetime() }).strict();
const Route = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("sessions") }).strict(),
  z.object({ operation: z.literal("configure-model"), settings: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ operation: z.literal("connect-model"), settings: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ operation: z.literal("read"), sessionId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("run"), sessionId: z.string().uuid().optional(), prompt: z.string().min(1).max(100_000) }).strict(),
]);

/** Separate homes and workers, not an OS sandbox: household profiles still use one OS account. */
export class ProfileGateways {
  private readonly live = new Map<string, Gateway>();
  private readonly busy = new Set<string>();
  private closing = false;
  constructor(private readonly dataDir: string) {}

  private home(profileId: string): string { return join(this.dataDir, "profile-gateways", ProfileId.parse(profileId)); }

  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink()) throw new Error("An isolated gateway home must not be a link.");
  }

  private async binding(profileId: string) {
    const home = this.home(profileId);
    await this.directory(join(this.dataDir, "profile-gateways"));
    await this.directory(home);
    const found = Binding.parse(JSON.parse(await readFile(join(home, "binding.json"), "utf8")));
    if (found.profileId !== profileId) throw new Error("Gateway profile binding does not match.");
    return found;
  }

  async view(profileId: string) {
    try {
      const binding = await this.binding(profileId);
      return { ...binding, isolation: "separate-process-and-data-home", running: this.live.get(profileId)?.health() ?? null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profileId, configured: false };
      throw error;
    }
  }

  async create(profileId: string, input: unknown, authorize: () => void = () => undefined) {
    const choices = Choice.parse(input);
    const home = this.home(profileId);
    await this.directory(join(this.dataDir, "profile-gateways"));
    await this.directory(home);
    authorize();
    await writeFile(join(home, "binding.json"), JSON.stringify({ profileId, choices, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    return this.view(profileId);
  }

  async start(profileId: string, authorize: () => void = () => undefined) {
    if (this.closing || this.busy.has(profileId)) throw new Error("Gateway lifecycle is busy; try again.");
    if (this.live.has(profileId)) return this.view(profileId);
    this.busy.add(profileId);
    try { return await this.startBound(profileId, authorize); }
    finally { this.busy.delete(profileId); }
  }

  private async startBound(profileId: string, authorize: () => void) {
    await this.binding(profileId);
    const home = this.home(profileId);
    await this.directory(join(home, "data"));
    await this.directory(join(home, "workspace"));
    // Atomic supervisor lease. A crash leaves it closed: no automatic stale-lock takeover.
    const lease = join(home, "writer.lock");
    authorize();
    await mkdir(lease, { mode: 0o700 });
    await writeFile(join(lease, "owner.json"), JSON.stringify({ pid: process.pid, profileId }), { mode: 0o600 });
    const env = isolatedEnvironment(home, profileId);
    const gateway = new Gateway({ dataDir: join(home, "data"), port: 0, version: "profile-isolation-v1",
      script: fileURLToPath(new URL("./profile-gateway-worker.js", import.meta.url)), args: [], env });
    try {
      if (this.closing) throw new Error("Branch is closing.");
      authorize();
      await gateway.start();
      if (this.closing) throw new Error("Branch is closing.");
      this.live.set(profileId, gateway);
      return this.view(profileId);
    } catch (error) {
      await gateway.stop();
      if ((gateway.health().worker as { state: string }).state !== "stopped") throw new Error("Worker exit is unconfirmed; its writer lease was retained.");
      await rm(lease, { recursive: true });
      throw error;
    }
  }

  async stop(profileId: string): Promise<void> {
    if (this.busy.has(profileId)) throw new Error("Gateway lifecycle is busy; try again.");
    const gateway = this.live.get(profileId);
    if (!gateway) return;
    this.busy.add(profileId);
    try {
      await gateway.stop();
      if ((gateway.health().worker as { state: string }).state !== "stopped") throw new Error("Worker exit is unconfirmed; its writer lease was retained.");
      this.live.delete(profileId);
      await rm(join(this.home(profileId), "writer.lock"), { recursive: true });
    } finally { this.busy.delete(profileId); }
  }

  async route(profileId: string, input: unknown, authorize: (configure: boolean) => void) {
    const route = Route.parse(input);
    const configure = route.operation === "configure-model" || route.operation === "connect-model";
    authorize(configure);
    await this.binding(profileId);
    const gateway = this.live.get(profileId);
    if (!gateway || gateway.health().ok !== true) throw new Error("This profile's isolated gateway is not ready.");
    const tokenPath = join(this.home(profileId), "data", "session-token");
    if ((await lstat(tokenPath)).isSymbolicLink()) throw new Error("Gateway key must not be a link.");
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Gateway key is not ready.");
    const call = async (path: string, body?: unknown) => {
      authorize(configure);
      if (this.live.get(profileId) !== gateway || this.busy.has(profileId)) throw new Error("Gateway changed; retry.");
      const response = await fetch(`${gateway.url}${path}`, { method: body ? "POST" : "GET", redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Isolated gateway refused the request (${response.status}).`);
      return response.json() as Promise<unknown>;
    };
    // No fallback to the original Store. Existing sessions must resolve inside this exact worker.
    if ("sessionId" in route && route.sessionId) await call(`/api/sessions/${route.sessionId}`);
    const result = route.operation === "sessions" ? await call("/api/sessions")
      : route.operation === "configure-model" ? await call("/api/models", route.settings)
      : route.operation === "connect-model" ? await call("/api/connections/from-preset", route.settings)
      : route.operation === "read" ? await call(`/api/sessions/${route.sessionId}`)
      : await call("/api/run", { prompt: route.prompt, ...(route.sessionId ? { sessionId: route.sessionId } : {}) });
    authorize(configure);
    return { profileId, isolated: true, result };
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}

function isolatedEnvironment(home: string, profileId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "TZ"])
    if (process.env[key]) env[key] = process.env[key];
  // No parent PATH, model keys, OAuth tokens, integration file, device broker or shared HOME.
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "config"), LOCALAPPDATA: join(home, "local"),
    TMP: join(home, "tmp"), TEMP: join(home, "tmp"), BRANCH_PROFILE_GATEWAY: profileId,
    BRANCH_PROFILE_WORKSPACE: join(home, "workspace") });
  return env;
}
