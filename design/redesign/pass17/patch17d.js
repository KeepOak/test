/* ================= pass 17d: computers, reach, automation and skills ================= */
/* One block, so nothing here can clash with another part's names. Every class, action and state key ends in 17d.
   Features: always-on cloud computers per Trunk; phone calls and meeting notes; the "learn this app" workbook skill;
   decision models; words to a confirmed schedule; procedure changes as proposals with history; connectors you add
   yourself with a safety check; chat-app polish and Settings › Chat apps; computers per Trunk; release notes. */
{
Object.assign(P, {
  cloud17d: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z"/>',
  call17d: '<path d="M5 4.5h3.5l1.5 4-2 1.5a10 10 0 0 0 6 6l1.5-2 4 1.5V19a1.5 1.5 0 0 1-1.5 1.5A15.5 15.5 0 0 1 3.5 6 1.5 1.5 0 0 1 5 4.5z"/>',
  meet17d: '<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="8" r="2.3"/><path d="M15.5 13.2A4.5 4.5 0 0 1 21 17.5"/>',
  book17d: '<path d="M6 3.5h9.5L19 7v13.5H6z"/><path d="M15 3.5V7h4M9 11l1.5 1.5L13 10M9 16l1.5 1.5L13 15M15 11.5h1.5M15 16.5h1.5"/>',
  judge17d: '<path d="M12 4v16M8 20h8M5 8h14M7 8l-3 6a3 3 0 0 0 6 0zM17 8l-3 6a3 3 0 0 0 6 0z"/>',
  news17d: '<rect x="4" y="4.5" width="16" height="15" rx="2"/><path d="M8 9h8M8 12.5h8M8 16h5"/>'
});
const D = S.d17 = S.d17 || {};
const quick = () => calm11();
const later = (fn, ms) => setTimeout(fn, quick() ? Math.min(ms, 120) : ms);
const trunks = () => trunkList().filter(t => t.id !== 'new');
const pillOf = (cls, txt) => `<span class="pill ${cls}"><i></i>${esc(txt)}</span>`;
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem('branch-proto-' + k)) ?? d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem('branch-proto-' + k, JSON.stringify(v)); } catch (e) {} };

/* =====================================================================================================
   1. Always-on cloud computers, one per Trunk. Off until you choose: it costs money and runs outside this PC.
   ===================================================================================================== */
const SIZES = {small: ['Small', '2 vCPU · 4 GB', 4, 0.03], standard: ['Standard', '4 vCPU · 8 GB', 8, 0.07], large: ['Large', '8 vCPU · 16 GB', 16, 0.14]};
const WHERES = {keepoak: ['KeepOak', 'Your keepoak.com plan'], daytona: ['Daytona', 'Your own Daytona account'], modal: ['Modal', 'Your own Modal account'], ssh: ['A server of yours', 'Over SSH · Proposal']};
const REGIONS = ['US East (Virginia)', 'US West (Oregon)', 'Europe (Frankfurt)'];
const cost = size => { const [, , base, hr] = SIZES[size]; return {month: Math.round(base + hr * 60), max: Math.round(base + hr * 720)}; };
const STATE = {sleeping: ['idle', 'Sleeping'], working: ['work', 'Working'], stopped: ['no', 'Stopped'], starting: ['work', 'Starting']};
const clouds = () => COMPUTERS.filter(x => x.cloud17d);
const cloudOf = id => COMPUTERS.find(x => x.id === id && x.cloud17d);
D.offer = D.offer || 'show';
function makeCloud(o) {
  const t = C(o.trunk), id = 'cloud-' + o.trunk + '-' + Date.now().toString(36);
  const c = {id, name: `${t.name}’s cloud computer`, icon: 'cloud17d', kind: 'linux', where: 'cloud',
    os: `Linux · ${WHERES[o.where][0]} · ${o.region}`, reach: 'Always on. Keeps working while this PC sleeps or is off.',
    cloud17d: {trunk: o.trunk, where: o.where, region: o.region, size: o.size, sleep: o.sleep, cap: o.cap, state: 'starting', spent: 0, task: o.task || ''}};
  COMPUTERS.push(c);
  const l = S.compsFor[o.trunk] = S.compsFor[o.trunk] || []; if (!l.includes(id)) l.push(id);
  if (o.alsoFor) { const r = S.compsFor[o.alsoFor] = S.compsFor[o.alsoFor] || []; r.push(id); S.compFor[o.alsoFor] = id; }
  later(() => { c.cloud17d.state = o.task ? 'working' : 'sleeping'; render(); toast(o.task ? `${c.name} took over: ${o.task}. You can let this PC sleep.` : `${c.name} is ready and asleep. It wakes when ${t.name} needs it.`); }, 1600);
  return c;
}
const cloudLine = x => { const k = x.cloud17d, c = cost(k.size); return `${WHERES[k.where][0]} · ${k.region} · ${SIZES[k.size][0]}, ${SIZES[k.size][1]} · about $${c.month} a month`; };
function cloudBtns(x) {
  const s = x.cloud17d.state, b = (v, l, pri) => `<button class="btn ${pri ? 'pri ' : ''}sm" type="button" data-act="clstate17d" data-id="${x.id}" data-v="${v}">${l}</button>`;
  return s === 'sleeping' ? b('wake', 'Wake') + b('stop', 'Stop') : s === 'working' ? b('sleep', 'Put to sleep') + b('stop', 'Stop') : s === 'stopped' ? b('start', 'Start') + `<button class="btn ghost sm" type="button" data-act="clrm17d" data-id="${x.id}">Remove</button>` : '';
}
function cloudCard(x) {
  const k = x.cloud17d, [cls, word] = STATE[k.state];
  return `<div class="comp7-card cl-card17d" data-cl17d="${x.id}"><span class="ico-tile">${ic('cloud17d', 's')}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(cloudLine(x))}</small>
    <span class="c7-reach">${k.state === 'working' ? esc(k.task || 'Working') + ' · keeps going while this PC sleeps' : k.state === 'stopped' ? 'Stopped: nothing runs and only its disk is billed, about $1 a month.' : 'Asleep. Wakes by itself when ' + esc(C(k.trunk).name) + ' needs it.'}</span>
    <span class="cl-key17d">${ic('lock', 's')}Its ${esc(WHERES[k.where][0])} key is in the locker (Saved sign-ins). Branch never shows it.</span>
    <span class="cl-acts17d">${cloudBtns(x)}</span></span>${pillOf(cls, word)}</div>`;
}
function cloudOffer() {
  return `<div class="cl-offer17d" role="note"><span class="ico-tile">${ic('cloud17d', 's')}</span><span class="grow"><b>An always-on cloud computer for a Trunk</b><small>It keeps working while this PC sleeps or is switched off. Off until you choose: it costs money each month and runs outside this PC. Branch offers it when a task would run past bedtime.</small></span><button class="btn sm" type="button" data-act="cloudnew17d">Set one up</button></div>`;
}
{ const _pc = PAGES.computer; PAGES.computer = () => {
  let h = _pc();
  clouds().forEach(x => { const re = new RegExp(`<div class="comp7-card[^"]*">(?:(?!comp7-card)[\\s\\S])*?<b>${esc(x.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</b>[\\s\\S]*?</div>`); h = h.replace(re, cloudCard(x)); });
  const anchor = '<div class="acts" style="margin-top:10px"><button class="btn pri" type="button" data-act="comp-add">';
  const sleepLine = `<p class="hint cl-sleep17d">${ic('moon', 's')}This PC goes to sleep at 11:30 PM (its power plan). ${clouds().length ? 'Cloud computers keep going.' : 'Work on it pauses until it wakes.'}</p>`;
  return h.replace(anchor, (clouds().length ? '' : cloudOffer()) + sleepLine + anchor);
}; }
/* the add-a-computer flow: "Cloud computer" is the kind, KeepOak is one place it can run */
{ const _add = addCompDlg; addCompDlg = function (step) {
  if (step === 'cloud') return cloudDlg();
  const r = _add.apply(this, arguments);
  if (!step) { const b = dlgEl?.querySelector('.prov[data-v="cloud"]'); if (b) { b.querySelector('b').textContent = 'A cloud computer'; b.querySelector('small').textContent = 'Always on, keeps working while this PC sleeps. KeepOak or your own cloud account. Billed monthly.'; b.querySelector('.ico-tile').innerHTML = ic('cloud17d', 's'); } }
  return r;
}; }
function cloudDlg(pre) {
  const w = D.cw = pre ? {step: 0, trunk: 'ada', where: S.ko === 'on' ? 'keepoak' : 'daytona', region: REGIONS[0], size: 'small', sleep: '15 minutes', cap: '$10', key: false, ...pre} : (D.cw || {step: 0, trunk: 'ada', where: S.ko === 'on' ? 'keepoak' : 'daytona', region: REGIONS[0], size: 'small', sleep: '15 minutes', cap: '$10', key: false});
  const c = cost(w.size), seg = (k, opts) => `<span class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-act="cw17d" data-k="${k}" data-v="${esc(v)}" aria-pressed="${w[k] === v}">${esc(l)}</button>`).join('')}</span>`;
  const dots = `<div class="cw-steps17d">${['Where', 'Sign-ins', 'Check'].map((s, i) => `<span class="${i < w.step ? 'done' : i === w.step ? 'now' : ''}"><em>${i < w.step ? '✓' : i + 1}</em>${s}</span>`).join('')}</div>`;
  let body;
  if (w.step === 0) body = `<div class="fld"><span>Which Trunk it’s for</span>${seg('trunk', trunks().map(t => [t.id, t.name]))}</div>
    <div class="fld"><span>Where it runs</span><div class="cw-where17d">${Object.entries(WHERES).map(([v, [n, s]]) => { const dis = v === 'ssh' || (v === 'keepoak' && S.ko !== 'on'); return `<button type="button" class="prov" data-act="cw17d" data-k="where" data-v="${v}" aria-pressed="${w.where === v}" ${dis ? 'disabled' : ''}><b>${n}</b><small>${v === 'keepoak' && S.ko !== 'on' ? 'Connect keepoak.com first' : s}</small></button>`; }).join('')}</div></div>
    <div class="fld"><span>Region</span>${seg('region', REGIONS.map(r => [r, r]))}</div>
    <div class="fld"><span>Size</span>${seg('size', Object.entries(SIZES).map(([v, [n, s]]) => [v, `${n} · ${s}`]))}</div>
    <div class="cw-cost17d"><div><b>About $${c.month} a month</b><small>If it works two hours a day and sleeps the rest. Up to $${c.max} if it works around the clock. Billed by ${esc(WHERES[w.where][0])}, not by Branch.</small></div><div class="art-slot17d" data-art17="art17-cloud"></div></div>`;
  else if (w.step === 1) body = `<p style="margin:0 0 10px">Credentials go through the locker. The cloud computer gets each one only while a task needs it, and the model never sees a value.</p>
    <div class="prow cw-key17d"><span class="ico-tile">${ic('key', 's')}</span><span class="grow"><b>${esc(WHERES[w.where][0])} account key</b><small>${w.key ? 'In Bitwarden · ••••7Q2F · put in when the computer starts' : 'Needed to create and wake the computer.'}</small></span>${w.key ? pillOf('ok', 'In the locker') : '<button class="btn sm" type="button" data-act="cwkey17d">Add it from Bitwarden</button>'}</div>
    <div class="fld" style="margin-top:12px"><span>Sign-ins ${esc(C(w.trunk).name)} may use there</span><div class="chips8">${['Outlook', 'Delta', 'Booking.com'].map((n, i) => `<button type="button" class="chip6" data-act="seg" aria-pressed="${i < 2}">${n}</button>`).join('')}</div><small class="hint">Filled by the locker when asked, never copied onto the cloud computer.</small></div>
    <div class="fld"><span>Sleep when nothing is running</span>${seg('sleep', [['15 minutes', 'After 15 minutes'], ['1 hour', 'After an hour'], ['never', 'Never']])}</div>
    <div class="fld"><span>Monthly cap</span>${seg('cap', [['$10', '$10'], ['$25', '$25'], ['none', 'No cap']])}<small class="hint">It stops and tells you when it gets there.</small></div>`;
  else body = `<div class="cw-sum17d">${[['For', C(w.trunk).name], ['Runs on', `${WHERES[w.where][0]} · ${w.region}`], ['Size', `${SIZES[w.size][0]} · ${SIZES[w.size][1]}`], ['Costs', `About $${c.month} a month · cap ${w.cap === 'none' ? 'none' : w.cap}`], ['Sleeps', w.sleep === 'never' ? 'Never' : 'After ' + w.sleep + ' with nothing to do'], ['Sign-ins', 'Through the locker only']].map(([k, v]) => `<div><small>${k}</small><b>${esc(v)}</b></div>`).join('')}</div>
    <p class="hint">${w.task ? `It picks up “${esc(w.task)}” as soon as it starts.` : 'It starts asleep and wakes when ' + esc(C(w.trunk).name) + ' has work for it.'} You can stop or remove it any time in Settings › Computer &amp; browser.</p>`;
  const next = w.step === 0 ? '<button class="btn pri" type="button" data-act="cwgo17d" data-v="1">Continue</button>' : w.step === 1 ? `<button class="btn pri" type="button" data-act="cwgo17d" data-v="2" ${w.key ? '' : 'disabled'}>Continue</button>` : `<button class="btn pri" type="button" data-act="cwmake17d">Turn on and create · about $${c.month}/mo</button>`;
  openDlg({title: 'A cloud computer', wide: true, body: `<div class="cw17d">${dots}${body}</div>`, foot: `${w.step ? '<button class="btn ghost" type="button" data-act="cwgo17d" data-v="' + (w.step - 1) + '">Back</button>' : '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button>'}${next}`});
}
Object.assign(ACTS, {
  cloudnew17d: el => cloudDlg({trunk: el.dataset.id || 'ada'}),
  cw17d: el => { D.cw[el.dataset.k] = el.dataset.v; cloudDlg(); },
  cwkey17d: () => { D.cw.key = true; cloudDlg(); toast('Bitwarden saved the key. Branch shows only the last four characters.'); },
  cwgo17d: el => { D.cw.step = +el.dataset.v; cloudDlg(); },
  cwmake17d: () => { const w = D.cw; closeDlg(); const c = makeCloud(w); if (w.task) D.offer = 'done'; D.cw = null; render(); toast(`Creating ${c.name}. It’s ready in about a minute.`); },
  clstate17d: el => { const x = cloudOf(el.dataset.id); if (!x) return; const k = x.cloud17d, v = el.dataset.v;
    if (v === 'wake' || v === 'start') { k.state = 'starting'; render(); later(() => { k.state = v === 'wake' ? 'working' : 'sleeping'; if (v === 'wake') k.task = k.task || 'Checking what’s queued for ' + C(k.trunk).name; render(); }, 1200); toast(v === 'wake' ? `Waking ${x.name}…` : `Starting ${x.name}. It goes to sleep until there’s work.`); return; }
    k.state = v === 'sleep' ? 'sleeping' : 'stopped'; render(); toast(v === 'sleep' ? `${x.name} is asleep. It costs almost nothing while it sleeps.` : `${x.name} stopped. Nothing runs on it; its disk is kept.`); },
  clrm17d: el => { const x = cloudOf(el.dataset.id); openDlg({title: `Remove ${x.name}?`, body: `<p style="margin:0">It’s deleted from ${esc(WHERES[x.cloud17d.where][0])} and billing stops. Its disk is kept for 7 days in case you change your mind.</p>`, foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn bad" type="button" data-act="clrmgo17d" data-id="${x.id}">Remove it</button>`}); },
  clrmgo17d: el => { const i = COMPUTERS.findIndex(x => x.id === el.dataset.id); const [x] = COMPUTERS.splice(i, 1); Object.values(S.compsFor).forEach(l => { const j = l.indexOf(x.id); if (j >= 0) l.splice(j, 1); }); Object.keys(S.compFor).forEach(k => { if (S.compFor[k] === x.id) S.compFor[k] = (S.compsFor[k] || [])[0] || 'none'; }); closeDlg(); render(); toast(`${x.name} removed. Billing stopped.`); },
  offer17d: el => { if (el.dataset.v === 'no') { D.offer = 'no'; render(); toast('Fine. If this PC sleeps, the goal pauses and picks up when it wakes.'); return; } cloudDlg({trunk: 'scout', task: 'the room’s supplier-quotes goal', alsoFor: 'room'}); }
});
/* offered at the moment it helps: the room's goal would run past the time this PC sleeps */
afterChat15(() => {
  if (S.chat !== 'room' || D.offer !== 'show' || clouds().length) return;
  $('#scroll .thread')?.insertAdjacentHTML('beforeend', `<div class="offer17d" role="note">${ic('cloud17d', 's')}<span class="grow"><b>This goal could run past bedtime</b><small>Scout and Ledger may need three more hours, and this PC sleeps at 11:30 PM. A cloud computer keeps the goal going while it sleeps, for about $6 a month.</small></span><button class="btn ghost sm" type="button" data-act="offer17d" data-v="no">Not now</button><button class="btn pri sm" type="button" data-act="offer17d" data-v="yes">Use a cloud computer</button></div>`);
});
/* the full-size view says where a cloud computer runs, what it costs and its state */
{ const _rs = renderStage7; renderStage7 = function () {
  _rs.apply(this, arguments);
  const st = $('#stage7'); if (!st || S.stage !== 'computer') return;
  const x = cloudOf(S.compFor[S.chat]); if (!x) return;
  const k = x.cloud17d, [cls, word] = STATE[k.state];
  const t = st.querySelector('.st7-title'); t?.insertAdjacentHTML('beforeend', pillOf(cls, 'Cloud · ' + word)); if (t?.nextElementSibling?.matches('.pill.idle')) t.nextElementSibling.remove();
  st.querySelector('.dk7-h')?.insertAdjacentHTML('afterend', `<div class="cl-dock17d"><b>${ic('cloud17d', 's')}Cloud computer</b><small>${esc(cloudLine(x))}</small><small>Keeps going while this PC sleeps. $${(k.spent || 1.84).toFixed(2)} so far this month.</small><span class="cl-acts17d">${cloudBtns(x)}</span></div>`);
  if (k.state !== 'working') st.querySelector('.st7-screen')?.insertAdjacentHTML('beforeend', `<div class="cl-veil17d"><b>${k.state === 'stopped' ? 'Stopped' : k.state === 'starting' ? 'Starting…' : 'Asleep'}</b><small>${k.state === 'stopped' ? 'Nothing runs on it until you start it.' : k.state === 'starting' ? 'About a minute.' : 'It wakes by itself when ' + esc(C(k.trunk).name) + ' has work.'}</small>${k.state === 'starting' ? '' : `<button class="btn sm" type="button" data-act="clstate17d" data-id="${x.id}" data-v="${k.state === 'stopped' ? 'start' : 'wake'}">${k.state === 'stopped' ? 'Start' : 'Wake it'}</button>`}</div>`);
}; }

/* =====================================================================================================
   9. Computers per Trunk: the allow-list, an "at once" limit that limits, and a pick per conversation
   ===================================================================================================== */
{ const _tc = toggleComp; toggleComp = function (id, cid) { const before = S.compMax[id] || 1, l = _tc.apply(this, arguments); S.compMax[id] = Math.max(1, Math.min(before, l.length || 1)); return l; }; }
{ const _nc = newConv; newConv = function () { _nc.apply(this, arguments); const allow = S.compsFor.branch || []; S.compsFor[S.chat] = [...allow]; S.compFor[S.chat] = allow[0] || 'none'; S.compMax[S.chat] = S.compMax.branch || 1; }; }
{ const _pc = POPS.comps; POPS.comps = () => {
  const id = S.chat, list = compsOf(id), max = S.compMax[id] || 1;
  const here = list.length ? `<div class="ph">This conversation uses</div>${list.map(x => radio('convcomp17d', x.id, x.name, x.cloud17d ? STATE[x.cloud17d.state][1] + ' · cloud' : x.os, S.compFor[id] === x.id)).join('')}<p class="pp comp-max17d">Up to ${max} at once${list.length > max ? `, of ${list.length} allowed` : ''}. <button class="link" type="button" data-act="edit" data-id="${C(id).kind === 'trunk' ? id : 'scout'}">Change</button></p><hr>` : '';
  return here + _pc().replace(/<div class="ph">Computers (.*?) may use<\/div>/, '<div class="ph">Allowed for $1</div>');
}; }
ACTS.convcomp17d = el => { S.compFor[S.chat] = el.dataset.v; S.stageGrid = false; closePop(); render(); toast(`This conversation uses ${COMPUTERS.find(x => x.id === el.dataset.v)?.name}.`); };
/* the Trunk's page: an "Its computers" tab in the Trunk editor */
function itsComputers(id) {
  const t = C(id), on = S.compsFor[id] || [], max = S.compMax[id] || 1, mine = clouds().find(x => x.cloud17d.trunk === id);
  const rows = COMPUTERS.filter(x => !x.cloud17d || x.cloud17d.trunk === id || on.includes(x.id)).map(x => `<label class="ic-row17d ${compReady(x) ? '' : 'off7'}"><input type="checkbox" data-sw="itsc17d" data-id="${id}" data-v="${x.id}" ${on.includes(x.id) ? 'checked' : ''} ${compReady(x) ? '' : 'disabled'} aria-label="${esc(t.name)} may use ${esc(x.name)}"><span class="ico-tile">${ic(x.icon, 's')}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.cloud17d ? cloudLine(x) : compReady(x) ? x.os : 'Connect keepoak.com first')}</small></span>${x.cloud17d ? pillOf(STATE[x.cloud17d.state][0], STATE[x.cloud17d.state][1]) : ''}</label>`).join('');
  return `<div class="its17d"><p class="hint" style="margin:0">Which computers ${esc(t.name)} may use. Each task runs on one; a conversation can pick which.</p>
    <div class="ic-list17d">${rows}</div>
    <div class="ic-ctl17d"><span><b>At once</b><small>How many tasks it may run side by side, one per computer.</small></span><span class="seg">${[1, 2, 3, 4].map(n => `<button type="button" data-act="itsmax17d" data-id="${id}" data-v="${n}" aria-pressed="${max === n}" ${n > Math.max(1, on.length) ? 'disabled' : ''}>${n}</button>`).join('')}</span></div>
    <div class="ic-ctl17d"><span><b>A new conversation starts on</b><small>You can change it in the conversation’s computer menu.</small></span><span class="seg">${on.length ? on.slice(0, 3).map((cid, i) => `<button type="button" data-act="itsfirst17d" data-id="${id}" data-v="${cid}" aria-pressed="${i === 0}">${esc(COMPUTERS.find(x => x.id === cid)?.name || cid)}</button>`).join('') : '<button type="button" disabled aria-pressed="true">No computer</button>'}</span></div>
    ${mine ? cloudCard(mine).replace('comp7-card', 'comp7-card ic-cloud17d') : `<div class="cl-offer17d"><span class="ico-tile">${ic('cloud17d', 's')}</span><span class="grow"><b>Give ${esc(t.name)} its own cloud computer</b><small>Always on, so its work carries on while this PC sleeps. Off until you choose: about $6 a month.</small></span><button class="btn sm" type="button" data-act="cloudnew17d" data-id="${id}">Set one up</button></div>`}</div>`;
}
{ const _et = editTrunk; editTrunk = function (id) {
  _et.apply(this, arguments);
  const st = editTrunk.state; if (!st || st.its17d) return; st.its17d = true;
  const d1 = st.draw;
  st.draw = () => { d1(); const tabs = document.querySelector('.dlg .editor > div:last-child .tabs'); if (!tabs) return;
    tabs.insertAdjacentHTML('beforeend', `<button class="tab" role="tab" type="button" aria-selected="${st.tab === 'its17d'}" data-act="st-tab" data-v="its17d">Its computers</button>`);
    if (st.tab !== 'its17d') return; let n = tabs.nextElementSibling; while (n) { const nx = n.nextElementSibling; n.remove(); n = nx; }
    tabs.insertAdjacentHTML('afterend', itsComputers(st.id)); };
  st.draw();
}; }
const redrawEditor = () => { if (editTrunk.state && dlgEl) editTrunk.state.draw(); render(); };
Object.assign(ACTS, {
  itsmax17d: el => { S.compMax[el.dataset.id] = +el.dataset.v; redrawEditor(); toast(`${C(el.dataset.id).name} may run ${el.dataset.v} ${+el.dataset.v === 1 ? 'task' : 'tasks'} at once.`); },
  itsfirst17d: el => { const l = S.compsFor[el.dataset.id]; l.unshift(...l.splice(l.indexOf(el.dataset.v), 1)); redrawEditor(); }
});
document.addEventListener('change', e => { const t = e.target; if (t.dataset?.sw !== 'itsc17d') return; toggleComp(t.dataset.id, t.dataset.v); redrawEditor(); });

/* =====================================================================================================
   2. Phone calls and meeting notes. Both off until you choose; a consent step before any call.
   ===================================================================================================== */
D.calls = D.calls || {on: false, meet: false, key: false, tab: 'someone', trunk: 'scout', ok: false, when: 'now', plat: 'Teams'};
D.results = D.results || [];
const NUM = '+1 (404) 555-0142', MINE = '+1 (404) 555-0127';
const CALLS = {
  someone: {title: 'Scout is calling Oakfield Supply', who: 'scout', lines: [['Scout', 'Hello, this is an AI assistant calling for Taofik Bishi about a paper order. Is it all right if I go on? Nothing is recorded unless you agree.'], ['Maria · Oakfield', 'Sure, go ahead. No recording, please.'], ['Scout', 'Thank you. Can 10 cases of A4 arrive by Thursday, October 1, and is the $412 quote still good?'], ['Maria · Oakfield', 'Yes to both, if the order is in by Wednesday noon.'], ['Scout', 'That’s clear. I’ll tell Taofik. Goodbye.']],
    res: {icon: 'call17d', title: 'Called Oakfield Supply', sub: 'Scout · 1m 48s · not recorded, as they asked', sum: 'Delivery by Thursday, October 1 works if the order is in by Wednesday noon. The $412 quote still stands.', todo: [['Place the order by Wednesday noon', 'You']], act: ['draft17d', 'Draft the order']}},
  me: {title: 'Ada is calling you', who: 'ada', lines: [['Ada', 'Hi Taofik, it’s Ada. The Lisbon hotel can be cancelled free until October 3. Shall I put the trip on your calendar?'], ['You', 'Yes, and share it with Sam.'], ['Ada', 'I’ll add it now and ask you before anything goes to Sam.']],
    res: {icon: 'call17d', title: 'Call with Ada', sub: `Ada · 52s · to ${MINE}`, sum: 'You asked for the Lisbon trip on your calendar and a copy for Sam.', todo: [['Add Oct 10–17 to your calendar', 'Ada'], ['Share the plan with Sam (asks first)', 'Ada']], act: ['chat', 'Open Ada', 'ada']}},
  meet: {title: 'Scout is in “Hartwell weekly”', who: 'scout', lines: [['Scout', 'Posted in the meeting chat: “Taofik’s notes (Branch) is taking notes. Ask me to leave any time.”'], ['Dana Okafor', 'Were we charged twice for August?'], ['Priya · Hartwell', 'No, the second charge was the Oakfield paper order.'], ['Dana Okafor', 'Then let’s waive the $100 late fee and move billing to the 5th.'], ['Priya · Hartwell', 'Agreed. I’ll send a corrected statement by Monday.']],
    res: {icon: 'meet17d', title: 'Notes from “Hartwell weekly”', sub: 'Scout · Teams · 34 min · 4 people', sum: 'No double charge in August: the second charge was the Oakfield order. Hartwell waives the $100 late fee.', dec: ['The $100 late fee is waived', 'Billing moves to the 5th of each month'], todo: [['Send a corrected statement by Monday', 'Priya'], ['Update the Hartwell rule in Ledger', 'Ledger'], ['Check the September invoice when it arrives', 'Scout']], act: ['sendnotes17d', 'Send to the 4 people there']}}
};
const fseg = (title, sub, opts, cur) => `<div class="fld"><span>${esc(title)}</span><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(o => `<button type="button" data-act="seg" aria-pressed="${o === cur}">${esc(o)}</button>`).join('')}</span><small class="hint" style="margin:0">${esc(sub)}</small></div>`;
const platOf = u => /zoom\.us/i.test(u) ? 'Zoom' : /meet\.google/i.test(u) ? 'Meet' : /teams\./i.test(u) ? 'Teams' : null;
function offDlg(kind) {
  const call = kind === 'call';
  openDlg({title: call ? 'Phone calls' : 'Meeting notes', body: `<div class="cm-off17d"><span class="ico-tile">${ic(call ? 'call17d' : 'meet17d', 's')}</span><div><b>${call ? 'Phone calls are off' : 'Meeting notes are off'}</b><p>${call ? 'Off until you choose: calls cost money by the minute and reach people outside Branch.' : 'Off until you choose: a Trunk joins your meetings as a guest and listens to everyone there.'}</p></div></div>
    ${call ? `<div class="prow cw-key17d"><span class="ico-tile">${ic('key', 's')}</span><span class="grow"><b>Your Twilio number</b><small>${D.calls.key ? `${NUM} · key in Bitwarden · ••••A91C` : 'Branch calls from your own Twilio number. Its key goes in the locker; Branch never sees it.'}</small></span>${D.calls.key ? pillOf('ok', 'In the locker') : '<button class="btn sm" type="button" data-act="cmkey17d">Add it from Bitwarden</button>'}</div>` : `<div class="prow"><span class="ico-tile">${ic('mail', 's')}</span><span class="grow"><b>Outlook calendar</b><small>Connected. Meetings with a Teams, Zoom or Meet link can be joined.</small></span>${pillOf('ok', 'Connected')}</div>`}
    <p class="hint">${call ? 'Every call starts by saying it’s an AI assistant calling for you, and records only if the other person agrees.' : 'It says in the meeting chat that it’s taking notes, and leaves if anyone asks.'}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Not now</button><button class="btn pri" type="button" data-act="cmon17d" data-v="${kind}" ${call && !D.calls.key ? 'disabled' : ''}>Turn on ${call ? 'phone calls' : 'meeting notes'}</button>`});
}
function callDlg() {
  const c = D.calls; if (!c.on) return offDlg('call');
  const seg = `<span class="seg" role="group" aria-label="Kind of call">${[['someone', 'Call someone for me'], ['me', 'Call me']].map(([v, l]) => `<button type="button" data-act="cmtab17d" data-v="${v}" aria-pressed="${c.tab === v}">${l}</button>`).join('')}</span>`;
  const who = `<div class="fld"><span>Who calls</span><span class="seg">${trunks().slice(0, 4).map(t => `<button type="button" data-act="cmset17d" data-k="trunk" data-v="${t.id}" aria-pressed="${c.trunk === t.id}">${esc(t.name)}</button>`).join('')}</span></div>`;
  let body, foot;
  if (c.tab === 'me') { body = `${who}<div class="fld"><span>When</span><span class="seg">${[['now', 'Now'], ['done', 'When its task finishes'], ['at', 'Tomorrow at 9 AM']].map(([v, l]) => `<button type="button" data-act="cmset17d" data-k="when" data-v="${v}" aria-pressed="${c.when === v}">${l}</button>`).join('')}</span></div><label class="fld"><span>What about</span><input class="inp" id="cm-why17d" value="The Lisbon plan and what’s left to book"></label><p class="hint">It calls ${MINE}, your number in Settings › People, from ${NUM}.</p>`;
    foot = `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="cmgo17d" data-v="me">${c.when === 'now' ? 'Call me now' : 'Schedule the call'}</button>`; }
  else { body = `${who}<div class="split17d"><label class="fld"><span>Who to call</span><input class="inp" id="cm-name17d" value="Oakfield Supply"></label><label class="fld"><span>Number</span><input class="inp" id="cm-num17d" value="+1 (678) 555-0199" inputmode="tel"></label></div>
    <label class="fld"><span>What it should find out</span><textarea class="inp" id="cm-goal17d" rows="2">Can 10 cases of A4 arrive by Thursday, October 1, and is the $412 quote still good?</textarea></label>
    ${fseg('What it may agree to', 'Anything more, it says it will check with you.', ['Nothing, only ask', 'Small changes under $50'], 'Nothing, only ask')}
    <div class="consent17d" role="group" aria-label="Before it calls"><b>Before it calls</b>
      <label class="cs-row17d"><input type="checkbox" checked disabled><span>It says first that it’s an AI assistant calling for Taofik, and asks if it may go on.</span></label>
      <label class="cs-row17d"><input type="checkbox" checked disabled><span>It records only if they agree, and hangs up if they ask.</span></label>
      <label class="cs-row17d"><input type="checkbox" id="cm-ok17d" data-sw="cmok17d" ${c.ok ? 'checked' : ''}><span>I have a reason to call this number, and it’s between 8 AM and 8 PM where they are.</span></label></div>`;
    foot = `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="cmgo17d" data-v="someone" ${c.ok ? '' : 'disabled'}>Place the call</button>`; }
  openDlg({title: 'A phone call', wide: true, body: `<div class="cm17d">${seg}${body}</div>`, foot});
}
function meetDlg() {
  const c = D.calls; if (!c.meet) return offDlg('meet');
  openDlg({title: 'Join a meeting', wide: true, body: `<div class="cm17d"><label class="fld"><span>Meeting link</span><input class="inp" id="mt-url17d" value="https://teams.microsoft.com/l/meetup-join/hartwell-weekly (example)" autocomplete="off"></label>
    <div class="fld"><span>Where it is</span><span class="seg" id="mt-plat17d">${['Meet', 'Teams', 'Zoom'].map(p => `<button type="button" data-act="cmset17d" data-k="plat" data-v="${p}" aria-pressed="${c.plat === p}">${p === 'Meet' ? 'Google Meet' : p === 'Teams' ? 'Microsoft Teams' : 'Zoom'}</button>`).join('')}</span></div>
    <div class="fld"><span>From your calendar</span><div class="prow mt-cal17d"><span class="ico-tile">${ic('clock', 's')}</span><span class="grow"><b>Hartwell weekly</b><small>Today 2:00 PM · Teams · Dana, Priya and 2 more</small></span>${pillOf('idle', 'In 2 hours')}</div></div>
    <div class="fld"><span>Who joins</span><span class="seg">${trunks().slice(0, 4).map(t => `<button type="button" data-act="cmset17d" data-k="trunk" data-v="${t.id}" aria-pressed="${c.trunk === t.id}">${esc(t.name)}</button>`).join('')}</span></div>
    ${fseg('In the meeting it may', 'It shows as “Taofik’s notes (Branch)”.', ['Only listen', 'Answer when asked by name'], 'Only listen')}
    <p class="hint">It posts in the meeting chat that it’s taking notes, and leaves if anyone asks. Notes come to your Inbox afterwards; nothing is sent to anyone without your yes.</p></div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="cmgo17d" data-v="meet">Join now</button>'});
}
document.addEventListener('input', e => { if (e.target.id !== 'mt-url17d') return; const p = platOf(e.target.value); if (p && p !== D.calls.plat) { D.calls.plat = p; document.querySelectorAll('#mt-plat17d button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === p))); } });
document.addEventListener('change', e => { const t = e.target; if (t.dataset?.sw === 'cmok17d') { D.calls.ok = t.checked; const b = $('.dlg [data-act="cmgo17d"]'); if (b) b.disabled = !t.checked; } });
function liveDlg() {
  const l = D.live; if (!l) return;
  openDlg({title: l.spec.title, body: `<div class="lvd17d"><div class="lv-h17d">${av(C(l.spec.who), 30)}<span class="grow"><b>${esc(l.spec.title)}</b><small id="lv-t17d">${l.t ? mmss(l.t) : 'Connecting…'}</small></span>${pillOf('work', l.kind === 'meet' ? 'In the meeting' : 'On the call')}</div><ol class="lv-lines17d" aria-live="polite">${l.spec.lines.slice(0, l.i).map(([w, s]) => `<li><b>${esc(w)}</b>${esc(s)}</li>`).join('')}</ol><p class="hint" style="margin:0">You can close this; it carries on and the status bar shows it.</p></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Keep it in the background</button><button class="btn bad" type="button" data-act="cmend17d">${l.kind === 'meet' ? 'Leave the meeting' : 'Hang up'}</button>`});
}
const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function startLive(kind) {
  const spec = CALLS[kind]; clearInterval(D.liveIv); D.live = {kind, spec, t: 0, i: 0};
  closeDlg(); liveDlg(); renderStatus();
  D.liveIv = setInterval(() => { const l = D.live; if (!l) return clearInterval(D.liveIv); l.t += 3;
    if (l.i < spec.lines.length) { l.i++; if (dlgEl?.querySelector('.lvd17d')) liveDlg(); } else finishLive();
    const sb = $('#statusbar .live17d span'); if (sb) sb.textContent = `${spec.title} · ${mmss(l.t)}`; const tt = $('#lv-t17d'); if (tt) tt.textContent = mmss(l.t); }, quick() ? 60 : 1400);
}
function finishLive() {
  const l = D.live; if (!l) return; clearInterval(D.liveIv); D.live = null;
  D.results.unshift({...l.spec.res, id: 'r' + Date.now(), when: 'just now', kind: l.kind});
  if (dlgEl?.querySelector('.lvd17d')) closeDlg(); render();
  toast(l.kind === 'meet' ? 'Scout left the meeting. The notes are in your Inbox.' : 'The call finished. What was said is in your Inbox.');
}
POPS.plusmenu = (_p => (...a) => _p(...a) + '<hr>' + mi('call17d', 'call17d', 'Phone call…', D.calls.on ? '' : 'off') + mi('meet17d', 'meet17d', 'Join a meeting…', D.calls.meet ? '' : 'off'))(POPS.plusmenu);
{ const _st = renderStatus; renderStatus = function () { _st.apply(this, arguments); const l = D.live; if (!l) return; $('#statusbar .tb-grow')?.insertAdjacentHTML('beforebegin', `<button class="sb live17d" type="button" data-act="cmlive17d" data-tip="Open the live ${l.kind === 'meet' ? 'meeting' : 'call'}">${ic(l.kind === 'meet' ? 'meet17d' : 'call17d', 's')}<span>${esc(l.spec.title)} · ${mmss(l.t)}</span></button>`); }; }
Object.assign(ACTS, {
  call17d: () => { closePop(); callDlg(); },
  meet17d: () => { closePop(); meetDlg(); },
  cmkey17d: () => { D.calls.key = true; offDlg('call'); toast('Bitwarden saved the Twilio key. Branch shows only the last four characters.'); },
  cmon17d: el => { if (el.dataset.v === 'call') { D.calls.on = true; callDlg(); } else { D.calls.meet = true; meetDlg(); } if (S.view === 'settings') render(); toast(el.dataset.v === 'call' ? 'Phone calls are on. Each call still needs your yes.' : 'Meeting notes are on. A Trunk joins only when you ask.'); },
  cmtab17d: el => { D.calls.tab = el.dataset.v; callDlg(); },
  cmset17d: el => { D.calls[el.dataset.k] = el.dataset.v; if (el.dataset.k === 'plat') { el.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === el))); return; } if (dlgEl?.querySelector('#mt-url17d')) meetDlg(); else callDlg(); },
  cmgo17d: el => { const v = el.dataset.v; if (v === 'someone' && !D.calls.ok) return; if (v === 'me' && D.calls.when !== 'now') { closeDlg(); toast(`${C(D.calls.trunk).name} will call ${MINE} ${D.calls.when === 'at' ? 'tomorrow at 9 AM' : 'when its task finishes'}.`); return; } startLive(v); },
  cmend17d: () => finishLive(),
  cmlive17d: () => liveDlg(),
  resx17d: el => { D.results = D.results.filter(r => r.id !== el.dataset.id); render(); },
  resopen17d: el => { const r = D.results.find(x => x.id === el.dataset.id), spec = Object.values(CALLS).find(c => c.res.title === r.title); openDlg({title: r.title, wide: true, body: `<p class="hint" style="margin:0 0 8px">${esc(r.sub)} · ${esc(r.when)}</p><ol class="lv-lines17d">${spec.lines.map(([w, s]) => `<li><b>${esc(w)}</b>${esc(s)}</li>`).join('')}</ol>`, foot: '<button class="btn pri" type="button" data-act="dlg-close">Done</button>'}); },
  ressave17d: el => { const r = D.results.find(x => x.id === el.dataset.id); library.documents.unshift([r.title.replace(/[“”]/g, '') + '.md', 'Scout · today', 'md']); r.saved = true; render(); toast('Saved to Library › Documents.'); },
  sendnotes17d: () => openDlg({title: 'Send the notes to 4 people?', body: `<div class="kv17d">${[['To', 'dana.okafor@hartwell.example, priya@hartwell.example and 2 more'], ['From', 'Your Outlook'], ['Subject', 'Notes: Hartwell weekly, Sep 25']].map(([k, v]) => `<div><small>${k}</small><span>${esc(v)}</span></div>`).join('')}</div>`, foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="sendnotesgo17d">Send</button>'}),
  sendnotesgo17d: () => { closeDlg(); toast('Sent to 4 people from your Outlook.'); },
  draft17d: () => toast('Scout drafted the Oakfield order in Supplier quotes. It won’t send it until you say yes.')
});
const resCard = r => `<article class="res17d" aria-label="${esc(r.title)}"><div class="rs-h17d"><span class="ico-tile">${ic(r.icon, 's')}</span><span class="grow"><b>${esc(r.title)}</b><small>${esc(r.sub)} · ${esc(r.when)}</small></span><button class="icon-btn" type="button" aria-label="Dismiss" data-act="resx17d" data-id="${r.id}">${ic('x', 's')}</button></div>
  <p>${esc(r.sum)}</p>${r.dec ? `<div class="rs-l17d"><small>Decided</small><ul>${r.dec.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}<div class="rs-l17d"><small>To do</small><ul>${r.todo.map(([t, w]) => `<li>${esc(t)} <em>${esc(w)}</em></li>`).join('')}</ul></div>
  <div class="acts"><button class="btn pri sm" type="button" data-act="${r.act[0]}" ${r.act[2] ? `data-id="${r.act[2]}"` : ''}>${esc(r.act[1])}</button><button class="btn sm" type="button" data-act="resopen17d" data-id="${r.id}">${r.kind === 'meet' ? 'What was said' : 'Transcript'}</button>${r.kind === 'meet' ? `<button class="btn ghost sm" type="button" data-act="ressave17d" data-id="${r.id}" ${r.saved ? 'disabled' : ''}>${r.saved ? 'Saved' : 'Save to Library'}</button>` : ''}</div></article>`;
addSection15('inbox', 'finished', () => D.results.length ? `<div class="res-list17d">${D.results.map(resCard).join('')}</div>` : '');
/* Settings › Voice, at Advanced: calls and meetings */
addSettings15('voice', 1, () => sec15('Calls and meetings', `<div class="ctl"><b>Phone calls</b><input class="sw" type="checkbox" data-sw="cmsw17d" data-v="call" ${D.calls.on ? 'checked' : ''} aria-label="Phone calls"><small>Call you, or call someone for you. Off until you choose: calls cost money by the minute and reach people outside Branch.</small></div>
  <div class="ctl"><b>Calling from</b><span class="right">${D.calls.key ? esc(NUM) : '<button class="btn sm" type="button" data-act="call17d">Set up</button>'}</span><small>Your Twilio number. Its key is in the locker.</small></div>
  ${ctlSeg('Who it may call', 'Numbers you approve once, or anyone you name in a message.', ['People I approve', 'Anyone I name'], 'People I approve')}
  ${ctlSeg('Recording', 'It always says first that it’s an AI assistant calling for you.', ['Only if they agree', 'Never'], 'Only if they agree')}
  <div class="ctl"><b>Meeting notes</b><input class="sw" type="checkbox" data-sw="cmsw17d" data-v="meet" ${D.calls.meet ? 'checked' : ''} aria-label="Meeting notes"><small>A Trunk joins Meet, Teams or Zoom as a guest and brings the notes back. Off until you choose: it listens to everyone there.</small></div>
  ${ctlSeg('Join from your calendar', 'It never joins a meeting by itself unless you pick the second.', ['Only when I ask', 'Meetings I’m invited to'], 'Only when I ask')}
  ${ctlSeg('Send notes afterwards', 'Sending to other people asks you first.', ['To me', 'To everyone there'], 'To me')}`, 'Phone calls go through your own Twilio number; meeting notes use your connected calendar.'));
document.addEventListener('change', e => { const t = e.target; if (t.dataset?.sw !== 'cmsw17d') return; const k = t.dataset.v === 'call' ? 'on' : 'meet';
  if (t.checked) { t.checked = false; if (k === 'on' && !D.calls.key) offDlg('call'); else { D.calls[k] = true; render(); toast(k === 'on' ? 'Phone calls are on. Each call still needs your yes.' : 'Meeting notes are on.'); } }
  else { D.calls[k] = false; render(); toast(k === 'on' ? 'Phone calls are off.' : 'Meeting notes are off.'); } });

/* =====================================================================================================
   3. The behaviour workbook skill: learn an app or workflow, write its MUST list, derive checks, prove it
   ===================================================================================================== */
const WB_SAMPLE = {id: 'wb-outlook', name: 'Invoice rules in Outlook', src: 'outlook.office.com · the rules Ledger relies on', who: 'scout', when: 'Sep 20', pages: 9, ran: 'Private computer · 1m 52s',
  must: [['A rule can move mail from one sender into a folder', 'pass', ['Make a test rule for billing@hartwell.example', 'Send a test message from that address', 'It lands in Receipts within a minute']], ['Rules run in the order listed', 'pass', ['Two rules match one message', 'Only the first one’s action happens']], ['“Stop processing more rules” stops the rest', 'pass', ['Tick it on rule 1', 'Rule 2 does nothing to the same message']], ['A rule can forward to one address', 'pass', ['Forward a test message', 'It arrives at the second mailbox']], ['Rules made in the web version also run on the phone', 'fail', ['Make the rule on the web', 'Open the phone app', 'The phone still shows the message in Inbox']], ['A rule can be turned off without deleting it', 'pass', ['Switch it off', 'A new test message stays in Inbox']], ['Rules can match words in the subject', 'pass', ['Rule on “Invoice”', 'A test subject with “Invoice” moves']], ['There are at most 256 KB of rules', 'unclear', ['Not tested: it would mean making hundreds of rules']]]};
const WB_NEW = {name: 'The Hartwell Supply ordering portal', src: 'hartwell.example/orders', pages: 14, ran: 'Private computer · 2m 40s',
  must: [['You can sign in with a saved sign-in', 'pass', ['Fill from Bitwarden', 'The dashboard shows “Hartwell · Taofik”']], ['An order needs a PO number', 'pass', ['Try to submit without one', 'The form says the PO number is required']], ['Quantities must be whole cases', 'pass', ['Type 2.5 cases', 'It rounds to 3 and says so']], ['Delivery dates are weekdays only', 'pass', ['Pick Saturday, Oct 3', 'The calendar greys out weekends']], ['Orders over $500 need a second approver', 'pass', ['Build an order for $540', 'It says “Waiting for approval”']], ['A draft order is kept for 7 days', 'unclear', ['Would need a week to check; noted to recheck Oct 2']], ['The invoice shows on the Invoices page within a day', 'pass', ['Open Invoices', 'INV-0826 is listed with its PDF']], ['Cancelling an order before it ships is free', 'fail', ['Open a sent order', 'Cancel says “A $25 restocking fee applies”']], ['Prices include delivery', 'fail', ['Compare the cart total with the price list', 'Delivery of $27 is added at checkout']], ['You can download a statement as CSV', 'pass', ['Statements › Export', 'statement-sep.csv downloads']], ['Saved addresses can be picked at checkout', 'pass', ['Checkout › Address', 'Two saved addresses show']], ['The portal logs you out after 30 minutes', 'pass', ['Wait 30 minutes idle', 'It asks you to sign in again']], ['Order history goes back 24 months', 'pass', ['Filter to Oct 2024', 'Orders from then are listed']]]};
D.wb = D.wb || {list: [WB_SAMPLE], run: null, open: null, tab: 'must'};
const tally = w => { const n = s => w.must.filter(m => m[1] === s).length; return {pass: n('pass'), fail: n('fail'), unclear: n('unclear'), all: w.must.length}; };
TOOLS9.skills.unshift({id: 'learn17d', name: 'learn-this', icon: 'book17d', src: 'Built in · new', desc: 'Learn an app, site or workflow: write what it must do, then prove each point on the real thing.', who: ['scout', 'branch'], on: true});
const STAGES = [['Read it', 'Pages, help and settings'], ['Write the MUST list', 'Numbered, one behaviour each'], ['Derive the checks', 'Two or three per MUST'], ['Run them for real', 'On a computer it may use']];
function learnDetail() {
  const r = D.wb.run;
  const prog = r ? `<ol class="wb-prog17d">${STAGES.map(([t, s], i) => `<li class="${i < r.stage ? 'done' : i === r.stage ? 'now' : ''}">${ic(i < r.stage ? 'check' : i === r.stage ? 'spin' : 'info', i === r.stage ? 's spin' : 's')}<span><b>${t}</b><small>${i < r.stage ? ['14 pages read', '13 MUSTs written', '31 checks derived', 'Done'][i] : s}</small></span></li>`).join('')}</ol>` : '';
  return `<div class="t9-detail wb17d"><div class="t9-dh"><span class="ico-tile t9i" style="width:40px;height:40px">${ic('book17d', 's')}</span><span class="grow"><b>learn-this</b><small>Built in · learns an app or workflow and proves what it learned</small></span><input type="checkbox" class="sw" data-sw="tool9g" data-k="skills" data-id="learn17d" checked aria-label="learn-this on or off"></div>
    <div class="sec"><h2>How it works</h2><div class="art-slot17d wb-art17d" data-art17="art17-learn"></div><ol class="wb-how17d">${STAGES.map(([t, s], i) => `<li><em>${i + 1}</em><span><b>${t}</b><small>${s}</small></span></li>`).join('')}</ol><p class="hint">It writes a workbook: what the app MUST do, the checks for each point, and which passed on the real thing. A Trunk then works from what was proved, not from guesses.</p></div>
    <div class="sec"><h2>Learn something new</h2><label class="fld"><span>An app, a site or a workflow</span><input class="inp" id="wb-what17d" value="The Hartwell Supply ordering portal" autocomplete="off"></label>
      <div class="fld"><span>Where it runs the checks</span><span class="seg"><button type="button" data-act="seg" aria-pressed="true">Private computer</button><button type="button" data-act="seg" aria-pressed="false">Sealed browser only</button></span><small class="hint">Checks that would send, buy or delete are written down but never run.</small></div>
      <div class="acts"><button class="btn pri sm" type="button" data-act="wbstart17d" ${r ? 'disabled' : ''}>${r ? 'Learning…' : 'Start learning'}</button></div>${prog}</div>
    <div class="sec"><h2>Workbooks</h2><div class="rows">${D.wb.list.map(w => { const t = tally(w); return `<div class="prow wb-row17d"><span class="grow"><b>${esc(w.name)}</b><small>${esc(w.src)} · ${esc(w.when)}</small></span>${pillOf(t.fail ? 'warn' : 'ok', `${t.pass} of ${t.all} pass`)}<button class="btn sm" type="button" data-act="wbopen17d" data-id="${w.id}">Open</button></div>`; }).join('')}</div></div></div>`;
}
{ const _td = toolDetail; toolDetail = function (k, x) { return k === 'skills' && x.id === 'learn17d' ? learnDetail() : _td.apply(this, arguments); }; }
{ const _rt = renderTools9; renderTools9 = function () { _rt.apply(this, arguments); if (S.tools9.k !== 'skills' || S.tools9.sel === 'learn17d') return;
  $('#main .t9-list')?.insertAdjacentHTML('afterbegin', `<div class="tile wb-tile17d"><div class="th"><span class="ico-tile">${ic('book17d', 's')}</span><b>Learn an app or workflow</b></div><p>Branch reads it, writes what it must do, and proves each point on the real thing.</p><div class="acts"><button class="btn sm" type="button" data-act="t9-sel" data-v="learn17d">Try it</button></div></div>`); }; }
function wbDlg() {
  const w = D.wb.list.find(x => x.id === D.wb.open); if (!w) return; const t = tally(w), tab = D.wb.tab;
  const mark = s => s === 'pass' ? pillOf('ok', 'Pass') : s === 'fail' ? pillOf('no', 'Fails') : pillOf('idle', 'Not proved');
  const ring = `<span class="wb-ring17d" role="img" aria-label="${t.pass} of ${t.all} pass"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" pathLength="100"/><circle class="wb-arc17d" cx="18" cy="18" r="15" pathLength="100" style="stroke-dasharray:${Math.round(t.pass / t.all * 100)} 100"/></svg><b>${t.pass}/${t.all}</b></span>`;
  const list = tab === 'must' ? `<ol class="wb-must17d">${w.must.map(([m, s, ch], i) => `<li class="${s}"><span class="wb-n17d">MUST ${i + 1}</span><span class="grow"><b>${esc(m)}</b><small>${ch.length} ${ch.length === 1 ? 'check' : 'checks'}</small></span>${mark(s)}</li>`).join('')}</ol>`
    : tab === 'checks' ? `<ol class="wb-checks17d">${w.must.map(([m, s, ch], i) => `<li><b>MUST ${i + 1} · ${esc(m)}</b><ul>${ch.map(c => `<li class="${s}">${ic(s === 'pass' ? 'check' : s === 'fail' ? 'x' : 'info', 's')}${esc(c)}</li>`).join('')}</ul></li>`).join('')}</ol>`
    : `<div class="wb-fail17d">${w.must.map(([m, s, ch], i) => s === 'pass' ? '' : `<div class="status"><span class="sdot ${s === 'fail' ? 'bad' : ''}"></span><div><b>MUST ${i + 1}: ${esc(m)}</b><p>${esc(ch[ch.length - 1])}. ${s === 'fail' ? 'The workbook now says what really happens, so a Trunk won’t count on it.' : 'Written down to check again later.'}</p></div></div>`).join('') || '<p class="empty">Everything passed.</p>'}</div>`;
  openDlg({title: w.name, wide: true, body: `<div class="wbv17d"><div class="wbv-h17d">${ring}<span class="grow"><b>${t.pass} of ${t.all} proved on the real thing</b><small>${esc(w.src)} · read ${w.pages} pages · ran on ${esc(w.ran)} · ${esc(C(w.who).name)} · ${esc(w.when)}</small><span class="wbv-k17d">${pillOf('ok', t.pass + ' pass')}${t.fail ? pillOf('no', t.fail + ' fail') : ''}${t.unclear ? pillOf('idle', t.unclear + ' not proved') : ''}</span></span></div>
    <div class="tabs" role="tablist" style="margin:12px 0 8px">${[['must', 'What it must do'], ['checks', 'The checks'], ['fail', 'What didn’t pass']].map(([v, l]) => `<button class="tab" role="tab" type="button" aria-selected="${tab === v}" data-act="wbtab17d" data-v="${v}">${l}</button>`).join('')}</div>${list}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="wbexport17d">Save the workbook</button><button class="btn" type="button" data-act="wbrerun17d">Run the checks again</button><button class="btn pri" type="button" data-act="wbskill17d" ${w.skill ? 'disabled' : ''}>${w.skill ? 'Skill made' : 'Make it a skill'}</button>`});
}
Object.assign(ACTS, {
  wbstart17d: () => { const what = ($('#wb-what17d')?.value || WB_NEW.name).trim(); D.wb.run = {stage: 0, what}; render();
    const step = () => { const r = D.wb.run; if (!r) return; r.stage++; if (r.stage < 4) { if (S.view === 'customize') render(); later(step, 1100); return; }
      const w = {...WB_NEW, name: what, id: 'wb' + Date.now(), who: 'scout', when: 'just now'}; D.wb.list.unshift(w); D.wb.run = null; D.wb.open = w.id; D.wb.tab = 'must'; render(); if (!dlgEl) wbDlg(); toast(`Workbook ready: ${tally(w).pass} of ${tally(w).all} proved.`); };
    later(step, 1100); },
  wbopen17d: el => { D.wb.open = el.dataset.id; D.wb.tab = 'must'; wbDlg(); },
  'wb-open17d': () => { closeDlg(); S.view = 'customize'; S.tabs.customize = 'tools'; S.tools9 = {k: 'skills', sel: 'learn17d'}; render(); },
  wbtab17d: el => { D.wb.tab = el.dataset.v; wbDlg(); },
  wbrerun17d: () => { const w = D.wb.list.find(x => x.id === D.wb.open); toast(`Running ${w.must.reduce((n, m) => n + m[2].length, 0)} checks again on the private computer…`); later(() => { w.when = 'just now'; if (dlgEl?.querySelector('.wbv17d')) wbDlg(); toast('Same result. Nothing changed since the last run.'); }, 1500); },
  wbskill17d: () => { const w = D.wb.list.find(x => x.id === D.wb.open), id = w.name.toLowerCase().replace(/^the /, '').replace(/[^a-z0-9]+/g, '-').slice(0, 28).replace(/-$/, ''); if (!TOOLS9.skills.some(s => s.id === id)) TOOLS9.skills.push({id, name: id, src: 'From a workbook', desc: `What ${w.name} really does, with ${tally(w).pass} proved points.`, who: [w.who], on: true}); w.skill = true; wbDlg(); render(); toast(`Skill “${id}” made. Scout reads it before working in ${w.name}.`); },
  wbexport17d: () => toast('Saved the workbook as a Markdown file in Downloads.')
});
{ const _sl = POPS.slash; POPS.slash = (...a) => _sl(...a).replace('</button>', '</button>' + `<button class="mi" type="button" data-act="slash-pick" data-v="/learn-this"><span class="mi-t" style="font-family:var(--mono)">/learn-this</span><span class="r">Learn an app and prove it</span></button>`); }

/* =====================================================================================================
   4. Decision models: small, fast yes / pick / score / filter judgments for routing and triage
   ===================================================================================================== */
const DM = {
  yes: ['Yes or no', 'Is this email an invoice? “Hartwell Supply: Invoice INV-0826 for August, $1,340 due Sep 28”', ''],
  pick: ['Pick one', 'Which Trunk should answer: “Did Hartwell charge us the late fee?”', 'Scout, Ledger, Ada, Fieldnotes'],
  score: ['Score', 'How urgent is this, 1 to 10? “A late fee of $100 applies after Sep 28.”', ''],
  filter: ['Filter', 'Keep only the ones about money', 'Invoice INV-0826 from Hartwell\nLunch with Sam on Friday\nCard statement for September\nLease renewal reminder\nRefund from Delta, $61']
};
D.dm = D.dm || {kind: 'pick'};
const MONEY = /invoice|statement|refund|\$|bill|fee|rent|paid|charge|payment|expense/i;
function decide(kind, q, opts) {
  if (kind === 'yes') { const y = MONEY.test(q) && /invoice|bill|due/i.test(q); return {html: `<b>${y ? 'Yes' : 'No'}</b><small>${y ? 'It names an invoice and a due amount.' : 'Nothing asks for payment.'}</small>`, sure: y ? .96 : .88}; }
  if (kind === 'pick') { const list = opts.split(',').map(s => s.trim()).filter(Boolean); const want = MONEY.test(q) ? 'Ledger' : /trip|flight|hotel|lisbon/i.test(q) ? 'Ada' : /lease|pdf|read/i.test(q) ? 'Fieldnotes' : 'Scout'; const pick = list.find(x => x.toLowerCase() === want.toLowerCase()) || list[0] || want; return {html: `<b>${esc(pick)}</b><small>${pick === 'Ledger' ? 'It’s about a charge, and Ledger looks after money.' : 'Best match for the question.'}</small>`, sure: .91}; }
  if (kind === 'score') { const n = Math.min(10, 2 + ['due', 'late', 'fee', 'today', 'tomorrow', 'urgent', 'overdue'].filter(w => new RegExp(w, 'i').test(q)).length * 2 + (/\$\d/.test(q) ? 1 : 0)); return {html: `<b>${n} / 10</b><small>${n >= 7 ? 'A deadline with money attached.' : 'Nothing pressing.'}</small>`, sure: .84}; }
  const lines = opts.split('\n').map(s => s.trim()).filter(Boolean), m = q.match(/about ([a-z ]+)/i), word = m && !/money/i.test(m[1]) ? new RegExp(m[1].trim().split(' ')[0], 'i') : MONEY;
  const keep = lines.filter(l => word.test(l));
  return {html: `<b>Kept ${keep.length} of ${lines.length}</b><ul class="dm-f17d">${lines.map(l => `<li class="${keep.includes(l) ? 'k' : 'd'}">${ic(keep.includes(l) ? 'check' : 'x', 's')}${esc(l)}</li>`).join('')}</ul>`, sure: .9};
}
addSettings15('models', 1, () => { const k = D.dm.kind, [, q, o] = DM[k];
  return `<div class="sec x15-sec dm17d"><h2>Decision models</h2><p class="hint">Small, fast judgments: yes or no, pick one, a score, or keep-or-drop over a list. Branch uses them to send a message to the right Trunk and to sort the Inbox, so the big model isn’t woken for easy calls.</p>
    ${ctlSeg('Model for decisions', 'On this computer, so it’s free and nothing leaves.', ['Qwen3.6 4B here', 'GPT-6 Mini', 'Same as the task'], 'Qwen3.6 4B here')}
    ${sw15('Send each message to the right Trunk', 'When you don’t say who, it picks from their jobs.', true)}${sw15('Sort the Inbox by urgency', 'Deadlines and money first.', true)}${sw15('Filter long lists before a Trunk reads them', 'Mail, files and search results it clearly doesn’t need are dropped.', true)}
    <div class="dm-try17d"><div class="dm-h17d"><b>Try it</b><span class="seg" role="group" aria-label="Kind of decision">${Object.entries(DM).map(([v, [l]]) => `<button type="button" data-act="dmkind17d" data-v="${v}" aria-pressed="${k === v}">${l}</button>`).join('')}</span></div>
      <label class="fld"><span>Question</span><textarea class="inp" id="dm-q17d" rows="2">${esc(q)}</textarea></label>
      ${o ? `<label class="fld"><span>${k === 'filter' ? 'The list, one per line' : 'Choices, separated by commas'}</span>${k === 'filter' ? `<textarea class="inp" id="dm-o17d" rows="5">${esc(o)}</textarea>` : `<input class="inp" id="dm-o17d" value="${esc(o)}">`}</label>` : ''}
      <div class="acts"><button class="btn pri sm" type="button" data-act="dmrun17d">Decide</button><span class="hint" style="margin:0">Last 24 hours: 212 decisions · 140 ms on average · $0.00</span></div>
      <div class="dm-out17d" id="dm-out17d" aria-live="polite"></div></div></div>`; });
addSettings15('models', 2, () => sec15('Decision models, technical', num15('Ask the big model when it’s less sure than', 'Below this, the task’s own model decides instead.', '0.75', 'sure') + num15('Longest list it filters at once', 'Longer lists are split.', '400', 'lines')));
Object.assign(ACTS, {
  dmkind17d: el => { D.dm.kind = el.dataset.v; render(); },
  dmrun17d: () => { const k = D.dm.kind, q = $('#dm-q17d')?.value || '', o = $('#dm-o17d')?.value || '', out = $('#dm-out17d'); if (!out) return; out.innerHTML = `<span class="hint">${ic('spin', 's spin')} Deciding…</span>`;
    later(() => { const r = decide(k, q, o); out.innerHTML = `<div class="dm-r17d">${r.html}<span class="dm-m17d">${Math.round(r.sure * 100)}% sure · ${k === 'filter' ? 310 : 120 + q.length % 60} ms · Qwen3.6 4B on this computer · $0.00</span></div>`; }, 450); }
});

/* =====================================================================================================
   5. Words to a schedule, confirmed before it first runs (Automations › Describe it)
   ===================================================================================================== */
const DAYN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NOW = new Date(2026, 8, 25, 12, 4); /* the prototype's "now": Friday, Sep 25, 12:04 PM */
function parseWhen(text) {
  const t = text.toLowerCase(); let days = 'daily', day = null, guess = false, h = null, m = 0, hit = [];
  const dm = t.match(/every weekday|weekdays|on weekdays|every weekend|weekends|every (day|morning|night|evening)|daily|nightly|each day|every month|monthly|(?:every |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?/);
  if (dm) { hit.push(dm[0]); const s = dm[0]; if (/weekday/.test(s)) days = 'weekdays'; else if (/weekend/.test(s)) days = 'weekends'; else if (/month/.test(s)) days = 'monthly'; else if (dm[2]) { days = 'weekly'; day = DAYN.indexOf(dm[2]); } }
  else guess = true;
  const tm = t.match(/\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?|\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bnoon\b|\bmidnight\b/);
  if (tm) { hit.push(tm[0]); if (tm[0] === 'noon') h = 12; else if (tm[0] === 'midnight') h = 0; else { h = +(tm[1] || tm[4]); m = +(tm[2] || tm[5] || 0); const ap = tm[3] || tm[6]; if (ap && /p/.test(ap) && h < 12) h += 12; else if (ap && /a/.test(ap) && h === 12) h = 0; else if (!ap && h >= 1 && h <= 6) h += 12; } }
  else if (/morning/.test(t)) { h = 8; guess = true; } else if (/night/.test(t)) { h = 21; guess = true; } else if (/evening/.test(t)) { h = 18; guess = true; }
  let what = text; hit.forEach(x => { what = what.replace(new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ''); });
  what = what.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').replace(/^(and|then)\s+/i, '').replace(/\s{2,}/g, ' ');
  return {days, day, h, m, guess, what: what ? what[0].toUpperCase() + what.slice(1) : text};
}
const hm = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
const cap1 = s => s[0].toUpperCase() + s.slice(1);
const whenWords = p => p.h == null ? 'Pick a time' : (p.days === 'weekdays' ? 'Weekdays' : p.days === 'weekends' ? 'Weekends' : p.days === 'monthly' ? 'The 1st of each month' : p.days === 'weekly' ? cap1(DAYN[p.day]) + 's' : 'Every day') + ' at ' + hm(p.h, p.m);
const cronOf = p => `${p.m} ${p.h ?? '?'} ${p.days === 'monthly' ? 1 : '*'} * ${p.days === 'weekdays' ? '1-5' : p.days === 'weekends' ? '0,6' : p.days === 'weekly' ? p.day : '*'}`;
function firstRun(p) {
  if (p.h == null) return null;
  for (let i = 0; i < 40; i++) { const d = new Date(NOW); d.setDate(NOW.getDate() + i); d.setHours(p.h, p.m, 0, 0); if (d <= NOW) continue; const w = d.getDay();
    if ((p.days === 'weekdays' && (w === 0 || w === 6)) || (p.days === 'weekends' && w > 0 && w < 6) || (p.days === 'weekly' && w !== p.day) || (p.days === 'monthly' && d.getDate() !== 1)) continue;
    return (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', {weekday: 'long'})) + ', ' + d.toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) + ' at ' + hm(p.h, p.m); }
  return null;
}
function propCard() {
  const p = D.prop; if (!p) return '';
  if (p.kind === 'trig') return `<div class="prop17d" role="region" aria-label="Proposed trigger"><div class="pp-h17d">${ic('bolt', 's')}<b>Here’s the trigger Branch understood</b><span class="pill idle"><i></i>Not saved yet</span></div>
    <div class="pp-g17d"><label class="fld"><span>When</span><input class="inp" id="pp-when17d" value="${esc(p.when)}"></label><label class="fld"><span>It does</span><input class="inp" id="pp-what17d" value="${esc(p.what)}"></label></div>
    <div class="fld"><span>Who does it</span><span class="seg">${trunks().map(t => `<button type="button" data-act="ppset17d" data-k="trunk" data-v="${t.id}" aria-pressed="${p.trunk === t.id}">${esc(t.name)}</button>`).join('')}</span></div>
    <div class="acts"><button class="btn ghost sm" type="button" data-act="ppno17d">Cancel</button><button class="btn pri sm" type="button" data-act="ppok17d">Confirm the trigger</button></div></div>`;
  const fr = firstRun(p);
  return `<div class="prop17d" role="region" aria-label="Proposed schedule"><div class="pp-h17d">${ic('clock', 's')}<b>Here’s the schedule Branch understood</b><span class="pill idle"><i></i>Not saved yet</span></div>
    <label class="fld"><span>It does</span><input class="inp" id="pp-what17d" value="${esc(p.what)}"></label>
    <div class="fld"><span>Repeats</span><span class="seg" role="group" aria-label="Repeats">${[['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekends', 'Weekends'], ['weekly', 'Once a week'], ['monthly', 'Monthly']].map(([v, l]) => `<button type="button" data-act="ppset17d" data-k="days" data-v="${v}" aria-pressed="${p.days === v}">${l}</button>`).join('')}</span></div>
    ${p.days === 'weekly' ? `<div class="fld"><span>On</span><span class="seg">${DAYN.map((d, i) => `<button type="button" data-act="ppset17d" data-k="day" data-v="${i}" aria-pressed="${p.day === i}">${cap1(d.slice(0, 3))}</button>`).join('')}</span></div>` : ''}
    <div class="pp-g17d"><label class="fld ${p.h == null ? 'need17d' : ''}"><span>At${p.h == null ? ' · it didn’t say when' : ''}</span><input class="inp" type="time" id="pp-time17d" value="${p.h == null ? '' : String(p.h).padStart(2, '0') + ':' + String(p.m).padStart(2, '0')}"></label>
      <div class="fld"><span>Who does it</span><span class="seg">${trunks().slice(0, 5).map(t => `<button type="button" data-act="ppset17d" data-k="trunk" data-v="${t.id}" aria-pressed="${p.trunk === t.id}">${esc(t.name)}</button>`).join('')}</span></div></div>
    <p class="pp-first17d" id="pp-first17d">${fr ? `<b>${esc(whenWords(p))}</b> · first run ${esc(fr)}` : 'Pick a time to see when it first runs.'}${p.guess ? ' · Branch guessed part of this; check it.' : ''}</p>
    ${S.level === 'technical' ? `<code class="pp-cron17d">cron ${esc(cronOf(p))} · America/New_York</code>` : ''}
    <div class="acts"><button class="btn ghost sm" type="button" data-act="ppno17d">Cancel</button><button class="btn pri sm" type="button" data-act="ppok17d" ${fr ? '' : 'disabled'}>Confirm the schedule</button></div>
    <p class="hint" style="margin:0">It runs only after you confirm. Until then nothing is saved.</p></div>`;
}
document.addEventListener('submit', e => {
  const f = e.target; if (f.dataset?.form !== 'nl') return; e.preventDefault(); e.stopPropagation();
  const v = ($('#nl-in')?.value || '').trim(); if (!v) return; const tab = S.tabs.automations, trunk = S.chat === 'room' || !C(S.chat) || C(S.chat).kind !== 'trunk' ? 'branch' : S.chat;
  if (tab === 'triggers') { const m = v.match(/^(when [^,]+),?\s*(.*)$/i); D.prop = {kind: 'trig', when: m ? cap1(m[1]) : 'When something happens', what: m && m[2] ? cap1(m[2]) : v, trunk}; }
  else D.prop = {kind: 'sched', ...parseWhen(v), trunk: /brief|inbox|mail|calendar/i.test(v) ? 'ada' : /receipt|expense|invoice|bill/i.test(v) ? 'ledger' : trunk};
  render(); $('.prop17d input')?.focus();
}, true);
{ const _ra = renderAutomations; renderAutomations = function () { _ra.apply(this, arguments); if (!D.prop) return; const want = D.prop.kind === 'trig' ? 'triggers' : 'scheduled'; if (S.tabs.automations !== want) return; $('#main form.nl')?.insertAdjacentHTML('afterend', propCard()); }; }
const keepProp = () => { const p = D.prop; if (!p) return; const w = $('#pp-what17d'); if (w) p.what = w.value; const wh = $('#pp-when17d'); if (wh) p.when = wh.value; };
document.addEventListener('change', e => { if (e.target.id !== 'pp-time17d' || !D.prop) return; const [h, m] = e.target.value.split(':').map(Number); if (isNaN(h)) return; keepProp(); D.prop.h = h; D.prop.m = m || 0; render(); });
Object.assign(ACTS, {
  ppset17d: el => { keepProp(); const k = el.dataset.k; D.prop[k] = k === 'day' ? +el.dataset.v : el.dataset.v; if (k === 'days' && el.dataset.v === 'weekly' && D.prop.day == null) D.prop.day = 5; render(); },
  ppno17d: () => { D.prop = null; render(); toast('Nothing was saved.'); },
  ppok17d: () => { keepProp(); const p = D.prop; if (p.kind === 'trig') { automations.triggers.unshift({name: p.what.slice(0, 60), when: p.when, trunk: p.trunk, on: true}); D.prop = null; const i = $('#nl-in'); if (i) i.value = ''; render(); toast('Trigger saved and on.'); return; }
    const fr = firstRun(p); if (!fr) return; automations.scheduled.unshift({name: p.what.slice(0, 60), when: whenWords(p), trunk: p.trunk, on: true}); D.prop = null; render(); toast(`Scheduled. First run: ${fr}.`); }
});

/* =====================================================================================================
   6. Procedure steps: a change becomes a proposal the owner approves, with the difference, and history is kept
   ===================================================================================================== */
const stepText = s => ({when: 'When: ', do: '', if: 'If it says “', ask: 'Ask me: ', wait: 'Wait: '}[s.kind] || '') + (s.text || '') + (s.kind === 'if' ? `” → yes: ${s.yes || '…'} · no: ${s.no || '…'}` : '');
const clone = x => JSON.parse(JSON.stringify(x));
D.hist = D.hist || {
  'Tidy the Downloads folder': [{v: 1, when: 'Aug 29', who: 'Branch, after your third request', steps: clone(PROCS['Tidy the Downloads folder']).filter(s => s.kind !== 'ask')}, {v: 2, when: 'Sep 12', who: 'You', steps: clone(PROCS['Tidy the Downloads folder'])}],
  'Price check': [{v: 1, when: 'Sep 3', who: 'You', steps: clone(PROCS['Price check'])}],
  'Month-end report': [{v: 1, when: 'Sep 2', who: 'Learned by watching you once', steps: clone(PROCS['Month-end report'])}]
};
D.pend = D.pend || {'Month-end report': {who: 'ledger', why: 'Last month two receipts were missing and the report had to be built twice.', steps: (() => { const s = clone(PROCS['Month-end report']); s.splice(3, 0, {kind: 'if', text: 'a receipt is missing', yes: 'Ask me for it before building', no: 'Build the report'}); return s; })()}};
const histOf = n => D.hist[n] = D.hist[n] || [{v: 1, when: 'Earlier', who: 'You', steps: clone(PROCS[n] || [])}];
function diffSteps(a, b) {
  const A = a.map(stepText), B = b.map(stepText), L = Array.from({length: A.length + 1}, () => Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < A.length || j < B.length) { if (i < A.length && j < B.length && A[i] === B[j]) { out.push(['same', A[i]]); i++; j++; } else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) { out.push(['add', B[j]]); j++; } else { out.push(['rm', A[i]]); i++; } }
  return out;
}
function propDlg(name, steps, who, why) {
  const h = histOf(name), cur = h[h.length - 1], d = diffSteps(cur.steps, steps), v = cur.v + 1;
  const add = d.filter(x => x[0] === 'add').length, rm = d.filter(x => x[0] === 'rm').length;
  D.pp = {name, steps: clone(steps), who, v};
  openDlg({title: `Change “${name}”?`, wide: true, body: `<p style="margin:0 0 4px">${who === 'You' ? 'Your edit' : `${esc(C(who).name)} suggests this`}. Nothing changes until you approve it. It stays the same procedure, as version ${v}; version ${cur.v} is kept in its history.</p>${why ? `<p class="hint" style="margin:0 0 8px">Why: ${esc(why)}</p>` : ''}
    <div class="df-k17d">${add ? `<span class="add">+${add} added</span>` : ''}${rm ? `<span class="rm">−${rm} taken out</span>` : ''}<span>version ${cur.v} → ${v}</span></div>
    <ol class="df17d">${d.map(([k, t]) => `<li class="${k}"><em>${k === 'add' ? '+' : k === 'rm' ? '−' : ''}</em><span>${esc(t)}</span></li>`).join('')}</ol>`,
    foot: `<button class="btn ghost" type="button" data-act="ppback17d">${S.flow ? 'Back to editing' : 'Not now'}</button>${who !== 'You' ? '<button class="btn" type="button" data-act="ppdeny17d">Keep it as it is</button>' : ''}<button class="btn pri" type="button" data-act="ppapprove17d" ${add + rm ? '' : 'disabled'}>Approve version ${v}</button>`});
}
{ const _fs = ACTS['flow-save']; ACTS['flow-save'] = el => {
  const f = S.flow, a = automations.procedures[f.i]; if (f.steps.some(s => !(s.text || '').trim())) return _fs(el);
  const h = histOf(a.name), cur = h[h.length - 1].steps;
  if (JSON.stringify(cur.map(stepText)) === JSON.stringify(f.steps.map(stepText))) return _fs(el);
  propDlg(a.name, f.steps, 'You');
}; }
{ const _df = drawFlow; drawFlow = function () {
  _df.apply(this, arguments);
  const a = automations.procedures[S.flow.i], b = dlgEl?.querySelector('.dlg-b'); if (!b) return;
  const p = D.pend[a.name], h = histOf(a.name);
  if (p) b.insertAdjacentHTML('afterbegin', `<div class="fp17d" role="note">${av(C(p.who), 26)}<span class="grow"><b>${esc(C(p.who).name)} suggests a change</b><small>${esc(p.why)}</small></span><button class="btn sm" type="button" data-act="ppsee17d">See the change</button></div>`);
  b.insertAdjacentHTML('beforeend', `<div class="fh17d"><b>History</b><ol>${h.slice().reverse().map((x, i) => `<li><span class="grow"><b>Version ${x.v}</b><small>${esc(x.when)} · ${esc(x.who)}</small></span>${i === 0 ? pillOf('ok', 'In use') : `<button class="btn ghost sm" type="button" data-act="ppold17d" data-v="${x.v}">Go back to this</button>`}</li>`).join('')}</ol></div>`);
}; }
Object.assign(ACTS, {
  ppsee17d: () => { const a = automations.procedures[S.flow.i], p = D.pend[a.name]; propDlg(a.name, p.steps, p.who, p.why); },
  ppold17d: el => { const a = automations.procedures[S.flow.i], x = histOf(a.name).find(y => y.v === +el.dataset.v); propDlg(a.name, x.steps, 'You', `Going back to version ${x.v}. It becomes a new version, so nothing in the history is lost.`); },
  ppback17d: () => { if (S.flow) drawFlow(); else closeDlg(); },
  ppdeny17d: () => { const n = D.pp.name; delete D.pend[n]; closeDlg(); if (S.flow) drawFlow(); render(); toast(`Kept as it is. ${D.pp.who && C(D.pp.who) ? C(D.pp.who).name : 'The Trunk'} won’t suggest this again.`); },
  ppapprove17d: () => { const {name, steps, who, v} = D.pp, a = automations.procedures.find(x => x.name === name);
    histOf(name).push({v, when: 'Just now', who: who === 'You' ? 'You' : `${C(who).name}, approved by you`, steps: clone(steps)}); PROCS[name] = clone(steps); if (D.pend[name] && who !== 'You') delete D.pend[name];
    if (a) a.when = `${steps.length} steps · version ${v}`; if (S.flow) S.flow.steps = clone(steps); closeDlg(); render(); toast(`Version ${v} approved. It runs the new way next time; the old version is kept.`); }
});
{ const _ra2 = renderAutomations; renderAutomations = function () { _ra2.apply(this, arguments); if (S.tabs.automations !== 'procedures') return;
  document.querySelectorAll('#main .place .rows .prow').forEach((r, i) => { const a = automations.procedures[i]; if (a && D.pend[a.name]) r.querySelector('.grow b')?.insertAdjacentHTML('beforeend', ` <span class="pill work pp-pill17d"><i></i>Change suggested</span>`); }); }; }

/* =====================================================================================================
   7. Connectors: add your own server, kept after a reload, with a safety check and a yes before a program starts
   ===================================================================================================== */
const OWN = lsGet('mcp17d', []);
const ownEntry = o => ({id: o.id, name: o.name, icon: 'plug', st: 'ok', how: `${o.how === 'cmd' ? 'Local command' : 'Remote server'} · ${o.cmd}`, tools: ['search_notes', 'read_note', 'create_note'], who: ['branch'], on: true, own17d: o});
OWN.forEach(o => { if (!TOOLS9.mcp.some(x => x.id === o.id)) TOOLS9.mcp.push(ownEntry(o)); });
D.own = null;
const CHECKS = [['Preflight', 'Starts, answers the handshake and lists 3 tools: search_notes, read_note, create_note.'], ['Malware scan', 'No known bad version of the package; 0 flags from the scan.'], ['Fingerprint', 'sha256 9f2c…41ab is pinned. If the program changes, Branch asks you again.']];
function ownDlg() {
  const o = D.own = D.own || {how: 'cmd', name: 'My notes', cmd: 'npx -y @acme/notes-mcp', chk: 0, busy: false};
  const rows = CHECKS.map(([t, s], i) => `<li class="${i < o.chk ? 'ok' : o.busy && i === o.chk ? 'now' : ''}">${ic(i < o.chk ? 'check' : o.busy && i === o.chk ? 'spin' : 'info', o.busy && i === o.chk ? 's spin' : 's')}<span><b>${t}</b><small>${i < o.chk ? s : o.busy && i === o.chk ? 'Checking…' : 'Not run yet'}</small></span></li>`).join('');
  openDlg({title: 'Add your own server', body: `<div class="fld"><span>How it runs</span><span class="seg">${[['cmd', 'A program on this computer'], ['url', 'A web address']].map(([v, l]) => `<button type="button" data-act="ownhow17d" data-v="${v}" aria-pressed="${o.how === v}">${l}</button>`).join('')}</span></div>
    <label class="fld"><span>Name</span><input class="inp" id="own-name17d" value="${esc(o.name)}"></label>
    <label class="fld"><span>${o.how === 'cmd' ? 'Command' : 'Address'}</span><input class="inp code6" id="own-cmd17d" value="${esc(o.how === 'cmd' ? o.cmd : o.cmd.startsWith('http') ? o.cmd : 'https://notes.example/mcp')}" style="height:34px"></label>
    <label class="fld"><span>Secrets it needs</span><input class="inp" value="ACME_TOKEN, from the locker" aria-label="Secrets it needs"></label>
    <div class="own-chk17d"><b>Safety check</b><ol id="own-list17d">${rows}</ol>${o.how === 'cmd' ? '<p class="hint" style="margin:0">A program on this computer asks you before it starts, and again if it changes.</p>' : ''}</div>`,
    foot: `<button class="btn" type="button" data-act="ownchk17d" ${o.busy ? 'disabled' : ''}>${o.chk === 3 ? 'Check again' : 'Run the check'}</button><button class="btn pri" type="button" data-act="ownadd17d" ${o.chk === 3 ? '' : 'disabled'}>Add server</button>`});
}
const keepOwn = () => { const o = D.own; if (!o) return; const n = $('#own-name17d'), c = $('#own-cmd17d'); if (n) o.name = n.value.trim() || o.name; if (c) o.cmd = c.value.trim() || o.cmd; };
{ const _ta = toolAdd; toolAdd = function (k, step) {
  if (k === 'mcp' && step === 'own') { D.own = null; return ownDlg(); }
  const r = _ta.apply(this, arguments);
  if (k === 'mcp' && !step) { const p = dlgEl?.querySelector('.dlg-b > p'); if (p) p.textContent = `${MCP_CATALOG.length} connectors in curated groups, or add your own server. Every one is scanned and fingerprinted before it runs.`; }
  return r;
}; }
Object.assign(ACTS, {
  ownhow17d: el => { keepOwn(); D.own.how = el.dataset.v; D.own.chk = 0; if (el.dataset.v === 'url' && !D.own.cmd.startsWith('http')) D.own.cmd = 'https://notes.example/mcp'; if (el.dataset.v === 'cmd' && D.own.cmd.startsWith('http')) D.own.cmd = 'npx -y @acme/notes-mcp'; ownDlg(); },
  ownchk17d: () => { keepOwn(); const o = D.own; o.chk = 0; o.busy = true; ownDlg(); const step = () => { if (D.own !== o || !dlgEl?.querySelector('.own-chk17d')) { o.busy = false; return; } o.chk++; if (o.chk >= 3) { o.chk = 3; o.busy = false; } ownDlg(); if (o.busy) later(step, 700); }; later(step, 700); },
  ownadd17d: () => { keepOwn(); const o = D.own; if (o.how !== 'cmd') return saveOwn();
    openDlg({title: 'Start a program on this computer?', body: `<p style="margin:0 0 8px">Branch will run this to talk to <b>${esc(o.name)}</b>:</p><code class="own-cmd17d">${esc(o.cmd)}</code><p class="hint">It runs as you, with no window. It gets ACME_TOKEN from the locker and nothing else. Branch asks again if the program’s fingerprint changes.</p>`, foot: '<button class="btn ghost" type="button" data-act="ownback17d">Don’t start it</button><button class="btn pri" type="button" data-act="ownyes17d">Allow and start</button>'}); },
  ownback17d: () => ownDlg(),
  ownyes17d: () => saveOwn()
});
function saveOwn() {
  const o = D.own, rec = {id: 'own17d-' + Date.now().toString(36), name: o.name, how: o.how, cmd: o.cmd, fp: '9f2c…41ab', when: 'today'};
  OWN.push(rec); lsSet('mcp17d', OWN); TOOLS9.mcp.push(ownEntry(rec)); D.own = null; closeDlg();
  S.view = 'customize'; S.tabs.customize = 'tools'; S.tools9 = {k: 'mcp', sel: rec.id}; render(); toast(`${rec.name} is added and kept. Pick which Trunks may use it.`);
}
{ const _td2 = toolDetail; toolDetail = function (k, x) {
  const h = _td2.apply(this, arguments); if (k !== 'mcp') return h;
  const own = x.own17d, local = /Local command/.test(x.how || '');
  const sec = `<div class="sec own-safe17d"><h2>Safety check</h2><ul>${[['Preflight', x.st === 'err' ? 'Didn’t answer the handshake' : `Answered · ${x.tools.length} tools`, x.st !== 'err'], ['Malware scan', own ? 'Clean · scanned ' + own.when : 'Clean · checked by the catalogue', true], ['Fingerprint', own ? 'sha256 ' + own.fp + ' pinned' : 'Pinned when it was added', true]].map(([t, s, ok]) => `<li>${ic(ok ? 'check' : 'x', 's')}<b>${t}</b><small>${esc(s)}</small></li>`).join('')}</ul>${local ? '<p class="hint" style="margin:6px 0 0">A program on this computer: Branch asks you before it starts it for the first time, and again if it changes.</p>' : ''}${own ? `<p class="hint" style="margin:6px 0 0">Added by you ${esc(own.when)}. It stays after Branch restarts.</p>` : ''}</div>`;
  return h.replace(/(<div class="acts" style="margin-top:16px">)/, sec + '$1');
}; }
{ const _rm = ACTS['tool-rm']; ACTS['tool-rm'] = el => { if (el.dataset.k === 'mcp') { const i = OWN.findIndex(o => o.id === el.dataset.id); if (i >= 0) { OWN.splice(i, 1); lsSet('mcp17d', OWN); } } return _rm(el); }; }

/* =====================================================================================================
   8. Chat apps: Settings › Chat apps, each app's page, and a prompt when a bot token is revoked
   ===================================================================================================== */
D.ch = D.ch || {revoked: 'pending', fmt: {}};
const NATIVE = {telegram: 'MarkdownV2', slack: 'Slack mrkdwn', discord: 'Markdown', whatsapp: 'WhatsApp styles', matrix: 'HTML', signal: 'Signal styles'};
const fmtOf = id => D.ch.fmt[id] || NATIVE[id] || 'Plain text';
const chOn = () => CH12.filter(c => S.ch12.on[c.id]);
const chLine = c => c.id === 'telegram' && D.ch.revoked === 'pending' ? ['no', 'Offline', 'The bot token was revoked at 9:40 AM. Messages since then haven’t arrived.'] : ['ok', 'Online', 'Last update 4 s ago · the watchdog is happy'];
if (!PAGES.chatapps) {
  PAGES.chatapps = () => { const on = chOn();
    return `<h1>Chat apps</h1><p class="lede">Where you can message your Trunks, and how each chat app behaves.</p>
    <div class="rows ca17d">${on.map(c => { const [cls, w, s] = chLine(c); return `<div class="prow">${logo(c.id, 32)}<span class="grow"><b>${esc(c.name)}</b><small>${esc(s)}</small></span>${pillOf(cls, w)}<button class="btn sm" type="button" data-act="ch-open" data-v="${c.id}">Open</button></div>`; }).join('') || '<p class="empty">No chat app is connected yet.</p>'}</div>
    <div class="acts" style="margin-top:10px"><button class="btn" type="button" data-act="ptab" data-place="customize" data-v="channels">All ${CH12.length} chat apps</button></div>`; };
  SET_NAV.find(g => g[0] === 'Your assistant')?.[1].push(['chatapps', 'Chat apps']);
}
addSettings15('chatapps', 1, () => sec15('What the Trunk sees', sw15('Edited messages', 'When you edit a message, the Trunk sees the latest version and answers that one.', true) + sw15('Photo albums as one message', 'Ten photos sent together arrive as one message, not ten.', true) + ctlSeg('Wait for messages split in two', 'Some apps split long messages; Branch joins them first.', ['Off', '1 second', '3 seconds'], '1 second')));
addSettings15('chatapps', 1, () => sec15('Staying connected', sw15('Watch for a chat app that stops receiving', 'If no update arrives for a while, Branch reconnects it and tells you if that fails.', true) + ctlSeg('Reconnect after', 'Quiet apps are checked, not restarted.', ['1 minute', '3 minutes', '10 minutes'], '3 minutes') + sw15('Show online or offline in the app', 'The bot’s description says “Online” or “Offline, back soon”, so people know.', true) + `<div class="rows wd17d">${chOn().map(c => { const [cls, w] = chLine(c); return `<div class="prow">${logo(c.id, 24)}<span class="grow"><b>${esc(c.name)}</b><small>${cls === 'ok' ? 'Watchdog: last update 4 s ago · reconnected 0 times today' : 'Watchdog: stopped · the token was refused'}</small></span>${pillOf(cls, w)}</div>`; }).join('')}</div>`));
addSettings15('chatapps', 1, () => sec15('Formatting in each app', chOn().concat(CH12.filter(c => ['slack', 'discord', 'whatsapp'].includes(c.id) && !S.ch12.on[c.id])).map(c => `<div class="ctl"><b>${esc(c.name)}${S.ch12.on[c.id] ? '' : ' <small>(when connected)</small>'}</b><span class="right"><span class="seg" role="group" aria-label="Formatting in ${esc(c.name)}">${[NATIVE[c.id] || 'Its own styles', 'Plain text'].map(o => `<button type="button" data-act="chfmt17d" data-id="${c.id}" data-v="${esc(o)}" aria-pressed="${fmtOf(c.id) === o || (!D.ch.fmt[c.id] && !NATIVE[c.id] && o !== 'Plain text')}">${esc(o)}</button>`).join('')}</span></span><small>Bold, lists and links are turned into what ${esc(c.name)} shows.</small></div>`).join(''), 'Replies are written once and turned into each app’s own formatting.'));
addSettings15('chatapps', 2, () => sec15('Chat apps, technical', num15('Call it stalled after', 'No update from the app for this long.', '180', 'seconds') + `<div class="ctl"><b>Watchdog log</b><span class="right"><code>~/.branch/logs/channels/telegram.log</code></span><small>One line each time it checks or reconnects.</small></div>`));
ACTS.chfmt17d = el => { D.ch.fmt[el.dataset.id] = el.dataset.v; el.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === el))); toast(`${CH12.find(c => c.id === el.dataset.id)?.name}: ${el.dataset.v}.`); };
{ const _cg = channelsGrid12; channelsGrid12 = function () { const h = _cg.apply(this, arguments); return D.ch.revoked !== 'pending' || !S.ch12.on.telegram ? h : h.replace(/(data-v="telegram">[\s\S]*?<small>)Connected · reaches Branch(<\/small><\/span>)<i class="dot12"><\/i>/, '$1Offline · the bot token was revoked$2<i class="dot12 off17d"></i>'); }; }
/* each app's own page: the manage view of the setup wizard */
{ const _cw = chWizard; chWizard = function (id) {
  _cw.apply(this, arguments);
  const w = S.chw, c = CH12.find(x => x.id === id); if (!w || !c || !dlgEl) return;
  const cur = w.steps[Math.min(w.step, w.steps.length - 1)], body = dlgEl.querySelector('.chw-body12'); if (!body) return;
  if (D.ch.fixing === id && cur === 'Paste') body.insertAdjacentHTML('afterbegin', `<div class="status chfix17d"><span class="sdot bad"></span><div><b>The old token stopped working</b><p>Someone made a new token in BotFather, which revokes the old one. Send /token to @BotFather, pick your bot, and paste the new token here.</p></div></div>`);
  if (!S.ch12.on[id] || cur !== 'Save') return;
  const [cls, word, line] = chLine(c);
  body.insertAdjacentHTML('beforeend', `<div class="chx17d"><div class="chx-h17d">${pillOf(cls, word)}<small>${esc(line)}</small></div>
    <label class="chx-r17d"><input type="checkbox" class="sw" checked data-sw="set" aria-label="Sees edited messages"><span><b>Sees edited messages</b><small>It answers the latest version.</small></span></label>
    <label class="chx-r17d"><input type="checkbox" class="sw" checked data-sw="set" aria-label="Photo albums as one message"><span><b>Photo albums as one message</b><small>Not one reply per photo.</small></span></label>
    <label class="chx-r17d"><input type="checkbox" class="sw" checked data-sw="set" aria-label="Online status in the app"><span><b>Online status in ${esc(c.name)}</b><small>“Online” or “Offline, back soon” in the bot’s description.</small></span></label>
    <div class="chx-f17d"><b>Formatting</b><span class="seg">${[NATIVE[id] || 'Its own styles', 'Plain text'].map(o => `<button type="button" data-act="chfmt17d" data-id="${id}" data-v="${esc(o)}" aria-pressed="${fmtOf(id) === o || (!D.ch.fmt[id] && !NATIVE[id] && o !== 'Plain text')}">${esc(o)}</button>`).join('')}</span></div>
    ${cls === 'no' ? `<div class="acts"><button class="btn pri sm" type="button" data-act="revfix17d">Paste a new token</button></div>` : ''}</div>`);
}; }
{ const _save = ACTS['chw-save']; ACTS['chw-save'] = el => { const id = S.chw?.id; _save(el); if (id && D.ch.fixing === id) { D.ch.fixing = null; D.ch.revoked = 'fixed'; render(); toast(`${CH12.find(c => c.id === id)?.name} is back online. The watchdog is watching again.`); } }; }
addSection15('inbox', 'needs', () => D.ch.revoked !== 'pending' || !S.ch12.on.telegram ? '' : `<div class="rev17d" role="status">${logo('telegram', 34)}<span class="grow"><b>Telegram stopped: its bot token was revoked</b><small>A new token was made in BotFather at 9:40 AM, so the old one stopped working. Messages sent to @branch_taofik_bot since then haven’t reached Branch.</small></span><button class="btn ghost sm" type="button" data-act="revoff17d">Turn Telegram off</button><button class="btn pri sm" type="button" data-act="revfix17d">Paste the new token</button></div>`);
Object.assign(ACTS, {
  revfix17d: () => { D.ch.fixing = 'telegram'; S.chw = null; chWizard('telegram', 0); const i = S.chw?.steps.indexOf('Paste'); if (i > 0) chWizard('telegram', i); },
  revoff17d: () => { delete S.ch12.on.telegram; D.ch.revoked = 'off'; render(); toast('Telegram is off. Set it up again any time in Customize › Channels.', () => { S.ch12.on.telegram = 'ok'; D.ch.revoked = 'pending'; render(); }); }
});

/* =====================================================================================================
   10. Release notes for the installed version (and the one waiting)
   ===================================================================================================== */
const RN = {
  '0.19.4': {when: 'Installed Sep 18', groups: [['New', [['55 chat apps, each with its own setup recipe and a pairing code', 'view', {v: 'customize', tab: 'channels'}], ['Models on this computer: a hardware check and one-click models that fit', 'setgo', {v: 'local'}], ['Several accounts per service, used in the order you choose', 'setgo', {v: 'accounts'}], ['The gateway keeps Trunks running when the window is closed', 'setgo', {v: 'gateway'}]]], ['Better', [['Every file change keeps a checkpoint you can put back', null], ['Saved sign-ins come from Bitwarden; Branch never sees the password', 'setgo', {v: 'secrets'}], ['Settings has Regular, Advanced and Technical', null]]], ['Fixed', [['A Trunk no longer stops when the model service is slow to answer; it waits and retries', null], ['Telegram voice notes over 1 minute are transcribed in full', null]]]]},
  '0.20.0': {when: 'Ready to install', groups: [['New', [['Rooms can have rules: who answers first, and whether Trunks may message each other', null]]], ['Better', [['Faster first answer on this computer', null], ['A checkpoint before every file change, not only big ones', null]]]]}
};
D.rn = '0.19.4';
function notesDlg() {
  const v = D.rn, n = RN[v];
  openDlg({title: 'Release notes', wide: true, body: `<div class="rn17d"><span class="seg" role="group" aria-label="Version">${Object.keys(RN).map(k => `<button type="button" data-act="relnotes17d" data-v="${k}" aria-pressed="${v === k}">${k}${k === '0.19.4' ? ' · installed' : ' · ready'}</button>`).join('')}</span>
    <p class="hint" style="margin:10px 0 4px">Branch Agent ${v} · ${n.when}. These come with the version itself, so they match what’s on this computer.</p>
    ${n.groups.map(([g, items]) => `<div class="rn-g17d"><h3>${g}</h3><ul>${items.map(([t, a, d]) => `<li><span>${esc(t)}</span>${a ? `<button class="link" type="button" data-act="rngo17d" data-a="${a}" ${Object.entries(d).map(([k, x]) => `data-${k}="${x}"`).join(' ')}>Show me</button>` : ''}</li>`).join('')}</ul></div>`).join('')}</div>`,
    foot: v === '0.20.0' ? '<button class="btn ghost" type="button" data-act="dlg-close">Later</button><button class="btn pri" type="button" data-act="rninstall17d">Install when nothing is running</button>' : '<button class="btn pri" type="button" data-act="dlg-close">Done</button>'});
}
Object.assign(ACTS, {
  relnotes17d: el => { closePop(); if (el?.dataset?.v) D.rn = el.dataset.v; notesDlg(); },
  rngo17d: el => { closeDlg(); ACTS[el.dataset.a]?.(el); },
  rninstall17d: () => { closeDlg(); ACTS.install(); }
});
{ const _pu = PAGES.updates; PAGES.updates = () => _pu().replace('</p>', `</p><div class="rn-row17d">${ic('news17d', 's')}<span class="grow">You have 0.19.4. See what it has, and what 0.20.0 adds.</span><button class="btn sm" type="button" data-act="relnotes17d">Release notes</button></div>`); }
{ const _um = POPS.updmenu; POPS.updmenu = (...a) => _um(...a).replace(/(<button class="mi"[^>]*data-act="install")/, mi('relnotes17d', 'news17d', 'Read the release notes', '', 'data-v="0.20.0"') + '$1'); }
NEW13.unshift(['cloud17d', 'Always-on cloud computers', 'A Trunk keeps working while this PC sleeps. Off until you choose.', 'setgo', {v: 'computer'}],
  ['call17d', 'Phone calls and meeting notes', 'Call you, call someone for you with a consent step, or join a meeting and bring the notes back.', 'call17d', {}],
  ['book17d', 'Learn an app, and prove it', 'Branch writes what an app must do and checks each point on the real thing.', 'wb-open17d', {}],
  ['news17d', 'Release notes', 'What 0.19.4 has and what 0.20.0 adds.', 'relnotes17d', {}]);
/* test plumbing only (see BRANCH-DESIGN-INTENT §1.8.1): lets check17d.cjs read the example state */
window.__d17 = () => ({S, COMPUTERS, automations, PROCS, TOOLS9, library, render: () => render(), drawFlow: () => drawFlow()});
}
