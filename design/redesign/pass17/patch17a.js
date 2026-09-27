/* ================= pass 17a: the look and feel ================= */
/* Slate's colours live twice: in the CSS tokens and in BRANCH_EF (used when an accent override or "more contrast" is on,
   and by the theme previews and colour editor). Keep the two in step with patch17a.css. */
Object.assign(BRANCH_EF.light, {bg:'#F6F8F9', side:'#EDF1F3', raise:'#FFFFFF', ink:'#141D24', ink2:'#3A4751', ink3:'#5F6C76', line:'#DFE5E9'});
Object.assign(BRANCH_EF.dark, {bg:'#0F1418', side:'#0B0F12', raise:'#161D22', ink:'#E6ECF0', ink2:'#AEBAC3', ink3:'#85929B', line:'#1D262C', btn:'#E6ECF0', onBtn:'#0F1418'});
Object.assign(BRANCH_EF.light, {btn:'#141D24', onBtn:'#F6F8F9'});
/* Paper is Branch's own Daylight skin: its faint text was 3.7:1 on cards; this warm grey clears 4.5:1 on page, sidebar and cards */
if (SKINS.paper?.v) SKINS.paper.v['--ink-3'] = '#6B665F';

/* Arrivals: a popover or dialog that opens fresh eases in once. A re-draw of one already open (a theme change, a
   picked skin) does not replay it, so nothing flickers. Setup is left alone. CSS keyframes only, so reduced motion
   and "keep Branch still" turn it off through the base rules. */
const _openPop17 = openPop;
openPop = function (anchor, html, opt) {
  const fresh = !popEl || (popAnchor !== anchor && !(opt && opt.force)), r = _openPop17.apply(this, arguments);
  if (fresh && popEl) popEl.classList.add('in17');
  return r;
};
const _openDlg17 = openDlg;
openDlg = function (o) {
  const fresh = !dlgEl, r = _openDlg17.apply(this, arguments);
  if (fresh && dlgEl && !dlgEl.querySelector('.ob9')) dlgEl.classList.add('in17');
  return r;
};

/* More contrast asks for strong lines: the soft hairline steps aside while it is on (see :root.contrast17 in the CSS) */
const _applyLook17 = applyLook;
applyLook = function () {
  const r = _applyLook17.apply(this, arguments);
  document.documentElement.classList.toggle('contrast17', !!S.contrast);
  return r;
};
document.documentElement.classList.toggle('contrast17', !!S.contrast);
