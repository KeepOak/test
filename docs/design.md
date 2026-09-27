# Branch Agent interface

The desktop and browser share one interface. It follows the approved KeepOak redesign
(`keepoak-redesign-public/public`): calm forest and paper surfaces, a copper action colour,
quiet borders, generous spacing, and one clear primary action per screen. The layout follows the
ChatGPT desktop application crossed with the Hermes desktop application: one rail, one column of
messages, one context pane. There is no top bar, and no panel is drawn as a card floating on a
page — the three columns are flush, as the KeepOak portal is.

## The shell

Wave 9 rebuilt the window around five places. **Where a feature goes, and how a new screen puts
itself there, is in [places.md](places.md); read it before adding anything the owner can see.**

| Part | What it holds |
| --- | --- |
| Sidebar head | The mark and the assistant's name (switches project), search, appearance, and the Settings gear |
| Sidebar body | New conversation, Find anything, then **Inbox** (with a count of what waits for a yes), **Automations**, **Library**, **Customize**, then **Projects** and **Recents**, which fold and are remembered |
| Sidebar foot | The owner row. Its menu starts with seven quick themes and "All 44 themes", then Settings, Lock session, Help, Updates, About. The initial turns into a moving ring while work runs and glows amber while something waits |
| Title bar | The sidebar switch, a way back to the conversation from any place, the page and tab, and in a conversation the side-pane tabs (Activity, Plan, Files, Memory). Then Clear the view, the Lockdown shield and the connection pill |
| Lockdown | The shield opens the one switch. While Lockdown is on, a red banner under the title bar says so on every page, with Turn it off |
| A place | A condensed title, one sentence saying what the place holds, tabs, the tab's cards, and an ask box at the foot that sends a question straight to a conversation |
| Settings | A floating window: named pages down the left with search above them, one page at a time; Models has five tabs of its own. Escape, the close button or the scrim closes it |
| Side pane | Only in a conversation, only when opened, on one of four tabs |
| Composer | A rounded, nearly solid box at the foot of the conversation with the model chip first, then attach, voice, Temporary, Ask me first, who answers, and Send |

The panes are glass over a pixel oak (`public/grove.js`) drawn in the season of the year or the one
the owner picked, from the theme's own colours. **Clear the view** fades every pane away and leaves
the oak; a click anywhere or Escape brings them back.

Under 1180 px the side pane floats over the conversation and starts closed; under 860 px the
sidebar slides over the page and Settings becomes full screen with its pages in a strip along the
top. The page never scrolls sideways, down to 400 px.

The composer floats over the reading column rather than sitting in it. `public/shell.js` measures
the dock with a `ResizeObserver` and writes its height to `--composer-h`; `#chat` keeps exactly
that much room at its end, so nothing in the column — the welcome card, the greeting, the last
message — can come to rest underneath the composer.

Keyboard: **Ctrl+K** opens the command palette (sections, conversations, projects, recipes,
skills, and the top actions), **Ctrl+N** starts a conversation, **Ctrl+,** opens Appearance,
**Ctrl+Shift+K** folds the context pane away and back, **Esc** closes the palette, a menu, or the
rail, and from the message box it steps out of the box without touching what has been typed.
Arrow keys and Enter move through the palette. Tab walks the rail first, then the title bar, then
the messages, then the composer; the message column is a stop of its own so it can be scrolled
from the keyboard.

On a new workspace the welcome card is the greeting: "How should Branch think?", equal tiles for
the ways in (two by two; the "model on this computer" tile only when one answers there), and no
tick boxes. Since 0.18.1 the window is calm by default: one question and one box, with every other
control behind More or shown only when it matters, and "Show everything" brings the full window
back (docs/configuration.md, "The calm window"). No label is styled as a code comment. The selected tile is marked with the
accent ring, not a heavy border. Once that is done the card gives way to a short greeting and
four suggestion chips. The chips use the owner's own recipes when there are any, and fall back to
stock prompts otherwise.

## The anatomy of a card

Every card on every section screen reads down the page in the same order, so the owner learns the
shape once and never has to learn it again.

| In order | What it is | Written as |
| --- | --- | --- |
| Title | What this card is, in two to five words | `<h2>` — a section's own name is the `<h1>` in the title bar, so a card is always an `<h2>`, never an `<h3>` |
| Purpose | One sentence saying what the card is for, in the owner's words | the first `<p>` after the title; `.card > h2 + p` gives it the reading face at 0.95 rem and `--muted` |
| Controls | The fields, one idea each | `<label>` for a short caption in the label face; a whole sentence belongs in a `.field-note` under the control, not in the label |
| A plain note | Anything worth saying about consequences | `<p class="subtle">` |
| One filled button | The single thing this card is for | `<button>`; anything else on the card is `.quiet-button` or `.text-button` |

The last row is the rule to write new cards by; it is not yet true of every card that shipped.
Nothing checks it, so a few older cards still carry two filled buttons. Fix them as you touch them.

Two rules matter more than the rest because they were the two faults this pass was written to fix:

- **A tick box sits beside its words.** `label:has(> input[type="checkbox"])` is a flex row in the
  reading face; the tick itself is `width: auto`. Before this, the blanket `input { width: 100% }`
  stretched every checkbox across the column, so the tick floated on a line of its own above
  11 px monospace prose. The monospace label face is for short captions only.
- **An empty screen says what the screen is for and what to do next.** `list()` in
  `public/app.js` takes `["what this is", "what to do about it"]` and draws an `.empty-state`, not
  a bare "No skills installed."

### The artifact card (wave 8)

An artifact — a page, a drawing, a chart or a script the assistant wrote — sits **inside a reply**,
not on a section screen, so it deliberately breaks two of the rules above:

- It is **not a `.card`**, and its title is **not a heading**. A reply is already a document with a
  shape of its own; an `<h2>` in the middle of one would push its way into that shape and be read
  out as part of it. The title is `<p class="artifact-title"><strong>`, and the card rule in
  `tests/shell-ui.test.mjs` therefore does not apply to it.
- It carries **several equal buttons** rather than one filled one — Open larger, Copy code, Save to
  workspace, Run this script. None of them is "the thing this card is for": the artifact is.
  They are all `.quiet`.

What it keeps: the one-sentence purpose line under the title, which here says what the frame can and
cannot do ("Shown in a sealed frame: it cannot run a script, reach this page, or reach the
internet"), and the reading face throughout. The code that produced it is folded away behind a
`<details>`, because it is the thing the card exists to spare the owner from reading.

The frame is `width: 100%` with a `min-height`, and the chart's SVG is `width: 100%; height: auto`
inside a wrapper that hides its overflow, so at 400 px neither makes the reading column scroll
sideways. The chart's data table gets the ordinary `.md-table-scroll` wrapper, which is the one
place a sideways scroll is allowed.

Chart colours come from eight `--series-N` tokens in `public/tokens.css` — Forest first, Daylight
darkened so text on a slice stays readable. Nothing in `public/charts.js` writes a colour down: the
values are read off the running page, which is also how they reach a sandboxed artifact, since a
frame under `default-src 'none'` cannot link a stylesheet.

### The flow editor (wave 8)

The editor keeps the wave-7 picture and puts the list under it, in that order, because the picture is
the thing the owner is reasoning about and the list is how they change it. The picture redraws on
every keystroke from the steps being edited, so a change is seen before it is saved — the one place
in the app where drawing on every input is worth the work, because the whole point is watching the
shape change.

The side form under each step shows **only the boxes that kind of step needs**. This is not tidiness:
`WorkflowStepSchema` refuses a prompt step with no prompt and a branch step with no words to look
for, so a form offering every box for every kind would produce a refusal the owner could not read.
The rules live in one table, `STEP_FIELDS` in `public/flow-editor.js`, beside the kinds they belong
to.

Move up, Move down and Take it out are `.text-button`s on the row they act on; Add a step, Save and
Run are `.quiet` in a row of their own under the list, because they act on the whole flow.

### The dashboard in the browser (wave mac3)

`/dashboard` (`public/dashboard/`) is a page of its own rather than a sixth place. It is for a phone,
another computer or a screen on the wall, where the rail, the composer and eighty modules are in the
way; and it reads across all five places at once, so it belongs to none of them. It wears the window
exactly: one glass pane over the same oak, the owner's theme, season and contrast from this browser
and light or dark from the workspace (`public/dashboard/look.js` and `layout.js` both hand the
catalogue's colours to Branch's token names through `public/theme-bridge.js`, because `layout.js`
itself cannot be loaded without the whole app). The head carries the mark, a status chip and Refresh; under it the five places and Settings in
the window's order and names, each a link back into the window; then the condensed title and one
sentence. Five areas follow — Now, Health, Spend, Activity, Controls — as `.lx-eyebrow` labels over
ordinary cards (`<h2>`, a purpose line, one filled button at most), one column under 900 px, two
under 1400 px, three above and four on a wall. Chips, rows, tabs and buttons are `layout.css`'s own;
`public/dashboard/dashboard.css` adds only the layout, the meters (good below 75%, warn below 92%,
bad above) and the spend bars in `--series-N`. Its switch card lives in `customize:channels`.

## The glossary

One name per idea, across every screen, the rail, the palette and the language files. The words on
the right never reach the owner on their own.

| Say | Never say | Why |
| --- | --- | --- |
| task | run, job, execution | "Activity" lists tasks; "Every run has a trace" meant nothing to anybody |
| connection | provider, endpoint, API base URL | a connection is a model service this workspace can reach |
| toolbox | tool group, prefix, namespace | how `src/catalog.ts` groups tools, said in a word |
| skill | SKILL.md, skill document | a skill is a page of instructions; its file is "a skill file" |
| note / what it remembers | memory record, fact row | Memory holds notes |
| words of context | tokens | the room a conversation has left |
| what is sent | payload, request body | |
| live updates | SSE, streaming | |
| signing in on their site | OAuth, device flow | glossed on first use per screen if it must appear |

`tests/shell-ui.test.mjs` walks all ten sections and fails if `SKILL.md`, `API base URL`,
`endpoint`, `payload` or `SSE` appears in the rendered text of any of them. The rest of the table
is not machine-checkable, because "run" and "provider" are ordinary English in the right sentence:
those are for whoever writes the next screen to honour by hand.

## Taking the pictures

The screens are checked with a headless browser, never a visible window, and never through
Electron. Two scripts do it, both against a scratch workspace that is thrown away afterwards:

- `node tests/wave8-audit.mjs` reads every section at 400 px and reports what is measurably wrong:
  prose set in the label face, a control nothing can read out, a stretched tick box, a card with
  no title, a section with no opening line, anything wider than the window. Run this first; it is
  cheaper and more honest than reading the source.
- `node tests/wave8-screenshots.mjs before` and `… after` take the same 70 pictures of eighteen
  screens — ten sections plus the lock screen, the welcome card before and after a choice is made,
  the palette, the workspace menu, the context pane, an answered conversation and the receipt
  sheet — in Forest and Daylight at 1280×800 and 400×800, into
  `claude-session-files/wave8-design-qa/<stage>/`. (The context pane is a wide-window thing, so it
  is taken at 1280 only, which is why the count is 70 and not 72.) The names match between the two
  runs so `contact-sheet.html` in that folder can put each pair side by side.

## Tokens

`public/tokens.css` is the only place a colour is written down. `public/style.css`,
`public/shell.css` and every inline style read from it. Two themes, five accents, and the
scales for text, spacing and radius live there.

`tests/web-ui.test.mjs` proves this for every stylesheet. It cannot prove it for the drawings,
which paint on a canvas or into an SVG from JavaScript, so those are checked by hand. Three are
allowed to name a colour and no others may be added without a reason written down here:

- `public/deployment.js` paints the square code for the phone in plain black on plain white,
  because a phone camera needs that contrast to read it, in either theme.
- `public/channel-setup.js` paints the square codes of the Set up a chat app panel (mac7/connect)
  black on white for the same reason as the phone code.
- `public/update-screen.js` carries the palette of the little figure who walks across the screen
  while an update installs. It is a picture, not a surface.
- `public/flows.js` passes a token to the SVG with a colour after it as a safety net. The token is
  what draws; write the token name exactly, because a typo there fails silently into the net.

| Role | Forest (dark) | Daylight (light) | Copied from |
| --- | --- | --- | --- |
| Ground | `#03140B` | `#DDE7DA` | `site.css` `:root` / `:root[data-theme="light"]` `--ground` |
| Panel | `rgba(5,24,15,.94)` | `rgba(255,253,248,.96)` | `site.css` `--glass`, `app/portal.css` `--card` |
| Solid surface | `#051810` | `#FFFDF8` | `app/portal.css` `--card` |
| Rail ground | `#041710` | `#EEECE1` | variant of `--ground` / `--paper`, matching the portal rail |
| Reading ground | `#071D14` | `#FFFDF8` | variant of `--surface` |
| Owner's message | `rgba(237,241,234,.08)` | `rgba(23,40,30,.07)` | variant of `site.css` `--hover` |
| Tool step / context row | `rgba(237,241,234,.05)` | `rgba(23,40,30,.04)` | variant of `site.css` `--hover` |
| Text | `#EDF1EA` | `#17231D` | `site.css` `--text`, `app/portal.css` `--ink` |
| Muted text | `rgba(237,241,234,.78)` | `#59675F` | `site.css` `--text-2`, `app/portal.css` `--muted` |
| Line | `rgba(236,241,233,.12)` | `rgba(23,40,30,.14)` | `site.css` `--line` |
| Warm paper | `#F4F1E8` / `#FFFDF7` | `#F4F1E9` / `#FFFDF8` | `site.css` `--paper`, `app/portal.css` `--paper`/`--card` |
| Good / warn / bad | `#86D6A0` `#F2C572` `#F28B7A` | `#1F7A45` `#8A5A00` `#B3321F` | `site.css` `--ok`/`--warn`/`--bad` |

Accents (dark value, light value):

| Accent | Dark | Light | Copied from |
| --- | --- | --- | --- |
| Copper (default) | `#E07033` | `#E07033` | `site.css` `--copper` |
| Leaf | `#D3E3B6` | `#35563B` | `public-theme.css` `--pk-accent` |
| Earth | `#E4BA94` | `#77523B` | `app/appearance.css` `html[data-palette=earth]` |
| Slate | `#B0D0E0` | `#3F6378` | `app/appearance.css` `html[data-palette=slate]` |
| Ink | `#F1EDDD` | `#233529` | `public-theme.css` `--pk-ink` |

Every accent tint is derived once with `color-mix` (`--accent-soft`, `--accent-tint`,
`--accent-edge`, `--accent-ring`, `--accent-glow`), so no component invents an alpha of its own.
Spacing is `--s1`…`--s7` and radius `--r1`…`--r4`; both scale with `--density`. Focus rings are
`--ring`. Fonts stay Archivo (condensed display), Geist (body) and Geist Mono (labels), bundled
locally; the appearance screen can swap the body and display faces for this computer's own.

## Appearance

Settings → Appearance opens on the theme gallery: 44 themes in two groups (KeepOak's own, and ones
from editors and terminals), each drawn as a small preview in the mode showing. Under it, light or
dark (or follow this computer), the oak's season, and more contrast; then text size, spacing,
lettering, "keep things still", "show the acorn", and language.

Light or dark is saved with the workspace through `POST /api/preferences`, as Forest and Daylight
always were. The theme, the season and the contrast are this computer's own choice, kept in local
storage. A theme arrives as finished colours from `public/theme-catalogue.js`; `public/layout.js`
writes them onto `<html>` and hands each to Branch's own token name, so every rule that already
reads `--panel`, `--muted` or `--copper` follows the theme with no change. The old five highlight
colours still exist in `tokens.css` for anything that sets `data-accent`, but the gallery replaces
them on screen.

Appearance also carries the language. English is the source of truth; every other language file
answers the same keys and falls back to English where it does not. The choice is this browser's,
not the workspace's, and dates and numbers follow it through `Intl`.

## Rendered prose, code and the wave 6 panels

`public/web-ui.css` holds the newer pieces and uses nothing but the tokens above: rendered
markdown and code blocks, the "Look inside" sheet, the live row, the cost under the message box, the developer
playground's fields and the offline banner. Rendered prose sets its own rhythm (paragraph line
height 1.55, headings at 1.35/1.18/1.04 rem) and borrows `--well` for code grounds, `--line` for
every rule, `--copper-text` for links and `--font-mono` for code. The "Look inside" sheet is a
680 px panel over `--scrim`, full width below 720 px. The cost at the far end of the line under the
message box is small `--faint` text and says nothing when a price is not known. The "Context used"
chip beside it (DG-101) is one of the line's chips and borrows the limits glance's ring. Nothing here
introduces a colour of its own.

## Help with code (wave 7)

The coder's tools add almost nothing to the interface on purpose. Settings → Developer gains one
more `<details>` block, "Help with code", holding two checkboxes and two plain text areas — one
line per program: a short name, the full address of the program, and for a language server the
kinds of file it handles. No new colour, no new component and no new layout: it borrows the same
`.check-row`, label and `textarea` rules the rest of that card already uses, and reads and writes
through `/api/developer/*` in `public/code-ide.js`.

That restraint is the design decision, not an omission. A language server or a debugger is a
program the owner already chose to install; the screen's job is to say which one, in one line, and
to make clear that nothing is downloaded and nothing runs until the switch is on. Everything else
these tools do is shown where the owner already looks: a rename appears as an ordinary multi-file
change in the approval sheet, and a checkpoint appears in Settings → Workspace snapshots with the
same "put the workspace back to this" row every other kept point has.

## Settings → Developer → How the assistant finds its tools

A read-only card, folded away under Developer beside "Try things out", using the same `.card`,
`details`/`summary` and `.subtle` pieces as everything else — no new colours and no new components.
It says in ordinary sentences how many tools are installed, how many travelled with the last
request in full, how many were named in one line, how many were left to look up, and what that
weighed against its allowance. Under that: the tools the computer made ready before being asked and
the plain reason for each, and the short things it has been told to remember about a tool, each
with a Delete button. One button at the foot forgets all of it. Nothing on this card can change how
the assistant behaves, and no tool can be switched on or off from here.

## Artwork

Branch's icon is its mascot. `node scripts/make-icons.mjs` makes every icon from one picture,
`docs/images/mascot.png`: the favicons (the face alone at 16 and 32 px, where the branches are too
thin to see), the install icons, the desktop window, tray and `.ico`/`.icns`/Linux sizes, and the
phone app icons and launch mark. The KeepOak logo stays where it means the company (the KeepOak
account and team screens, the publisher and bundle id), and so does the revolving acorn. Logo PNGs
are bundled locally.
`public/acorn.js` adapts its analytic ellipsoid geometry, ordered dithering, colours and
rotation to this interface, and supports dragging, arrow keys, pause/resume and reduced-motion
preferences; animation suspends when hidden. "Show the acorn" hides it entirely. No KeepOak
scripts, analytics or network calls run inside the application.

Electron supplies the native window and tray. The renderer has no Node integration, uses
context isolation and sandboxing, and loads only the local application. Credentials are added
to authorized local requests in the main process, not embedded in URLs or page source.
