/* ================= pass 17c: new capabilities around the conversation ================= */
/* The conversation stays calm: each capability has one small way in (a message's More menu, a line in the thread, a chip),
   and the depth lives in the side panel, popovers and dialogs. Everything here is example data. */
Object.assign(P, {
  tl17c: '<path d="M4 12h16"/><circle cx="6.5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="17.5" cy="12" r="2.2"/>',
  back17c: '<path d="M7 5.5v13M18 5.5v13L9.5 12z"/>', fwd17c: '<path d="M17 5.5v13M6 5.5v13l8.5-6.5z"/>',
  hide17c: '<path d="M3.5 12s3-6 8.5-6c1.6 0 3 .5 4.2 1.2M20.5 12s-3 6-8.5 6c-1.6 0-3-.5-4.2-1.2M4.5 19.5l15-15"/>',
  dia17c: '<rect x="3.5" y="4" width="7" height="5" rx="1.2"/><rect x="13.5" y="15" width="7" height="5" rx="1.2"/><path d="M7 9v4.5h10V15"/>',
  quick17c: '<path d="M13 3.5L5.5 13.5H12l-1 7 7.5-10H12z"/>', helper17c: '<circle cx="8" cy="8" r="3"/><circle cx="17" cy="15.5" r="2.5"/><path d="M3.5 19a4.5 4.5 0 0 1 9 0M10.5 10.5l4.5 3"/>'
});
const blk17c = i => (threads[S.chat] || [])[+i];
const idxOf17c = el => { const v = el?.dataset?.i ?? el?.closest?.('[data-i15]')?.dataset.i15; return v == null || v === '' ? null : +v; };
const lastBot17c = () => { const l = threads[S.chat] || []; for (let i = l.length - 1; i >= 0; i--) if (l[i].k === 'b') return i; return null; };
const say17c = (id, text) => threads[id]?.push({k: 'pass', text});
const quiet17c = () => { if (prevStatus11) chats.forEach(c => { prevStatus11[c.id] = c.status; }); };

/* ---------- new kinds of block: a diagram, and the thinking-dropped notice ---------- */
const _block17c = block;
block = function (b) {
  if (b.k !== 'dia17c' && b.k !== 'drop17c') return _block17c.apply(this, arguments);
  const i = (threads[S.chat] || []).indexOf(b), at = i < 0 ? '' : ` data-i15="${i}"`;
  if (b.k === 'drop17c') return `<div class="drop17c" role="note"${at}>${ic('spark', 's')}<span>Switched to <b>${esc(b.to)}</b>. ${esc(b.from)}’s thinking stays here for you but isn’t passed on: ${esc(b.to)} sees the messages and results, not the reasoning.</span><button type="button" class="link" data-act="dropwhy17c">Why</button></div>`;
  const c = C(S.chat), first = arguments[2];
  return `<div class="b"${at}><div class="gut">${first ? av(c, 28) : ''}</div><div>${diaCard17c(b)}</div></div>`;
};
botKinds.add('dia17c');
const _phBlock17c = phBlock8;
phBlock8 = function (id, b) {
  if (b.k === 'dia17c') return `<div class="pmsg bot">${ic('dia17c', 's')} Diagram · ${esc(b.title)}</div>`;
  if (b.k === 'drop17c') return `<div class="pmsg pst">Switched to ${esc(b.to)}; earlier thinking isn’t passed on.</div>`;
  return _phBlock17c.apply(this, arguments);
};
const _termLines17c = termLines;
termLines = function (id) {
  const orig = threads[id]; if (!orig?.some(b => b.k === 'dia17c' || b.k === 'drop17c')) return _termLines17c.apply(this, arguments);
  threads[id] = orig.map(b => b.k === 'dia17c' ? {k: 'pass', text: `Diagram: ${b.title} (drawn in the window)`} : b.k === 'drop17c' ? {k: 'pass', text: `Switched to ${b.to}; earlier thinking isn’t passed on`} : b);
  try { return _termLines17c.apply(this, arguments); } finally { threads[id] = orig; }
};

/* ---------- a message's More menu: branch, leave out of context, every step ---------- */
POPS.more17c = i => { const b = blk17c(i), bot = b?.k === 'b';
  return mi('br17c', 'branch', 'Branch from here', '', `data-i="${i}"`) + mi('out17c', 'hide17c', b?.out17c ? 'Put back in context' : 'Leave out of context', '', `data-i="${i}"`) + (bot ? mi('tlopen17c', 'tl17c', 'Every step behind this reply', '', `data-i="${i}"`) : ''); };
ACTS.more17c = el => openPop(el, POPS.more17c(el.dataset.i), {right: true});
afterChat15(() => {
  document.querySelectorAll('#scroll [data-i15]').forEach(el => {
    const i = +el.dataset.i15, b = blk17c(i), acts = el.querySelector(':scope > .msg-acts'); if (!b) return;
    if (acts && !acts.querySelector('[data-act="more17c"]')) {
      const br = acts.querySelector('[aria-label="Branch from here"]'); if (br) { br.dataset.act = 'br17c'; br.dataset.i = i; br.removeAttribute('data-msg'); }
      const fl = acts.querySelector('[data-act="flag"]'); if (fl) { fl.dataset.i = i; fl.setAttribute('aria-pressed', String(!!b.flag17c)); }
      const more = `<button type="button" aria-label="More for this message" aria-haspopup="menu" data-act="more17c" data-i="${i}">${ic('more')}</button>`;
      const pin = acts.querySelector('[data-act="pin15"]'); pin ? pin.insertAdjacentHTML('beforebegin', more) : acts.insertAdjacentHTML('beforeend', more);
    }
    if (b.out17c) { el.classList.add('out17c'); el.insertAdjacentHTML('afterend', `<div class="outb17c ${b.k === 'u' ? 'me17c' : ''}">${ic('hide17c', 's')}<span>Left out of context · kept here, never sent to the model</span><button type="button" data-act="out17c" data-i="${i}">Put back</button></div>`); }
    if (b.flag17c) el.insertAdjacentHTML('afterend', `<div class="flb17c">${ic('flag', 's')}<span>Flagged: ${esc(b.flag17c.reasons.join(', '))} · ${b.flag17c.sent ? 'sent to the Branch team' : 'kept on this computer'}</span><button type="button" data-act="flrm17c" data-i="${i}">Remove</button></div>`);
  });
});

/* ---------- leave out of context ---------- */
ACTS.out17c = el => {
  const i = +el.dataset.i, b = blk17c(i); if (!b) return; closePop();
  b.out17c = !b.out17c; let pinNote = '';
  if (b.out17c && S.pins15?.[S.chat]?.includes(i)) { S.pins15[S.chat] = S.pins15[S.chat].filter(x => x !== i); pinNote = ' It was pinned, so it’s unpinned too.'; }
  render();
  if (b.out17c) toast('Left out of context. It stays here for you; the model won’t see it from the next reply.' + pinNote, () => { b.out17c = false; render(); });
  else toast('Back in context. The model sees it again from the next reply.');
};
const outCount17c = id => (threads[id] || []).filter(b => b.out17c).length;

/* ---------- Timeline: every model call, tool step and approval in one task ---------- */
const TL17C = {
  scout: {title: 'Find the Hartwell invoice', model: 'GPT-6 Sol', steps: [
    ['model', 'Scout', 'Read your message and made a plan', 'GPT-6 Sol · 2,140 words in, 310 out', '12:02:04', 3.1, .05, 2, 'Your message, SOUL.md, USER.md and 2 things it remembers.', 'A four-step plan: folders first, then Outlook, then compare.'],
    ['tool', 'Scout', 'Searched Downloads', '0 files match “Hartwell”', '12:02:08', .4, 0, 4, 'Downloads, 214 files.', 'Nothing matched.'],
    ['tool', 'Scout', 'Searched Documents', '0 files match', '12:02:09', .6, 0, 4, 'Documents, 1,120 files.', 'Nothing matched.'],
    ['model', 'Scout', 'Decided to look in Outlook', 'GPT-6 Sol · 2,610 words in, 120 out', '12:02:11', 1.8, .03, 3, 'Both searches came back empty.', 'Invoices from Hartwell arrive by mail, so it went to Outlook.'],
    ['ok', 'Scout', 'Open outlook.office.com', 'Allowed by your rules: a site you use', '12:02:13', 0, 0, null, 'Browse · outlook.office.com', 'No question needed: you allowed this site on Sep 12.'],
    ['tool', 'Scout', 'Opened Outlook on the web', 'outlook.office.com', '12:02:17', 4.2, 0, 4, 'The sign-in page.', 'Found the sign-in form.'],
    ['help', 'Statement reader', 'Started a helper: Statement reader', 'Opus 5.5 · your Claude account', '12:02:18', .2, .09, null, 'Scout’s request: find the Hartwell charge on the August statement.', 'Started, with read-only access it must ask for.'],
    ['ok', 'Statement reader', 'Read card-statement-aug.csv', 'Asked by Statement reader for Scout', '12:02:20', 0, 0, null, 'Read · Documents/Statements', 'Waiting for your answer in Activity.', 'r1'],
    ['help', 'Receipt matcher', 'Started a helper: Receipt matcher', 'Qwen3.6 35B · on this computer', '12:02:21', .1, 0, null, 'Scout’s request: is a receipt for the charge already filed?', 'Started on this computer, free.'],
    ['tool', 'Scout', 'Filled the sign-in form', 'Bitwarden filled it; Branch never saw the password', '12:02:28', 6.8, 0, 5, 'Outlook asked for an authenticator code.', 'Bitwarden filled the form and the code.'],
    ['model', 'Scout', 'Waiting for the page', 'GPT-6 Sol · running', 'now', 98.8, .11, 5, 'The inbox is loading.', 'It will search for “Hartwell” next.']]},
  ledger: {title: 'September expense report', model: 'Opus 5.5', steps: [
    ['model', 'Ledger', 'Read your message and made a plan', 'Opus 5.5 · 1,880 words in, 240 out', '11:40:02', 2.6, .06, 1, 'Your message and SOP.md.', 'Statement, receipts, report, then ask before sending.'],
    ['tool', 'Ledger', 'Read the card statement', '16 charges · Sep 1–30', '11:40:09', 3.9, 0, 2, 'card-statement-sep.csv', '16 charges.'],
    ['tool', 'Ledger', 'Matched receipts in Downloads', '14 of 14 found', '11:40:51', 41.5, 0, 2, 'Downloads/receipts, 14 files.', 'All 14 matched.'],
    ['model', 'Ledger', 'Left out personal charges', '2 charges · $48.20', '11:41:20', 4.4, .04, 2, 'Charges without a work category.', 'Two personal charges left out.'],
    ['tool', 'Ledger', 'Built the report', 'September-expenses.xlsx', '11:41:44', 12.1, 0, 4, 'The 14 matched receipts.', 'A 38 KB spreadsheet in Library.'],
    ['model', 'Ledger', 'Wrote the email to Dana', 'Opus 5.5 · 2,300 words in, 160 out', '11:42:02', 3.2, .05, 5, 'The report and Dana’s address.', 'A short email with the report attached.'],
    ['ok', 'Ledger', 'Send this email to Dana Okafor?', 'Send · dana.okafor@hartwell.example', '11:42:05', 0, 0, 6, 'Send · 1 email, 1 attachment', 'Waiting for your yes.', 'a1']]},
  room: {title: 'Supplier quotes', model: 'GPT-6 Sol', steps: [
    ['model', 'Scout', 'Read the room message', 'GPT-6 Sol · 1,420 words in, 180 out', '11:02:03', 2.2, .06, 1, 'Your message to @Scout.', 'Find four quotes for 10 cases.'],
    ['tool', 'Scout', 'Oakfield price page', 'oakfield.example/paper', '11:02:14', 5.1, 0, 3, 'oakfield.example', '$38.50 a case.'],
    ['tool', 'Scout', 'Brightline, Parcel & Co, Staples Pro', '3 pages, delivery added', '11:03:40', 58.3, 0, 3, 'Three supplier pages.', '$41 to $46 a case.'],
    ['model', 'Ledger', 'Compared with delivery in', 'GPT-6 Sol · 1,960 words in, 140 out', '11:04:02', 3.5, .15, 4, 'Four quotes and delivery fees.', 'Oakfield $412 delivered, 12% under the next.'],
    ['tool', 'Ledger', 'Drew the chart', 'Cost for 10 cases, delivered', '11:04:09', 1.2, .10, 5, 'The four totals.', 'A bar chart in a sealed frame.'],
    ['ok', 'Scout', 'Open staplespro.example/paper', 'A website it hasn’t used before', '11:04:12', 0, 0, null, 'Browse · a new site', 'Waiting for your yes.']]}
};
S.tl17c = S.tl17c || {chat: null, at: 0, on: false, ver: 0};
let tlTimer17c = null;
const kindWord17c = {model: 'Model call', tool: 'Tool', ok: 'Approval', help: 'Helper', you: 'You'};
function tlSteps17c(id) {
  const d = TL17C[id], mk = s => ({k: s[0], who: s[1], t: s[2], d: s[3], at: s[4], s: s[5], $: s[6], i: s[7], saw: s[8], did: s[9], req: s[10]});
  if (d) { const st = d.steps.map(mk); if (id === 'scout' && threads.scout?.find(b => b.k === 'computer')?.state === 'done') st[st.length - 1] = mk(['model', 'Scout', 'Compared and wrote the answer', 'GPT-6 Sol · 3,940 words in, 380 out', '12:04:10', 98.8, .11, lastBot17c(), 'The invoice ($2,140.00) and the card statement ($2,040.00).', 'Found it: $100 short on the August invoice.']); return st; }
  const list = threads[id] || [], items = list.filter(b => b.k === 'steps').flatMap(b => b.items); if (!items.length) return [];
  const c = C(id), who = c?.name || 'Branch';
  return [{k: 'model', who, t: 'Read your message and made a plan', d: 'Model call', at: '', s: 2.1, $: 0, i: list.findIndex(b => b.k === 'u'), saw: 'Your message.', did: 'A plan.'},
    ...items.map(([a, dd]) => ({k: 'tool', who, t: a, d: dd, at: '', s: 1.4, $: 0, i: list.findIndex(b => b.k === 'steps'), saw: a, did: dd})),
    {k: 'model', who, t: 'Wrote the answer', d: 'Model call', at: '', s: 2.4, $: 0, i: lastBot17c(), saw: 'Every result above.', did: 'The reply in the conversation.'}];
}
const reqState17c = s => s.req === 'a1' ? (findBlock('a1')?.state || 'pending') : s.req ? (S.hp17c[s.req] || 'pending') : (s.k === 'ok' && s.did.startsWith('Waiting') ? 'pending' : 'allowed');
const extra17c = id => (S.tlx17c?.[id] || []).map(x => ({k: 'you', who: 'You', t: x, d: 'By Taofik, in this window', at: 'now', s: 0, $: 0, i: null, saw: '', did: x}));
const dur17c = s => s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
const hash17c = (id, k) => { let h = 2166136261; for (const ch of id + ':' + k) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h.toString(16).padStart(8, '0'); };
/* the total always matches the cost line under the message box; the latest model call carries any difference */
function tlAll17c(id) {
  const st = tlSteps17c(id), m = safe15(() => curModel(), null), models = st.filter(s => s.k === 'model');
  if (m && !/Qwen|local/i.test(m.name || '') && models.length) {
    const target = 0.03 * (threads[id] || []).length + 0.07, sum = st.reduce((a, s) => a + s.$, 0);
    if (Math.abs(target - sum) > 0.004) models[models.length - 1].$ = Math.max(0, +(models[models.length - 1].$ + target - sum).toFixed(2));
  }
  return [...st, ...extra17c(id)];
}
function tlHead17c(id, st) {
  const d = TL17C[id], c = C(id), time = st.reduce((a, s) => a + s.s, 0), cost = st.reduce((a, s) => a + s.$, 0), live = c?.status === 'working';
  const T = S.tl17c, ticks = st.map((s, i) => `<button type="button" class="tk17c k${s.k}17c ${i === T.at ? 'on17c' : ''} ${i > T.at ? 'later17c' : ''}" data-act="tlgo17c" data-v="${i}" aria-label="Step ${i + 1}: ${esc(s.t)}"></button>`).join('');
  return `<div class="tlh17c"><b>${esc(d?.title || c?.name || 'This task')}</b><small>${st.length} steps · ${dur17c(time)}${live ? ' so far' : ''} · $${cost.toFixed(2)}${cost ? '' : ' (this computer or your plan)'}</small></div>
    <div class="tlctl17c"><button type="button" class="icon-btn" data-act="tlstep17c" data-v="-1" aria-label="Step back" ${T.at <= 0 ? 'disabled' : ''}>${ic('back17c', 's')}</button><button type="button" class="btn sm tlplay17c" data-act="tlplay17c" aria-pressed="${T.on}">${ic(T.on ? 'pause15' : 'play15', 's')}${T.on ? 'Pause' : 'Play'}</button><button type="button" class="icon-btn" data-act="tlstep17c" data-v="1" aria-label="Step forward" ${T.at >= st.length - 1 ? 'disabled' : ''}>${ic('fwd17c', 's')}</button><span class="tkrow17c" role="group" aria-label="Steps">${ticks}</span></div>`;
}
function tlAt17c(id, st) {
  const T = S.tl17c, s = st[T.at], upto = st.slice(0, T.at + 1), rs = s.k === 'ok' ? reqState17c(s) : '';
  const tot = upto.reduce((a, x) => a + x.$, 0), time = upto.reduce((a, x) => a + x.s, 0);
  const pill = s.k === 'ok' ? `<span class="pill ${rs === 'pending' ? 'work' : rs === 'denied' ? 'no' : 'done'}"><i></i>${rs === 'pending' ? 'Waiting for you' : rs === 'denied' ? 'You said no' : 'Allowed'}</span>` : `<span class="pill idle">${kindWord17c[s.k]}</span>`;
  return `<div class="tlat17c" aria-live="polite"><div class="tla-h17c"><b>At step ${T.at + 1} of ${st.length}</b>${pill}</div><h3>${esc(s.t)}</h3><dl class="kv"><dt>Who</dt><dd>${esc(s.who)}</dd><dt>Details</dt><dd>${esc(s.d)}</dd><dt>Took</dt><dd>${s.s ? dur17c(s.s) : 'no time'}${s.at ? ` · at ${esc(s.at)}` : ''}</dd><dt>Cost</dt><dd>$${s.$.toFixed(2)} · $${tot.toFixed(2)} so far, ${dur17c(time)} in</dd></dl>
    ${s.saw ? `<p><b>What it had</b>${esc(s.saw)}</p>` : ''}${s.did ? `<p><b>What happened</b>${esc(s.did)}</p>` : ''}
    <div class="acts">${s.i != null && s.i >= 0 ? `<button type="button" class="btn ghost sm" data-act="tljump17c" data-i="${s.i}">Show it in the conversation</button>` : ''}${s.req && s.req !== 'a1' && rs === 'pending' ? `<button type="button" class="btn sm" data-act="hpopen17c">Answer in Activity</button>` : ''}</div></div>`;
}
function tlList17c(id, st) {
  const T = S.tl17c, tech = lvl15() >= 2;
  const icon = {model: 'spark', tool: 'check', ok: 'shield', help: 'helper17c', you: 'pause'};
  return `<ol class="tll17c">${st.map((s, i) => `<li class="k${s.k}17c ${i === T.at ? 'on17c' : ''} ${i > T.at ? 'later17c' : ''}"><button type="button" data-act="tlgo17c" data-v="${i}"><span class="tli17c">${ic(icon[s.k], 's')}</span><span class="grow"><b>${esc(s.t)}</b><small>${esc(s.who)} · ${esc(s.d)}${tech ? ` · <code>${hash17c(id, i)}</code>` : ''}</small></span><span class="tlm17c">${s.s ? dur17c(s.s) : ''}${s.$ ? `<br>$${s.$.toFixed(2)}` : ''}</span></button></li>`).join('')}</ol>`;
}
function tlVer17c(id, st) {
  const v = S.tl17c.ver, first = st.find(s => s.at)?.at || 'the start';
  const msg = v === 2 ? `<b>Record intact</b><small>All ${st.length} steps link up, from ${esc(first)} to the latest. Nothing was cut or rebuilt.${lvl15() >= 2 ? `<br><code>chain head ${hash17c(id, 'head')}…${hash17c(id, st.length).slice(0, 4)} · sha-256</code>` : ''}</small>` : v === 1 ? '<b>Checking each link…</b><small>Every step carries the fingerprint of the one before.</small>' : '<b>Check the record</b><small>Each step is chained to the one before it, so a cut or an edit would show.</small>';
  return `<div class="tlver17c ${v === 2 ? 'ok17c' : ''}">${ic(v === 2 ? 'check' : 'shield', 's')}<span class="grow">${msg}</span>${v === 1 ? '' : `<button type="button" class="btn sm" data-act="tlver17c">${v === 2 ? 'Check again' : 'Check'}</button>`}</div>`;
}
function tlHTML17c() {
  const id = S.chat, st = tlAll17c(id), T = S.tl17c;
  if (!st.length) return `<div data-art17="art17-timeline"></div><p class="empty">No task in this conversation yet. When a Trunk works on something, every model call, tool step and approval shows here, and you can replay it.</p>`;
  if (T.chat !== id) Object.assign(T, {chat: id, at: st.length - 1, on: false, ver: 0});
  T.at = Math.max(0, Math.min(T.at, st.length - 1));
  return `<div class="tl17c">${tlHead17c(id, st)}${tlAt17c(id, st)}${tlList17c(id, st)}${tlVer17c(id, st)}<p class="hint tln17c">Example record. The real one comes from the activity log and the task’s recording.</p></div>`;
}
const drawTl17c = () => { const b = $('#pane .pane-b'); if (b && S.pane === 'tl17c') { const y = b.scrollTop; b.innerHTML = tlHTML17c(); b.scrollTop = y; } };
function stopTl17c() { clearInterval(tlTimer17c); tlTimer17c = null; S.tl17c.on = false; }
function tickTl17c() {
  const T = S.tl17c, n = tlAll17c(S.chat).length;
  if (S.pane !== 'tl17c' || S.chat !== T.chat || S.view !== 'chat') { stopTl17c(); return; }
  if (T.at >= n - 1) { stopTl17c(); drawTl17c(); return; }
  T.at++; if (T.at >= n - 1) stopTl17c(); drawTl17c();
}
Object.assign(ACTS, {
  tlgo17c: el => { stopTl17c(); S.tl17c.at = +el.dataset.v; drawTl17c(); },
  tlstep17c: el => { stopTl17c(); S.tl17c.at += +el.dataset.v; drawTl17c(); },
  tlplay17c: () => { const T = S.tl17c; if (T.on) { stopTl17c(); drawTl17c(); return; } if (T.at >= tlAll17c(S.chat).length - 1) T.at = 0; T.on = true; drawTl17c(); tlTimer17c = setInterval(tickTl17c, calm11() ? 1400 : 900); },
  tlver17c: () => { S.tl17c.ver = 1; drawTl17c(); setTimeout(() => { S.tl17c.ver = 2; drawTl17c(); }, calm11() ? 150 : 900); },
  tljump17c: el => { const i = el.dataset.i; if (innerWidth <= 1100) { S.pane = null; render(); } ACTS.pinjump15({dataset: {i}}); },
  tlopen17c: el => {
    closePop(); closeDlg(); const i = idxOf17c(el) ?? S.insp17c, st = tlAll17c(S.chat); stopTl17c();
    let at = st.length - 1; if (i != null) { const hit = st.map((s, k) => [s.i, k]).filter(([x]) => x != null && x <= i).pop(); if (hit) at = hit[1]; }
    Object.assign(S.tl17c, {chat: S.chat, at: Math.max(0, at), ver: 0}); S.pane = 'tl17c'; render();
  }
});

/* ---------- the side panel: a Timeline tab, a Branches tab when there are paths, and Helpers in Activity ---------- */
const PANE17C = {tl17c: 'Timeline', br17c: 'Branches'};
{ const _rp17c = renderPane; renderPane = function () {
  if (S.pane !== 'tl17c' && tlTimer17c) stopTl17c();
  if (S.pane === 'br17c' && S.view === 'chat' && pathsOf17c(S.chat).list.length < 2) S.pane = 'activity';
  const mine = PANE17C[S.pane] ? S.pane : null; if (mine) S.pane = 'activity';
  _rp17c.apply(this, arguments); if (mine) S.pane = mine;
  const tabs = $('#pane .ptabs'); if (!tabs) return;
  const add = (id, l, after) => { if (tabs.querySelector(`[data-p="${id}"]`)) return; const html = `<button class="ptab" role="tab" type="button" aria-selected="false" data-act="ptabp" data-p="${id}">${l}</button>`, a = tabs.querySelector(`[data-p="${after}"]`); a ? a.insertAdjacentHTML('afterend', html) : tabs.insertAdjacentHTML('beforeend', html); };
  add('tl17c', 'Timeline', 'activity'); if (pathsOf17c(S.chat).list.length > 1) add('br17c', 'Branches', 'tl17c');
  tabs.querySelectorAll('.ptab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.p === S.pane)));
  const on = tabs.querySelector('[aria-selected="true"]'); if (on && (on.offsetLeft + on.offsetWidth > tabs.scrollLeft + tabs.clientWidth || on.offsetLeft < tabs.scrollLeft)) tabs.scrollLeft = on.offsetLeft - 8;
  const body = $('#pane .pane-b'); if (!body) return;
  if (mine === 'tl17c') body.innerHTML = tlHTML17c();
  else if (mine === 'br17c') body.innerHTML = brPaneHTML17c();
  else if (S.pane === 'activity' && HELP17C[S.chat]) body.insertAdjacentHTML('beforeend', helpersHTML17c(S.chat));
}; }

/* ---------- Look inside a reply opens its steps ---------- */
{ const _in17c = ACTS.inspect; ACTS.inspect = el => {
  S.insp17c = idxOf17c(el); _in17c(el);
  const st = tlAll17c(S.chat), foot = dlgEl?.querySelector('.dlg-f'), kv = dlgEl?.querySelector('.dlg-b .kv'); if (!foot) return;
  const n = outCount17c(S.chat);
  if (kv) kv.insertAdjacentHTML('beforeend', `${st.length ? `<dt>Steps</dt><dd>${st.length} in this task · model calls, tools and approvals</dd>` : ''}${n ? `<dt>Left out</dt><dd>${n} message${n > 1 ? 's' : ''} kept here but not sent</dd>` : ''}`);
  if (st.length) foot.insertAdjacentHTML('afterbegin', `<button class="btn pri" type="button" data-act="tlopen17c" data-i="${S.insp17c ?? ''}">${ic('tl17c', 's')}Every step</button>`);
}; }

/* ---------- Branch from here: parallel paths, linked, switchable and comparable ---------- */
S.br17c = S.br17c || {}; S.brm17c = 'same'; S.cmp17c = null;
function pathsOf17c(id) {
  let r = S.br17c[id]; if (!r) r = S.br17c[id] = {cur: 'main', list: [{id: 'main', name: 'Original', parent: null, at: 0, self: 0, model: null, made: '', blocks: threads[id] || []}]};
  const cur = r.list.find(p => p.id === r.cur); if (cur && threads[id] && cur.blocks !== threads[id]) cur.blocks = threads[id];
  return r;
}
if (threads.ada && !S.br17c.ada) {
  const r = pathsOf17c('ada'), a = threads.ada;
  r.list.push({id: 'porto', name: 'Porto instead', parent: 'main', at: 1, self: 1, model: 'Opus 5.5', made: 'Yesterday 4:31 PM', blocks: [{...a[0]},
    {k: 'u', text: 'Same dates, but Porto instead of Lisbon. Cheapest refundable options.'},
    {k: 'steps', summary: 'Compared 26 options · 7 steps · 4m', items: [['Searched flights ATL → OPO', 'Oct 10–17 · 19 options'], ['Searched hotels in Ribeira', '6 refundable'], ['Held the cheapest refundable pair', 'nothing booked on this path']]},
    {k: 'b', html: '<p>Porto works too, and it’s cheaper: <strong>$1,228</strong> against $1,356 for Lisbon. Nothing is booked on this path; say the word and I’ll swap.</p>'},
    {k: 'check', lines: [['Flights', 'ATL → OPO, Oct 10–17, $538'], ['Hotel', 'Casa da Ribeira, 7 nights, $690'], ['Refundable', 'until October 5']]}]});
}
const lastText17c = p => { const b = [...p.blocks].reverse().find(x => x.k === 'b'); return b ? plain(b.html).slice(0, 96) : 'No answer yet'; };
function brPoints17c(r) {
  const cur = r.list.find(p => p.id === r.cur), pts = {};
  const put = (k, owner, p) => { const g = pts[k] = pts[k] || [owner]; if (!g.includes(p)) g.push(p); };
  r.list.filter(p => p.parent === cur.id).forEach(p => put(p.at, cur, p));
  if (cur.parent) { const par = r.list.find(p => p.id === cur.parent); put(cur.self, par, cur); r.list.filter(p => p.parent === par.id && p.at === cur.at && p !== cur).forEach(p => put(cur.self, par, p)); }
  return pts;
}
afterChat15(() => {
  const r = pathsOf17c(S.chat); if (r.list.length < 2) return;
  const cur = r.list.find(p => p.id === r.cur);
  Object.entries(brPoints17c(r)).forEach(([k, g]) => {
    const html = `<div class="brm17c" role="group" aria-label="Paths from here">${ic('branch', 's')}<span>${g.length} paths from here</span>${g.map(p => `<button type="button" data-act="brgo17c" data-v="${p.id}" aria-pressed="${p.id === r.cur}">${esc(p.name)}</button>`).join('')}</div>`;
    const at = $(`#scroll [data-i15="${+k - 1}"]`); at ? at.insertAdjacentHTML('afterend', html) : $('#scroll .thread')?.insertAdjacentHTML('afterbegin', html);
  });
  if (cur.parent) { const par = r.list.find(p => p.id === cur.parent);
    $('#scroll')?.insertAdjacentHTML('beforebegin', `<div class="brbar17c" role="region" aria-label="Which path">${ic('branch', 's')}<span class="grow">On the path <b>${esc(cur.name)}</b>${cur.model ? ` · ${esc(cur.model)}` : ''}</span><button class="btn ghost sm" type="button" data-act="brcmp17c">Compare</button><button class="btn sm" type="button" data-act="brgo17c" data-v="${par.id}">Back to ${esc(par.name)}</button></div>`); }
});
function brPaneHTML17c() {
  const r = pathsOf17c(S.chat);
  const row = (p, d) => `<div class="brr17c" style="--d:${d}"><span class="brdot17c ${p.id === r.cur ? 'on17c' : ''}"></span><span class="grow"><b>${esc(p.name)}</b><small>${p.blocks.length} messages · ${esc(p.model || 'same model')}${p.made ? ` · ${esc(p.made)}` : ''}</small><em>${esc(lastText17c(p))}</em></span>${p.id === r.cur ? '<span class="pill done"><i></i>Here</span>' : `<button class="btn sm" type="button" data-act="brgo17c" data-v="${p.id}">Switch</button>`}</div>`;
  const tree = (pid, d) => r.list.filter(p => p.parent === pid).map(p => row(p, d) + tree(p.id, d + 1)).join('');
  return `<div class="brp17c"><p class="hint">Each path is its own conversation from the point it split. Switching keeps every path exactly as it is.</p><div class="brtree17c">${row(r.list[0], 0)}${tree('main', 1)}</div><div class="acts"><button class="btn sm" type="button" data-act="brcmp17c">Compare two answers</button><button class="btn ghost sm" type="button" data-act="br17c" data-i="${(threads[S.chat] || []).length - 1}">New path from the latest</button></div></div>`;
}
function cmpCol17c(p, r) {
  const last = [...p.blocks].reverse().find(b => b.k === 'b'), chk = [...p.blocks].reverse().find(b => b.k === 'check');
  return `<section class="cmpc17c"><h3>${esc(p.name)}</h3><small>${esc(p.model || 'same model')} · ${p.blocks.length} messages</small><div class="txt">${last ? last.html : '<p>No answer yet on this path.</p>'}</div>${chk ? `<dl class="kv">${chk.lines.map(([a, d]) => `<dt>${esc(a)}</dt><dd>${esc(d)}</dd>`).join('')}</dl>` : ''}<button class="btn sm" type="button" data-act="brgo17c" data-v="${p.id}">${p.id === r.cur ? 'Keep going here' : 'Continue on this path'}</button></section>`;
}
Object.assign(ACTS, {
  brgo17c: el => {
    const r = pathsOf17c(S.chat), p = r.list.find(x => x.id === el.dataset.v); closePop(); closeDlg();
    if (!p || p.id === r.cur) return;
    r.cur = p.id; threads[S.chat] = p.blocks; render(); toast(`On “${p.name}”. The other path is kept as it was.`);
  },
  brcmp17c: () => {
    const r = pathsOf17c(S.chat); closePop();
    if (r.list.length < 2) { toast('Only one path so far. Use Branch from here on any message to start another.'); return; }
    const cur = r.list.find(p => p.id === r.cur), other = r.list.find(p => p.id === cur.parent) || r.list.find(p => p.id !== cur.id);
    const pick = (S.cmp17c || []).map(id => r.list.find(p => p.id === id)).filter(Boolean), two = pick.length === 2 ? pick : [other, cur];
    const sel = k => `<select class="inp" data-sel17c="${k}" aria-label="Path ${k + 1}">${r.list.map(p => `<option value="${p.id}" ${p === two[k] ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
    openDlg({title: 'Compare two paths', wide: true, body: `${r.list.length > 2 ? `<div class="cmpsel17c">${sel(0)}${sel(1)}</div>` : ''}<div class="cmp17c">${two.map(p => cmpCol17c(p, r)).join('')}</div>`});
  },
  br17c: el => {
    const i = idxOf17c(el) ?? lastBot17c() ?? (threads[S.chat].length - 1), r = pathsOf17c(S.chat), b = blk17c(i); closePop(); S.brm17c = 'same';
    openDlg({title: 'Branch from here', body: `<p class="lede" style="margin:0 0 10px">A new path with everything up to “${esc(plain15(b || {}).slice(0, 60))}”. The original stays exactly as it is; switch or compare any time.</p><label class="fld"><span>Name</span><input class="inp" id="br-name17c" value="Try ${r.list.length + 1}" autocomplete="off"></label>${segAct('Model for this path', 'A new path can try another model. Earlier thinking isn’t carried over.', [['same', 'Same model'], ['Opus 5.5', 'Opus 5.5'], ['Qwen3.6 35B', 'Qwen3.6 here']], 'same', 'brmodel17c')}`,
      foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="brmake17c" data-i="${i}">Start the new path</button>`});
  },
  brmodel17c: el => { S.brm17c = el.dataset.v; el.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === el))); },
  brmake17c: el => {
    const id = S.chat, i = +el.dataset.i, r = pathsOf17c(id), cur = r.list.find(p => p.id === r.cur), fromUser = blk17c(i)?.k === 'u';
    const name = ($('#br-name17c')?.value || '').trim() || `Try ${r.list.length + 1}`, model = S.brm17c === 'same' ? null : S.brm17c;
    /* approvals stay one object on every path, so a yes or no counts once and Inbox stays right; everything else is copied */
    const keep = threads[id].slice(0, i + 1).filter(b => !['computer', 'typing', 'think'].includes(b.k)).map(b => b.k === 'ask' || b.k === 'ask2' ? b : {...b, fresh: false});
    const p = {id: 'p' + Date.now(), name, parent: cur.id, at: i + 1, self: keep.length, model, made: 'Just now', blocks: keep};
    keep.push({k: 'pass', text: `New path “${name}”${model ? ` · ${model}` : ''}. The original is unchanged.`});
    r.list.push(p); r.cur = p.id; threads[id] = keep; closeDlg(); render();
    if (fromUser) botSay(id, [{k: 'b', html: `<p>Trying this again on the new path${model ? ` with ${esc(model)}` : ''}. The first answer is still in “${esc(cur.name)}”.</p>`}]);
    else setTimeout(() => $('#msg')?.focus({preventScroll: true}), 0);
    toast(`Started “${name}”. Switch back from the marker in the conversation or the side panel’s Branches tab.`);
  }
});
document.addEventListener('change', e => { const k = e.target.dataset?.sel17c; if (k == null) return; const r = pathsOf17c(S.chat), cur = S.cmp17c || [r.list[0].id, r.cur]; cur[+k] = e.target.value; S.cmp17c = cur; ACTS.brcmp17c(); });

/* ---------- Helpers: what a task's sub-agents are doing, thinking and asking ---------- */
S.hp17c = S.hp17c || {};
const HELP17C = {scout: [
  {id: 'h1', name: 'Statement reader', model: 'Opus 5.5', via: 'your Claude account', col: '#A0522D', job: 'Finds the Hartwell charge on the August card statement.', think: 'The August statement should have one Hartwell charge. Once I can read the file I’ll give Scout the exact amount and date, so it can compare them with the invoice.', thinkDone: 'Found it: $2,040.00 to Hartwell Supply on Aug 29. The invoice says $2,140.00, so Scout should report a $100 difference.', steps: 3, cost: '$0.09', done: 'Done · $2,040.00 on Aug 29', req: {id: 'r1', cat: 'Read', what: 'Read card-statement-aug.csv', where: 'Documents/Statements · 16 rows · read only'}},
  {id: 'h2', name: 'Receipt matcher', model: 'Qwen3.6 35B', via: 'on this computer · free', col: '#615CED', job: 'Checks whether a receipt for the charge is already filed.', think: 'There’s no Hartwell receipt in Downloads/receipts. I’d like to leave a short note so Ledger sees the gap at month-end.', thinkDone: 'Saved the note. Ledger will see it at month-end.', steps: 2, cost: '$0.00', done: 'Done · note saved', req: {id: 'r2', cat: 'Change', what: 'Save a note to Library › Notes', where: 'hartwell-aug-check.md · a new file, 3 lines'}}
]};
const waiting17c = id => (HELP17C[id] || []).filter(h => !S.hp17c[h.req.id]).length;
function helperCard17c(h, c) {
  const st = S.hp17c[h.req.id];
  const pill = !st ? '<span class="pill work"><i></i>Needs you</span>' : st === 'allowed' ? `<span class="pill done"><i></i>${esc(h.done)}</span>` : '<span class="pill no"><i></i>Stopped · you said no</span>';
  const ask = !st ? `<div class="hpask17c"><span class="pill idle">${esc(h.req.cat)}</span><span class="grow"><b>${esc(h.req.what)}</b><small>${esc(h.req.where)} · asked by ${esc(h.name)} for ${esc(c.name)}</small></span><span class="hpbtn17c"><button class="btn ghost sm" type="button" data-act="hpdo17c" data-id="${h.req.id}" data-v="denied">No</button><button class="btn pri sm" type="button" data-act="hpdo17c" data-id="${h.req.id}" data-v="allowed">Allow once</button></span></div>`
    : `<div class="hpdone17c">${ic(st === 'allowed' ? 'check' : 'x', 's')}<span>${esc(h.req.what)}: ${st === 'allowed' ? 'allowed once, by you' : 'not allowed'}</span></div>`;
  const thought = st === 'allowed' ? h.thinkDone : st ? 'Stopped before reading or writing anything. Scout carries on without it.' : h.think;
  return `<div class="hpc17c"><div class="hpt17c"><span class="hpav17c" style="--c:${h.col}">${esc(h.name[0])}</span><span class="grow"><b>${esc(h.name)}</b><small>${esc(h.model)} · ${esc(h.via)}</small></span>${pill}</div><p class="hpjob17c">${esc(h.job)}</p><details class="hpth17c"><summary>${ic('chev', 's chev')}What it’s thinking</summary><p>${esc(thought)}</p></details>${ask}<small class="hpm17c">${h.steps} steps · ${h.cost}</small></div>`;
}
function helpersHTML17c(id) {
  const list = HELP17C[id], c = C(id), wait = waiting17c(id);
  return `<section class="hp17c" id="helpers17c" aria-label="Helpers"><div class="hph17c"><b>Helpers</b><small>${list.length} started by ${esc(c.name)}${wait ? ` · ${wait} need${wait > 1 ? '' : 's'} you` : ''}</small></div>${list.map(h => helperCard17c(h, c)).join('')}<p class="hint">Each helper runs on its own model and asks for its own approvals. Nothing a helper does skips your rules.</p></section>`;
}
Object.assign(ACTS, {
  hpdo17c: el => { const k = el.dataset.id, v = el.dataset.v, h = Object.values(HELP17C).flat().find(x => x.req.id === k); S.hp17c[k] = v; render();
    toast(v === 'allowed' ? `Allowed once: ${h.name} may ${h.req.what.charAt(0).toLowerCase() + h.req.what.slice(1)}.` : `Not allowed. ${h.name} stops; Scout carries on without it.`); },
  hpopen17c: () => { closeDlg(); closePop(); S.pane = 'activity'; render(); setTimeout(() => $('#helpers17c')?.scrollIntoView({block: 'start', behavior: calm11() ? 'auto' : 'smooth'}), 30); }
});
afterChat15(() => {
  const list = HELP17C[S.chat]; if (!list || pathsOf17c(S.chat).cur !== 'main') return; const wait = waiting17c(S.chat);
  const at = $('#scroll .thread [data-note="computer"]')?.closest('.b') || $('#scroll .thread > :last-child');
  at?.insertAdjacentHTML('afterend', `<button type="button" class="hl17c" data-act="hpopen17c">${list.map(h => `<span class="hpav17c" style="--c:${h.col}">${esc(h.name[0])}</span>`).join('')}<span>${list.length} helpers${wait ? ` · <b>${wait} need${wait > 1 ? '' : 's'} you</b>` : ' · done'}</span>${ic('chev', 's')}</button>`);
});

/* ---------- diagrams in answers and artifacts (drawn by hand as SVG; no library) ---------- */
const DIA17C = {title: 'Who fixes what', src: 'flowchart LR\n  A([Something breaks]) --> B{Repair under $150?}\n  B -- yes --> C[You pay · clause 9.2]\n  B -- no --> D[Landlord pays · clause 9.3]\n  D --> E[Tell them in writing · within 7 days]'};
function diaSVG17c() {
  const node = (x, y, w, h, t, s, cls = '') => `<g class="dn17c ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${cls ? h / 2 : 9}"/><text x="${x + w / 2}" y="${y + (s ? h / 2 - 2 : h / 2 + 4)}">${esc(t)}</text>${s ? `<text class="ds17c" x="${x + w / 2}" y="${y + h / 2 + 13}">${esc(s)}</text>` : ''}</g>`;
  const head = (x, y) => `<path class="da17c" d="M${x - 8} ${y - 4.5}L${x} ${y}L${x - 8} ${y + 4.5}z"/>`;
  return `<svg class="dsvg17c" viewBox="0 0 640 250" role="img" aria-label="Flowchart: something breaks; if the repair is under $150 you pay (clause 9.2); otherwise the landlord pays (clause 9.3) and you tell them in writing within 7 days.">
    <path class="de17c" d="M126 124H143"/>${head(143, 124)}<path class="de17c" d="M205 84V59H300"/>${head(300, 59)}<path class="de17c" d="M205 164V190H300"/>${head(300, 190)}<path class="de17c" d="M450 190H482"/>${head(482, 190)}
    <text class="dl17c" x="214" y="74">yes</text><text class="dl17c" x="214" y="182">no</text>
    ${node(8, 102, 118, 44, 'Something breaks', '', 'start17c')}<g class="dn17c dd17c"><path d="M205 84L267 124L205 164L143 124z"/><text x="205" y="120">Repair under</text><text x="205" y="135">$150?</text></g>
    ${node(300, 36, 150, 46, 'You pay', 'clause 9.2')}${node(300, 167, 150, 46, 'Landlord pays', 'clause 9.3')}${node(482, 167, 150, 46, 'Tell them in writing', 'within 7 days')}</svg>`;
}
function diaCard17c(b) {
  return `<div class="card dia17c" data-note="dia17c"><div class="card-h"><b>${esc(b.title)}</b><span class="pill idle ml">Diagram</span></div><p class="note">Drawn from the text below, in a sealed frame: it can’t run a script or reach the internet.</p><div class="dwrap17c">${diaSVG17c()}</div>
    <div class="acts"><button class="btn sm" type="button" data-act="diaopen17c">Open larger</button><button class="btn sm" type="button" data-act="diacopy17c">Copy the text</button><button class="btn sm" type="button" data-act="diasave17c">${S.diaSaved17c ? 'In Library' : 'Save to Library'}</button></div>
    <details><summary>${ic('chev', 's chev')}The text that drew it</summary><pre>${esc(b.src)}</pre></details></div>`;
}
if (threads.field && !threads.field.some(b => b.k === 'dia17c')) threads.field.push({k: 'u', text: 'Draw how a repair gets handled under this lease.'}, {k: 'b', html: '<p>Here’s who pays, from clauses 9.2 and 9.3. Anything under $150 is yours; above that, tell the landlord in writing.</p>'}, {k: 'dia17c', title: DIA17C.title, src: DIA17C.src});
Object.assign(ACTS, {
  diaopen17c: () => openDlg({title: DIA17C.title, wide: true, body: `<div class="dwrap17c big17c">${diaSVG17c()}</div><p class="hint" style="margin:8px 0">From Fieldnotes, about lease-2026.pdf. Shown as an artifact: a sealed frame with no scripts and no internet.</p><pre class="dsrc17c">${esc(DIA17C.src)}</pre>`, foot: `<button class="btn" type="button" data-act="diacopy17c">Copy the text</button><button class="btn pri" type="button" data-act="diasave17c">${S.diaSaved17c ? 'In Library' : 'Save to Library'}</button>`}),
  diacopy17c: () => toast('Copied the diagram’s text. Paste it anywhere that reads Mermaid.'),
  diasave17c: () => { const was = S.diaSaved17c; S.diaSaved17c = true; closeDlg(); render(); toast(was ? 'Already in Library › Made for you.' : 'Saved to Library › Made for you as who-fixes-what.svg.'); }
});
addSection15('library', 'made', () => S.diaSaved17c ? `<div class="sec x15-sec dlib17c"><h2>Diagrams</h2><div class="dlrow17c"><span class="dthumb17c">${diaSVG17c()}</span><span class="grow"><b>${esc(DIA17C.title)}</b><small>Diagram · from Fieldnotes · saved today</small></span><button class="btn sm" type="button" data-act="diaopen17c">Open</button></div></div>` : '', 'bottom');

/* ---------- Quick ask: a small box from anywhere, into a new conversation ---------- */
S.qa17c = null;
const qaKeys17c = () => isMac16() ? '⌥ Space' : 'Ctrl Shift Space';
function qaHTML17c() {
  const q = S.qa17c, who = [C('branch'), ...trunkList().filter(t => t.id !== 'new')];
  return `<div class="qa17c" role="dialog" aria-label="Quick ask"><div class="qah17c">${ic('quick17c', 's')}<b>Quick ask</b><span class="qak17c">${kbd15(qaKeys17c())}</span><small>from any app, even with Branch in the background</small><button class="icon-btn" type="button" data-act="qaclose17c" aria-label="Close quick ask">${ic('x', 's')}</button></div>
    <input id="qa-in17c" class="inp" placeholder="Ask anything…" autocomplete="off" spellcheck="false" value="${esc(q.text || '')}" aria-label="Your question">
    <div class="qato17c" role="radiogroup" aria-label="Send to"><span>To</span>${who.map(c => `<button type="button" role="radio" aria-checked="${q.to === c.id}" data-act="qato17c" data-v="${c.id}">${av(c, 18)}<span>${esc(c.name)}${c.paused ? ' · paused' : ''}</span></button>`).join('')}</div>
    <div class="qaf17c"><small>Starts a new conversation. Enter sends, Esc closes.</small><button class="btn pri sm" type="button" data-act="qasend17c">Start</button></div></div>`;
}
function drawQa17c() {
  $('.qawrap17c')?.remove(); if (!S.qa17c) return;
  const w = document.createElement('div'); w.className = 'qawrap17c'; w.innerHTML = qaHTML17c(); app.appendChild(w);
  const i = $('#qa-in17c'); i?.focus({preventScroll: true}); if (i) i.selectionStart = i.selectionEnd = i.value.length;
}
Object.assign(ACTS, {
  qa17c: () => { closePop(); closeDlg(); S.qa17c = {to: S.qa17c?.to || 'branch', text: ''}; drawQa17c(); },
  qaclose17c: () => { S.qa17c = null; drawQa17c(); },
  qato17c: el => { S.qa17c.text = $('#qa-in17c')?.value || ''; S.qa17c.to = el.dataset.v; drawQa17c(); },
  qasend17c: () => {
    const text = ($('#qa-in17c')?.value || '').trim(), to = S.qa17c?.to || 'branch';
    if (!text) { toast('Type a question first.'); $('#qa-in17c')?.focus(); return; }
    S.qa17c = null; drawQa17c();
    if (to === 'branch') newConv(); else ACTS['new-with']({dataset: {id: to}});
    const id = S.chat, c = C(id), t = C(to); c.name = text.length > 38 ? text.slice(0, 36) + '…' : text; c.preview = text; threads[id].push({k: 'u', text, fresh: true});
    if (t?.paused) { say17c(id, `${t.name} is paused. This waits until you resume it.`); render(); toast(`Saved for ${t.name}, who is paused.`); return; }
    render(); botSay(id, [{k: 'b', html: `<p>Got it. I’ll start on this${to === 'branch' ? '' : ` as ${esc(t.name)}`} and check with you before anything is sent or changed.</p>`}]);
    toast(`New conversation${to === 'branch' ? '' : ` with ${t.name}`}, from Quick ask.`);
  }
});
document.addEventListener('keydown', e => {
  if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') || (isMac16() && e.altKey && e.code === 'Space')) { e.preventDefault(); e.stopImmediatePropagation(); ACTS[S.qa17c ? 'qaclose17c' : 'qa17c'](); return; }
  if (!S.qa17c) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); ACTS.qaclose17c(); }
  else if (e.key === 'Enter' && e.target.id === 'qa-in17c') { e.preventDefault(); e.stopImmediatePropagation(); ACTS.qasend17c(); }
}, true);
document.addEventListener('click', e => { if (S.qa17c && e.target.classList?.contains('qawrap17c')) ACTS.qaclose17c(); });
{ const _nm17c = POPS.newmenu; POPS.newmenu = () => _nm17c() + mi('qa17c', 'quick17c', 'Quick ask', `<kbd>${esc(qaKeys17c())}</kbd>`); }
{ const _ss17c = showShortcuts; showShortcuts = function () { _ss17c.apply(this, arguments); dlgEl?.querySelector('.keys15')?.insertAdjacentHTML('beforeend', `<div class="k-row15 kq17c"><span>Quick ask, from any app</span><span class="kqk17c">${kbd15(qaKeys17c())}</span><span></span></div>`); }; }

/* ---------- unread: conversations and Inbox items ---------- */
if (C('field')) C('field').unread = true;
S.iu17c = S.iu17c || {'Send this email to Dana Okafor?': 1, 'Install a PDF reading tool?': 1, 'September expense report': 1, 'Supplier quotes': 1};
{ const _rs17c = renderSide; renderSide = function () {
  _rs17c.apply(this, arguments);
  if (!chats.some(c => c.unread && c.id !== S.chat)) return;
  const lh = [...document.querySelectorAll('#side .lh')].find(x => x.textContent.trim().toLowerCase() === 'recent');
  if (lh && !lh.querySelector('.mar17c')) { lh.classList.add('lh17c'); lh.insertAdjacentHTML('beforeend', '<button type="button" class="mar17c" data-act="markread17c">Mark all read</button>'); }
}; }
{ const _rm17c = POPS.rowmenu; POPS.rowmenu = id => { const h = _rm17c(id), c = C(id), cut = h.indexOf('</button>') + 9; return h.slice(0, cut) + mi('unread17c', 'chat', c.unread ? 'Mark as read' : 'Mark as unread', '', `data-id="${id}"`) + h.slice(cut); }; }
function decorInbox17c() {
  if (!['needs', 'finished'].includes(S.tabs?.inbox)) return;
  document.querySelectorAll('#main .place .rows .prow').forEach(r => { const k = r.querySelector('.grow b')?.textContent.trim(); if (k && S.iu17c[k] && !r.classList.contains('unr17c')) { r.classList.add('unr17c'); r.dataset.k17c = k; r.insertAdjacentHTML('afterbegin', '<i class="udot17c" role="img" aria-label="Unread"></i>'); } });
  const tabs = $('#main .place .tabs');
  if (tabs && Object.values(S.iu17c).some(Boolean) && !tabs.querySelector('.mar17c')) tabs.insertAdjacentHTML('beforeend', '<button type="button" class="mar17c" data-act="inread17c">Mark all read</button>');
}
{ const _ri17c = renderInbox; renderInbox = function () { _ri17c.apply(this, arguments); safe15(decorInbox17c); }; }
document.addEventListener('click', e => { const r = e.target.closest?.('#main .prow.unr17c'); if (r && e.target.closest('button')) S.iu17c[r.dataset.k17c] = 0; }, true);
Object.assign(ACTS, {
  markread17c: () => { chats.forEach(c => { c.unread = false; }); render(); toast('All conversations marked read.'); },
  unread17c: el => { const c = C(el.dataset.id); c.unread = !c.unread; closePop(); render(); toast(c.unread ? (c.id === S.chat ? 'Marked unread. The dot shows once you leave this conversation.' : `${c.name}: marked unread.`) : `${c.name}: marked read.`); },
  inread17c: () => { Object.keys(S.iu17c).forEach(k => { S.iu17c[k] = 0; }); render(); toast('Inbox marked read. Nothing was answered or dismissed.'); }
});

/* ---------- flag this reply: reasons and a note, kept on this computer ---------- */
S.flags17c = S.flags17c || []; S.flagSend17c = S.flagSend17c || false; S.fl17c = null;
const REASONS17C = ['Wrong or made up', 'Didn’t do what I asked', 'Did something I didn’t ask for', 'Unsafe or rude', 'Too long or unclear', 'Something else'];
function flagSendRow17c() {
  const on = S.flagSend17c, owner = S.person === 0;
  const sub = on ? 'Only this reply and your note. No other conversation, file or memory.' : owner ? 'Off. You can allow it in Settings › Data & usage.' : 'Off. Only Taofik can turn this on.';
  return `<div class="flsend17c ${on ? '' : 'off17c'}"><input type="checkbox" class="sw" id="fl-send17c" ${on ? '' : 'disabled'} aria-label="Also send to the Branch team"><span class="grow"><b>Also send to the Branch team</b><small>${sub}</small></span>${!on && owner ? '<button class="link" type="button" data-act="flgo17c">Open that setting</button>' : ''}</div>`;
}
ACTS.flag = el => {
  const i = idxOf17c(el) ?? lastBot17c(); if (i == null) { toast('There’s no reply to flag here yet.'); return; }
  closePop(); S.fl17c = {i, pick: []}; const b = blk17c(i);
  openDlg({title: 'Flag this reply', body: `<p class="lede" style="margin:0 0 10px">What went wrong with “${esc(plain15(b).slice(0, 70))}”? The flag is kept on this computer with the reply, so you can look back at it.</p><div class="flr17c" role="group" aria-label="What went wrong">${REASONS17C.map((r, k) => `<button type="button" class="chip6" data-act="flr17c" data-v="${k}" aria-pressed="false">${esc(r)}</button>`).join('')}</div><div class="field"><label for="fl-note17c">A note (optional)</label><textarea class="inp" id="fl-note17c" rows="3" placeholder="What should it have done?"></textarea></div>${flagSendRow17c()}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="flsave17c">Keep the flag</button>`});
};
Object.assign(ACTS, {
  flr17c: el => { const k = +el.dataset.v, p = S.fl17c.pick, at = p.indexOf(k); at < 0 ? p.push(k) : p.splice(at, 1); el.setAttribute('aria-pressed', String(at < 0)); },
  flsave17c: () => {
    const f = S.fl17c, b = blk17c(f?.i); if (!b) { closeDlg(); return; }
    if (!f.pick.length) { toast('Pick at least one reason.'); return; }
    const reasons = f.pick.sort((a, c) => a - c).map(k => REASONS17C[k]), note = ($('#fl-note17c')?.value || '').trim(), sent = !!$('#fl-send17c')?.checked && S.flagSend17c;
    b.flag17c = {reasons, note, sent}; S.flags17c.push({chat: S.chat, b, text: plain15(b).slice(0, 80), reasons, note, sent});
    closeDlg(); render(); toast(sent ? 'Flagged and sent to the Branch team: this reply and your note only.' : 'Flagged. Kept on this computer only.');
  },
  flrm17c: el => { const b = blk17c(el.dataset.i); if (!b) return; delete b.flag17c; S.flags17c = S.flags17c.filter(x => x.b !== b); render(); toast('Flag removed.'); },
  flgo17c: () => { closeDlg(); S.view = 'settings'; S.setPage = 'usage'; render(); setTimeout(() => $('[data-note="flag17c"]')?.scrollIntoView({block: 'center'}), 30); },
  flforget17c: el => { const x = S.flags17c[+el.dataset.v]; if (x) { delete x.b.flag17c; S.flags17c.splice(+el.dataset.v, 1); } render(); toast('Flag removed.'); }
});
addSettings15('usage', 0, () => {
  const owner = S.person === 0, list = S.flags17c;
  const rows = list.map((x, k) => `<div class="prow">${ic('flag', 's')}<span class="grow"><b>${esc(x.reasons.join(', '))}</b><small>${esc(C(x.chat)?.name || '')} · “${esc(x.text)}”${x.sent ? ' · sent' : ' · kept here'}</small></span><button class="btn ghost sm" type="button" data-act="flforget17c" data-v="${k}">Remove</button></div>`).join('');
  return `<div class="sec x15-sec" data-note="flag17c"><h2>Flagged replies</h2><div class="ctl"><b>Let me send a flagged reply to the Branch team</b><input class="sw" type="checkbox" data-sw17c="flagsend" ${S.flagSend17c ? 'checked' : ''} ${owner ? '' : 'disabled'} aria-label="Let me send a flagged reply to the Branch team"><small>${owner ? 'Off until you turn it on. Even then each flag asks, and only that reply and your note go.' : 'Only Taofik can turn this on.'}</small></div>${list.length ? `<p class="hint" style="margin:6px 0">${list.length} flagged, kept on this computer.</p><div class="rows">${rows}</div>` : ''}</div>`;
});
document.addEventListener('change', e => { if (e.target.dataset?.sw17c !== 'flagsend') return; S.flagSend17c = e.target.checked; toast(S.flagSend17c ? 'On. When you flag a reply you can choose to send it; nothing goes by itself.' : 'Off. Flags stay on this computer.'); });

/* ---------- switching models drops earlier thinking: say so in the conversation ---------- */
{ const _pm17c = ACTS['pick-model']; ACTS['pick-model'] = el => {
  const was = S.model?.name || 'GPT-6 Sol', to = el.dataset.v, list = threads[S.chat];
  if (S.view === 'chat' && list && was !== to && list.some(b => b.k === 'b' || b.k === 'think')) {
    const last = list[list.length - 1];
    if (last?.k === 'drop17c') { if (last.from === to) list.pop(); else last.to = to; } else list.push({k: 'drop17c', from: was, to});
  }
  _pm17c(el);
}; }
ACTS.dropwhy17c = el => openPop(el, `<div class="pt">Why earlier thinking isn’t passed on</div><p class="pp">A model’s private reasoning only makes sense to the model that wrote it, and some services refuse it from another. Branch keeps every message, file and tool result, so the new model picks up where things are; it starts its own thinking fresh.</p>`);

/* ---------- Tier 2: room rules (who answers, how they work together) ---------- */
S.rrule17c = S.rrule17c || {room: 'mention', grp: S.grp10?.rule || 'mention'}; S.rpat17c = S.rpat17c || {};
const RULES17C = [['lead', 'A lead Trunk decides', 'It reads each message and picks who answers.', 'lead decides'], ['all', 'Everyone, every time', 'Every Trunk in the room answers.', 'everyone answers'], ['mention', 'Only those you @mention', 'Nobody mentioned means everyone.', 'mentions only']];
const ruleOf17c = id => RULES17C.find(x => x[0] === (S.rrule17c[id] || 'mention'));
const patName17c = v => (PATTERNS15.find(p => p[0] === v) || PATTERNS15[1])[1];
POPS.rr17c = () => { const id = S.chat, r = ruleOf17c(id)[0], o = S.rpat17c[id];
  return `<div class="pt">Room rules</div><div class="ph">Who answers</div>${RULES17C.map(([v, t, s]) => radio('rrule17c', v, t, s, r === v)).join('')}<hr><div class="ph">How the Trunks work together here</div>${radio('rpat17c', 'default', `Your default: ${esc(patName17c(S.pat15))}`, 'Set in Settings › Models › Defaults', !o)}${PATTERNS15.map(p => radio('rpat17c', p[0], esc(p[1]), esc(p[2]), o === p[0])).join('')}`; };
{ const _cm17c = POPS.chatmenu; POPS.chatmenu = () => { const h = _cm17c(); if (C(S.chat)?.kind !== 'room') return h;
  return h.replace(/<button[^>]*data-msg="Room rules:[^"]*"[^>]*>[\s\S]*?<\/button>/, mi('rr17c', 'sliders', 'Room rules', esc(ruleOf17c(S.chat)[3]))); }; }
{ const _sl17c = statusLine; statusLine = function (c) { const r = _sl17c.apply(this, arguments); return c?.kind === 'room' ? [r[0], `${r[1]} · ${ruleOf17c(c.id)[3]}`] : r; }; }
{ const _gm17c = ACTS['grp-make']; ACTS['grp-make'] = el => { const rule = S.grp10.rule, was = S.chat; _gm17c(el); if (S.chat !== was) { S.rrule17c[S.chat] = rule; render(); } }; }
Object.assign(ACTS, {
  rr17c: el => { const a = headEl14()?.querySelector('[data-act="chatmenu"]') || el; openPop(a, POPS.rr17c(), {right: true, force: true}); popEl?.classList.add('rr17c'); },
  rrule17c: el => { const id = S.chat, R = RULES17C.find(x => x[0] === el.dataset.v); closePop(); if (ruleOf17c(id) === R) return;
    S.rrule17c[id] = R[0]; say17c(id, `Room rule changed by Taofik: ${R[1].toLowerCase()}. ${R[2]}`); render(); toast(`${R[1]}, in ${C(id).name} from now on.`); },
  rpat17c: el => { const id = S.chat, v = el.dataset.v; closePop(); if (v === 'default') delete S.rpat17c[id]; else S.rpat17c[id] = v;
    const n = patName17c(v === 'default' ? S.pat15 : v); say17c(id, v === 'default' ? `This room follows your default again: ${n}.` : `This room now works as “${n}”, instead of your default.`); render(); toast(`${C(id).name}: ${n}.`); }
});

/* ---------- Tier 2: the owner's default way Trunks work together (Settings › Models › Defaults, at Advanced) ---------- */
addSettings15('models', 1, () => { if (S.modelsTab !== 'defaults') return ''; const over = Object.entries(S.rpat17c).filter(([id]) => C(id));
  return `<div class="sec x15-sec" data-note="pat17c"><h2>How Trunks work together, by default</h2><p class="hint" style="margin:0 0 10px">For rooms and big tasks. A Trunk may suggest another pattern for one task; yours wins unless you agree. A room can use its own, in its Room rules.</p><div class="pats15 pats17c" role="radiogroup" aria-label="Default way Trunks work together">${PATTERNS15.map(p => `<button type="button" role="radio" class="pat15" aria-checked="${S.pat15 === p[0]}" data-act="pat15" data-v="${p[0]}">${patSVG15(p)}<b>${esc(p[1])}</b><small>${esc(p[2])}</small></button>`).join('')}</div>${sw15('A Trunk may suggest a different pattern', 'It asks first; nothing changes until you agree.', true)}${over.length ? `<p class="hint" style="margin:8px 0 0">Rooms with their own: ${over.map(([id, v]) => `${esc(C(id).name)} (${esc(patName17c(v))})`).join(', ')}.</p>` : ''}</div>`; });

/* ---------- Tier 2: pause a Trunk, pause all ---------- */
S.tlx17c = S.tlx17c || {};
const logPause17c = (id, t) => { (S.tlx17c[id] = S.tlx17c[id] || []).push(t); };
function pauseDlg17c(list) {
  const work = list.filter(c => c.status === 'working'), one = list.length === 1, names = work.map(c => c.name).join(' and ');
  openDlg({title: one ? `Pause ${list[0].name}?` : 'Pause all Trunks?', body: `<p class="lede" style="margin:0 0 10px">${esc(names)} ${work.length > 1 ? 'are' : 'is'} working. While paused, nothing new starts: schedules, triggers and messages wait until you resume.</p><div class="opts"><label class="opt"><input type="radio" name="pz17c" id="pz-after17c" checked><b>When the current task ends</b><small>${esc(work[0]?.preview || 'It finishes first.')}</small></label><label class="opt"><input type="radio" name="pz17c" id="pz-now17c"><b>Now</b><small>Stops what’s running. Nothing half-done is sent, and checkpoints stay.</small></label></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="pausedo17c" data-ids="${list.map(c => c.id).join(',')}">Pause</button>`});
}
function pauseOne17c(c, now) {
  if (c.status === 'working' && !now) { c.pauseAfter17c = true; say17c(c.id, `${c.name} will pause when this task ends. Asked by Taofik.`); logPause17c(c.id, 'Asked to pause after this task'); return; }
  if (c.status === 'working') { (threads[c.id] || []).forEach(b => { if (b.k === 'computer' && b.state === 'working') b.state = 'stopped'; }); c.status = 'idle'; say17c(c.id, `Paused by Taofik. What was running stopped; nothing half-done was sent.`); }
  c.paused = true; c.pauseAfter17c = false; logPause17c(c.id, 'Paused');
}
Object.assign(ACTS, {
  pausedo17c: el => { const now = !!$('#pz-now17c')?.checked, list = el.dataset.ids.split(',').map(C).filter(Boolean); closeDlg(); list.forEach(c => pauseOne17c(c, now)); quiet17c(); render();
    toast(list.length > 1 ? (now ? 'All Trunks paused. Nothing new starts.' : 'Trunks that are working pause when their task ends; the rest are paused now.') : now ? `${list[0].name} is paused.` : `${list[0].name} will pause when this task ends.`); },
  pausenow17c: el => { const c = C(el.dataset.id); pauseOne17c(c, true); quiet17c(); render(); toast(`${c.name} is paused.`); },
  pausekeep17c: el => { const c = C(el.dataset.id); c.pauseAfter17c = false; say17c(c.id, `${c.name} keeps going; the pause was cancelled.`); render(); toast(`${c.name} keeps going.`); },
  pauseall17c: () => { closePop(); const all = trunkList(), live = all.filter(c => !c.paused);
    if (!live.length) { all.forEach(c => { c.paused = false; c.pauseAfter17c = false; logPause17c(c.id, 'Resumed'); }); render(); toast('All Trunks are back.'); return; }
    if (live.some(c => c.status === 'working')) { pauseDlg17c(live); return; }
    live.forEach(c => pauseOne17c(c, true)); quiet17c(); render(); toast('All Trunks paused. Nothing new starts.'); },
  pzlist17c: el => { const ps = trunkList().filter(c => c.paused || c.pauseAfter17c);
    openPop(el, `<div class="ph">Paused</div>${ps.map(c => `<div class="mi pzrow17c">${av(c, 22)}<span class="grow"><span class="mi-t">${esc(c.name)}</span><span class="mi-s">${c.paused ? 'Nothing new starts' : 'Pauses after this task'}</span></span><button class="btn sm" type="button" data-act="${c.paused ? 'pausetrunk' : 'pausekeep17c'}" data-id="${c.id}">${c.paused ? 'Resume' : 'Keep going'}</button></div>`).join('')}<hr>${mi('pauseall17c', 'play', trunkList().every(c => c.paused) ? 'Resume all Trunks' : 'Pause all Trunks')}`, {right: true}); }
});
{ const _pt17c = ACTS.pausetrunk; ACTS.pausetrunk = el => {
  const c = C(el.dataset.id); if (!c) return;
  if (c.pauseAfter17c && !c.paused) { closePop(); openDlg({title: `${c.name} pauses after this task`, body: `<p class="lede" style="margin:0">Pause now instead, or let it keep going without a pause?</p>`, foot: `<button class="btn ghost" type="button" data-act="pausekeep17c" data-id="${c.id}">Keep going</button><button class="btn pri" type="button" data-act="pausenow17c" data-id="${c.id}">Pause now</button>`}); return; }
  if (!c.paused && c.status === 'working') { closePop(); pauseDlg17c([c]); return; }
  const was = c.paused; quiet17c(); _pt17c(el); logPause17c(c.id, was ? 'Resumed' : 'Paused');
}; }
{ const _pa17c = ACTS.pauseall; ACTS.pauseall = el => { if (trunkList().some(c => !c.paused && c.status === 'working')) { ACTS.pauseall17c(el); return; } quiet17c(); _pa17c(el); }; }
{ const _t10 = ACTS.tasks10; ACTS.tasks10 = el => { _t10(el); popEl?.insertAdjacentHTML('beforeend', mi('pauseall17c', 'pause', trunkList().every(c => c.paused) ? 'Resume all Trunks' : 'Pause all Trunks')); }; }
afterChat15(() => {
  const c = C(S.chat); if (c?.kind !== 'trunk' || !(c.paused || c.pauseAfter17c)) return;
  $('#scroll .thread')?.insertAdjacentHTML('beforeend', c.paused
    ? `<div class="pz17c" role="note">${ic('pause', 's')}<span class="grow"><b>${esc(c.name)} is paused</b><small>Nothing new starts. What you send waits until you resume.</small></span><button class="btn sm" type="button" data-act="pausetrunk" data-id="${c.id}">Resume</button></div>`
    : `<div class="pz17c" role="note">${ic('pause', 's')}<span class="grow"><b>${esc(c.name)} will pause when this task ends</b><small>It finishes what it’s doing, then waits for you.</small></span><button class="btn ghost sm" type="button" data-act="pausekeep17c" data-id="${c.id}">Keep going</button><button class="btn sm" type="button" data-act="pausenow17c" data-id="${c.id}">Pause now</button></div>`);
});
{ const _st17c = renderStatus; renderStatus = function () { _st17c.apply(this, arguments);
  const n = trunkList().filter(c => c.paused || c.pauseAfter17c).length, sb = $('#statusbar'); if (!n || !sb || sb.querySelector('.pzsb17c')) return;
  const html = `<button class="sb pzsb17c" type="button" data-act="pzlist17c" data-tip="Paused Trunks">${ic('pause', 's')}${trunkList().every(c => c.paused) ? 'All Trunks paused' : `${n} paused`}</button>`;
  const t = sb.querySelector('[data-act="tasks10"]'); t ? t.insertAdjacentHTML('afterend', html) : sb.insertAdjacentHTML('afterbegin', html);
}; }

/* ---------- What's new ---------- */
NEW13.splice(1, 0, ['tl17c', 'Every step, and parallel paths', 'Replay a task step by step, branch a conversation from any message, leave a message out of context, and see what helpers are doing.', 'chat', {id: 'scout'}]);
