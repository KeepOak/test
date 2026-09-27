# Pass 18: helpers you can see, room lanes, one frame

Files: `patch18.css` and `patch18.js`, spliced into `../prototype.html` as its **last** CSS and JS (after pass 17e, before the
closing `render()`), so pass 18 wins over pass 17 wherever they differ. Source: the redesign lead's design direction
(2026-09-26), PR items 3, 6 and 9. Every new class, action and state key ends in `18a`, `18b`, `18c` (or `18` when shared).
All data in the prototype is example data; the window shows only what an engine route returns, and nothing when it has no value.

The owner's keepers stay: the always-animated 3D characters (`fig12` videos; pass 18's faces keep moving even with reduced
motion, and fall back to the still only for the explicit "hold still" choice or a browser without see-through video), the
Blender pebble faces (`av()` for a Trunk with no character), the sample's chat and room look, and the plan meter ring.

## 18a: the helpers frame and the view-only helper conversation

| Part | What it draws | Actions (`data-act`) | Engine |
|---|---|---|---|
| Frame, collapsed | At the top of the dock, above the chips row. Shown only while a helper runs or needs you. Header: up to 3 faces, "N helpers · N need(s) you" (copper only for need), elapsed `m:ss`, chevron. Up to 3 rows, needs-you first: face, name, live line, model chip, **Stop** (or **Look** when it needs you). "Show all N" when there are more. | `hf18a` (open/close, window state), `hfstop18a` | `GET /api/runs/:id/steps` → `helpers[]`; `POST /api/runs/<helperRunId>/cancel` |
| Frame, open | A roster card per helper, needs-you first: face, name, live line, `model · via`; the job (two lines, tap for all); "What it's thinking"; the exact request with **No** / **Allow once**; "N steps · $cost"; **Steer**, **Stop**, **Open**. | `hfjob18a` (window state), `hpdo17c` (as pass 17), `hfsteer18a` → `hfsend18a`, `hfstop18a`, `hfopen18a` | `POST /api/policy/approve` (exact fingerprint only); `POST /api/runs/<helperRunId>/steer {text}` |
| After | When none runs or waits the frame goes, and the thread's chip reads "N helpers · done". | `hpopen17c` (as pass 17) | same |
| View only | **Open** shows the helper's own conversation: "What <parent> asked for", its steps, its thinking, its request if any. The composer's place holds "View only" and one **Back to <parent>**. The header reads "Helper for <parent> · view only". Helpers never join the sidebar. | `voback18` | the helper's `sessionId` conversation |

Faces: a helper that is a Trunk shows that Trunk's character; one without an agent shows its parent's face, dimmed. Stop
spares the other helpers ("Stopped <name>. The other helpers keep going."). Steer reaches the helper at its next step
("Sent to <name>. It reads it before its next step.").

## 18b: room lanes and the team run board

| Part | What it draws | Actions | Engine |
|---|---|---|---|
| Who's in the room | The room's side panel › Activity opens with one lane per member, in seat order, instead of "No steps yet": the character (its work loop while its run works, typing dots from `/typing`), the name, and a live line. "Needs you: …" in copper; "Had nothing to add" for a pass; "Idle" otherwise. Another assistant (A2A) and people get a letter face; a person reads "Person · here now". | `lane18b` opens that Trunk's own conversation view only, with **Back to <room>** and "In <room> · view only" | `GET /api/trunks/rooms/:id`, `/typing`, each member's newest run |
| Team run board | Team › Teams of specialists: a team card (name, purpose, "Working · round N", member faces with roles) that opens into rounds, one lane per member; each lane is a helper card with **Steer** and **Stop**. | `tboard18b` (window state), `hfsteer18a`/`hfsend18a`, `hfstop18a` | `GET /api/teams`; events `team.batch.started`, `team.members.planned`, `team.ran` |
| Handoff | "Open handoff: <from> → <to>" with **Accept** and **Reject** drawn **greyed** (`data-held="security"`, disabled, "Coming soon"). They decide who may act, so they stay unwired until a separate safety review. | `hoaccept18b`, `horeject18b` (**held**) | `/api/teams/:id/handoffs/:id/accept\|reject` |

## 18c: one frame, Settings, setup, empty states, live lines, motion

- **One frame.** 52 px title bar everywhere (focus mode too). Widths: chat 720 (Comfortable becomes the default; Wide and
  Full stay in Appearance), places 960, settings 760. Tab rows (a place's tabs, the side panel's tabs) scroll sideways
  with a soft edge instead of clipping, and keep the chosen tab in view. The pet sits in the owner row. The status bar at
  phone width keeps the dots and the counts and drops the words ("this computer"). The room's placeholder is "Message the
  room"; "@ to call a Trunk" is a hint at the top of the @ list.
- **Update banner** only on Overview and Inbox: "Branch 0.20.0 is ready", **Read the release notes** (`relnotes17d`),
  **Install when nothing is running** (`install`). Never over a conversation.
- **Settings in five plain groups**, drawn in the sidebar (no third column; at phone width the same list stays in its
  strip): **You** (General, People, Appearance, Notifications, Achievements); **Assistant** (Instructions & personality,
  Models, Accounts, On this computer, Voice); **Reach** (Chat apps, Gateway); **Safety** (Permissions, Computer & browser,
  Saved sign-ins); **Care** (Data & usage, Branch itself, Updates & about). "Back to Branch Agent" on top, then the
  search, then the groups, then "How much to show". Actions: `setpage` (as before).
- **Setup in three steps**: Welcome (with the safety promise), Models, Your first Trunk. Models has **Choose the model
  later** (`oblater18c`). The other steps wait on Overview in **Finish setting up**: Where Branch runs, Make it yours,
  Reach it anywhere, Tools, Keep it running, People, Two more things, Health check; each **Open** goes to its page
  (`fin18c`); **Hide** (`finhide18c`).
- **Empty states**: every empty list shows a Branch pose (`public/art/branch-<pose>.webp`), one sentence and one button
  (table `EMPTY18` in `patch18.js`), e.g. Team › Live now "Start a conversation" (`newconv`), Teams of specialists "Make a
  team" (`mkteam18c`, `POST /api/teams`), the side panel's Activity "Ask something" (`ask18c`). A button that would invite,
  share or group people is drawn **held** like the handoff. The status bar's "Show empty lists" (`empty18proto`) is
  **prototype only** so a reviewer can see them; the window draws an empty state whenever the engine returns nothing.
- **Live lines under faces**: Customize › Trunks rows show the character (its work loop while working) and a line under
  the role: "Needs you: …" (copper), the newest run's first line while working, "Paused" or "Idle".
- **Motion**: new cards, lanes, banners and empty states rise 6 px and fade in 160 ms; live lines fade in 120 ms; the
  helpers roster opens with a 200 ms height transition; ease-out, no bounce. `prefers-reduced-motion` drops these UI
  transitions and the typing dots, never the characters.

## Actions the window PRs implement

`hf18a`, `hfjob18a`, `hfstop18a`, `hfsteer18a`, `hfsend18a`, `hfopen18a`, `voback18` (PRs 4 and 5); `lane18b`, `tboard18b`
(PRs 7 and 8); `hoaccept18b`, `horeject18b` (drawn greyed, held for review); `fin18c`, `finhide18c`, `oblater18c` (PR 13);
`mkteam18c`, `ask18c` (PR 12). Reused as before: `hpdo17c`, `hpopen17c`, `setpage`, `newconv`, `newmenu`, `install`,
`relnotes17d`. Prototype only (never in the window): `empty18proto`.
