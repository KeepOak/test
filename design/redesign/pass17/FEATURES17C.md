# Pass 17, part C: new capabilities around the conversation

Files: `patch17c.js`, `patch17c.css`, `check17c.cjs`. Sources: `../CAPABILITY-LOGIC.md` §4–§5 and `../research/GAP-MATRIX.md` §3.

**The rule for every item.** The conversation stays calm. Each capability gets one small way in:
- a message's **More** (…) button;
- a one-line chip or note in the thread;
- a status-bar item;
- a menu row.

The depth lives in the side panel, popovers and dialogs.

**Naming.** Every new class, action and state key ends in `17c`. All data is example data; the page already says so in the status bar.

**Where the new parts sit.**

| Place | What part C adds |
|---|---|
| **Message** | **More** button: Branch from here, Leave out of context, Every step behind this reply |
| **Side panel** | **Timeline** tab, always shown; **Branches** tab, only when paths exist; **Helpers** section at the end of Activity |
| **Thread** | helpers chip; thinking-dropped notice; paused strip; "paths from here" marker |
| **Above the thread** | "On the path …" bar, while you're on a branch |
| **Status bar** | "N paused" / "All Trunks paused" |
| **Menus** | Room rules in the room menu; Quick ask in the New menu and the shortcuts list; Mark as unread in the list's right-click menu; Pause all in the "N running" menu |
| **Settings** | Data & usage › Flagged replies (Regular); Models › Defaults › How Trunks work together (Advanced) |
| **Library** | Made for you › Diagrams, once one is saved |

---

## 1. Timeline

**Where it lives.**
- Side panel › **Timeline**. The tab sits right after Activity.
- It also opens from:
  - **Look inside** on a reply: the dialog gains an **Every step** button and a "Steps: N in this task" row;
  - the reply's More › **Every step behind this reply**.
- Either way it opens at the step that produced that reply.

**How it behaves.**
- **The header** gives the task name, the step count, the total time ("so far" while working) and the total cost. The total always equals the "$… so far" line under the message box: the latest model call carries any difference.
- **Controls:**
  - Step back and Step forward;
  - **Play / Pause**, which replays one step every 0.9 s, or 1.4 s with reduced motion;
  - a row of tick buttons, one per step, coloured by kind, to jump.
- **The "At step N of M" card** shows:
  - who took the step and its details;
  - how long it took and at what time;
  - its cost, plus the running total and running time up to that step;
  - **What it had** and **What happened**;
  - **Show it in the conversation**, which closes the panel on narrow windows, scrolls to the message and flashes it;
  - **Answer in Activity**, for a helper's approval that's still waiting.
- **The step list** has:
  - an icon per kind (model call, tool, approval, helper, you);
  - time and cost for each step;
  - later steps faded while you replay;
  - a hash per step at Technical.
- **Check the record:**
  1. It shows "Checking each link…".
  2. Then it shows **Record intact**: "All N steps link up … Nothing was cut or rebuilt."
  3. At Technical it adds the chain head (sha-256).
- **Owner actions join the timeline** as "You" steps: pause, resume, and "asked to pause after this task".
- Play re-draws only the panel body, never the whole page. It stops on a tab, chat or view change.

**Example data.**

| Task | Steps | What's in it |
|---|---|---|
| Scout: Hartwell invoice | 11 | The four Activity steps in order, plus model calls, an approval allowed by your rules, two helpers and a helper's approval |
| Ledger: September report | 7 | Ends on "Send this email to Dana Okafor?", whose state follows the real ask card |
| Supplier quotes room | 6 | Scout's and Ledger's steps |

- Other conversations are built from their own step cards.
- When Scout finishes its example task, the last step turns into "Compared and wrote the answer".

**States.**
- No task: an empty line that explains what will show, above part E's `art17-timeline` illustration slot. The slot draws nothing when part E isn't built in.
- Live (working), finished, replaying, paused replay, checking, intact.
- An approval step reads Waiting for you, Allowed or You said no.

## 2. Branch from here

**Where it lives.**
- Ways in:
  - the user message's own **Branch from here** button, which was a toast in v16 and now works;
  - any message's More › **Branch from here**;
  - Branches › **New path from the latest**.
- In the thread, a **"N paths from here"** marker sits at each split point, with one chip per path.
- While you're on a branch, a slim bar above the thread reads "On the path **X** · model", with **Compare** and **Back to …**.
- Side panel › **Branches** is a small tree. It shows each path's name, message count, model, when it was made and its last answer, with **Here** or **Switch**.

**How it behaves.**
1. **Starting a path.** A dialog asks for a name and a model for the path (Same model / Opus 5.5 / Qwen3.6 here).
2. **What the new path holds.**
   - It copies everything up to the message. Each block is a copy, so an edit, pin mark or flag in one path never changes another.
   - **Approvals are the exception:** an approval card stays one object on every path, so a yes or no is one decision. Inbox counts it once, and the card shows the outcome on every path. An email can't be sent twice by answering it on two paths.
   - It leaves out the live computer card, typing and thinking blocks.
   - It adds a line: "New path "X" · model. The original is unchanged."
3. **What happens next.**
   - Branching from your own message answers again on the new path.
   - Branching from a reply puts the cursor in the message box.
4. **Switching** (marker, bar, tree or Compare) swaps the conversation in place; every path is kept exactly as it was.
5. **Compare two answers** shows two columns: each path's latest answer, its check lines and its model, with **Continue on this path**. The columns stack at phone width. With more than two paths, two pickers choose which to compare.

**Example data.** Ada's Lisbon trip already has a path, **Porto instead**, on Opus 5.5 ($1,228 against $1,356).

**States.** One path (no marker, no tab); several paths; on the original; on a branch (bar shown).

## 3. Leave out of context

**Where it lives.** Any message's More › **Leave out of context**.

**How it behaves.**
- The message stays, faded (a dashed outline on your own bubbles).
- A badge under it reads "Left out of context · kept here, never sent to the model", with **Put back**.
- The toast has **Undo**.
- A pinned message is unpinned too, and the toast says so.
- Look inside counts messages that are left out.
- The flag lives on the message itself, so it survives switching paths.

**States.** In context; left out; put back.

## 4. Helpers (sub-agent oversight)

**Where it lives.**
- In the conversation: one chip after the computer card, "2 helpers · 1 needs you ›", or "· done".
- In depth: side panel › Activity › **Helpers**.

**How it behaves.** Each helper card shows:
- its name, and its own model and provider;
- a status pill;
- the job it was given;
- a **What it's thinking** summary that changes with its state;
- its own approval, which names the exact request, where it applies and who asked for whom, with **No** / **Allow once**;
- steps and cost.

The example helpers:

| Helper | Model | Asks to | Category |
|---|---|---|---|
| Statement reader | Opus 5.5, your Claude account (a different provider from Scout's GPT-6 Sol) | Read `card-statement-aug.csv` | Read |
| Receipt matcher | Qwen3.6 35B on this computer | Save a note to Library › Notes, `hartwell-aug-check.md` | Change |

- Answers land in the Timeline's approval steps.
- Helper approvals don't change Inbox counts.

**States.** Needs you, then either Done (the result is in the pill) or Stopped (you said no).

## 5. Quick ask

**Where it lives.**
- The hotkey **Ctrl Shift Space**, or **⌥ Space** on a Mac.
- New menu › **Quick ask**.
- A row in Keyboard shortcuts.

**How it behaves.**
- A small box opens near the top. It has:
  - the hotkey hint;
  - a field;
  - **To** chips: Branch, Scout, Ledger, Ada, Fieldnotes;
  - Start.
- Enter sends and Esc closes. The hotkey toggles the box, and clicking outside closes it.
- Switching the Trunk keeps what you typed.
- Sending starts a **new conversation**, named from the question, with the chosen Trunk, and the Trunk replies.
- An empty box doesn't send.
- A paused Trunk gets the message queued, with a line that says so.

**States.** Closed, open, empty (won't send), sent.

## 6. Diagrams (Mermaid-style)

**Where it lives.**
- In an answer: Fieldnotes answers "Draw how a repair gets handled under this lease." with a diagram card.
- As an artifact: **Open larger** opens a wide dialog with the diagram and its text.
- Library › Made for you › **Diagrams**, after **Save to Library**.

**How it behaves.**
- The diagram is a hand-drawn inline SVG. There's no library.
- It uses theme variables, so it reads in both themes.
- On a phone it scrolls sideways inside its card rather than shrinking the text.
- The card has:
  - a note that it's shown in a sealed frame;
  - **Copy the text**;
  - **Save to Library**, which reads "In Library" once done;
  - "The text that drew it", with the `flowchart LR` source.
- The phone and terminal views show the diagram as a single line.

**States.** In the answer; open larger; saved.

## 7. Unread

**Where it lives.**
- List › **Recent** heading: **Mark all read**, shown only while something is unread.
- Right-click a conversation: **Mark as unread** or **Mark as read**.
- Inbox: a dot on unread items in **Needs you** and **Finished**, and **Mark all read** at the end of the tabs.

**How it behaves.**
- Conversations reuse v16's own unread dot, which the phone reads too. Fieldnotes starts unread because of the new diagram.
- Answering or opening an Inbox item marks it read.
- Marking read never answers or dismisses anything, and the toast says so.

**States.** Unread; read; all read.

## 8. Flag this reply

**Where it lives.**
- The reply's flag button. It now opens the new dialog, replacing v16's "Send report", which contradicted local-first.
- Settings › Data & usage › **Flagged replies**, at Regular: one switch, plus the list once there are flags.

**How it behaves.**
- **The dialog:**
  - reason chips (at least one is needed): Wrong or made up / Didn't do what I asked / Did something I didn't ask for / Unsafe or rude / Too long or unclear / Something else;
  - an optional note.
- **Keeping it:** the flag is kept on this computer. A badge under the reply names the reasons, with **Remove**.
- **"Also send to the Branch team"** is **off and greyed** until the owner allows it:
  - for the owner, **Open that setting** goes to Settings › Data & usage › Flagged replies;
  - for someone else, it reads "Only Taofik can turn this on", and their switch is disabled too.
- **Once allowed**, the box can be ticked for one flag at a time. Even then, only that reply and the note go.
- Settings lists every flag with **Remove**.

**States.** No flag; flagged locally; flagged and sent; sending not allowed; sending allowed.

## 9. Thinking dropped on a model switch

**Where it lives.** A one-line note in the conversation, where the switch happened.

**How it behaves.**
- It appears when you pick another model in a conversation that already has replies.
- It reads: "Switched to **Opus 5.5**. GPT-6 Sol's thinking stays here for you but isn't passed on: Opus 5.5 sees the messages and results, not the reasoning."
- **Why** opens a short explanation.
- Quick switches merge into one note, and switching straight back removes it.
- The phone and terminal views show it as one line.

**States.** No switch; one notice; merged.

## 10. Tier 2, on the conversation side

**What v16 already had, and what part C changed.**

| Item | v16 | Part C |
|---|---|---|
| Room answering rule | Chosen only when making a group chat; the room menu's "Room rules" was just a toast | **Room rules** in the room menu opens a popover with three radios: A lead Trunk decides / Everyone, every time / Only those you @mention. The current rule shows beside the menu item and under the room's name ("… · mentions only"). A change is logged in the room as a line. A new group chat keeps the rule chosen when it was made |
| Default way Trunks work together | Customize › Specialists had the six pattern cards | **Settings › Models › Defaults, at Advanced:** "How Trunks work together, by default" uses the same cards and the same state as Specialists, with a switch "A Trunk may suggest a different pattern" (it asks first; yours wins). It lists rooms that override it |
| Per-room pattern override | none | Room rules' second group: **Your default: …** or any of the six. A change is logged in the room |
| Pause a Trunk / pause all | Pause set a flag. On a working Trunk the card still said Working and a false "Scout is done" cheer fired. No resume in the conversation. Pause all only on Overview | See below |

**Pause and pause all, in part C.**
- **Pausing a working Trunk asks** whether to pause when the current task ends, or now.
  - **Now** stops the computer card: it reads Stopped, with Carry on. It logs "Paused by Taofik … nothing half-done was sent", and fires no "done" cheer.
  - **After this task** shows "Scout will pause when this task ends", with **Keep going** and **Pause now**.
- **While paused**, a strip in the conversation reads "Scout is paused" with **Resume**.
- **The status bar** shows "1 paused" or "All Trunks paused". It opens a list with Resume or Keep going per Trunk, and Pause all / Resume all.
- **Pause all** is also in the "N running" menu. Overview's button asks first when something is working.
- **Pause, resume and pause-after** each land in the Timeline as "You" steps.

---

## Checks

**Commands.**
- `node check17c.cjs <file>`
- `human12.cjs` and `sweep13.cjs` load `branch-redesign.html` from their own folder, so run them from copies placed beside the build.

**What check17c covers.**
- **Every control.** It clicks all 39 `…17c` actions through `data-act` and asserts the state each one changes.
- **Cross-feature rules.** A new group chat keeps its rule. An approval answered on one path is answered on every path, and Inbox counts it once.
- **Sizes and modes.** It runs at 1440 light and 400 dark (every step), then 760 light, 1100 dark, 1440 dark, 400 light, and 1100 light with reduced motion.
- **Probe.** On every new surface it checks:
  - page-level sideways scroll;
  - `17c` parts past the edge;
  - text contrast inside `17c` parts (4.5:1, or 3:1 for large text).
- **Screenshots** go to `%TEMP%/claude-session-files/branch-redesign/check17c/`.

**A new colour token.** New secondary text uses `--mute17c`, defined for light and dark, instead of v16's `--ink-3`. `--ink-3` measures about 3.5:1, under 4.5:1.

**Growth at Regular** (count15 against plain v16):

| Page | v16 | Part C |
|---|---|---|
| Settings › Data & usage | 17 | 18 |
| Inbox › Needs you | 12 | 13 |
| Inbox › Finished | 10 | 11 |

count15's `chat:scout` figure doesn't measure the thread, so the conversation was counted directly: buttons in `#scroll`, plain v16 against v16 plus part C, at 1366 px.

| Conversation | Always visible | On hover or focus (`.msg-acts`) | Why |
|---|---|---|---|
| Scout | 3 → 4 | 9 → 11 | the helpers chip; one More per message with actions |
| Ledger | 4 → 4 | 9 → 11 | More per message |
| Ada | 3 → 5 | 21 → 25 | the "paths from here" chips; More per message |
| Fieldnotes | 1 → 4 | 18 → 33 | the new example exchange: the diagram card's three buttons, plus that exchange's message actions |
| Supplier quotes | 10 → 10 | 15 → 18 | More per message |

The comparison is against v16, not `compare/count-v14.json`, because v16 is this pass's base.
