# The new window: build contract

Everyone building the new Branch window (Claude sessions, agents, reviewers) follows this file. It is short on purpose.
The **design** is `design/redesign/BRANCH-DESIGN-INTENT.md`; the **look and behaviour** is `design/redesign/prototype.html`
(open it in a browser; it needs `prototype/assets/` from the redesign folder beside it). When they disagree, the prototype wins
for look and behaviour, and the document wins for wording and intent.

## Goal of the first PR (branch `redesign/window`, based on `mac/cross-platform`)
Replace the old window (`public/` app files) with the redesign, wired to the existing engine. Sending, replies, approvals
and accounts must work before this merges to trunk (the Dev channel installs trunk within minutes). Everything the engine
cannot do yet is drawn in place but **greyed out** ("Coming soon"). Nothing new is invented.

## The rules (a PR that breaks one is not merged)
0. **The owner's priority: the redesign works 1:1.** Old conventions, labels, ids and test expectations never outrank the
   design; tests adapt to the new window. (The engine's security policy and not uninstalling the owner's app still hold,
   because they do not block 1:1.)
1. **No new text.** Every visible sentence is in the design document. Exceptions only: words the engine sends (approval
   questions, errors, step labels, names, numbers) and the French locale. No explanatory hints, no "Note:", no placeholders
   that are not in the prototype.
2. **No new look.** Layout, spacing, colour and motion match the prototype. Do not "improve" the design.
3. **No new features.** If it is not in the prototype, it is not built. If it is in the prototype but the engine cannot
   do it, it is greyed out through the feature list (rule 6), not faked.
4. **No example data.** The prototype's people, Trunks, numbers and conversations are demo data (design doc 1.8). Read real
   data from the engine; where there is none, show the empty state the document describes.
5. **One definition per thing.** No `const _x = x; x = function () {…}` layering, no legacy branches, no fallbacks to the old
   window, no imports from deleted files. Functions stay under about 50 lines.
6. **Greyed out, one way.** `public/app/core/features.js` lists every feature as `live` or `soon`. A `soon` control keeps its
   exact place and look, gets `aria-disabled="true"`, the class `soon`, and the tooltip "Coming soon". Nothing else is said.
   Flipping a feature to live is a one-line change there plus the wiring.
7. **The engine's security policy stays.** `script-src 'self'; style-src 'self'`: no inline `<script>`, no `style="…"`
   attributes, no `on…=` attributes, no `eval`. Dynamic styles go in `data-css="…"`; the renderer applies them with the CSSOM
   after each draw (`applyCss(root)` in `core/dom.js`). CSS custom properties work the same way.
8. **Tests are re-pointed, not deleted.** 204 test files drive the old window (token sign-in, approvals, quit warning,
   streaming, rewind…). Keep what they prove; change their selectors to the new window.
9. **Never run `npm test` on the owner's computers** (it closes and uninstalls the real app). Run exact files:
   `node --test --test-concurrency=1 <files>`, or the GitHub check `gh workflow run checks.yml --ref <branch> -f own_computers=auto`.
10. **Commits and PRs carry no Co-Authored-By or AI attribution lines** (owner's rule). Conventional Commits.
11. Never `git stash` in shared checkouts; never force-push anything that is not yours; merge only at the checked head.

## Files
```
public/index.html            the page: links app.css, loads app/main.js as a module. No inline code.
public/app.css               tokens (design doc 2), then every component, in the prototype's order, flattened
public/app/main.js           boots: token, first load, event stream, first draw
public/app/core/             state.js (S + setters), api.js (fetch + event stream), dom.js ($, esc, applyCss, render
                             scheduler), ui.js (icons, avatars, popovers, dialogs, toasts, tooltips), actions.js (the
                             single click/keyboard dispatcher: on('act', fn)), features.js (live/soon)
public/app/shell/            title bar, sidebar, places list, status bar, surfaces
public/app/chat/             conversation, blocks, composer, approvals, agent window, its computer
public/app/places/           inbox, automations, library, customize, team, overview
public/app/settings/         the settings frame and one file per page
public/app/flows/            setup, walkthrough, add account, chat apps, local models, connectors, pairing
public/app/mac/              This Mac / This PC permissions (real Electron calls through the preload bridge)
public/art/                  characters, pets, scenes (from the redesign's prototype/assets)
```
The engine serves these through its asset list in `src/server.ts`; one change there serves `public/app/**`, `public/art/**`
by exact file (built from the directory at start-up; no path from the request is ever joined onto the disk path).

## Areas and owners
| Area | Owner |
|---|---|
| Core, shell, chat (the merge gate: sending, replies, approvals) | Branch growth visualization (coordinator of this PR) |
| Settings pages, accounts | agent under the coordinator |
| Places | agent under the coordinator |
| Flows (setup, wizards) and Mac permissions | agent under the coordinator |
| Engine: asset serving, events for the window (thinking, tool labels, nudges, plain approval questions), feature list audit (which prototype actions map to which routes) | Claude Legion |
| Tests re-pointed at the new window | Claude Legion, with the Mac mini |
| Look check (new window vs prototype, 5 sizes × light/dark) and final judging | Claude Mac mini |
| Reviews | Claude NAS (one review; two plus an adversarial test for token sign-in, approvals, hidden secrets) |

Post progress to `stabrea/branch-agent-work` NOTES (newest first).
