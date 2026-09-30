import { E } from '../core/state.js';
import { esc, renderNow, onRender } from '../core/dom.js';
import { on } from '../core/actions.js';
import { markLive } from '../core/features.js';
import { toast } from '../core/ui.js';

let data = null, busy = false, message = '';
const bridge = () => window.branchDesktop;
const ready = () => E.profiles?.isOwner === true && typeof bridge()?.keepOakTeam === 'function';
const options = (selected = 'operator') => ['admin', 'operator', 'viewer'].map((role) =>
  `<option value="${role}"${role === selected ? ' selected' : ''}>${role}</option>`).join('');

export function keepOakWorkspaceSection() {
  if (!ready()) return '';
  const manager = data && ['owner', 'admin'].includes(data.you.role);
  const rows = (data?.members ?? []).map((member) => `<li class="row">
    <span class="grow"><b>${esc(member.email)}${member.you ? ' (you)' : ''}</b><small>${esc(member.role)} · ${esc(member.status)}</small></span>
    ${manager && !member.you && member.role !== 'owner' ? `<select aria-label="Role for ${esc(member.email)}" data-ko-role="${esc(member.id)}"${busy ? ' disabled' : ''}>${options(member.role)}</select>
    <button class="btn sm" data-act="ko-team-role" data-id="${esc(member.id)}"${busy ? ' disabled' : ''}>Review role change</button>
    <button class="btn sm" data-act="ko-team-remove" data-id="${esc(member.id)}"${busy ? ' disabled' : ''}>Review removal</button>` : ''}</li>`).join('');
  return `<section class="sec" data-ko-workspace><h2>KeepOak computer team</h2>
    <p>Sign in through the isolated KeepOak view, then read your team. These members are separate from local Branch profiles.</p>
    <div class="acts"><button class="btn" data-act="ko-view-open">Open KeepOak view</button><button class="btn pri" data-act="ko-team-read"${busy ? ' disabled' : ''}>${data ? 'Refresh team' : 'Read team'}</button></div>
    <p role="status" aria-live="polite">${esc(message)}</p>
    ${data ? `<p><b>${esc(data.organizationId)}</b> · ${data.seats.used} of ${data.seats.total} member places used (invited people count). Your role: ${esc(data.you.role)}.</p><ul>${rows}</ul>` : ''}
    ${manager ? `<p class="hint">An admin manages the team; an operator uses its agents; a viewer only reads. Billing stays with the payer. Everyone uses the same computer.</p>
    <div class="row"><input type="email" maxlength="254" data-ko-email aria-label="Email to invite" placeholder="name@example.com"${busy ? ' disabled' : ''}><select data-ko-invite-role aria-label="Invited role"${busy ? ' disabled' : ''}>${options()}</select>
    <button class="btn pri" data-act="ko-team-invite"${busy || data.seats.used >= data.seats.total ? ' disabled' : ''}>Review invitation</button></div>` : ''}
    <p class="hint">A change asks in a native confirmation window. Shared Trunk definitions are not available from this KeepOak API.</p></section>`;
}
async function read() {
  if (!ready() || busy) return;
  busy = true; message = 'Reading KeepOak team…'; renderNow();
  try { data = await bridge().keepOakTeam(); message = 'Read from your current KeepOak session.'; }
  catch (error) { data = null; message = error.message; }
  finally { busy = false; renderNow(); }
}
async function update(action, element) {
  if (!ready() || busy || !data) return;
  const section = element.closest('[data-ko-workspace]');
  const input = { action, organizationId: data.organizationId, fingerprint: data.fingerprint };
  if (action === 'invite') {
    input.email = section.querySelector('[data-ko-email]').value;
    input.role = section.querySelector('[data-ko-invite-role]').value;
  } else {
    input.memberId = element.dataset.id;
    if (action === 'role') input.role = section.querySelector(`[data-ko-role="${input.memberId}"]`).value;
  }
  busy = true; message = 'Waiting for native confirmation…'; renderNow();
  try {
    const result = await bridge().changeKeepOakTeam(input);
    if (result.cancelled) message = 'Cancelled. No team change was requested.';
    else { data = result.team; message = 'KeepOak confirmed the change and the current team was read again.'; }
  } catch (error) { data = null; message = 'The change was not confirmed. Refresh before retrying.'; toast(error.message); }
  finally { busy = false; renderNow(); }
}
export function initKeepOakWorkspace() {
  markLive(['ko-team-read', 'ko-team-invite', 'ko-team-role', 'ko-team-remove']);
  on('ko-team-read', read);
  on('ko-team-invite', (el) => update('invite', el));
  on('ko-team-role', (el) => update('role', el));
  on('ko-team-remove', (el) => update('remove', el));
  onRender(() => { if (data && !ready()) { data = null; message = ''; } });
  window.addEventListener('focus', async () => {
    if (!data || !ready()) return;
    try { if (!(await bridge().keepOakViewStatus()).enabled) { data = null; message = ''; renderNow(); } } catch { data = null; }
  });
}
