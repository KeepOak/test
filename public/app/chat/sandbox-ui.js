import { $, afterDraw } from '../core/dom.js';
import { S, E } from '../core/state.js';
import { api } from '../core/api.js';
import { on } from '../core/actions.js';
import { markLive } from '../core/features.js';
import { toast } from '../core/ui.js';

const locked = () => document.getElementById('app')?.classList.contains('locked') === true;
const scope = () => JSON.stringify([S.view, S.chat, E.profiles, locked()]);
const owner = () => E.profiles?.isOwner !== false && !locked();
const denied = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'";
let pages = { scope: '', entries: [], at: 0 }, reading = false;
const open = new Set();

export function canvasAction(message) {
  if (!owner() || !message.messageId || message.role !== 'assistant' || !/(?:^|\n)```html[ \t]*\r?\n[\s\S]*?\r?\n```/i.test(String(message.content ?? ''))) return '';
  return `<button class="btn sm" type="button" data-act="reply-canvas-preview" data-v="${message.messageId}">Open reply canvas</button>`;
}
function contribution(entry) {
  const boundary = document.createElement('section'); boundary.dataset.contribution = entry.id;
  const heading = document.createElement('p'); heading.textContent = `${entry.pluginName}: ${entry.title}`; boundary.append(heading);
  try {
    if (entry.error) throw new Error(entry.error);
    const frame = document.createElement('iframe'); frame.title = heading.textContent;
    frame.setAttribute('sandbox', ''); frame.setAttribute('allow', denied); frame.referrerPolicy = 'no-referrer'; frame.src = entry.url;
    frame.width = '100%'; frame.height = '180'; boundary.append(frame);
    const fail = () => { frame.remove(); const note = document.createElement('p'); note.textContent = 'This contribution could not be displayed.'; boundary.append(note); };
    const timer = setTimeout(fail, 10000);
    frame.addEventListener('load', () => clearTimeout(timer), { once: true });
    frame.addEventListener('error', () => { clearTimeout(timer); fail(); }, { once: true });
  } catch { const note = document.createElement('p'); note.textContent = 'This contribution could not be displayed.'; boundary.append(note); }
  return boundary;
}
function mount() {
  for (const item of open) if (item.scope !== scope() || !owner()) item.dialog.close();
  if (!owner() || pages.scope !== scope()) { document.querySelectorAll('[data-ui-slot]').forEach(node => node.remove()); return; }
  const dock = $('.dock');
  if (!dock) return;
  for (const slot of ['conversation-aside', 'composer-aside']) {
    const entries = pages.entries.filter(entry => entry.slot === slot), key = JSON.stringify(entries);
    const existing = document.querySelector(`[data-ui-slot="${slot}"]`);
    if (existing?.dataset.key === key) continue;
    existing?.remove(); if (!entries.length) continue;
    const area = document.createElement('aside'); area.dataset.uiSlot = slot; area.dataset.key = key; area.setAttribute('aria-label', `Plugin ${slot}`);
    for (const entry of entries) area.append(contribution(entry));
    if (slot === 'composer-aside') dock.prepend(area); else dock.before(area);
  }
}
async function refreshPages() {
  if (reading || !$('.dock') || !S.chat || !owner() || pages.scope === scope() && Date.now() - pages.at < 5000) return;
  reading = true; const key = scope();
  try { const got = await api(`sandbox-ui/plugins/${encodeURIComponent(S.chat)}`); if (key === scope()) pages = { scope: key, entries: got.pages, at: Date.now() }; }
  catch { if (key === scope()) pages = { scope: key, entries: [], at: Date.now() }; }
  finally { reading = false; mount(); }
}
async function openCanvas(messageId) {
  const key = scope(), sessionId = S.chat;
  if (!sessionId || !owner()) return;
  try {
    const page = await api('sandbox-ui/canvas', { sessionId, messageId, scripts: false });
    if (key !== scope()) { void api('sandbox-ui/close', { capability: page.capability }).catch(() => {}); return; }
    const dialog = document.createElement('dialog'), heading = document.createElement('h2'), stage = document.createElement('div');
    heading.textContent = 'Reply canvas'; dialog.append(heading, stage);
    const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => dialog.close();
    const scripts = document.createElement('button'); scripts.textContent = 'Run isolated scripts';
    const item = { scope: key, dialog, capabilities: new Set([page.capability]), stop: () => {} }; open.add(item);
    showCanvas(stage, page, item);
    scripts.onclick = async () => {
      if (!confirm('Run scripts from this saved reply in an isolated offline frame? It can change its own page, with no access to Branch, tools, files, browser permissions or the network.')) return;
      scripts.disabled = true;
      try {
        const active = await api('sandbox-ui/canvas', { sessionId, messageId, scripts: true, confirmed: true, previewCapability: page.capability }); item.capabilities.add(active.capability);
        if (key !== scope() || !dialog.isConnected) { void api('sandbox-ui/close', { capability: active.capability }).catch(() => {}); return; }
        item.stop(); showCanvas(stage, active, item); scripts.disabled = true;
      } catch (error) { scripts.disabled = false; toast(error.message); }
    };
    dialog.append(scripts, close);
    dialog.addEventListener('close', () => { item.stop(); dialog.remove(); open.delete(item); for (const capability of item.capabilities) void api('sandbox-ui/close', { capability }).catch(() => {}); }, { once: true });
    document.body.append(dialog); dialog.showModal();
  } catch (error) { toast(error.message); }
}
function showCanvas(stage, page, item) {
  const frame = document.createElement('iframe'); frame.title = 'Reply canvas'; frame.width = '700'; frame.height = '500';
  frame.setAttribute('sandbox', page.scripts ? 'allow-scripts allow-same-origin' : ''); frame.setAttribute('allow', denied); frame.referrerPolicy = 'no-referrer';
  const bridge = event => {
    if (event.source !== frame.contentWindow || event.data?.nonce !== page.nonce || event.data.rpc?.method !== 'ui/notifications/sandbox-proxy-ready') return;
    window.removeEventListener('message', bridge);
    frame.contentWindow.postMessage({ nonce: page.nonce, rpc: { jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready', params: { html: page.html } } }, '*');
  };
  if (page.scripts) window.addEventListener('message', bridge);
  const timer = setTimeout(() => { frame.remove(); stage.textContent = 'This canvas expired. Reopen it to continue.'; }, 300000);
  item.stop = () => { clearTimeout(timer); window.removeEventListener('message', bridge); };
  frame.src = page.url; stage.replaceChildren(frame);
}
export function initSandboxUi() {
  markLive(['reply-canvas-preview']); on('reply-canvas-preview', element => void openCanvas(Number(element.dataset.v)));
  afterDraw(() => { mount(); void refreshPages(); });
  setInterval(() => { if (!document.hidden) { mount(); void refreshPages(); } }, 5000);
}
