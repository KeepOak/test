/* ================= pass 17e: new art (six quiet scenes, six pets, three characters, feature pictures) ================= */
/* Everything lives under assets/art17/ and joins the galleries people already use: Appearance › Painted scenes,
   Appearance › The pet, and a Trunk's Look tab. Feature pictures fill any element marked data-art17="<id>", so other
   parts can ask for one without calling this file (their code runs before this one in the combined build). */
const A17 = 'assets/art17/';

/* ---------- scenes: calm wallpapers for behind the glass ---------- */
const SCENES17 = [
  ['night17-lake', 'Still lake at night', 'bg/lake-night.webp'],
  ['night17-highland', 'Moonlit highland', 'bg/highland-moon.webp'],
  ['day17-sea', 'Morning sea', 'bg/sea-morning.webp'],
  ['day17-meadow', 'Meadow afternoon', 'bg/meadow-afternoon.webp'],
  ['glow17-amber', 'Amber glass', 'bg/glow-amber.webp'],
  ['season17-snow', 'First snow', 'bg/first-snow.webp']
];
SCENES17.forEach(([id, name, f]) => { if (!SCENES12.some(s => s[0] === id)) SCENES12.push([id, name, A17 + f]); });

/* ---------- pets: a still and a walk loop each ---------- */
const PETS17 = [
  ['redpanda', 'Red panda', 'A round red panda cub with a striped tail and a leaf behind one ear'],
  ['pangolin', 'Pangolin', 'A baby pangolin with honey-bronze scales and a flower bud on its head'],
  ['quokka', 'Quokka', 'A smiling quokka holding a sprig of clover'],
  ['acornling', 'Acorn sprite', 'A little walking acorn with a leaf on its cap'],
  ['goatkid', 'Goat kid', 'A patchy goat kid with a daisy behind one ear'],
  ['piglet', 'Teacup piglet', 'A tiny pink piglet with a leaf balanced on its head']
];
PETS17.forEach(([id, name, description]) => {
  if (PETS12.some(p => p.id === id)) return;
  const p = {id, name, description, still: `${A17}pets/${id}.webp`, walk: `${A17}pets/${id}-walk.webm`};
  PETS12.push(p); PETS['pet-' + id] = {name, px: [], col: {}, still: p.still, walk: p.walk};
});

/* ---------- characters: idle, think, work and celebrate; the other states fall back to idle ---------- */
const LOOKS17 = [
  ['sorrel', 'Sorrel', 'A round hedgehog whose spines are soft pine needles, with a little satchel.'],
  ['skein', 'Skein', 'A knitted wool creature in teal and cream, with knitting-needle antennae.'],
  ['nib', 'Nib', 'A glass ink bottle full of swirling blue ink, with a cork hat and a feather.']
];
LOOKS17.forEach(([id, name, description]) => {
  if (LOOKS.some(l => l.id === id)) return;
  const d = `${A17}agents/${id}/`;
  LOOKS.push({id, name, description, still: d + 'still.webp', states: {idle: d + 'idle.webm', think: d + 'think.webm', work: d + 'work.webm', yay: d + 'yay.webm'}});
});

/* the counts people read elsewhere follow the real numbers */
{ const nLooks = LOOKS.length, word = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen'][nLooks] || String(nLooks);
  if (NOTES.look12) NOTES.look12[2] = NOTES.look12[2].replace(/^\w+ original characters/, `${word} original characters`);
  NEW13.forEach(e => {
    if (typeof e[2] !== 'string') return;
    e[2] = e[2].replace(/^\w+ original characters/, `${word} original characters`)
      .replace(/^\d+ pets that walk and nap, and \d+ scenes/, `${PETS12.length} pets that walk and nap, and ${SCENES12.length - 1} scenes`);
  }); }

/* ---------- feature pictures ---------- */
const ART17 = {
  'art17-cloud': ['A cloud computer at work', 'feature/cloud'],
  'art17-call': ['A phone call in progress', 'feature/call'],
  'art17-meeting': ['Joining a meeting', 'feature/meeting'],
  'art17-learn': ['Learning an app', 'feature/learn'],
  'art17-timeline': ['A timeline replaying', 'feature/timeline'],
  'art17-branch-call': ['Branch on a call', 'branch/branch-call', true],
  'art17-branch-workbook': ['Branch reading a workbook', 'branch/branch-workbook', true]
};
/* a loop, or its still when motion is reduced, Branch is kept still, or the browser can't show see-through video */
function art17(id, still = false) {
  const a = ART17[id]; if (!a) return '';
  const [label, f, stillOnly] = a, pic = A17 + f + '.webp', move = !still && !stillOnly && !calm11();
  return `<span class="art17e" data-art17-id="${id}" data-m="${move ? 'v' : 'i'}" aria-hidden="true" title="${esc(label)}">${move
    ? `<video src="${A17 + f}.webm" poster="${pic}" muted loop autoplay playsinline></video>` : `<img src="${pic}" alt="" draggable="false">`}</span>`;
}
/* fill every requested slot (data-art17-still="1" asks for the still); redraw one whose motion setting no longer fits */
function fillArt17(root = document) {
  root.querySelectorAll('[data-art17]').forEach(el => {
    const id = el.dataset.art17, still = !!el.dataset.art17Still, want = !still && !(ART17[id] || [])[2] && !calm11() ? 'v' : 'i', have = el.firstElementChild;
    if (have?.dataset.art17Id === id && have.dataset.m === want) return;
    el.classList.add('slot17e'); el.innerHTML = art17(id, still);
  });
}
/* the pictures also sit in the new feature places when those parts are in the build:
   [where, which picture, replace the small icon tile there, still only (the place redraws every second or so)] */
const SPOTS17 = [
  ['.cl-offer17d', () => 'art17-cloud', true],
  ['.cm-off17d', el => /Phone calls/.test(el.querySelector('b')?.textContent || '') ? 'art17-call' : 'art17-meeting', true],
  ['.cm17d', el => el.querySelector('[data-act="cmtab17d"]') ? 'art17-branch-call' : 'art17-meeting', false],
  ['.wb-tile17d', () => 'art17-learn', true],
  ['.wb17d .t9-dh', () => 'art17-branch-workbook', true],
  ['.lvd17d .lv-h17d', el => /In the meeting/.test(el.textContent) ? 'art17-meeting' : 'art17-call', false, true]
];
function spotArt17() {
  SPOTS17.forEach(([sel, pick, swap, still]) => document.querySelectorAll(sel).forEach(el => {
    if (el.querySelector(':scope > .spot17e, :scope > .th > .spot17e')) return;
    const tile = swap && el.querySelector(':scope > .ico-tile, :scope > .th > .ico-tile');
    const box = Object.assign(document.createElement('span'), {className: 'spot17e' + (swap ? ' tile17e' : ' side17e')});
    box.dataset.art17 = pick(el); if (still) box.dataset.art17Still = '1';
    if (tile) { tile.classList.add('ico17e'); tile.insertAdjacentElement('afterend', box); }
    else el.insertAdjacentElement('afterbegin', box);
    el.classList.add('has-art17e');
  }));
}
/* a small "New" mark on the cards this pass adds, so they're easy to find in a long gallery */
function markNew17() {
  const ids = new Set([...SCENES17.map(s => s[0]), ...PETS17.map(p => 'pet-' + p[0]), ...LOOKS17.map(l => l[0])]);
  document.querySelectorAll('.scene-c12, .pet-c12, .look-c12').forEach(b => { if (ids.has(b.dataset.v)) b.classList.add('new17e'); });
}

/* ---------- Appearance (Advanced): the pictures Branch uses around the app ---------- */
addSettings15('appearance', 1, () => sec15('Pictures around Branch', `<div class="arts17e">${Object.entries(ART17).map(([id, [label]]) => `<figure class="art-c17e"><span data-art17="${id}"></span><figcaption>${esc(label)}</figcaption></figure>`).join('')}</div>`,
  'Shown where a feature starts or has nothing to show yet. They move gently, and hold still when motion is reduced.'));

function dress17e() { spotArt17(); fillArt17(); markNew17(); }
{ const _r17e = render; render = function () { _r17e.apply(this, arguments); safe15(dress17e); }; }
/* dialogs and side panels draw outside render(); catch those too */
{ let q17e = 0; new MutationObserver(() => { if (q17e) return; q17e = setTimeout(() => { q17e = 0; safe15(dress17e); }, 50); }).observe(document.body, {childList: true, subtree: true}); }
matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => safe15(fillArt17));
