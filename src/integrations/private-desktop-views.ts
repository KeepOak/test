import { randomUUID } from 'node:crypto';
import type { PrivateDesktops } from './private-desktops.js';

interface Grant {
  id: string; owner: string; profile: string; conversation: string; agent: string;
  control: boolean; revision: number; expiresAt: number; claimed: boolean; disconnect?: () => void;
}
export interface DesktopViewScope {
  owner: string; profile: () => string; allowed: () => boolean;
  trunk: (conversation: string) => string | null; owns: (conversation: string) => boolean;
}
/** Views are ephemeral capabilities, never a saved settings record or computer-action permission. */
export class PrivateDesktopViews {
  private readonly grants = new Map<string, Grant>();
  private readonly unsubscribe: () => void;
  constructor(private readonly desktops: PrivateDesktops, private readonly scope: DesktopViewScope) {
    this.unsubscribe = desktops.onInvalidate((owner, agent) => {
      for (const grant of this.grants.values()) if (grant.owner === owner && grant.agent === agent) this.revoke(grant.id);
    });
  }
  private live(grant: Grant): boolean {
    try {
      const target = this.desktops.viewerStatus(grant.owner, grant.agent);
      return this.grants.get(grant.id) === grant && Date.now() < grant.expiresAt && this.scope.allowed()
        && grant.owner === this.scope.owner && grant.profile === this.scope.profile()
        && this.scope.owns(grant.conversation) && this.scope.trunk(grant.conversation) === grant.agent
        && target.revision === grant.revision && (!grant.control || target.control === 'user');
    } catch { return false; }
  }
  open(conversation: string, agent: string, control: boolean): {id: string; expiresAt: number; control: boolean} {
    for (const grant of this.grants.values()) if (!this.live(grant)) this.revoke(grant.id);
    if (!this.scope.allowed() || !this.scope.owns(conversation) || this.scope.trunk(conversation) !== agent)
      throw new Error('This view must belong to the owner’s current Trunk conversation.');
    const target = this.desktops.viewerStatus(this.scope.owner, agent);
    if (control && target.control !== 'user') throw new Error('Take over this same private computer before controlling it.');
    if (this.grants.size >= 4) throw new Error('Close another private desktop view before opening one.');
    const grant: Grant = {id: randomUUID(), owner: this.scope.owner, profile: this.scope.profile(), conversation, agent,
      control, revision: target.revision, expiresAt: Date.now() + 5 * 60_000, claimed: false};
    this.grants.set(grant.id, grant); return {id: grant.id, expiresAt: grant.expiresAt, control};
  }
  claim(id: string): {agent: string; owner: string; control: boolean; valid: () => boolean; disconnect: (close: () => void) => void} {
    const grant = this.grants.get(id);
    if (!grant || grant.claimed || !this.live(grant)) throw new Error('This private desktop view has ended. Open it again.');
    grant.claimed = true;
    return {agent: grant.agent, owner: grant.owner, control: grant.control,
      valid: () => { if (this.live(grant)) return true; this.revoke(id); return false; },
      disconnect: close => { grant.disconnect = close; if (!this.live(grant)) this.revoke(id); }};
  }
  revoke(id: string): void {
    const grant = this.grants.get(id); this.grants.delete(id); grant?.disconnect?.();
  }
  revokeAll(): void { for (const id of this.grants.keys()) this.revoke(id); }
  close(): void { this.revokeAll(); this.unsubscribe(); }
}
