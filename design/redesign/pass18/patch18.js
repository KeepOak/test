/* ================= pass 18: helpers you can see, room lanes, one frame (pass 18 wins over pass 17 where they differ) ================= */
/* Spec: pass18/PASS18.md and the coord repo's briefs/DESIGN-DIRECTION.md. 18a: the helpers frame above the composer and the
   view-only helper conversation. 18b: room lanes and the team run board. 18c: one frame, Settings in five groups, setup in
   three steps with "Finish setting up", friendly empty states, live lines under faces and calm motion.
   Every new class, action and state key ends in 18a, 18b or 18c (18 when shared). All data here is example data. */

/* ---------- a living face: the Trunk's 3D character, round. Characters always move (the owner's rule); only the
   explicit "hold still" choice, or a browser that can't show see-through video, gets the still. ---------- */
function fig18(look, st) {
  const src = stateSrc(look, st);
  return S.still || NOALPHA13 || !src ? `<img class="fig12" src="${look.still}" alt="" draggable="false" data-st="${st}">`
    : `<video class="fig12" src="${src}" poster="${look.still}" muted loop autoplay playsinline data-st="${st}" aria-hidden="true"></video>`;
}
function face18(c, s = 32, st = null, cls = '') {
  const look = c && c.kind !== 'room' ? lookOf(c) : null;
  if (!look) return `<span class="face18 ${cls}" style="--s:${s}px" aria-hidden="true">${av(c, s)}</span>`;
  return `<span class="face18 ${cls}" style="--s:${s}px" aria-hidden="true">${fig18(look, st || agentState(c))}</span>`;
}
const who18 = (letter, s = 40) => `<span class="face18 who18" style="--s:${s}px" aria-hidden="true">${esc(letter)}</span>`;
/* the live line under a face: plain words from the newest run; copper only for "needs you" */
function liveLine18(c) {
  if (!c) return '';
  const typing = ['think', 'talk'].includes(agentState(c)) ? '<span class="typing18"><i></i><i></i><i></i></span>' : '';
  if (c.status === 'waiting') return `<span class="live18 you18">Needs you: ${esc(String(c.preview || '').replace(/^Needs you:\s*/, ''))}</span>`;
  if (c.paused) return '<span class="live18">Paused</span>';
  if (c.status === 'working') return `<span class="live18">${esc(c.preview || 'Working')}${typing}</span>`;
  return '<span class="live18">Idle</span>';
}

/* ================= 18a: the helpers frame above the composer ================= */
S.hs18 = S.hs18 || {}; S.hfo18 = false; S.st18 = null; S.job18 = {}; S.vo18 = null;
const HX18 = {
  h1: {agent: 'ledger', live: 'Reading card-statement-aug.csv', steps18: ['Opened Documents/Statements', 'Found card-statement-aug.csv']},
  h2: {agent: null, live: 'Looking in Downloads/receipts', steps18: ['Opened Downloads/receipts', 'No Hartwell receipt there']}
};
const HELP18 = {scout: [
  ...HELP17C.scout.map(h => ({...h, ...HX18[h.id]})),
  {id: 'h3', name: 'Mail searcher', agent: 'ada', model: 'GPT-6 Sol', via: 'your ChatGPT account', job: 'Looks through your mail for the Hartwell invoice and saves it as a PDF next to the statement.', think: 'Two mails from Hartwell Supply in August. The second one has the invoice attached, so I’ll save that one.', steps: 5, cost: '$0.03', live: 'Searching mail for “Hartwell invoice”', done: 'Done · invoice saved', steps18: ['Opened your mail', 'Searched for “Hartwell invoice”', 'Found 2 mails from Hartwell Supply']},
  {id: 'h4', name: 'Sum checker', agent: null, model: 'Qwen3.6 35B', via: 'on this computer · free', job: 'Adds up the September receipts and compares the total with the bank export.', think: 'Sixteen receipts, one bank export. The totals match to the cent.', steps: 4, cost: '$0.00', done: 'Done · the totals match', finished: true, steps18: ['Read bank-export-sep.csv', 'Added up 16 receipts', 'Compared the totals']}
]};
const HELP_T0 = Date.now() - 42000;
function status18(h) {
  if (S.hs18[h.id] === 'stopped') return 'stopped';
  if (h.finished) return 'done';
  if (h.req) { const a = S.hp17c[h.req.id]; return !a ? 'wait' : a === 'allowed' ? 'done' : 'stopped'; }
  return 'run';
}
const RANK18 = {wait: 0, run: 1, done: 2, stopped: 3};
const helpers18 = id => (HELP18[id] || []).slice().sort((a, b) => RANK18[status18(a)] - RANK18[status18(b)]);
const hLive18 = h => ({wait: `Needs you: ${h.req?.what || ''}`, run: h.live, done: h.done, stopped: 'Stopped'})[status18(h)];
/* a helper that is a Trunk shows that Trunk's face; one without an agent shows its parent's face, dimmed */
const hFace18 = (h, parent, s) => h.agent ? face18(C(h.agent), s, status18(h) === 'run' ? 'work' : status18(h) === 'wait' ? 'wait' : 'idle') : face18(C(parent), s, status18(h) === 'run' ? 'work' : 'idle', 'dim18');
const clock18 = () => { const s = Math.max(0, Math.floor((Date.now() - HELP_T0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function helperRow18(h, parent) {
  const st = status18(h);
  return `<div class="hfr18a">${hFace18(h, parent, 28)}<span class="nm18"><b>${esc(h.name)}</b><span class="live18 ${st === 'wait' ? 'you18' : ''}">${esc(hLive18(h))}</span></span><span class="chip18">${esc(h.model)}</span>${st === 'wait'
    ? '<button class="btn pri sm" type="button" data-act="hf18a">Look</button>'
    : `<button class="btn ghost sm" type="button" data-act="hfstop18a" data-id="${h.id}">Stop</button>`}</div>`;
}
function helperCard18(h, parent) {
  const st = status18(h), c = C(parent), live = st === 'run' || st === 'wait';
  const ask = st === 'wait' ? `<div class="ask18a"><span class="chip18">${esc(h.req.cat)}</span><span class="q18"><b>${esc(h.req.what)}?</b><small>${esc(h.req.where)} · asked by ${esc(h.name)} for ${esc(c.name)}</small></span><button class="btn ghost sm" type="button" data-act="hpdo17c" data-id="${h.req.id}" data-v="denied">No</button><button class="btn pri sm" type="button" data-act="hpdo17c" data-id="${h.req.id}" data-v="allowed">Allow once</button></div>` : '';
  const steer = S.st18 === h.id ? `<div class="steer18a"><input id="steer18" type="text" placeholder="Tell ${esc(h.name)} what to change" aria-label="Steer ${esc(h.name)}"><button class="btn pri sm" type="button" data-act="hfsend18a" data-id="${h.id}">Send</button></div>` : '';
  return `<div class="card18a ${st === 'wait' ? 'wait18' : st === 'done' || st === 'stopped' ? 'done18' : ''}"><div class="ch18a">${hFace18(h, parent, 36)}<span class="grow"><b>${esc(h.name)}</b><span class="live18 ${st === 'wait' ? 'you18' : ''}">${esc(hLive18(h))}</span></span><span class="chip18">${esc(h.model)} · ${esc(h.via)}</span></div>
    <p class="job18a ${S.job18[h.id] ? 'full18' : ''}" data-act="hfjob18a" data-id="${h.id}">${esc(h.job)}</p>
    ${h.think ? `<details class="hpth17c"><summary>${ic('chev', 's chev')}What it’s thinking</summary><p>${esc(h.think)}</p></details>` : ''}
    ${ask}${steer}
    <div class="acts18a"><span class="chip18">${h.steps} steps · ${esc(h.cost)}</span><span class="grow"></span>${live ? `<button class="btn sm" type="button" data-act="hfsteer18a" data-id="${h.id}">Steer</button><button class="btn ghost sm" type="button" data-act="hfstop18a" data-id="${h.id}">Stop</button>` : ''}<button class="btn sm" type="button" data-act="hfopen18a" data-id="${h.id}">Open</button></div></div>`;
}
function frame18(parent) {
  const list = helpers18(parent), act = list.filter(h => ['run', 'wait'].includes(status18(h)));
  if (!act.length) return '';
  const wait = list.filter(h => status18(h) === 'wait').length, rows = act.slice(0, 3), rest = list.length - rows.length;
  return `<section class="hf18a ${S.hfo18 ? 'open' : ''}" aria-label="Helpers" data-note="hf18a">
    <button class="hfh18a" type="button" data-act="hf18a" aria-expanded="${S.hfo18}"><span class="stack18">${rows.map(h => hFace18(h, parent, 24)).join('')}</span><span class="grow">${list.length} helpers${wait ? ` · <span class="need18">${wait} ${wait > 1 ? 'need' : 'needs'} you</span>` : ''}</span><span class="time18">${clock18()}</span><span class="chev18">${ic('down', 's')}</span></button>
    ${rows.map(h => helperRow18(h, parent)).join('')}${rest > 0 ? `<div class="hfr18a"><button class="more18" type="button" data-act="hf18a">Show all ${list.length}</button></div>` : ''}
    <div class="hfb18a"><div><div class="roster18a">${list.map(h => helperCard18(h, parent)).join('')}<p class="hint">Each helper runs on its own model and asks for its own approvals. Nothing a helper does skips your rules.</p></div></div></div>
  </section>`;
}
const findHelper18 = id => Object.values(HELP18).flat().find(h => h.id === id) || TEAM18.lanes.find(l => l.id === id);
Object.assign(ACTS, {
  hf18a: () => { S.hfo18 = !S.hfo18; const f = $('.hf18a'); if (f) { f.classList.toggle('open', S.hfo18); f.querySelector('.hfh18a')?.setAttribute('aria-expanded', String(S.hfo18)); setTimeout(liftAgent18, 220); } else render(); },
  hfjob18a: el => { S.job18[el.dataset.id] = !S.job18[el.dataset.id]; el.classList.toggle('full18', !!S.job18[el.dataset.id]); },
  hfsteer18a: el => { S.st18 = S.st18 === el.dataset.id ? null : el.dataset.id; if (S.view === 'chat') S.hfo18 = true; render(); setTimeout(() => $('#steer18')?.focus(), 0); },
  hfsend18a: el => { const t = ($('#steer18')?.value || '').trim(), h = findHelper18(el.dataset.id); if (!t || !h) return; S.st18 = null; render(); toast(`Sent to ${h.name}. It reads it before its next step.`); },
  hfstop18a: el => { const h = findHelper18(el.dataset.id); if (!h) return; S.hs18[h.id] = 'stopped'; render(); toast(`Stopped ${h.name}. The other helpers keep going.`); },
  hfopen18a: el => { const parent = S.chat; S.vo18 = {kind: 'helper', id: el.dataset.id, parent}; S.hfo18 = false; render(); },
  voback18: () => { const v = S.vo18; S.vo18 = null; if (v) openChat(v.parent); else render(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'steer18') { e.preventDefault(); $('[data-act="hfsend18a"]')?.click(); } });
setInterval(() => document.querySelectorAll('.time18').forEach(el => { el.textContent = clock18(); }), 1000);

/* the view-only conversation of a helper (or of a room member): what it was asked, its steps, and one way back */
function helperThread18(h, parent) {
  const c = C(parent), st = status18(h);
  return `<div class="voh18">${hFace18(h, parent, 28)}<span>What ${esc(c.name)} asked for: ${esc(h.job)}</span></div>
    <div class="b"><div class="gut">${hFace18(h, parent, 28)}</div><div><ol class="vosteps18">${h.steps18.map((s, i) => `<li class="${st === 'run' && i === h.steps18.length - 1 ? 'now18' : ''}">${esc(s)}</li>`).join('')}</ol>
    ${h.think ? `<details class="hpth17c" open><summary>${ic('chev', 's chev')}What it’s thinking</summary><p>${esc(h.think)}</p></details>` : ''}
    ${st === 'wait' ? `<div class="ask18a"><span class="chip18">${esc(h.req.cat)}</span><span class="q18"><b>${esc(h.req.what)}?</b><small>${esc(h.req.where)} · asked by ${esc(h.name)} for ${esc(c.name)}</small></span><button class="btn ghost sm" type="button" data-act="hpdo17c" data-id="${h.req.id}" data-v="denied">No</button><button class="btn pri sm" type="button" data-act="hpdo17c" data-id="${h.req.id}" data-v="allowed">Allow once</button></div>` : ''}
    <p class="hint">${esc(hLive18(h))} · ${h.steps} steps · ${esc(h.cost)}</p></div></div>`;
}
function dressViewOnly18() {
  const v = S.vo18; if (!v || S.view !== 'chat') return;
  const back = C(v.parent); if (!back) return;
  const dock = $('#main .dock');
  if (dock) dock.innerHTML = `<div class="vo18" data-note="vo18"><span class="grow">View only</span><button class="btn pri sm" type="button" data-act="voback18">${ic('back', 's')}Back to ${esc(back.name)}</button></div>`;
  $('.agent12')?.remove();
  const who = $('.head .who'), face = $('.head > .av, .head > .face18');
  if (v.kind === 'helper') {
    const h = findHelper18(v.id); if (!h) return;
    const th = $('#scroll .thread'); if (th) th.innerHTML = helperThread18(h, v.parent);
    if (who) who.innerHTML = `<b>${esc(h.name)}</b><small>Helper for ${esc(back.name)} · view only</small>`;
    if (face) face.outerHTML = hFace18(h, v.parent, 32);
  } else if (who) who.innerHTML = `<b>${esc(C(v.id)?.name || '')}</b><small>In ${esc(back.name)} · view only</small>`;
}
/* the frame sits at the top of the dock, above the chips row (Steer, N waiting, N in the background) */
function dressFrame18() {
  if (S.view !== 'chat' || S.vo18 || !HELP18[S.chat]) return;
  if (typeof pathsOf17c === 'function' && pathsOf17c(S.chat).cur !== 'main') return;
  const dock = $('#main .dock'); if (!dock || dock.querySelector('.hf18a')) return;
  const html = frame18(S.chat), chip = $('#scroll .hl17c');
  /* while the frame shows, it is the one place for helpers; once all are done, the thread's chip says so */
  if (html) { dock.insertAdjacentHTML('afterbegin', html); chip?.remove(); }
  else if (chip) chip.querySelector('span:last-of-type').textContent = `${HELP18[S.chat].length} helpers · done`;
  liftAgent18();
}
/* the floating character window moves up by the frame's height, so it never covers a helper's Stop */
function liftAgent18() {
  const a = $('.agent12'), f = $('.hf18a'); if (!a) return;
  a.style.removeProperty('bottom'); if (!f) return;
  a.style.bottom = `${parseFloat(getComputedStyle(a).bottom) + f.offsetHeight + 8}px`;
}

/* ================= 18b: room lanes ("Who's in the room") in the room's side panel ================= */
const PASSED18 = {grp: ['scout']};
const OTHER18 = {hermes: ['Hermes Agent', 'H', 'No duplicates against last month.']};
const PERSON18 = {d: ['Dana', 'D']};
function lanes18(room) {
  const trunk = id => { const c = C(id); if (!c) return '';
    const line = (PASSED18[room.id] || []).includes(id) ? '<span class="live18">Had nothing to add</span>' : liveLine18(c);
    return `<button class="lane18b" type="button" data-act="lane18b" data-id="${esc(id)}" data-room="${esc(room.id)}" aria-label="Open ${esc(c.name)}’s conversation, view only">${face18(c, 40, c.status === 'working' ? 'work' : null)}<span class="grow"><b>${esc(c.name)}</b>${line}</span>${ic('chev', 's')}</button>`; };
  const other = id => { const a = OTHER18[id]; return a ? `<div class="lane18b">${who18(a[1])}<span class="grow"><b>${esc(a[0])}</b><span class="live18">${esc(a[2])}</span></span></div>` : ''; };
  const person = id => { const p = PERSON18[id]; return p ? `<div class="lane18b">${who18(p[1])}<span class="grow"><b>${esc(p[0])}</b><span class="live18">Person · here now</span></span></div>` : ''; };
  return `<section class="lanes18b" aria-label="Who’s in the room" data-note="lanes18b"><h3>Who’s in the room</h3>${(room.members || []).map(trunk).join('')}${(room.agents || []).map(other).join('')}${(room.people || []).map(person).join('')}</section>`;
}
function dressPane18() {
  const body = $('#pane .pane-b'); if (!body || S.view !== 'chat' || S.pane !== 'activity') return;
  if (S.empty18) { body.innerHTML = empty18('pane:activity'); return; }
  const c = C(S.chat); if (!c || c.kind !== 'room' || body.querySelector('.lanes18b')) return;
  /* the lanes replace "No steps yet": each member runs in its own conversation */
  [...body.children].forEach(el => { if (/No steps yet/.test(el.textContent || '')) el.remove(); });
  body.insertAdjacentHTML('afterbegin', lanes18(c));
}
Object.assign(ACTS, {
  lane18b: el => { const room = el.dataset.room; openChat(el.dataset.id); S.vo18 = {kind: 'member', id: el.dataset.id, parent: room}; render(); }
});

/* ================= 18b: the team run board (Team › Teams of specialists) ================= */
S.tb18 = S.tb18 ?? true;
const TEAM18 = {name: 'Month-end close', purpose: 'Closes September: finds the receipts, checks them, writes the summary.', roles: [['scout', 'Researcher'], ['ledger', 'Checker'], ['field', 'Writer']],
  lanes: [
    {id: 't1', round: 1, who: 'scout', name: 'Scout', live: 'Done · found 16 receipts', st: 'done', model: 'GPT-6 Sol', steps: 9, cost: '$0.06'},
    {id: 't2', round: 2, who: 'scout', name: 'Scout', live: 'Finding the last receipt in Outlook', st: 'run', model: 'GPT-6 Sol', steps: 4, cost: '$0.02'},
    {id: 't3', round: 2, who: 'ledger', name: 'Ledger', live: 'Has a handoff from Scout', st: 'wait', model: 'Opus 5.5', steps: 2, cost: '$0.01'},
    {id: 't4', round: 3, who: 'field', name: 'Fieldnotes', live: 'Writes the summary last', st: 'idle', model: 'Qwen3.6 35B', steps: 0, cost: '$0.00'}
  ],
  handoff: {from: 'Scout', to: 'Ledger', what: '14 receipts matched, 2 need a category.'}};
function teamLane18(l) {
  const c = C(l.who), st = S.hs18[l.id] === 'stopped' ? 'stopped' : l.st, live = st === 'run' || st === 'wait';
  const line = st === 'stopped' ? 'Stopped' : l.live;
  return `<div class="card18a ${st === 'wait' ? 'wait18' : st === 'done' || st === 'stopped' ? 'done18' : ''}"><div class="ch18a">${face18(c, 36, st === 'run' ? 'work' : st === 'wait' ? 'wait' : 'idle')}<span class="grow"><b>${esc(l.name)}</b><span class="live18 ${st === 'wait' ? 'you18' : ''}">${esc(line)}</span></span><span class="chip18">${esc(l.model)}</span></div>
    ${S.st18 === l.id ? `<div class="steer18a"><input id="steer18" type="text" placeholder="Tell ${esc(l.name)} what to change" aria-label="Steer ${esc(l.name)}"><button class="btn pri sm" type="button" data-act="hfsend18a" data-id="${l.id}">Send</button></div>` : ''}
    <div class="acts18a"><span class="chip18">${l.steps} steps · ${esc(l.cost)}</span><span class="grow"></span>${live ? `<button class="btn sm" type="button" data-act="hfsteer18a" data-id="${l.id}">Steer</button><button class="btn ghost sm" type="button" data-act="hfstop18a" data-id="${l.id}">Stop</button>` : ''}</div></div>`;
}
function teamBoard18() {
  const t = TEAM18, rounds = [...new Set(t.lanes.map(l => l.round))];
  return `<section class="team18b" data-note="team18b"><button class="th18" type="button" data-act="tboard18b" aria-expanded="${S.tb18}"><span class="grow"><b>${esc(t.name)}</b><small>${esc(t.purpose)}</small></span><span class="pill work"><i></i>Working · round 2</span><span class="chev18">${ic(S.tb18 ? 'chev' : 'down', 's')}</span></button>
    <div class="roles18b">${t.roles.map(([id, role]) => `<span>${face18(C(id), 26)}${esc(C(id).name)} · ${esc(role)}</span>`).join('')}</div>
    ${S.tb18 ? `<div class="board18b">${rounds.map(r => `<div class="round18b"><small>Round ${r}</small><div class="lanes">${t.lanes.filter(l => l.round === r).map(teamLane18).join('')}</div></div>`).join('')}
      <div class="hand18b" data-note="hand18b">${ic('branch', 's')}<span class="grow"><b>Open handoff: ${esc(t.handoff.from)} → ${esc(t.handoff.to)}</b><small>${esc(t.handoff.what)}</small></span><button class="btn sm held18" type="button" data-act="hoaccept18b" data-held="security" disabled aria-disabled="true" title="Coming soon">Accept</button><button class="btn ghost sm held18" type="button" data-act="horeject18b" data-held="security" disabled aria-disabled="true" title="Coming soon">Reject</button></div></div>` : ''}
  </section>`;
}
Object.assign(ACTS, { tboard18b: () => { S.tb18 = !S.tb18; render(); } });
function dressTeam18() {
  if (S.view !== 'team' || S.tabs.team !== 'agents' || S.empty18) return;
  const old = $('#main .place [data-note="agentteam"]');
  if (old) old.outerHTML = teamBoard18();
  else if (!$('#main .team18b')) $('#main .place .tabs')?.insertAdjacentHTML('afterend', teamBoard18());
}

/* ================= 18c: one frame ================= */
/* one reading width for chat and rooms (720 px); Wide and Full stay in Appearance for anyone who wants them */
S.width = 'comfortable';
/* the update banner shows only on Overview and Inbox */
function dressUpdate18() {
  if (!['overview', 'inbox'].includes(S.view)) return;
  const place = $('#main .place'); if (!place || place.querySelector('.upd18c')) return;
  const h1 = place.querySelector(':scope > h1');
  const html = `<div class="upd18c" role="status" data-note="upd18c">${ic('spark', 's')}<span class="grow"><b>Branch 0.20.0 is ready</b><small>Installs when nothing is running and keeps a safety copy first.</small></span><button class="btn ghost sm" type="button" data-act="relnotes17d" data-v="0.20.0">Read the release notes</button><button class="btn pri sm" type="button" data-act="install">Install when nothing is running</button></div>`;
  if (h1) h1.insertAdjacentHTML('beforebegin', html); else place.insertAdjacentHTML('afterbegin', html);
}
/* the pet moves into the owner row, so nothing floats over the list */
function dressPet18() {
  const k = $('#side .keeper'), o = $('#side .owner-wrap'); if (!k || !o) return;
  o.classList.add('pet18c'); if (k.parentElement !== o) o.appendChild(k);
}
/* at phone width the room's placeholder is short; "@ to call a Trunk" moves into the @ list */
function dressComposer18() {
  const m = $('#msg'), c = C(S.chat); if (!m || !c || c.kind !== 'room') return;
  m.placeholder = 'Message the room';
}
{ const _men18 = POPS.mention; POPS.mention = (...a) => `<p class="athint18c">@ to call a Trunk</p>` + _men18(...a); }
/* the status bar keeps the dot and the count at phone width */
{ const _rs18 = renderStatus; renderStatus = function () { _rs18.apply(this, arguments);
  const b = $('#statusbar [data-act="machines"]'); if (b && !b.querySelector('.where18c')) b.innerHTML = b.innerHTML.replace(' · this computer', '<span class="where18c"> · this computer</span>');
  /* at phone width the dots stay and the words go, so the running count is never cut off */
  document.querySelectorAll('#statusbar [data-act="machines"], #statusbar [data-act="gwpop"]').forEach(el => el.childNodes.forEach(n => { if (n.nodeType === 3 && n.textContent.trim()) n.replaceWith(Object.assign(document.createElement('span'), {className: 'sbt18c', textContent: n.textContent})); }));
  /* prototype only: see every list empty (the window draws an empty state whenever the engine returns nothing) */
  if (!$('#statusbar [data-act="empty18proto"]')) $('#statusbar .proto7')?.insertAdjacentHTML('beforebegin', `<button class="sb" type="button" data-act="empty18proto" aria-pressed="${!!S.empty18}">${S.empty18 ? 'Show the sample' : 'Show empty lists'}</button>`);
}; }

/* ================= 18c: Settings in five plain groups, in the sidebar (no third column) ================= */
const GROUPS18 = [['You', ['general', 'people', 'appearance', 'notifications', 'achievements']], ['Assistant', ['instructions', 'models', 'accounts', 'local', 'voice']], ['Reach', ['chatapps', 'gateway']], ['Safety', ['permissions', 'computer', 'secrets']], ['Care', ['usage', 'self', 'updates']]];
function dressSettings18() {
  const side = $('#side'); if (!side) return;
  const on = S.view === 'settings' && !matchMedia('(max-width:760px)').matches;
  side.classList.toggle('set18c', on);
  if (S.view !== 'settings') { side.querySelector(':scope > .set-nav')?.remove(); return; }
  const nav = $('#main .set-nav'); if (!nav || nav.dataset.g18) return;
  const btns = new Map([...nav.querySelectorAll('[data-act="setpage"]')].map(b => [b.dataset.v, b]));
  nav.querySelectorAll('.grp').forEach(g => g.remove());
  const before = nav.querySelector('.set-level');
  GROUPS18.forEach(([g, ids]) => {
    nav.insertBefore(Object.assign(document.createElement('div'), {className: 'grp', textContent: g}), before);
    ids.forEach(id => { const b = btns.get(id); if (b) { nav.insertBefore(b, before); btns.delete(id); } });
  });
  btns.forEach(b => nav.insertBefore(b, before)); /* any later page joins Care */
  const back = nav.querySelector('.set-back'); if (back) back.innerHTML = `${ic('back', 's')}Back to Branch Agent`;
  nav.dataset.g18 = '1'; nav.dataset.note = 'set18c';
  if (on) { side.querySelector(':scope > .set-nav')?.remove(); side.appendChild(nav); $('#main .settings')?.classList.add('set18c'); }
}

/* ================= 18c: setup asks three things; the rest waits on Overview ================= */
OB_STEPS.splice(0, OB_STEPS.length, ['welcome', 'Welcome'], ['brains', 'Models'], ['trunks', 'Your first Trunk']);
{ const _ob18 = obBody; obBody = function (k) {
  const h = _ob18(k);
  if (k === 'brains') return h + `<div class="later18c" data-note="later18c">${ic('clock', 's')}<span class="grow">${S.ob?.later ? 'You can choose a model any time in Settings › Models.' : 'Not sure yet? Skip this and choose one any time in Settings › Models.'}</span><button class="btn" type="button" data-act="oblater18c">Choose the model later</button></div>`;
  return h;
}; }
Object.assign(ACTS, { oblater18c: () => { S.ob.later = true; S.ob.brains = S.ob.brains.map(() => false); openOnboarding(S.ob.i + 1); } });
S.fin18 = S.fin18 || {where: true};
const FIN18 = [
  ['where', 'Where Branch runs', 'This computer, or another one', 'general'],
  ['yours', 'Make it yours', 'A look, a pet and a painted scene', 'appearance'],
  ['reach', 'Reach it anywhere', 'Telegram, WhatsApp, Discord and more', 'chatapps'],
  ['tools', 'Tools', 'Mail, files and apps your Trunks can use', 'tools'],
  ['keep', 'Keep it running', 'The gateway keeps Branch running in the background', 'gateway'],
  ['people', 'People', 'Anyone else who uses Branch', 'people'],
  ['more', 'Two more things', 'Email and calendar, and bringing back a backup', 'accounts'],
  ['check', 'Health check', 'Branch checks everything', 'self']
];
function finCard18() {
  const done = FIN18.filter(f => S.fin18[f[0]]).length;
  if (S.fin18hide || done === FIN18.length) return '';
  return `<div class="tile fin18c" data-note="fin18c"><div class="th"><b>Finish setting up</b><span class="hint ml">${done} of ${FIN18.length} done</span><button class="btn ghost sm" type="button" data-act="finhide18c">Hide</button></div><p>These can wait until you want them.</p>
    <ol>${FIN18.map(([k, t, s]) => `<li class="${S.fin18[k] ? 'ok18' : ''}"><span class="tick18">${S.fin18[k] ? ic('check', 's') : ''}</span><span class="grow"><b>${esc(t)}</b><small>${esc(s)}</small></span>${S.fin18[k] ? '' : `<button class="btn sm" type="button" data-act="fin18c" data-v="${k}">Open</button>`}</li>`).join('')}</ol></div>`;
}
Object.assign(ACTS, {
  fin18c: el => { const f = FIN18.find(x => x[0] === el.dataset.v); if (!f) return; S.fin18[f[0]] = true;
    if (f[3] === 'tools') { S.view = 'customize'; S.tabs.customize = 'tools'; } else { S.view = 'settings'; S.setPage = f[3]; } render(); },
  finhide18c: () => { S.fin18hide = true; render(); toast('Hidden. Setup is still in the Guide menu.'); }
});
function dressOverview18() {
  if (S.view !== 'overview' || S.empty18) return;
  const grid = $('#main .place .ov'); if (!grid || grid.querySelector('.fin18c')) return;
  const html = finCard18(); if (html) grid.insertAdjacentHTML('afterbegin', html);
}

/* ================= 18c: every empty list is a welcome: a character, one sentence, one button ================= */
/* [pose (public/art/branch-<pose>.webp), sentence, button, action, extra attributes, held for review] */
const EMPTY18 = {
  'team:live': ['sleep', 'Nobody is working right now. When a Trunk starts a task, it shows up here.', 'Start a conversation', 'newconv'],
  'team:people': ['wave', 'It’s just you here so far.', 'Invite someone', 'invite', '', true],
  'team:groups': ['point', 'No groups yet. A group shares Trunks and rules with a few people.', 'Make a group', 'group', '', true],
  'team:shared': ['read', 'Nothing is shared yet.', 'Share a conversation', 'share', '', true],
  'team:agents': ['work', 'No teams yet. A team is a few Trunks that take one big job together.', 'Make a team', 'mkteam18c'],
  'team:activity': ['read', 'Nothing has happened yet.', 'Start a conversation', 'newconv'],
  'team:usage': ['sleep', 'No usage yet. It fills in as your Trunks work.', 'Start a conversation', 'newconv'],
  'inbox:needs': ['yay', 'Nothing needs you. Anything that does will wait here.', 'Start a conversation', 'newconv'],
  'inbox:finished': ['sleep', 'Nothing has finished yet.', 'Start a conversation', 'newconv'],
  'inbox:history': ['read', 'No history yet.', 'Start a conversation', 'newconv'],
  'automations:scheduled': ['sleep', 'Nothing runs on a schedule yet.', 'New automation', 'newmenu'],
  'automations:triggers': ['point', 'Nothing starts on its own yet.', 'New automation', 'newmenu'],
  'automations:board': ['work', 'The board is empty.', 'New automation', 'newmenu'],
  'library:memory': ['think', 'Nothing to remember yet. Branch saves what matters as you talk.', 'Start a conversation', 'newconv'],
  'library:documents': ['read', 'No documents yet. Drop a file into a conversation and it lands here.', 'Start a conversation', 'newconv'],
  'library:made': ['workbook', 'Nothing made yet. Reports, tables and pictures your Trunks make land here.', 'Start a conversation', 'newconv'],
  'customize:trunks': ['wave', 'No Trunks yet. A Trunk is a helper that takes one job.', 'New Trunk', 'chat', 'data-id="new"'],
  'customize:specialists': ['work', 'No specialists yet.', 'Make a team', 'mkteam18c'],
  'pane:activity': ['think', 'Nothing here yet. Ask something and each step shows up here.', 'Ask something', 'ask18c'],
  '*': ['wave', 'Nothing here yet.', 'Start a conversation', 'newconv']
};
function empty18(key) {
  const [pose, line, btn, act, extra = '', held = false] = EMPTY18[key] || EMPTY18['*'];
  return `<div class="empty18c" data-note="empty18c"><img src="${ART(pose)}" alt="" draggable="false"><p>${esc(line)}</p><button class="btn pri ${held ? 'held18' : ''}" type="button" data-act="${act}" ${extra} ${held ? 'data-held="security" disabled aria-disabled="true" title="Coming soon"' : ''}>${esc(btn)}</button></div>`;
}
function dressEmpty18() {
  if (!S.empty18 || !['team', 'inbox', 'automations', 'library', 'customize'].includes(S.view)) return;
  const tabs = $('#main .place .tabs'); if (!tabs) return;
  let n = tabs.nextElementSibling; while (n) { const nx = n.nextElementSibling; n.remove(); n = nx; }
  tabs.insertAdjacentHTML('afterend', empty18(`${S.view}:${S.tabs[S.view]}`));
}
Object.assign(ACTS, {
  empty18proto: () => { S.empty18 = !S.empty18; render(); },
  mkteam18c: () => { S.empty18 = false; S.view = 'team'; S.tabs.team = 'agents'; S.tb18 = false; render(); toast('Made a new team. Pick who is on it.'); },
  ask18c: () => { $('#msg')?.focus(); }
});

/* ================= 18c: live lines under faces (Customize › Trunks) ================= */
function dressTrunks18() {
  if (S.view !== 'customize' || S.tabs.customize !== 'trunks' || S.empty18) return;
  document.querySelectorAll('#main .place .rows .prow').forEach(row => {
    if (row.dataset.l18) return;
    const name = row.querySelector('.grow b')?.textContent?.trim(), c = chats.find(x => x.name === name && x.kind !== 'room'); if (!c) return;
    row.querySelector(':scope > .av')?.replaceWith(Object.assign(document.createElement('span'), {innerHTML: face18(c, 40, c.status === 'working' ? 'work' : null)}).firstElementChild);
    row.querySelector('.grow small')?.insertAdjacentHTML('afterend', liveLine18(c));
    row.dataset.l18 = '1';
  });
}

/* ================= the notes behind pass 18 (Guide › Show the design notes) ================= */
Object.assign(NOTES, {
  hf18a: ['Pass 18a · Hermes Desktop', 'Helpers where you type', 'Up to three helpers above the composer, each with its face, a live line, its model and Stop. The header opens the roster: the job, what it’s thinking, steps and cost, the exact request with No / Allow once, Steer and Stop. Open shows the helper’s conversation, view only. Engine: GET /api/runs/:id/steps → helpers[], POST /api/runs/<helper>/steer and /cancel, POST /api/policy/approve.'],
  vo18: ['Pass 18a · OpenClaw, ClawX', 'View only, one way back', 'A helper’s (or a room member’s) conversation opens view only. The composer’s place holds one step back to where you came from. Helpers never join the sidebar.'],
  lanes18b: ['Pass 18b · Muse', 'Who’s in the room', 'One lane per member in seat order: the character, working while its run works, and a plain line from its newest run. “Needs you” is the only copper. Tap a Trunk to read its own conversation, view only. Engine: GET /api/trunks/rooms/:id, /typing, each member’s newest run.'],
  team18b: ['Pass 18b', 'The team run board', 'A running team opens into rounds and lanes; each lane is a helper card with Steer and Stop. Engine: GET /api/teams, team.batch.started, team.members.planned, team.ran.'],
  hand18b: ['Pass 18b · held', 'Handoffs stay greyed', 'Accept and Reject decide who may act, so they are drawn but not wired until a separate safety review (/api/teams/:id/handoffs/:id/accept|reject).'],
  set18c: ['Pass 18c · Hermes, ClawX', 'Five plain groups', 'Settings takes over the sidebar instead of adding a third column: You, Assistant, Reach, Safety and Care. Search stays on top and reaches every switch.'],
  later18c: ['Pass 18c · Hermes', 'Choose the model later', 'Setup asks three things: welcome and safety, models (or later), and your first Trunk.'],
  fin18c: ['Pass 18c', 'Finish setting up', 'The other setup steps wait on Overview as a checklist; each opens its own page.'],
  upd18c: ['Pass 18c', 'One place for updates', 'The update banner shows on Overview and Inbox only, never over a conversation.'],
  empty18c: ['Pass 18c', 'Empty is a welcome', 'A character, one sentence and one button that fills the list.']
});

/* ================= wire it in: pass 18 dresses after everything else ================= */
{ const _open18 = openChat; openChat = function () { S.vo18 = null; S.st18 = null; return _open18.apply(this, arguments); }; }
{ const _view18 = ACTS.view; ACTS.view = el => { S.vo18 = null; return _view18(el); }; }
{ const _rp18 = renderPane; renderPane = function () { _rp18.apply(this, arguments); safe15(dressPane18); }; }
/* a scrolled tab row keeps the chosen tab in view */
function dressTabs18() {
  document.querySelectorAll('#main .place .tabs [aria-selected="true"], #pane .ptabs [aria-selected="true"]').forEach(t => {
    const row = t.parentElement; if (row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = Math.max(0, t.offsetLeft - row.offsetLeft - 24);
  });
}
function dress18() {
  [dressSettings18, dressViewOnly18, dressFrame18, dressPane18, dressTeam18, dressUpdate18, dressOverview18, dressEmpty18, dressTrunks18, dressPet18, dressComposer18, dressTabs18].forEach(f => safe15(f));
}
{ const _r18 = render; render = function () { _r18.apply(this, arguments); dress18(); }; }
matchMedia('(max-width:760px)').addEventListener?.('change', () => render());
