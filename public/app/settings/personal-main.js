import { E } from '../core/state.js';
import { esc } from '../core/dom.js';
import { api } from '../core/api.js';
import { on } from '../core/actions.js';
import { markLive } from '../core/features.js';
import { openDlg, closeDlg, toast } from '../core/ui.js';
import { openConversation } from '../chat/chat.js';

const available = () => E.profiles?.isOwner === true && !!window.branchDesktop;
export function personalMainCard() {
  return available() ? `<div class="rows"><div class="ctl"><b>One personal main thread</b><span class="right"><button class="btn sm" data-act="personal-main-edit">Review sharing</button><button class="btn sm" data-act="personal-main-open">Open main thread</button></span><small>Explicitly share your default Trunk's conversation with one named owner Telegram DM. Other chats keep their own threads.</small></div></div>` : '';
}
let current = null;
export function initPersonalMain(reload) {
  markLive(['personal-main-edit', 'personal-main-save', 'personal-main-off', 'personal-main-open']);
  on('personal-main-edit', async () => {
    if (!available()) return;
    try {
      const [value, lock] = await Promise.all([api('channels/personal-main'), api('lock')]);
      current = value;
      const rows = value.accounts.map((account, index) => `<option value="${index}">${esc(account.name)} · ${esc(account.channel)} · sender ${esc(account.sender)}</option>`).join('');
      openDlg({ title: 'One personal main thread', body: `<p>Your exact default Trunk conversation (${esc(value.main?.sessionId ?? 'not available')}) will be visible through the selected owner Telegram account. Its earlier separate thread is kept. Tool access and approvals still follow the original surface rules.</p><p>Use a named, approved owner account with full-owner-chat access already enabled. Send a message in your default Trunk first if its conversation does not exist yet. Finish or stop any current task before changing this setting.</p>
        <p>${value.binding ? `Sharing ${value.active ? 'is active' : 'is held'} for ${esc(value.binding.channel)} · sender ${esc(value.binding.sender)}.` : 'Sharing is off.'}</p>
        <label>Exact Telegram account<select id="personal-main-account">${rows}</select></label>
        ${lock.pinSet ? '<label>Your Branch PIN<input type="password" autocomplete="off" id="personal-main-pin" maxlength="64"></label>' : ''}
        <div class="acts"><button class="btn pri" data-act="personal-main-save"${!value.main || !rows ? ' disabled' : ''}>Confirm sharing this history</button><button class="btn" data-act="personal-main-off">Stop sharing</button></div>` });
    } catch (error) { toast(error.message); }
  });
  const save = async (enabled) => {
    if (!available() || !current) return;
    const pin = document.getElementById('personal-main-pin');
    const account = current.accounts[Number(document.getElementById('personal-main-account')?.value)];
    try {
      await api('channels/personal-main', { on: enabled,
        ...(enabled ? { channel: account?.channel, sender: account?.sender, ...current.main } : {}),
        ...(pin ? { pin: pin.value } : {}) });
      current = null; closeDlg(); await reload(); toast(enabled ? 'Personal main thread shared.' : 'Sharing stopped; chat histories were kept.');
    } catch (error) { toast(error.message); }
  };
  on('personal-main-save', () => save(true));
  on('personal-main-off', () => save(false));
  on('personal-main-open', async () => {
    if (!available()) return;
    try {
      const value = await api('channels/personal-main');
      if (!value.active) throw new Error('Review and enable personal main-thread sharing first.');
      await openConversation(value.binding.sessionId);
    } catch (error) { toast(error.message); }
  });
}
