# Pass 17a: look and feel

Files: `patch17a.css` (the system), `patch17a.js` (Slate kept in step in `BRANCH_EF`, Paper's faint text, one arrival
class), `check17a.cjs` (the check).
Screenshots: `C:/Users/bishi/AppData/Local/Temp/claude-session-files/p17/`
- `before-*`: the v16 build.
- `after-*`: v16 plus 17a.
- `all-*`: every pass-17 part together.
- `mid-*`: 760 and 1100 px.
- `check17a/`: themes, More contrast, and Settings at 400 px.

Each name ends in `-1440light`, `-1440dark`, `-400light` or `-400dark`, and says what it shows: `chat`, `chat2`
(an approval), `side`, `pop-plus`, `pop-owner`, `place-*`, `set-*`, `dlg-edit` or `dlg-skins`.

## 1. Audit of v16 (what felt busy, uneven or dated)

**Title bar and header**
- Two strong rules under the header: a full-width line plus a 2 px state line in solid copper or green. The state line
  runs the whole window and reads like a loading bar.
- The pane toggle, when on, is a solid black square (dark mode: a white one). It is the loudest thing on screen, and it
  isn't important.
- The eight header icons are full ink-2 colour. They compete with the name of the Trunk you're talking to.
- The surface switcher ("Windows") is a bordered white pill, so the chrome gets one more box.

**Sidebar**
- The current conversation and the current place are only one grey step darker than hover, so they are hard to find at
  a glance.
- Two different counters: copper for Inbox (attention) and green for Team. The green is a second accent that isn't
  asking for anything.
- Hairlines between every group at full `--line` strength.

**Faint text**
- Light `--ink-3` (#7A8791) is 3.5:1 on the page and 3.3:1 on the sidebar. It is used for every hint, time, subtitle
  and row description, so the most-read small text failed WCAG AA.
- Paper's faint text was 3.7:1.

**Borders and shadows stamped everywhere**
- Every card, tile, file chip, check list, status card, tab, search box, "1 in the background" chip, flag, kbd and pane
  had its own 1 px `--line` or `--line-2` border.
- Elevation used a single `--pop` shadow for everything.
- The composer (the one thing that should float) had a darker border and no lift until focus.

**Tabs**
- Every tab was an outlined pill, and the selected one was a solid black pill. With five tabs this made a row of
  buttons, not a quiet switcher.
- The same pattern appeared in dialogs (Edit Scout: Look / What it may do).

**Settings**
- Rows are flat lines separated by full-strength rules. Long pages (Models, Permissions at Technical) read as one long
  list with no grouping.

**Popovers and dialogs**
- Solid cards with a 1 px ring shadow.
- The dialog header has a rule under the title, and footers show two or three equally weighted outlined buttons.
- There's no arrival motion, so menus and dialogs "pop".
- The keyboard ring on the first menu item was a thick 2 px copper outline around the whole row.

**Radius mix**
- 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18 and 24 px all appear on neighbouring parts.

**Type**
- 14 px body, 14.5 px chat, 15 px names and 24 px page titles, with titles at weight 600. The hierarchy between a page
  title and a section is weak.
- Competing accents that aren't about attention: the teal border on "Branch wants to improve itself" and the copper
  "Add another ChatGPT account" link.

**Spacing**
- Paddings of 13, 14, 26 and 30 px sit next to each other: `.ctl` 13 px, `.place` 30/24/40, `.set-col` 30/28/48,
  `.sec` 26 px, thread gap 14 px.

## 2. What changed, and why

Everything is done with tokens and class rules. There are no markup changes, no renamed `data-act`s and no new
controls.

### Tokens
- **Slate, refined.** A slightly bluer, calmer neutral in both modes:
  - light: bg `#F6F8F9`, sidebar `#EDF1F3`, cards `#FFF`, ink `#141D24`;
  - dark: bg `#0F1418`, sidebar `#0B0F12`, cards `#161D22`.
  - Copper stays exactly as it was: `--accent` is untouched.
- **Legible faint text.** `--ink-3` is `#5F6C76` in light (5.1:1 on the page, 5.4:1 on cards) and `#85929B` in dark
  (5.8 and 5.3). Paper's faint text is now `#6B665F` (5.4:1).
- **In step with the JS.** `BRANCH_EF.light` and `BRANCH_EF.dark` take the same values. Without this, turning on an
  accent override or More contrast on Slate would snap back to the old palette, and the theme previews would disagree.
- **New derived tokens.** All are mixed from the colours a theme writes, so each of the 44 themes gets its own:
  - `--hair17`: the line colour at 70%, or the full line while More contrast is on (a `contrast17` class that
    `applyLook` keeps in step);
  - `--wash17` and `--wash2-17`: ink at 5% and 9%, for hover and pressed;
  - `--glass17` and `--glass2-17`: cards at 90% and 97%;
  - `--sh1-17` and `--sh2-17`: a resting lift and a floating lift;
  - a new `--pop` (a soft ring plus two layered shadows).
- **Radius scale.** 8, 12, 16 and 20 (`--r1-17` … `--r4-17`), plus pill. **Motion curve:** `--ease17`.
- **One type scale.** 11 · 12 · 13 · 14 · 15 · 17 · 26:
  - page titles 26 px / 650 with tight tracking;
  - chat text 15 px / 1.62;
  - names 14–15 px;
  - hints 12.5 px / 1.45.

### Components

**Title bar and header**
- The state line is still read from `--tint14`. It is now a 2 px wash that fades out by 62% of the width, instead of a
  full rule. It is restated for `.app.has-bg`, so it survives a painted scene.
- The header rule is a hairline.
- Header icons are faint until hovered.
- The pressed pane toggle is a soft wash, not a black square.
- The surface switcher is a borderless wash pill.

**Sidebar**
- The current conversation and the current place are raised white rows (dark: card colour) with a resting lift, so the
  current item is obvious.
- Hover is a light wash.
- The search box and machine icon lose their borders.
- The Team count is neutral; only the Inbox keeps copper.
- Group lines are hairlines.

**Conversation**
- 16 px between turns and 15 px text.
- The user bubble uses `--fill-2` with a 20 px radius.
- Cards, check lists and file chips use hairlines and the radius scale.
- The approval card keeps its copper ring, softened to 75%.

**Composer**
- One 26 px surface with a hairline and the floating lift, since it is the one thing that floats over the thread.
- Focus adds a 4 px ink halo, not a dark border.
- The tools (+, plug, model, mode, mic) are faint until hovered.
- Send is a 36 px circle: a quiet wash when empty, copper with a soft glow when ready, ink when it's a stop button.
- The background chip and flags lose their borders.

**Places**
- Tabs are borderless. The selected tab is a soft `--fill-2` pill in bold, not a black pill.
- A list made only of rows (for example Automations › Scheduled) sits on one soft card with hairline dividers.
  Lists that mix rows with other blocks stay flat with hairlines, so there is never a card inside a card: Inbox (its
  "Allow all" bar), Customize › Trunks (its buttons) and Library › Memory (its summary).
- Padding is 32/24/48.
- Quieted: the teal border on "Branch wants to improve itself", and the copper "Add another account" link (now ink).

**Settings**
- A section made only of rows and hints becomes one card of rows, like a system settings pane: hairline dividers,
  16 px radius, 14/16 padding.
- Row-only lists get the same card.
- The nav's current page is a wash.
- The search box and level switch lose their borders.
- The danger box border is softened.

**Popovers**
- Soft glass: 90% card colour, with 20 px blur and saturation.
- 16 px radius, and 10 px items with a wash on hover.
- The keyboard ring is an inset 1.5 px copper line inside the item.

**Dialogs**
- 97% card colour (nearly solid) on a blurred scrim, 20 px radius.
- No `backdrop-filter` on the dialog itself, so positioned sheets inside it (the pass-16 Mac sheets and alerts) keep
  their containing block.
- No rule under the title; the title is 17 px.
- Roomier body and footer.
- When a footer has a filled (or danger) button, that is the one clear action, and the other buttons become quiet
  text buttons.
- Footers without one (Close, Done, Copy the record…) keep their outlined buttons, so no dialog loses its visible
  action. This is scoped with `:has()`.
- The scrim gets a 2 px blur. The palette matches the dialogs.
- Arrival animations use `backwards` fill, so no transform stays on a dialog or popover after it lands.

**Status bar**
- Sidebar colour, 11 px, hairline top.

**Motion**
- 140 ms colour and shadow transitions on rows, nav, menu items, buttons, tabs and chips.
- The composer's tools and send press in slightly (0.96).
- A popover or dialog that opens *fresh* eases in: 160 ms for popovers, 220 ms for dialogs.
- `openPop` and `openDlg` are chain-wrapped (the pass-13 pattern) so that a redraw of one already open does not
  replay: a theme change, a picked skin, a forced popover refresh.
- Setup (`.ob9`) never animates, which keeps human12's flicker watch clean.
- All motion is CSS keyframes, so the base `prefers-reduced-motion` and `[data-still]` rules turn it off.

**Narrow windows (≤760)**
- The same rhythm, restated one step more specific, because the base narrow rules come after this file.

## 3. Checks

Run on the 17a-only build and on the `all` build (17a + b + c + d). The test copies were run from a scratch folder, so
the shared `branch-redesign.html` was never written.

| check | 17a build | all build |
|---|---|---|
| `check17a.cjs` (49 checks) | all passed, no errors | all passed, no errors |
| `check16.cjs` | all passed | all passed |
| `human12.cjs` 1366 light | no errors | no errors |
| `human12.cjs` 1440 dark, 760 light, 400 dark | no errors | (1366 only) |
| `sweep13.cjs` (5 sizes × 2 modes × 9 screens) | no issues (v16 baseline also none) | no issues |

What `check17a.cjs` covers:
- Slate's tokens and contrast on the page, cards and glass, at 1440 and 400, in light and dark.
- Every look in the gallery (46: the 44 themes, Slate and Paper), in Daylight and Moonlight. For each one: the hairline
  and wash follow that theme's own colours, and glass never lowers faint-text contrast by more than 0.35.
- More contrast on a KeepOak theme and on Slate:
  - full-strength lines while it is on;
  - Slate through `BRANCH_EF` equals the CSS.
- A painted scene keeps the header's state line.
- The composer surface, the header wash, the approval ring, the raised current row, and the Settings card.
- Popover glass and arrival, and that picking a theme does not replay a dialog's arrival.
- Reduced motion: dialogs arrive without animation.
- No sideways scroll on Settings at 400 px.

## 4. Unsure, or left alone

- **Tone.** I don't have the Grok, Hermes, OpenClaw or Muse apps in front of me, so the direction comes from the brief:
  calm neutral canvas, soft glass, quiet chrome, one accent, conversation first. No layouts, names or colours are
  copied.
- **Glass.** Popovers and dialogs are 90% and 97% card colour. The real app's comment says "menus and cards stay solid".
  I kept dialogs nearly solid, with no blur of their own, and the check proves text contrast holds in every theme. If the owner wants fully solid
  menus, set `--glass17` to `var(--raise)`.
- **Mono uppercase section labels** (PLACES, PINNED, STARTING UP) were kept on purpose from pass 5, with slightly
  tighter tracking. Switching them to sentence case would be a bigger change of identity than this pass should make
  alone.
- **The recommendation bar's green "Recommended"** and the green "Answers first" pills are meaningful status (protected
  since pass 4), so they were left.
- **The 400 px header character.** The living character (pass 13) spills over the state line. It is intentional there,
  so I left it.
- **Inbox, Customize › Trunks and Library › Memory** put a bar, buttons or a summary inside the same `.rows` as their
  rows. Those lists stay flat with hairlines rather than becoming a card. Carding them would need a markup change.
- **Other letters.** In the `all` build, parts b–d use the shared tokens and look consistent. Any of their components
  that set literal `border:1px solid var(--line)` keep that slightly stronger line, because this pass softens by class,
  not by redefining `--line`.
- **Base rules at ≤760 px** that I didn't override stay as they were: the set-nav tab row, the hidden cost flag, and the
  composer's hidden voice and mode buttons.
- **One flaky run.** A single check17a run on the `all` build timed out once while two sweep13 runs were loading the
  machine. Three later runs passed cleanly.
- **Theme data I did touch.** Paper's `--ink-3` (Branch's own Daylight skin) moved from #8A857F to #6B665F for
  legibility. The 44 catalogue themes are unchanged.
