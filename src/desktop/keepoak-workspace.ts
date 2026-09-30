import { dialog, type BrowserWindow, type Session } from 'electron';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const api = 'https://api.keepoak.com/v1/customer/team';
const role = z.enum(['admin', 'operator', 'viewer']);
const email = z.string().trim().toLowerCase().email().max(254);
const member = z.object({ id: z.string().regex(/^mem_[A-Za-z0-9-]{1,76}$/), email,
  role: z.enum(['owner', 'admin', 'operator', 'viewer']), status: z.enum(['invited', 'active']),
  you: z.boolean(), since: z.string().min(1).max(80) });
const team = z.object({ organization_id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  you: z.object({ email, role: z.enum(['owner', 'admin', 'operator', 'viewer']) }),
  limit: z.number().int().min(1).max(1000), members: z.array(member).max(1000) });
const common = { organizationId: z.string().min(1).max(120), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) };
const change = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('invite'), email, role }).strict(),
  z.object({ ...common, action: z.literal('role'), memberId: member.shape.id, role }).strict(),
  z.object({ ...common, action: z.literal('remove'), memberId: member.shape.id }).strict(),
]);
type Team = z.infer<typeof team>;
type Change = z.infer<typeof change>;
type WorkspaceHooks = { session: () => Session | null; owner: () => Promise<void> };
const fingerprint = (value: Team) => createHash('sha256').update(JSON.stringify({
  organization: value.organization_id, you: value.you, limit: value.limit,
  members: [...value.members].sort((a, b) => a.id.localeCompare(b.id)),
})).digest('hex');

/** Existing product cookie session only; no bearer fallback, local role grants or shared Trunk uploads. */
export class KeepOakWorkspace {
  private busy = false;
  private reads: number[] = [];
  private writes: number[] = [];
  constructor(private readonly main: BrowserWindow, private readonly hooks: WorkspaceHooks) {}

  private async current(expected?: Session): Promise<Session> {
    await this.hooks.owner();
    const session = this.hooks.session();
    if (!session || expected && session !== expected || this.main.isDestroyed())
      throw new Error('Open and sign in to the isolated KeepOak view first.');
    return session;
  }
  private rate(write: boolean): void {
    const list = (write ? this.writes : this.reads).filter((at) => Date.now() - at < 60000);
    if (list.length >= (write ? 6 : 30)) throw new Error('KeepOak team requests are temporarily limited.');
    list.push(Date.now());
    if (write) this.writes = list; else this.reads = list;
  }
  private async request(session: Session, path = '', method = 'GET', payload?: unknown): Promise<unknown> {
    await this.current(session);
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.current(session).catch(() => controller.abort()).finally(() => { checking = false; });
    }, 500);
    timer.unref();
    try {
      const response = await session.fetch(api + path, { method, credentials: 'include', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        headers: { accept: 'application/json', origin: 'https://keepoak.com',
          ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      const value = await boundedJson(response);
      await this.current(session);
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? 'KeepOak denied this session or team role. Sign in again or ask its owner.'
        : method === 'GET' ? 'KeepOak could not read the team.' : 'KeepOak did not confirm the change. Refresh before retrying.');
      return value;
    } finally { clearInterval(timer); controller.abort(); }
  }
  private async snapshot(session: Session): Promise<Team> {
    this.rate(false);
    const value = team.parse(await this.request(session));
    if (new Set(value.members.map((item) => item.id)).size !== value.members.length
      || new Set(value.members.map((item) => item.email)).size !== value.members.length
      || value.members.filter((item) => item.you && item.email === value.you.email).length !== 1
      || value.members.some((item) => item.you && item.email !== value.you.email))
      throw new Error('KeepOak returned an inconsistent team identity.');
    return value;
  }
  async read() {
    try {
      const session = await this.current(), value = await this.snapshot(session);
      return projection(value);
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error('KeepOak returned invalid team data.');
      throw error;
    }
  }
  async update(input: unknown) {
    if (this.busy) throw new Error('A KeepOak team change is already awaiting its result.');
    const value = change.parse(input);
    this.busy = true;
    try {
      const session = await this.current(), before = await this.snapshot(session);
      const detail = review(before, value);
      const answer = await dialog.showMessageBox(this.main, { type: 'question', title: 'KeepOak team change',
        message: detail, detail: 'This changes the KeepOak computer team. Local Branch profiles and tool permissions remain separate.',
        buttons: ['Cancel', 'Confirm change'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return { cancelled: true };
      await this.current(session);
      review(await this.snapshot(session), value);
      this.rate(true);
      const path = value.action === 'invite' ? '/invitations' : `/members/${value.memberId}`;
      const result = await this.request(session, path, value.action === 'invite' ? 'POST' : value.action === 'remove' ? 'DELETE' : 'PATCH',
        value.action === 'invite' ? { email: value.email, role: value.role } : value.action === 'role' ? { role: value.role } : undefined);
      const after = await this.snapshot(session);
      verifyChange(before, after, value, result);
      return { confirmed: true, team: projection(after) };
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error('KeepOak team data or request was invalid. Refresh before retrying.');
      throw new Error(error instanceof Error ? error.message : 'KeepOak did not confirm the team change. Refresh before retrying.');
    } finally { this.busy = false; }
  }
}

function verifyChange(before: Team, after: Team, value: Change, response: unknown): void {
  const result = z.object({ organization_id: team.shape.organization_id,
    member: member.optional(), removed: member.shape.id.optional() }).parse(response);
  if (result.organization_id !== before.organization_id || after.organization_id !== before.organization_id
    || before.you.email !== after.you.email) throw new Error('The KeepOak identity changed during this request. Refresh before retrying.');
  const target = value.action === 'invite' ? after.members.find((item) => item.email === value.email)
    : after.members.find((item) => item.id === value.memberId);
  const matches = value.action === 'remove' ? !target && result.removed === value.memberId
    : !!target && target.role === value.role && result.member?.id === target.id;
  if (!matches) throw new Error('KeepOak has not confirmed the requested membership state. Refresh before retrying.');
}

function projection(value: Team) {
  return { organizationId: value.organization_id, you: value.you, members: value.members,
    seats: { used: value.members.length, total: value.limit }, fingerprint: fingerprint(value) };
}
function review(before: Team, value: Change): string {
  if (value.organizationId !== before.organization_id || value.fingerprint !== fingerprint(before))
    throw new Error('The KeepOak account or team changed. Refresh and review the new team first.');
  if (!['owner', 'admin'].includes(before.you.role)) throw new Error('KeepOak requires its owner or admin for this change.');
  if (value.action === 'invite') {
    if (before.members.length >= before.limit) throw new Error('The KeepOak team has no unused member places.');
    if (before.members.some((item) => item.email === value.email)) throw new Error('That email is already on the KeepOak team.');
    return `Invite ${value.email} as ${value.role} to ${before.organization_id}? This sends email and uses one of ${before.limit} member places.`;
  }
  const target = before.members.find((item) => item.id === value.memberId);
  if (!target || target.you || target.role === 'owner') throw new Error('This KeepOak membership cannot be changed here.');
  return value.action === 'remove' ? `Remove ${target.email} from ${before.organization_id}? KeepOak revokes this membership.`
    : `Change ${target.email} from ${target.role} to ${value.role} in ${before.organization_id}?`;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body)
    throw new Error('KeepOak returned an unexpected team response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) throw new Error('KeepOak team response exceeds the size limit.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
