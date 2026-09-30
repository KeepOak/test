import { esc } from '../core/dom.js';
import { E, S, activeId } from '../core/state.js';
import { api, token, isDesktop } from '../core/api.js';
import { on } from '../core/actions.js';
import { markLive } from '../core/features.js';
import { t } from '../../i18n.js';
import { trunkOfId } from './trunkline.js';
import { desktopCanvas } from './private-desktop-canvas.js';
import { openPrivateComputers } from '../flows/private-computers.js';

let view = null, generation = 0, changing = false;
const locked = () => document.getElementById('app')?.classList.contains('locked');
const target = () => E.profiles?.isOwner && !locked() ? trunkOfId(S.chat) : null;
const inScope = state => view === state && state.generation === generation && S.view === 'chat' && S.pane === 'private-desktop'
  && S.chat === state.conversation && target()?.id === state.agent && activeId() === state.profile && token.get() === state.token && state.root.isConnected;
const say = (state, words) => { if (inScope(state)) state.root.querySelector('[role="status"]').textContent = words; };

export const privateDesktopTab = ['private-desktop', 'privateComputer.pane', () =>
  `<div id="private-desktop-pane"><p>${esc(t('privateComputer.paneHint'))}</p><div class="acts"><button class="btn" type="button" data-act="private-pane-view">${esc(t('privateComputer.view'))}</button><button class="btn" type="button" data-act="private-pane-control">${esc(t('privateComputer.takeOver'))}</button><button class="btn" type="button" data-act="private-pane-handback">${esc(t('privateComputer.handBack'))}</button><button class="btn" type="button" data-act="private-pane-close">${esc(t('privateComputer.closeView'))}</button><button class="btn" type="button" data-act="private-pane-setup">${esc(t('privateComputer.title'))}</button></div><p role="status">${esc(target()?.name ?? '')}</p><canvas tabindex="0" aria-label="${esc(t('privateComputer.canvas'))}" width="1" height="1" data-css="width:100%;height:auto;touch-action:none"></canvas></div>`, () => !!target()];

/** Preserve the canvas across ordinary message redraws, but never across target/profile/tab changes. */
export function beforePrivatePaneDraw(tab) {
  if (view && tab === 'private-desktop' && inScope(view)) return view.root;
  disconnect(); return null;
}
function disconnect() {
  const previous = view; previous?.canvas?.release(); view = null; generation++;
  if (!previous) return;
  dispose(previous);
}
function dispose(previous) {
  if (!previous.disposed) { previous.disposed = true; previous.canvas?.close(); previous.socket?.close(); previous.abort.abort(); }
  if (!previous.grant || previous.revoked) return;
  previous.revoked = true;
  if (previous.token === token.get() && previous.profile === activeId() && E.profiles?.isOwner && !locked())
    void api('private-desktops/view-grants', {id: previous.grant}, 'DELETE').catch(() => undefined);
}
async function connectView(control = false) {
  const trunk = target(), root = document.getElementById('private-desktop-pane');
  if (!trunk || !root || S.pane !== 'private-desktop') return;
  disconnect();
  const state = {root, agent: trunk.id, conversation: S.chat, profile: activeId(), token: token.get(), generation, abort: new AbortController()}; view = state;
  try {
    const profiles = await api('profiles', undefined, 'GET', state.abort.signal);
    if (!inScope(state)) return;
    if (!profiles.isOwner || (profiles.active?.id ?? null) !== state.profile) return disconnect();
    const grant = await api('private-desktops/view-grants', {agent: state.agent, conversation: state.conversation, control}, 'POST', state.abort.signal);
    state.grant = grant.id;
    if (!inScope(state)) return dispose(state);
    const url = new URL('/api/private-desktops/view', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = isDesktop ? ['bearer', `private-view.${grant.id}`] : ['bearer', state.token, `private-view.${grant.id}`];
    state.socket = new WebSocket(url, protocols); state.socket.binaryType = 'arraybuffer';
    state.canvas = desktopCanvas(root.querySelector('canvas'), bytes => {
      if (!inScope(state) || state.socket.readyState !== WebSocket.OPEN) return;
      if (state.socket.bufferedAmount >= 65536) state.socket.close(); else state.socket.send(bytes);
    }, () => inScope(state));
    state.socket.onmessage = event => receive(state, event, control);
    state.socket.onclose = state.socket.onerror = () => { if (inScope(state)) { state.canvas.close(); say(state, t('privateComputer.viewEnded')); } };
    say(state, t('privateComputer.connecting'));
  } catch (error) { if (inScope(state)) { state.canvas?.close(); say(state, error.name === 'AbortError' ? t('privateComputer.viewEnded') : error.message); } }
}
function receive(state, event, expectedControl) {
  if (!inScope(state)) return dispose(state);
  try {
    if (typeof event.data === 'string') {
      if (event.data.length > 512) throw new Error('Invalid private desktop reply.');
      const reply = JSON.parse(event.data);
      if (reply.kind !== 'ready' || reply.control !== expectedControl) throw new Error('Invalid private desktop authority.');
      state.canvas.ready(reply.width, reply.height, reply.control);
      say(state, t(reply.control ? 'privateComputer.driving' : 'privateComputer.readonly'));
    } else state.canvas.rectangle(event.data);
  } catch { state.canvas.close(); state.socket.close(); say(state, t('privateComputer.viewEnded')); }
}
async function changeControl(operation) {
  const trunk = target(), conversation = S.chat, profile = activeId(), key = token.get();
  if (!trunk || changing || S.view !== 'chat' || S.pane !== 'private-desktop') return;
  changing = true;
  try {
    view?.canvas?.release(); disconnect();
    const profiles = await api('profiles');
    if (!profiles.isOwner || (profiles.active?.id ?? null) !== profile || activeId() !== profile || target()?.id !== trunk.id || S.chat !== conversation || token.get() !== key || S.view !== 'chat' || S.pane !== 'private-desktop') return;
    await api('private-desktops', {operation, agent: trunk.id});
    if (target()?.id === trunk.id && S.chat === conversation && activeId() === profile && token.get() === key && S.view === 'chat' && S.pane === 'private-desktop') await connectView(operation === 'takeOver');
  } catch (error) { const root = document.getElementById('private-desktop-pane'); if (root && target()?.id === trunk.id && S.chat === conversation && activeId() === profile && token.get() === key) root.querySelector('[role="status"]').textContent = error.message; }
  finally { changing = false; }
}
export function initPrivateDesktopPane(extraTabs) {
  extraTabs.push(privateDesktopTab);
  markLive(['private-pane-view', 'private-pane-control', 'private-pane-handback', 'private-pane-close', 'private-pane-setup']);
  on('private-pane-view', () => { if (!changing) void connectView(); });
  on('private-pane-control', () => changeControl('takeOver'));
  on('private-pane-handback', () => changeControl('handBack'));
  on('private-pane-close', disconnect); on('private-pane-setup', openPrivateComputers);
  setInterval(() => { if (view && !inScope(view)) disconnect(); }, 250);
  addEventListener('pagehide', disconnect);
  const app = document.getElementById('app');
  if (app) new MutationObserver(() => { if (locked()) disconnect(); }).observe(app, {attributes: true, attributeFilter: ['class']});
}
