import type { IncomingMessage } from 'node:http';
import type { createBranch } from './index.js';
import { GatewayAuth } from './remote/gateway-auth.js';
import { liveScreenRefusal } from './live-screen.js';
import { startedWithShortLivedKey } from './key-context.js';
import { currentPerson } from './people/context.js';

/** Minimal status projection: no task titles, messages, prompts, tools, links or credentials. */
export function phoneWidgets(app: Awaited<ReturnType<typeof createBranch>>, request: IncomingMessage) {
  const key = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ''))?.[1] ?? '';
  const device = new GatewayAuth(app.store, app.runtime.owner).keyDevice(key);
  const profileId = app.store.profiles.localWindowProfileId();
  const sent = new URL(request.url ?? '/', 'http://local').searchParams.get('profile');
  const refusal = liveScreenRefusal({store: app.store, owner: app.runtime.owner, profiles: app.store.profiles,
    viaDoor: false, locked: () => app.sessionLock.refusal('GET', '/api/panels/screen')});
  if (request.method !== 'GET' || startedWithShortLivedKey() || currentPerson() || profileId !== null || !device?.keyFingerprint || refusal
    || sent !== null && sent !== (profileId ?? 'owner')) throw new Error('This paired phone widget profile is unavailable.');
  app.store.profiles.requireOwner('phone widgets');
  if (app.trunks.modes().trunks === 'off') return {profileId: profileId ?? 'owner', trunks: []};
  return {profileId: profileId ?? 'owner', at: Date.now(), trunks: app.trunks.roster().trunks.slice(0, 20).map(trunk => ({
    id: trunk.id, sessionId: trunk.chatSessionId, name: trunk.name.slice(0, 40),
    colour: trunk.chosenColour ?? '#376a50', eyes: trunk.eyes ?? 'round',
    status: trunk.paused ? 'paused' : trunk.working || trunk.running > 0 ? 'working' : trunk.unread > 0 ? 'unread' : 'idle',
  }))};
}
