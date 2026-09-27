/* One owner-controlled Branch browser page per conversation. The engine owns the page and every
   permission decision; this window keeps only its current grant, masked frame and exact pending yes. */
import { esc } from '../core/dom.js';
import { api } from '../core/api.js';
import { closeDlg, ic, openDlg, toast } from '../core/ui.js';
import { on } from '../core/actions.js';
import { markLive } from '../core/features.js';

const B = { sid: null, clientId: crypto.randomUUID(), profile: null, control: null, page: null,
  frameId: '', tabId: '', ready: false, frame: '', pending: null, reading: null, timer: 0, shown: false,
  busy: false, onChange: null, meta: '', pointer: null, text: '', textTimer: 0, lockWatch: false };
const locked = () => document.getElementById('app')?.classList.contains('locked-b17') === true;
const visible = () => B.shown && !document.hidden && !locked();
const owned = () => B.control?.state === 'owner' && B.control.writer?.kind === 'owner' && B.control.writer.id === B.clientId;
const scope = () => ({ sessionId: B.sid, clientId: B.clientId, profile: B.profile });
const bound = () => ({ ...scope(), id: B.control.id, epoch: B.control.epoch });
const changed = (redraw = true) => B.onChange?.(redraw);
const clearFrame = () => { B.frameId = ''; B.tabId = ''; B.ready = false; B.frame = ''; };
export const hasOwnerBrowser = () => !!B.control && B.control.state !== 'stopped';

function schedule(delay = 750) {
  clearTimeout(B.timer); B.timer = 0;
  if (visible() && hasOwnerBrowser() && !B.busy && !B.pending) B.timer = setTimeout(() => {
    B.timer = 0; void readView();
  }, delay);
}
async function readView() {
  if (!visible() || !hasOwnerBrowser() || B.busy || B.pending || B.reading) return;
  const request = bound(), sid = B.sid, controller = new AbortController();
  B.reading = controller;
  try {
    const params = new URLSearchParams({ sessionId: sid, clientId: B.clientId, id: request.id, epoch: String(request.epoch) });
    if (B.profile) params.set('profile', B.profile);
    const answer = await api(`panels/browser?${params}`, undefined, 'GET', controller.signal);
    if (B.reading !== controller || B.sid !== sid || !visible()) return;
    B.control = answer.control; B.page = answer.page;
    B.frameId = answer.frameId ?? ''; B.tabId = answer.tabId ?? ''; B.ready = answer.ready === true;
    B.frame = answer.page?.frame ? `data:image/jpeg;base64,${answer.page.frame}` : '';
    const meta = JSON.stringify([B.control, B.page?.url, B.page?.title, B.page?.tabs, B.ready]);
    const redraw = B.meta !== meta; B.meta = meta; changed(redraw);
  } catch (error) {
    if (error.name !== 'AbortError' && B.reading === controller) {
      clearFrame(); B.meta = ''; changed(true);
      if (error.status === 409 || error.status === 404) { B.control = null; B.page = null; }
      if (error.status === 409 || error.status === 404 || error.status === 423) toast(error.message);
    }
  } finally { if (B.reading === controller) B.reading = null; schedule(); }
}
function disconnect() {
  clearTimeout(B.timer); B.timer = 0;
  B.reading?.abort(); B.reading = null; clearFrame();
  if (B.pending) { B.pending = null; closeDlg(); }
  if (hasOwnerBrowser() && owned() && B.sid) void api('panels/browser/disconnect', bound()).catch(() => undefined);
}
/** Called by the stage's browser view; closing or hiding it releases owner input immediately. */
export function watchOwnerBrowser(sid, show, onChange) {
  B.onChange = onChange;
  const next = show && sid ? sid : null;
  if (B.sid && B.sid !== next) { disconnect(); B.control = null; B.page = null; B.meta = ''; }
  B.sid = next; B.shown = !!next;
  if (!visible()) { if (B.reading || B.timer || owned()) disconnect(); return; }
  schedule(0);
}
export function paintOwnerBrowser() {
  for (const img of document.querySelectorAll('#stage7 .owner-browser7-img, #pip7 .owner-browser7-img')) {
    if (B.frame && img.getAttribute('src') !== B.frame) img.setAttribute('src', B.frame);
    if (!B.frame) img.removeAttribute('src');
  }
}

export function ownerBrowserButtons(runId, sid) {
  if (!sid) return '';
  if (!hasOwnerBrowser()) return '<button class="btn pri sm" type="button" data-act="owner-browser-start">Open Branch browser</button>';
  const stop = '<button class="btn ghost sm" type="button" data-act="owner-browser-stop">Stop browser</button>';
  if (B.control.state === 'transferring') return `<span class="pill idle">Transferring control…</span>${stop}`;
  if (owned()) return `${runId ? `<button class="btn pri sm" type="button" data-act="owner-browser-handback" data-id="${esc(runId)}">Hand back to Branch</button>` : ''}
    <button class="btn sm" type="button" data-act="owner-browser-release">Release control</button>${stop}`;
  return `<button class="btn pri sm" type="button" data-act="owner-browser-take">Take over</button>${stop}`;
}
const canInput = () => visible() && owned() && B.ready && !!B.frameId && !B.busy && !B.pending;
const controlButton = (action, label, disabled = false) => `<button type="button" data-act="owner-browser-${action}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
export function ownerBrowserHTML() {
  if (!hasOwnerBrowser()) return '';
  const tabs = (B.page?.tabs ?? []).map((tab, index) => `<span class="${tab.active ? 'on7' : ''}">
    <button type="button" data-act="owner-browser-tab" data-index="${index}"${!owned() ? ' disabled' : ''}>${esc(tab.title || tab.url || `Tab ${index + 1}`)}</button>
    ${B.control.tabs.length > 1 ? `<button type="button" data-act="owner-browser-tab-close" data-index="${index}" aria-label="Close tab">×</button>` : ''}</span>`).join('');
  const holder = owned() ? 'You are driving' : B.control.writer?.kind === 'agent' ? 'Branch is driving' : 'Control released';
  const ready = B.ready && B.frame, disabled = !owned() || B.busy || !!B.pending;
  return `<div class="desk7 brfull7 live7 owner-browser7"><div class="dk-win br7">
    <div class="dk-tabs">${tabs}${controlButton('new-tab', '+', disabled || B.control.tabs.length >= 5)}</div>
    <div class="owner-browser7-bar">${controlButton('back', '←', !canInput())}${controlButton('forward', '→', !canInput())}
      ${controlButton('reload', '↻', !canInput())}<form data-form="owner-browser-address"><input class="inp" autocomplete="off" spellcheck="false"
      aria-label="Website address" placeholder="Enter a website address" value="${esc(B.page?.url ?? '')}"${disabled ? ' disabled' : ''}>
      <button type="submit"${disabled ? ' disabled' : ''}>Go</button></form><span role="status">${holder}</span></div>
    <div class="owner-browser7-page" tabindex="${owned() ? '0' : '-1'}" aria-label="Branch browser page">
      <img class="shot7 owner-browser7-img" draggable="false" alt="${esc(B.page?.title || 'Branch browser page')}"${ready ? '' : ' hidden'}>
      ${ready ? '' : `<div class="owner-browser7-empty" role="status">${B.page?.borrowed ? 'This page belongs to your external browser.' : B.page?.url ? 'Preview unavailable. Refresh the page or take over again.' : 'Enter an address to open a page.'}</div>`}
    </div></div></div>`;
}

function question(path, body, answer) {
  B.pending = { path, body, token: answer.confirmToken };
  openDlg({ title: 'Browser action', body: `<p>${esc(answer.question)}</p>`,
    foot: '<button class="btn ghost" type="button" data-act="owner-browser-no">No</button><button class="btn pri" type="button" data-act="owner-browser-yes">Allow once</button>' });
}
function accept(answer, path, body) {
  if (answer.status === 'asked') { question(path, body, answer); return; }
  if (answer.control) B.control = answer.control;
  if (answer.status === 'stopped') { B.control = null; B.page = null; }
  if (answer.status === 'refused' || answer.status === 'failed') toast(answer.reason || answer.error || 'The browser action did not finish.');
  clearFrame(); B.meta = ''; changed(true);
}
async function send(path, body) {
  if (B.busy || !B.sid) return;
  B.busy = true; clearTimeout(B.timer);
  try {
    B.reading?.abort();
    while (B.reading) await new Promise(resolve => setTimeout(resolve, 10));
    const answer = await api(`panels/browser/${path}`, body);
    if (B.sid === body.sessionId) accept(answer, path, body);
  } catch (error) { toast(error.message); clearFrame(); changed(true); }
  finally { B.busy = false; schedule(0); }
}
async function action(tool, args) {
  if (!owned() || !B.sid || B.pending) return;
  if (B.reading) {
    B.reading.abort();
    while (B.reading) await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!B.frameId) await readView();
  if (!B.frameId || (tool === 'browser.owner_input' && !B.ready)) return;
  const body = { ...bound(), frameId: B.frameId, tabId: B.tabId, sequence: B.control.sequence + 1, tool, arguments: args };
  await send('action', body);
}
function confirm() {
  const pending = B.pending; B.pending = null; closeDlg();
  if (pending && visible()) void send(pending.path, { ...pending.body, confirmToken: pending.token });
  else schedule(0);
}
function cancelQuestion() { B.pending = null; closeDlg(); schedule(0); }
function address(form) {
  const raw = form.querySelector('input')?.value.trim();
  if (!raw) return;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  void action('browser.navigate', { url });
}
function point(event, img) {
  const rect = img.getBoundingClientRect(), width = img.naturalWidth || 1280, height = img.naturalHeight || 720;
  const scale = Math.min(rect.width / width, rect.height / height), w = width * scale, h = height * scale;
  const x = (event.clientX - rect.left - (rect.width - w) / 2) / w;
  const y = (event.clientY - rect.top - (rect.height - h) / 2) / h;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
function flushText() {
  clearTimeout(B.textTimer); B.textTimer = 0;
  if (!B.text) return;
  if (B.busy || B.pending) { B.textTimer = setTimeout(flushText, 100); return; }
  const text = B.text; B.text = '';
  if (text.length > 8192) { toast('Paste at most 8,192 characters at a time.'); return; }
  void action('browser.owner_input', { kind: 'text', text });
}
function typeText(text) { B.text += text; clearTimeout(B.textTimer); B.textTimer = setTimeout(flushText, 70); }
function key(event) {
  if (!visible() || !owned() || B.pending || event.isComposing) return;
  const modifiers = [event.ctrlKey && 'Control', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
  const key = event.key === ' ' ? 'Space' : event.key;
  if (modifiers.length && /^[a-zA-Z0-9]$/.test(key)) {
    event.preventDefault(); void action('browser.owner_input', { kind: 'key', key: [...modifiers, key].join('+') }); return;
  }
  if (!modifiers.length && event.key.length === 1) { event.preventDefault(); typeText(event.key); return; }
  if (['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) {
    event.preventDefault(); void action('browser.owner_input', { kind: 'key', key });
  }
}
function pointerUp(event) {
  const start = B.pointer; B.pointer = null;
  if (!start || !canInput()) return;
  const end = point(event, start.img); if (!end) return;
  const moved = Math.hypot(end.x - start.x, end.y - start.y) > 0.012;
  const args = moved ? { kind: 'drag', x: start.x, y: start.y, toX: end.x, toY: end.y }
    : { kind: 'click', x: end.x, y: end.y, button: start.button };
  void action('browser.owner_input', args);
}

export function initOwnerBrowser() {
  markLive(['owner-browser-start', 'owner-browser-stop', 'owner-browser-take', 'owner-browser-handback', 'owner-browser-release',
    'owner-browser-tab', 'owner-browser-tab-close', 'owner-browser-new-tab', 'owner-browser-back', 'owner-browser-forward',
    'owner-browser-reload', 'owner-browser-yes', 'owner-browser-no']);
  on('owner-browser-start', () => { if (B.sid) void send('start', scope()); });
  on('owner-browser-stop', () => { if (hasOwnerBrowser()) void send('stop', bound()); });
  on('owner-browser-take', () => { if (hasOwnerBrowser()) void send('control', { ...bound(), operation: 'takeover' }); });
  on('owner-browser-handback', el => { if (owned()) void send('control', { ...bound(), operation: 'handback', runId: el.dataset.id }); });
  on('owner-browser-release', () => { if (hasOwnerBrowser()) void send('disconnect', bound()); });
  on('owner-browser-tab', el => { if (owned()) void action('browser.tab', { action: 'select', index: Number(el.dataset.index) }); });
  on('owner-browser-tab-close', el => { if (owned()) void action('browser.tab', { action: 'close', index: Number(el.dataset.index) }); });
  on('owner-browser-new-tab', () => { if (owned()) void action('browser.tab', { action: 'open' }); });
  for (const kind of ['back', 'forward', 'reload']) on(`owner-browser-${kind}`, () => { if (canInput()) void action('browser.owner_input', { kind }); });
  on('owner-browser-yes', confirm); on('owner-browser-no', cancelQuestion);
  document.addEventListener('submit', event => {
    const form = event.target.closest?.('#stage7 form[data-form="owner-browser-address"]');
    if (form) { event.preventDefault(); address(form); }
  }, true);
  document.addEventListener('pointerdown', event => {
    const img = event.target.closest?.('#stage7 .owner-browser7-img');
    if (!img || !canInput()) return;
    const at = point(event, img); if (!at) return;
    event.preventDefault(); img.closest('.owner-browser7-page')?.focus();
    B.pointer = { ...at, img, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' };
  }, true);
  document.addEventListener('pointerup', event => { if (B.pointer) pointerUp(event); }, true);
  document.addEventListener('contextmenu', event => { if (event.target.closest?.('.owner-browser7-img')) event.preventDefault(); }, true);
  document.addEventListener('wheel', event => {
    if (!event.target.closest?.('#stage7 .owner-browser7-page') || !canInput()) return;
    event.preventDefault(); void action('browser.owner_input', { kind: 'wheel', dx: Math.max(-4000, Math.min(4000, event.deltaX)),
      dy: Math.max(-4000, Math.min(4000, event.deltaY)) });
  }, { capture: true, passive: false });
  document.addEventListener('keydown', event => { if (event.target.closest?.('#stage7 .owner-browser7-page')) key(event); }, true);
  document.addEventListener('paste', event => {
    if (!event.target.closest?.('#stage7 .owner-browser7-page') || !visible() || !owned() || B.pending) return;
    event.preventDefault(); typeText(event.clipboardData?.getData('text/plain') ?? '');
  }, true);
  document.addEventListener('compositionend', event => {
    if (event.target.closest?.('#stage7 .owner-browser7-page') && canInput()) typeText(event.data ?? '');
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) disconnect(); else schedule(0); });
  window.addEventListener('pagehide', disconnect);
  if (!B.lockWatch) {
    B.lockWatch = true;
    const app = document.getElementById('app');
    if (app) new MutationObserver(() => { if (locked()) disconnect(); }).observe(app, { attributes: true, attributeFilter: ['class'] });
  }
}
