import { esc } from '../core/dom.js';
import { E, activeId } from '../core/state.js';
import { api, token } from '../core/api.js';
import { on } from '../core/actions.js';
import { markLive } from '../core/features.js';
import { openDlg, toast } from '../core/ui.js';
import { gsel } from '../core/gsel.js';
import { t } from '../../i18n.js';

let current = null, busy = false, generation = 0;
const locked = () => document.getElementById('app')?.classList.contains('locked');
const valid = state => current === state && generation === state.generation && E.profiles === state.profile && activeId() === state.id && token.get() === state.token && E.profiles?.isOwner === true && !locked();
const act = (operation, agent, label, extra = '') => `<button class="btn sm" type="button" data-act="private-computer" data-operation="${operation}" data-agent="${esc(agent)}" ${extra}>${esc(t(label))}</button>`;

export async function openPrivateComputers() {
  if (E.profiles?.isOwner !== true || locked() || busy) return toast(t('privateComputer.owner'));
  const state = {profile: E.profiles, id: activeId(), token: token.get(), generation}; current = state;
  try {
    const [agents, view] = await Promise.all([api('trunks'), api('private-desktops')]);
    if (!valid(state)) return;
    state.agents = agents.trunks ?? []; state.desktops = view.desktops ?? [];
    draw(state);
  } catch (error) { if (valid(state)) toast(error.message); }
}

function draw(state) {
  const agent = gsel({id: 'private-agent', label: t('privateComputer.trunk'), options: state.agents.map(agent => [agent.id, agent.name])});
  const rows = state.desktops.map(desktop => {
    const name = state.agents.find(agent => agent.id === desktop.agent)?.name ?? desktop.agent;
    const buttons = desktop.running ? act('stop', desktop.agent, 'privateComputer.stop') + act('snapshot', desktop.agent, 'privateComputer.snapshot') + act('viewerInfo', desktop.agent, 'privateComputer.watch') + act(desktop.control === 'user' ? 'handBack' : 'takeOver', desktop.agent, desktop.control === 'user' ? 'privateComputer.handBack' : 'privateComputer.takeOver') : act('start', desktop.agent, 'privateComputer.start');
    const snapshots = desktop.snapshots.map(snapshot => `<li><time>${esc(snapshot.at)}</time>${act('restore', desktop.agent, 'privateComputer.restore', `data-snapshot="${esc(snapshot.id)}"`)}${act('removeSnapshot', desktop.agent, 'privateComputer.remove', `data-snapshot="${esc(snapshot.id)}"`)}</li>`).join('');
    return `<div class="tile"><b>${esc(name)}</b><p>${esc(t(desktop.running ? 'privateComputer.running' : 'privateComputer.stopped'))} · ${esc(desktop.control)}</p><div class="acts">${buttons}</div><ul>${snapshots}</ul></div>`;
  }).join('');
  markLive(['private-computer', 'private-create', 'sw:private-agent', 'sw:private-image']);
  openDlg({title: t('privateComputer.title'), wide: true, body: `<p>${esc(t('privateComputer.about'))}</p><label>${esc(t('privateComputer.trunk'))}${agent}</label><label>${esc(t('privateComputer.image'))}<input class="inp" id="private-image" value="branch-linux-desktop:latest" spellcheck="false"></label><button class="btn" type="button" data-act="private-create" ${state.agents.length ? '' : 'disabled'}>${esc(t('privateComputer.create'))}</button>${rows}`});
}

async function operation(body) {
  const state = current;
  if (!state || !valid(state) || busy) return;
  busy = true;
  try {
    const profiles = await api('profiles');
    if (!valid(state) || !profiles.isOwner || (profiles.active?.id ?? null) !== state.id) return;
    const result = await api('private-desktops', body);
    if (!valid(state)) return;
    if (body.operation === 'viewerInfo') {
      openDlg({title: t('privateComputer.watch'), body: `<p>${esc(t('privateComputer.vnc'))}</p><code>${esc(result.host)}:${esc(result.port)}</code><label>${esc(t('privateComputer.password'))}<input class="inp" type="password" readonly value="${esc(result.password)}" autocomplete="off"></label>`});
      return;
    }
    if (result.note) toast(result.note);
  } catch (error) { if (valid(state)) toast(error.message); }
  finally { busy = false; }
  if (valid(state)) await openPrivateComputers();
}

export function initPrivateComputers() {
  markLive(['comp-private']); on('comp-private', openPrivateComputers);
  on('private-create', () => operation({operation: 'create', agent: document.getElementById('private-agent')?.value, image: document.getElementById('private-image')?.value}));
  on('private-computer', el => operation({operation: el.dataset.operation, agent: el.dataset.agent, ...(el.dataset.snapshot ? {snapshot: el.dataset.snapshot} : {})}));
  const app = document.getElementById('app');
  if (app) new MutationObserver(() => { if (locked()) { generation++; current = null; } }).observe(app, {attributes: true, attributeFilter: ['class']});
}
