import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store.js';
import { lockdownActive } from '../lockdown.js';
import { LinuxDesktopSandbox, LinuxDesktopSchema, readLinuxDesktop, saveLinuxDesktop, type SharedDesktopAction } from './linux-desktop.js';

const recordKey = 'private-desktop-records';
const Snapshot = z.object({ id: z.string().uuid(), image: z.string().regex(/^branch-agent-snapshot-[a-f0-9]{32}-[a-f0-9]{32}$/), at: z.iso.datetime() }).strict();
const Record = z.object({ agent: z.string().min(1).max(100), snapshots: z.array(Snapshot).max(3) }).strict();
const Records = z.array(Record).max(16);
const scopeOf = (owner: string, agent: string): string => createHash('sha256').update(JSON.stringify([owner, agent])).digest('hex').slice(0, 32);
const configKey = (owner: string, agent: string): string => `private-desktop-${scopeOf(owner, agent)}`;

/** Named local desktops reuse the shared desktop's confinement, VNC transport and take-over fences.
 * Snapshot images contain private desktop files; they stay local and are never exported or pulled. */
export class PrivateDesktops {
  private readonly desktops = new Map<string, LinuxDesktopSandbox>();
  private readonly work = new Map<string, Promise<unknown>>();
  private readonly cancellations = new Map<string, number>();
  private closed = false;
  constructor(private readonly store: Store, private readonly knownAgent: (agent: string) => boolean) {}

  private records(owner: string): z.infer<typeof Records> {
    const saved = Records.safeParse(this.store.get('settings', owner, recordKey)?.data?.records ?? []);
    if (!saved.success) throw new Error('Private desktop records are unreadable; no lifecycle action was taken.');
    return saved.data;
  }
  private persist(owner: string, records: z.infer<typeof Records>): void { this.store.save('settings', owner, recordKey, { records: Records.parse(records) }); }
  private requireRecord(owner: string, agent: string): void {
    this.store.profiles.requireOwner('Private computers');
    if (this.closed || lockdownActive(this.store, owner)) throw new Error('Private desktops are unavailable while Branch is closing or Lockdown is on.');
    if (!this.knownAgent(agent)) throw new Error('Choose an existing Trunk for this private computer.');
    if (!this.records(owner).some(record => record.agent === agent)) throw new Error('The owner has not enabled a private computer for this Trunk.');
  }
  private require(owner: string, agent: string): void {
    this.requireRecord(owner, agent);
    if (readLinuxDesktop(this.store, owner, configKey(owner, agent)).mode === 'off') throw new Error('This private computer is switched off.');
  }
  private desktop(owner: string, agent: string): LinuxDesktopSandbox {
    const scope = scopeOf(owner, agent);
    let desktop = this.desktops.get(scope);
    if (!desktop) {
      desktop = new LinuxDesktopSandbox(this.store, {settingsKey: configKey(owner, agent), containerLabel: `branch.private-desktop=${scope}`,
        banner: {show: async () => {}, hide: async () => {}}});
      this.desktops.set(scope, desktop);
    }
    return desktop;
  }
  private async serial<T>(owner: string, agent: string, job: (still: () => void) => Promise<T>): Promise<T> {
    const scope = scopeOf(owner, agent), previous = this.work.get(scope), epoch = this.cancellations.get(scope) ?? 0;
    const still = () => { if ((this.cancellations.get(scope) ?? 0) !== epoch || this.closed) throw new Error('This private computer operation was stopped.'); };
    const pending = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => { still(); return job(still); });
    this.work.set(scope, pending);
    try { return await pending; } finally { if (this.work.get(scope) === pending) this.work.delete(scope); }
  }
  async view(owner: string): Promise<unknown[]> {
    return Promise.all(this.records(owner).map(async record => ({...record, ...(await this.desktop(owner, record.agent).status(owner))})));
  }
  async create(owner: string, agent: string, image: string): Promise<unknown> {
    return this.serial(owner, agent, async () => {
      this.store.profiles.requireOwner('Private computers');
      if (!this.knownAgent(agent) || lockdownActive(this.store, owner) || this.closed) throw new Error('Choose an existing Trunk with Lockdown off.');
      const settings = LinuxDesktopSchema.parse({mode: 'on', image}), records = this.records(owner);
      if (records.some(record => record.agent === agent) && this.desktop(owner, agent).status(owner).running)
        throw new Error('Stop this private computer before changing its image or recreating it.');
      if (!records.some(record => record.agent === agent)) { records.push({agent, snapshots: []}); this.persist(owner, records); }
      saveLinuxDesktop(this.store, owner, settings, configKey(owner, agent));
      await this.desktop(owner, agent).start(owner);
      return this.desktop(owner, agent).status(owner);
    });
  }
  async start(owner: string, agent: string, ownerAction = false): Promise<unknown> {
    return this.serial(owner, agent, async () => {
      this.store.profiles.requireOwner('Private computers');
      if (ownerAction && this.knownAgent(agent) && this.records(owner).some(record => record.agent === agent) && !lockdownActive(this.store, owner) && !this.closed)
        saveLinuxDesktop(this.store, owner, {mode: 'on'}, configKey(owner, agent));
      this.require(owner, agent); await this.desktop(owner, agent).start(owner); return this.desktop(owner, agent).status(owner);
    });
  }
  async act(owner: string, agent: string, action: SharedDesktopAction): Promise<unknown> {
    return this.serial(owner, agent, async () => { this.require(owner, agent); return this.desktop(owner, agent).act(owner, action); });
  }
  async stop(owner: string, agent: string, ownerAction = false): Promise<void> {
    // End immediately cancels starts/actions; it does not wait behind a long lifecycle operation.
    if (!this.records(owner).some(record => record.agent === agent)) throw new Error('No private computer is enabled for that Trunk.');
    if (ownerAction) {
      this.store.profiles.requireOwner('Private computers');
      const scope = scopeOf(owner, agent); this.cancellations.set(scope, (this.cancellations.get(scope) ?? 0) + 1);
      await this.desktop(owner, agent).saveSettings(owner, {mode: 'off'});
    }
    else await this.desktop(owner, agent).stop(owner);
  }
  async snapshot(owner: string, agent: string): Promise<unknown> {
    return this.serial(owner, agent, async (still) => {
      this.require(owner, agent);
      const records = this.records(owner), record = records.find(entry => entry.agent === agent)!;
      if (record.snapshots.length >= 3) throw new Error('This private computer already has three snapshots. Remove one before taking another.');
      const id = randomUUID(), scope = scopeOf(owner, agent), image = `branch-agent-snapshot-${scope}-${id.replaceAll('-', '')}`;
      try {
        await this.desktop(owner, agent).snapshot(owner, image, scope); still(); this.require(owner, agent);
        const snapshot = {id, image, at: new Date().toISOString()}, latest = this.records(owner);
        latest.find(entry => entry.agent === agent)!.snapshots.push(snapshot); this.persist(owner, latest);
        return {snapshot: {id, at: snapshot.at}, control: 'user', note: 'Filesystem snapshot saved locally. Processes are not preserved. Hand back this desktop before the Trunk continues.'};
      }
      catch (error) {
        await this.checkImage(owner, agent, image).then(() => this.desktop(owner, agent).runner('docker', ['image', 'rm', image], 15_000)).catch(() => undefined);
        throw error;
      }
    });
  }
  private async checkImage(owner: string, agent: string, image: string): Promise<void> {
    const scope = scopeOf(owner, agent);
    if (!image.startsWith(`branch-agent-snapshot-${scope}-`)) throw new Error('That snapshot belongs to another desktop.');
    const label = await this.desktop(owner, agent).runner('docker', ['image', 'inspect', '--format', '{{ index .Config.Labels "branch.private-snapshot" }}', image], 15_000);
    if (label.trim() !== scope) throw new Error('The snapshot image does not belong to this desktop.');
  }
  async restore(owner: string, agent: string, id: string): Promise<unknown> {
    return this.serial(owner, agent, async (still) => {
      this.requireRecord(owner, agent);
      const snapshot = this.records(owner).find(record => record.agent === agent)?.snapshots.find(entry => entry.id === id);
      if (!snapshot) throw new Error('No snapshot with that ID belongs to this desktop.');
      await this.checkImage(owner, agent, snapshot.image); still(); this.requireRecord(owner, agent);
      await this.desktop(owner, agent).end(owner); still(); this.requireRecord(owner, agent);
      saveLinuxDesktop(this.store, owner, {mode: 'on', image: snapshot.image}, configKey(owner, agent));
      await this.desktop(owner, agent).start(owner);
      return this.desktop(owner, agent).status(owner);
    });
  }
  async removeSnapshot(owner: string, agent: string, id: string): Promise<void> {
    return this.serial(owner, agent, async () => {
      this.requireRecord(owner, agent);
      const records = this.records(owner), record = records.find(entry => entry.agent === agent)!, snapshot = record.snapshots.find(entry => entry.id === id);
      if (!snapshot) throw new Error('No snapshot with that ID belongs to this desktop.');
      await this.checkImage(owner, agent, snapshot.image); this.requireRecord(owner, agent);
      await this.desktop(owner, agent).runner('docker', ['image', 'rm', snapshot.image], 15_000);
      const latest = this.records(owner), current = latest.find(entry => entry.agent === agent)!;
      current.snapshots = current.snapshots.filter(entry => entry.id !== id); this.persist(owner, latest);
    });
  }
  async control(owner: string, agent: string, operation: 'takeOver' | 'handBack' | 'viewerInfo'): Promise<unknown> {
    this.require(owner, agent); return this.desktop(owner, agent)[operation](owner);
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.desktops.values()].map(desktop => desktop.close())); }
}
