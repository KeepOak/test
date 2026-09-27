# Branch: Design Intent and Language

**The complete description of the Branch desktop app redesign: what it is for, how it looks, how every part behaves and what it says.**

- Owner: Taofik Bishi (GitHub `stabrea`)
- Written: 2026-09-25, from prototype build 14 (published as Version 17 of the artifact)
- Live prototype: https://claude.ai/artifact/QnX6D3p3kALrVtRfa4MWTt (private to the owner)
- Everything this file describes is kept next to it in `C:\Users\bishi\Code\Branch-Redesign\`

---

## 0. How to use this file

### 0.1 If you are a person
- **Search for any word.** Every screen, button, menu, flow and rule has its own heading, and the app's own words are quoted exactly. Try "Continue", "Chat apps" or "Checking".
- **To see it,** open `prototype/branch-redesign.html` in Chrome or Edge. It needs the `prototype/assets/` folder beside it. No install or internet is needed, except the QR-code library, which falls back to a drawn code when offline.
- **To learn why something is the way it is,** read section 1 (intent) and section 10 (the owner's decisions and history).

### 0.2 If you are an AI or a developer rebuilding it
Rebuild in this order. Each step names the section with the exact values.
1. Read section 1 (intent and principles) and the non-negotiables in 1.4. They override your defaults.
   **Then read 1.8, "Prototype-only: do not copy".** The prototype contains demo scaffolding (the "Prototype" badge, example data, design notes, the surface switcher, drawn window buttons, "Prototype:" messages, simulated timers). Leave all of it out and build the real behaviour it stands for.
2. Set up the design tokens, themes, fonts, icons and motion rules from section 2.
3. Build the window frame and the surfaces (Windows/Mac window, terminal, phones, web) from section 3.
4. Build conversations, the composer, approvals, computers and the agent characters from section 4.
5. Build the places, Customize, Settings and every menu from section 5.
6. Wire the journeys (setup, walkthrough, add account, chat apps, local models, pairing) from section 6.
7. Load the data from section 7: 53 services, 55 chat apps, 52 connectors, 10 local models, 11 characters, 38 pets and 13 scenes.
8. Reuse the exact art in `prototype/assets/` (section 8). Only regenerate it if it is lost, following the same pipeline.
9. Check every action against Appendix A (every action, counted there), and use the tests in section 9 to prove the rebuild behaves the same.

**Two things win over anything else in this file:** the prototype's own code (`prototype/branch-redesign.html`) and the owner's decisions (section 10). If this text and the code disagree, the code is the truth for behaviour. Section 1.4 is the truth for intent.

### 0.3 The folder next to this file
| Path | What it is |
|---|---|
| `BRANCH-DESIGN-INTENT.md` | This file. |
| `prototype/branch-redesign.html` | The finished prototype: one self-contained page (about 1.39 MB). |
| `prototype/assets/` | All art: Branch poses and animations, 10 characters × 10 animations, 34 pets, painted scenes. |
| `prototype/branch-redesign.v2.html` … `v16.html` | Every earlier build, kept so any stage can be compared. |
| `prototype/patch*.py`, `patch*.js`, `patch*.css` | The layers each pass added (section 9 explains the chain). |
| `prototype/*.cjs` | The automated tests (section 9). |
| `prototype/keyvid.py`, `rekey.py`, `dlkey.py`, `mklist.py` | The art tools: background removal for videos and stills, downloading, and the publish list. |
| `prototype/art-sources/` | The original generated character and pet images on flat magenta, the inputs to the art pipeline. |
| `research/` | Notes on the installed Branch app's data, competitor research and the art pipeline. |
| `owner/OWNER-CRITIQUES.md` | The owner's numbered critiques (#1–#62) and where each went. |

### 0.4 Words used in this file
| Word | Meaning |
|---|---|
| **Branch** | The app, and also its main assistant. It runs on the person's own computer and acts for them. |
| **Trunk** | An assistant with its own job, name, look and permissions (for example Scout does research, Ledger does money). A person can have many. |
| **Room / group chat** | A conversation with several Trunks and people in it. |
| **Its computer** | The computer a Trunk is allowed to use: a private sandbox, this computer, a KeepOak cloud computer or another paired machine. It is not the web browser. |
| **Ask first / Plan / Auto / Full access** | Permission modes: how much a Trunk may do without asking. |
| **Approval / "needs you"** | A question a Trunk asks before acting, answered with Yes or No. |
| **Gateway** | The always-on background service that keeps Trunks reachable (for example from Telegram) when the window is closed. Off, When needed or On. |
| **Chat app / channel** | Telegram, WhatsApp, Slack and 52 others that can reach Branch. |
| **Connector** | An MCP server that gives Trunks access to another tool (GitHub, Notion…). |
| **Local model** | An AI model that runs on this computer instead of in the cloud. |
| **keepoak.com / KeepOak** | The owner's web service: accounts, cloud computers and teams. It has its own oak mark, used only there. |
| **Surface** | One way to use Branch: the Windows app, the Mac app, the terminal, the iPhone app, the Android app or the web. They all share one state. |
| **Look / character** | The animated body a Trunk wears (Ember, Tock, Kite…). Its animation follows its state automatically. |
| **State** | What an agent is doing right now: idle, thinking, working, searching, reading, talking, waiting, done, stuck or resting. |
| **Pass** | One round of the redesign. There were 16, each adding to the last (section 10). |

### 0.5 Contents
1. Intent: what Branch is and the rules behind every choice (1.8: prototype-only parts to leave out; 1.9: what ships on)
2. Design language: colour, themes, type, spacing, icons, logo, motion, voice
3. The window and every surface
4. Conversations and agents
5. Places, Customize and Settings
6. Journeys, step by step
7. Catalogs: services, chat apps, connectors, models, characters, pets, scenes
8. Art and assets: what exists and how it was made
9. Building, running and testing
10. History and the owner's decisions
11. Known limits and open questions
- Appendix A. Every action (453)
- Appendix B. The owner's critiques (#1–#62)

---

## 1. Intent: what Branch is and the rules behind every choice

### 1.1 What Branch is, in one breath
Branch is a desktop app that gives a person a small team of AI assistants ("Trunks") who live on their own computer, do real work
for them (search mail, read documents, fill forms, use a computer, build things), ask before doing anything risky, and can be
reached from anywhere: the window, the terminal, a phone app, the web, and 55 chat apps. It uses the AI accounts the person already
has, or models running on the computer itself, and keeps going in the background when the window is closed.

### 1.2 Who it is for
- One person first: someone who wants help with their real life and work (bills, research, email, trips, code) without learning
  anything technical. The sample person is Taofik, with Trunks Scout (research), Ledger (money), Ada, Fieldnotes and Quill.
- Then small teams: the same Trunks can be shared with teammates, work in group chats, and run on shared keepoak.com computers.
- The same app serves a beginner and an expert: Settings has a "How much to show" control (Regular, Advanced, Technical) so the
  beginner sees little and the expert can edit everything, including the files a Trunk reads before each task.

### 1.3 What it should feel like
The owner's words for the goal: **"beautiful and simplistic and smart and well organized."**
- **Calm, not busy.** One clear conversation in the middle. Everything else is one click away in menus, tabs and Settings, never
  piled onto the chat screen. The owner called an early version "text vomit"; that is the thing to avoid.
- **Alive, not decorative.** Agents have bodies that move by what they are doing (thinking, searching, reading, working, talking,
  waiting, done, stuck, resting). A small pet walks the sidebar. Painted scenes can sit behind the app. All of it is optional and
  never covers anything important.
- **Honest and in control.** The person always sees what a Trunk is doing, on which computer, with which account, and what is left
  of each plan. Risky actions wait for a Yes. Nothing is sent without permission.
- **Never broken.** Branch can change its own settings and restart itself without dying, and every screen works at every window
  size, in light and dark, with the keyboard, with reduced motion, and on Safari and iPhone.

### 1.4 Non-negotiables (these override everything else, including your own taste)
1. **Never remove a feature.** When something feels crowded, move it somewhere logical (a menu, a tab, Settings); do not delete it.
2. **Copy no company.** The look leans mostly toward GrokBot, then Hermes Agent desktop, with ideas from OpenClaw and Meta Muse,
   but nothing is copied: no logos, no characters, no layouts lifted whole, no brand or studio names in art prompts. The owner:
   "we arent going to copy any company with our sprites be creative and amazing so we dont get sued".
3. **The logo is the Branch sprite**: a green leafy creature with glowing orange orbs on its branches. The acorn was removed
   everywhere. The KeepOak oak mark appears only where the page is keepoak.com or the KeepOak account.
4. **Default theme: Slate.** Features ship ON. Default models: gpt-6-sol medium and Claude Opus 5.5 medium.
5. **Plain words.** Sentence case, second person, no jargon, the app's own names (Trunk, Inbox, Its computer, Gateway).
6. **Include everything** from the "Branch, Grown Up" concept and from the installed Branch Agent v0.19.4 (its providers, chat-app
   recipes, local models and settings), so nothing the real app can do is missing from the design.
7. **Every animation is automatic.** The person picks a character, never an animation; the agent's state chooses it.
8. **Accessible and resilient by default**: keyboard use (Tab stays in the top window, Escape closes, arrows move through
   galleries), screen-reader labels, reduced motion, Safari/iPhone stills, saved choices that survive a reload.
9. **New density lives at Advanced/Technical.** (Pass 15 onwards.) New controls and features are hidden from Regular level:
   shown only at Advanced ("Every feature and the fine controls") or Technical ("File paths, raw keys, launch variables, config
   and logs"). This keeps Regular lean and clean. The result: at Regular, Settings grew by 8 visible controls (usage 4, pet 3, phone
   1) and Places by about 20. All features still ship; they are just grouped by expertise level.

### 1.5 The big ideas, and why each exists
| Idea | Why it exists |
|---|---|
| **Trunks** (many assistants, each with a job, look, permissions and computers) | One assistant for everything gets confused and is hard to trust; separate Trunks keep jobs, memory and permissions apart. |
| **Its computer** (sandbox, this computer, cloud, other machines; several at once; full-size view) | Agents that use a computer must be watchable and stoppable. The person can watch, take over, pause or stop. |
| **Permission modes** (Auto, Ask first, Plan first, Full access, plus Lockdown) | Trust grows gradually; the person decides how much each Trunk may do alone. |
| **Inbox** ("needs you", finished, everything) | Approvals and results must not get lost in chat history. |
| **Accounts and "What each connection has left"** | Branch runs on the person's existing plans and keys; they must see limits before they run out and choose the order accounts are tried. |
| **On this computer** (local models) | Free, private models that fit the hardware, installed in one click. |
| **Chat apps and phone pairing** | The person can reach their Trunks from wherever they already are. |
| **Gateway** (Off / When needed / On) | Trunks keep running and stay reachable when the window is closed. |
| **Setup, walkthrough, What's new** | A beginner can start in three minutes and find every feature later. |
| **Characters, pets, scenes, achievements** | Make the app warm and personal, reward exploring, and show state at a glance. |
| **Surfaces** (Windows, Mac, Terminal, iPhone, Android, Web) sharing one state | The same Branch everywhere; a choice made on one surface shows on all. |

### 1.6 The shape of the app (read before sections 3–6)
- **Top bar** (one flush bar on wide windows): the Branch logo and the surface picker over the sidebar; the current conversation's
  header (character, name, state, its buttons) over the conversation; Guide, light/dark, list toggle and window buttons on the right.
- **Sidebar**: which Branch (machine), search, new, the places (Overview, Inbox, Automations, Library, Team, Customize), Projects,
  Pinned and Recent conversations, the pet, and the person's row with the settings gear.
- **Middle**: the conversation (or a place, or Settings), with the composer at the bottom and the agent window floating at the
  lower right.
- **Right pane** (optional): its computer, browser, activity or people.
- **Status bar**: connection, gateway, room left, what is running, the usage ring, version.
- **Overlays**: menus (popovers), dialogs, setup, the walkthrough, toasts, notifications and the "done" card.

### 1.7 What "done" looks like for any change
A change is finished only when: it follows 1.4; it works at 390, 768, 910, 1024 and 1440 px wide in light and dark; a real mouse
can click every control (nothing covers it); the keyboard can reach it; it has exact, plain wording; it survives a reload if it is
a choice; the automated tests in section 9 pass; and this file is updated.

---

### 1.8 Prototype-only: do not copy these into the real app
The prototype is a design demo. Some of what it shows exists only to make the demo work or to explain it to reviewers. When you
rebuild Branch 1:1, **copy the design, the logic and the real wording, and leave out everything in this section.** For each item
the right-hand column says what the real app does instead.

**Rule of thumb:** if a piece of text mentions "prototype", "example data", "sample", "stand-in", "would", "drawn in this
prototype" or starts with "Proposal:", it is describing the demo. Build the behaviour it stands for and drop the words.

#### 1.8.1 Remove entirely (demo scaffolding)
| In the prototype | Why it is there | In the real app |
|---|---|---|
| The "Prototype" badge at the right of the status bar (tooltip "Everything here is example data") and the hidden title-bar label "Prototype · example data" | Tells reviewers the data is fake | Nothing. Show the real version (for example "0.19.4") only. |
| The Guide's **design notes**: the count on the Guide button (e.g. "Guide 31"), "Show the design notes / Hide the design notes" (`notes-toggle`), the notes layer that explains why each part exists and which owner critique it answers (`data-note` attributes, `#notesLayer`) | Lets the owner review the design decisions | Nothing. Keep the Guide menu's real items: "What’s new", "Set up Branch", "Take the walkthrough". |
| The **surface switcher** in the title bar (Windows, Mac, Terminal, iPhone, Android, Web) and every "Try" button that jumps between surfaces | Lets one page preview every app | Each surface is its own real app (the Windows/Mac desktop app, the `branch` terminal command, the iPhone and Android apps, keepoak.com). They share one account and state; there is no switcher. |
| The **drawn window buttons** (minimise, maximise/focus, close) and the Mac traffic lights | Imitate an app window inside a web page | Use the real window frame's controls (Electron: native or custom title-bar controls wired to the real window). Minimise really minimises; close hides to the tray if the gateway is on. |
| "Start the prototype over" (Guide menu and What’s new) | Resets the demo's saved choices | Nothing (a real app might offer "Reset Branch" in Settings › Data & usage, with a confirmation, but that is a separate feature). |
| The canned reply "This is a prototype, so I can’t really do that yet. In the real app the answer streams in here…" and its step "Read the conversation so far · prototype reply" | The demo cannot think | The model's real, streamed answer and its real steps. |
| The scripted **Scout invoice job** (`scheduleScout`) that finishes by itself and shows the Hartwell invoice | Shows a live run without a real agent | Real runs driven by real Trunks. The states, cards and animations it demonstrates are the real design. |
| Every toast or hint that begins "Prototype:" — "Prototype: this phone stays connected.", "Prototype: any four digits unlock.", "Prototype: any four digits.", "Prototype: nothing you type here is kept.", "Prototype: Branch would close and remove itself now. Nothing was removed.", "…Prototype: this finishes by itself in a moment." | Explains that an action is simulated | Do the real action (forget the phone, check the real PIN, keep what is typed, uninstall, finish the real sign-in) and show the real result. |
| Pass 15 and 16 stand-in toasts and timers: the toasts that name a saved file ("Saved branch-memory.jsonl to Downloads…", "Saved usage-report.csv to Downloads.", "Copied: uses: branch-agent/action@v1"), the arena and test-suite toasts, the playground and site-skills toasts, "Draft pull request #291 opened on GitHub…"; the media player's 250 ms timer; background tasks finishing after 9 s; the record check finishing after 1.3 s; the cost line's formula; the **macOS System Settings window**, its Touch ID sheet, the "Quit & Reopen" sheet, the macOS-style "would like to access" alert and the "Reopening Branch…" cover (pass 16). | The prototype cannot save files, call GitHub, play real media, run tasks, hash a record or open the operating system's own settings. | Do the real thing: save dialogs, the clipboard, real ratings and tool calls, real playback, tasks that run until done, a real hash-chain check, a cost from real prices. For permissions, call the operating system (see 5.7): open the real System Settings pane, show the real system prompt, and read the real status; never draw a fake one. |
| Stand-in notes: "This prototype can’t read .glb files, so the oak turns there instead", "This prototype paints a stand-in" (image generation), "Example code for the prototype. A real code works once and expires in 5 minutes." (pairing), "the prototype stays in English, but every screen would switch" (language), "7 of the 44 skins are drawn in this prototype", "128 of 505 are drawn in this prototype" (achievements) | Explain missing pieces of the demo | Load the real 3D file, generate the real image, show a real one-time code, translate every screen, include every theme, include all 505 achievements. |
| Timers that fake work: install progress bars, the setup health check ticking "Checking… N of 6", token "Check" steps, account sign-in finishing by itself, the hardware scan delay | Make simulated work feel real | Drive the same UI from the real operation's progress and result (keep the wording and states). |
| The automation guard (`navigator.webdriver`) that stops setup opening during tests, and anything named `__D`/debug | Test plumbing | Nothing user-visible. |

#### 1.8.2 Replace with the person's real data
All names, numbers and content in the prototype are **example data**, marked in the code by `/* ---------- example data ---------- */`,
"(sample)", "Example data." and "This is sample data until you connect.". In the real app:
- The person (Taofik, the "TK"/"T" avatar), other people on the computer, and teammates come from the real account and team.
- The Trunks (Branch, Scout, Ledger, Ada, Fieldnotes, Quill, Month-end · Hartwell, Supplier quotes), their conversations, projects
  (Hartwell, Home), automations, memory and documents are the person's own. With none, show the empty states.
- Usage percentages, plan limits, spend, "room left", model lists and accounts come from the real connections.
- The machines ("This computer", taofik-ai, Legion, KeepOak computer), the hardware (AMD Ryzen 7 7800X3D, 32 GB, RTX 4070 12 GB,
  212 GB free, Ollama 0.12) and installed models come from the real computer.
- Achievement progress, notification counts (Inbox "2", Team "4") and times ("12:04", "Yesterday") are live.
- The phone clock "12:04", battery and signal glyphs in the phone frames are part of the preview frame, not the app.
- Pass 15 and 16 example data: the cost line ("$0.42 so far"), the 7 board cards, the memory count (4 of 500) and the three tidy-up findings, the archived facts, the record (1,284 entries, chain head 3f9a…c21e), the "Last run" steps, the background task "Compare the three phone plans", the two queued messages, the round-by-round bars, the media files (a 1:34 voice memo, a 0:42 tour), the usage report figures, the self-change diff and "#291", the lent iPhone, and the starting permission statuses on the Mac (only Notifications granted, Camera turned off, Automation for Mail and Finder).

#### 1.8.3 Build these, but note they are new ("Proposal:")
Text that starts with "Proposal:" marks a feature the real Branch 0.19.4 does not have yet. These **are** part of the intended design
and should be built when the backend exists; drop the word "Proposal" in the real app.
| Proposal in the prototype | What to build |
|---|---|
| "Proposal: Branch has no keepoak.com link today…" (Accounts, KeepOak sign-in, Team) | A real keepoak.com account link: sign in by pairing code, sync themes and backups, teams. |
| "Proposal: remote desktop and SSH computers aren’t in Branch yet." / "for a machine that can’t run Branch itself" | Remote desktop and SSH computers a Trunk can use. |
| "Video and 3D backgrounds are proposals." | Video and 3D (.glb) backgrounds. |
| "Each Trunk can have its own copies (proposal)." | Per-Trunk copies of the instruction files. |
| "Proposal: nothing to connect yet." | The connection it labels, once available. |
| Gateway choices stored as `S.gw.proposal` | The real always-on gateway modes. |

#### 1.8.4 Keep (these look like demo pieces but are the real design)
- Every screen, control, state, animation, character, pet, scene, wording and flow described in sections 2–7.
- The QR codes (they are real codes for the shown links), "Replay the first run", the walkthrough, What’s new, achievements.
- Toasts that describe what the real action does (for example "Goes back to 0.19.3 from the safety copy.", "Branch keeps working
  from the tray.") are the real confirmation wording.

---

### 1.9 What ships on (the owner's rule, pass 16)
The real Branch used to ship with almost everything switched off. Hermes Agent, OpenClaw, Muse and GrokBot ship with their useful
parts on. Going to Settings to switch things on is a chore most people never do, so they never meet the good parts.
**Branch ships with useful things already on.**

**Context window is not a reason to switch something off.** Tools load only when they are needed ("deferred tool loading", as in
Claude Code), so a switched-on tool costs almost nothing until it is used. The real question for every feature is:

> Sitting there switched on, can it **spend money, send something outward, delete something, use the microphone or camera, or use
> a lot of CPU and disk**?

- If not: **Ships on.**
- If it acts on the world: **On, but it asks first each time.** The approval is the safety, not a hidden switch.
- If it needs an account or a device: **On when connected.** Connecting it is the yes; nothing to find in Settings. Its sub-line says so
  ("On because a Claude account is connected." / "Turns on when an X account is connected.").
- If there is a real cost of another kind: **Off until you choose.** Each has a stated reason in its sub-line ("Off until you choose: it
  doubles the cost."), and Branch **offers it at the moment it would help** instead of leaving it to be found (see "An offer at the
  moment it's useful" in 5.7).

| Group | What belongs there | Examples |
|---|---|---|
| **Ships on** | Reading, thinking, remembering, organising, protecting, anything local and reversible | Summaries of older turns, memory suggestions, match by meaning, checkpoints, built-in skills, web search on a free backend, reading PDFs and Office files, read-only commands, the sealed browser "when needed", code map, format and check, every safety check, model per task, retries, the usage ring, start with the computer (quietly), updates when nothing is running, the pet and characters |
| **Asks first, each time** | Anything that acts on the world | Sending email or messages, deleting or moving many files, spending (with a default cap of $2 per task on pay-per-use accounts), installing tools, using the screen and mouse, opening an app or site for the first time, filling a sign-in, Branch changing its own code |
| **On when connected** | Features that only make sense once something is linked | Mail and calendar tools (Outlook or Gmail), Telegram topics, photos and receipts, Claude cache keep-alive, push to a paired phone, falling back to an installed local model, pull-request drafts and `AI!` comments (GitHub), page notes (the browser extension), X search (an X account) |
| **Off until you choose** | Microphone and camera, heavy background work, anything that doubles spend or moves your data elsewhere, developer plumbing | Wake word, lending the phone's camera and location, a local index of mail and messages, mixing models, the arena, flow search, full access, shared or outside memory, memory history in Git, the chat-app relay, a webhook tunnel, portable mode, OpenTelemetry, WebSocket and hardware tools |

Two special cases:
- **Authenticator codes for sensitive tools** ship on once more than one person uses Branch or any money tool is connected (both are
  true in the example, so the row reads "On because two people use Branch and Ledger handles money.").
- **Full access** is never shipped on. On a Mac it is not even one switch: it is a set of system permissions only the person can grant
  (5.7). Setup says "Full access stays off until you turn it on yourself."

Every settings row with its group is listed in 5.8.

## 2. Design language

### 2.1 Colour tokens

Branch uses CSS custom properties on `:root` to define all colours. Light mode is the default; dark mode is triggered by `@media (prefers-color-scheme:dark)` (for OS setting) or `data-theme="dark"` (explicit override). A third rule `data-theme="light"` forces light mode regardless of OS.

Every colour lives in one place: never hardcoded. The accent is **copper** (`#D8612A` light, `#E7753F` dark) and means "Branch wants your attention" (working, waiting, send-ready, focus).

| Token | Light | Dark | Used for |
|-------|-------|------|----------|
| `--bg` | `#F8FAFB` | `#11161A` | Page background, fills |
| `--side` | `#EFF3F5` | `#0C1013` | Sidebar background |
| `--raise` | `#FFFFFF` | `#182026` | Cards, popovers, dialogs |
| `--title` | `#E6ECEF` | `#080B0D` | Titlebar, status bar |
| `--ink` | `#16212A` | `#E8EEF2` | Body text, default foreground |
| `--ink-2` | `#3F4C56` | `#B3BFC7` | Secondary text, icons, hints |
| `--ink-3` | `#7A8791` | `#7D8A93` | Tertiary text, disabled, subtle |
| `--line` | `#DEE5E9` | `#1F282E` | Borders, dividers |
| `--line-2` | `#C9D3D9` | `#2D3840` | Subtle borders, input focus |
| `--fill` | `#EBF0F3` | `#1A2228` | Hover backgrounds, interactive states |
| `--fill-2` | `#DFE6EA` | `#232D34` | Active/selected backgrounds |
| `--accent` | `#D8612A` | `#E7753F` | Copper: loading spinners, unread dots, send ready, focus states |
| `--accent-ink` | `#A8461A` | `#F29062` | Text on copper; used in approval highlights |
| `--accent-tint` | `#FBEADF` | `#35221A` | Background tint behind accent elements |
| `--brand-tint` | `#E3EEE1` | `#17281C` | Green brand tint (KeepOak/Branch affinity) |
| `--btn` | `#16212A` | `#E8EEF2` | Primary button background |
| `--on-btn` | `#F8FAFB` | `#11161A` | Text on primary buttons |
| `--ok` | `#2F8F5B` | `#5CC08A` | Success, checkmarks, green status |
| `--ok-tint` | `#E2F0E7` | `#16291D` | Background for ok states |
| `--warn` | `#A86E12` | `#E0AF3B` | Warning, caution states |
| `--warn-tint` | `#F6EBD5` | `#2E2412` | Background for warn states |
| `--bad` | `#C2412D` | `#F0806C` | Destructive, error, deny states |
| `--bad-tint` | `#F8E3DF` | `#361C17` | Background for bad states |
| `--screen-a`, `--screen-b`, `--screen-c` | Various blues, greens, oranges | Darkened versions | Gradient backgrounds for "live computer" screen mockup |
| `--term-bg` | `#171A18` | `#0A0C0B` | Terminal background |
| `--term-ink` | `#D5DDD6` | `#D5DDD6` | Terminal text (same in both modes) |
| `--term-dim` | `#7F8B82` | `#6E7A71` | Terminal dim text |
| `--term-ok` | `#7FD39A` | `#7FD39A` | Terminal success (same in both modes) |
| `--scrim` | `rgba(27,26,24,.32)` | `rgba(0,0,0,.55)` | Overlay behind dialogs and popovers |
| `--pop` | `0 18px 40px -16px rgba(27,26,24,.28),0 0 0 1px var(--line)` | `0 18px 40px -16px rgba(0,0,0,.7),0 0 0 1px var(--line)` | Box shadow for floating panels |

**Font families:** `--sans: "Geist","Segoe UI Variable","Segoe UI",system-ui,sans-serif`; `--mono: "Geist Mono",ui-monospace,Consolas,monospace`.

---

### 2.2 Themes

Branch ships with **46 skins** in three groups:

#### Branch (2)
- `branch`: **Branch Slate** (default; owner chose it as default) — no explicit value, inherits `:root`
- `paper`: **Paper** — light, warm off-white palette (`#FBFAF7` background, `#1B1A18` ink)

#### KeepOak (16)
All named `t-*` and use the `t` array format (KeepOak-branded themes):
- `t-forest`: Forest
- `t-earth`: Earth
- `t-slate`: Slate (the "default" of KeepOak themes)
- `t-nocturne`: Nocturne
- `t-arctic`: Arctic
- `t-terracotta`: Terracotta
- `t-lavender`: Lavender
- `t-mint`: Mint
- `t-cherry`: Cherry
- `t-ocean`: Ocean
- `t-sunset`: Sunset
- `t-sepia`: Sepia
- `t-meadow`: Meadow
- `t-stone`: Stone
- `t-harbor`: Harbor
- `t-signal`: Midnight Signal

#### Editors & Terminals (28)
Editor/terminal colour schemes named `t-*`:
- `t-mono`: Monochrome
- `t-catppuccin`: Catppuccin
- `t-nord`: Nord
- `t-dracula`: Dracula
- `t-solarized`: Solarized
- `t-gruvbox`: Gruvbox
- `t-rose-pine`, `t-rose-pine-moon`: Rosé Pine (and Moon variant)
- `t-tokyo-night`: Tokyo Night
- `t-everforest`: Everforest
- `t-one-dark`: One Dark
- `t-monokai`: Monokai Pro
- `t-ayu`, `t-ayu-mirage`: Ayu (and Mirage variant)
- `t-kanagawa`: Kanagawa
- `t-palenight`: Palenight
- `t-material-ocean`: Material Ocean
- `t-github`: GitHub
- `t-horizon`: Horizon
- `t-synthwave`: Synthwave
- `t-night-owl`: Night Owl
- `t-poimandres`: Poimandres
- `t-vesper`: Vesper
- `t-flexoki`: Flexoki
- `t-oceanic`: Oceanic Next
- `t-nightfox`: Nightfox
- `t-amber-crt`: Amber terminal (CRT style)
- `t-green-crt`: Green terminal (CRT style)

**KeepOak themes use the `t` (Daylight/Moonlight) array format:**
Each KeepOak theme defines: `[id, name, family, daylight-colors, moonlight-colors, more-contrast-colors, more-contrast-dark-colors]` where each colour set is a space-separated string of CSS values applied in order to the colour tokens.

**Colour editor and accent picker:**
- User can open the colour editor from Settings › Appearance › Themes or via `startCed(baseTheme)` to clone and edit any skin
- User can pick a custom accent via `acc-set` action with `data-v="theme"` (uses theme accent) or a custom hex value
- Custom themes saved to `S.skins` (app state) prefixed `my-` if user-created
- Daylight/Moonlight switcher shown in theme picker; "More contrast" option appears for some KeepOak themes

---

### 2.3 Typography

**Font stack:**
- **Sans:** `"Geist","Segoe UI Variable","Segoe UI",system-ui,sans-serif` — primary for UI, body text
- **Mono:** `"Geist Mono",ui-monospace,Consolas,monospace` — code, terminals, monospaced data
- **Phone fonts (optional for smaller devices):** fallback to system stack if unavailable

**Body text:** `14px/1.5` (line-height) on `body`; scales via `data-size`:
- `data-size="small"`: `13px`
- `data-size="large"`: `15.5px`

**Font sizes and weights (common in UI):**
- **Page headings (`h1`):** `24px`, `font-weight:600`, `letter-spacing:-.02em`
- **Section headings (`h2`, `.sec h2`):** `13px`, `font-weight:600`, `color:var(--ink-3)`
- **Card titles (`.card-h b`, `.tile b`):** `13.5px`, `font-weight:600`
- **Main body (`.b .txt`):** `14.5px`, `line-height:1.6`
- **Small text (`.hint`, `.empty`, `.lh`):** `12.5px` (hints), `11.5px` (labels), `color:var(--ink-3)`
- **Labels and badges (`.lh`):** `11.5px`, `font-weight:500`, `color:var(--ink-3)`, `letter-spacing:.02em` (rare)
- **Monospace data (`.meta`, `.stamp`):** `12px` (monospace), `font-variant-numeric:tabular-nums`
- **Buttons (.btn):** `13px`, `font-weight:500`
- **Keyboard hint (`kbd`):** `10.5px`, monospace, `font-weight:500`

**Letter-spacing on uppercase:**
- Rarely applied; used on KeepOak site for section titles (`.k10-label`, `.k10-slash`) at `letter-spacing:.1em`, `.k10-disp` at `letter-spacing:-.02em`
- Branch app uses normal letter-spacing; no all-caps emphasis

---

### 2.4 Spacing, radii, borders, shadows, blur

**Spacing (gap and padding, no predefined variables; read from CSS):**
- **Tight:** `2px`, `4px` — internal spacing within components
- **Small:** `6px`, `8px` — between small elements (icons, chips)
- **Standard:** `10px`, `12px` — general component padding and gaps
- **Medium:** `14px`, `16px`, `18px` — section padding, card padding
- **Large:** `20px`, `24px`, `26px`, `28px` — page margins, thread padding
- **Extra large:** `30px`, `34px`, `40px`, `48px` — page section spacing, onboarding

**Border radii:**
- **Pills (buttons, badges):** `border-radius:999px` — infinitely round
- **Tight:** `5px`, `6px` — small elements (inputs, checkboxes)
- **Standard:** `10px`, `12px` — most components (buttons, cards, tiles)
- **Loose:** `14px`, `16px` — larger cards, panels
- **Very loose:** `18px`, `20px` — hero elements, dialog borders, full-screen panels
- **Circle:** `50%` — avatars, status dots

**Borders:**
- **Standard:** `1px solid var(--line)` — regular borders, dividers
- **Subtle:** `1px solid var(--line-2)` — less prominent dividers
- **Dashed:** `1px dashed var(--line-2)` — temporary or uncertain elements
- **Focus outline:** `2px solid var(--accent)` with `outline-offset:2px` — interactive element focus

**Shadows:**
- **Standard popover/dialog:** `var(--pop)` — `0 18px 40px -16px rgba(27,26,24,.28),0 0 0 1px var(--line)` (light); darker in dark mode
- **Soft elevation:** `0 1px 2px rgba(0,0,0,.3)` — small lifts (pin cursor, switch thumb)
- **Screen mockup:** `0 10px 30px -10px rgba(0,0,0,.4)` — live computer window
- **Accent ring:** `0 0 0 3px var(--accent-tint)` — approval and focus states

**Blur (glass effect):**
- Used throughout the app for glass morphism effect on floating panels and modals
- KeepOak site panels (`.ko10`): `backdrop-filter:blur(40px) saturate(1.25)` — frosted glass over gradient backgrounds
- Branch app panels: Various blur amounts including `blur(10px)`, `blur(14px)`, `blur(18px)`, `blur(20px)`, `blur(24px)` depending on context (e.g., agent window uses `blur(18px)`, bottom modals use `blur(20px) saturate(1.6)`)

---

### 2.5 Icons

All icons are inline **24×24 stroke SVGs** (default) or **15×15** (class `s`). Stroke styling: `stroke-width:1.7` (or `1.6` for KeepOak), `stroke-linecap:round`, `stroke-linejoin:round`, `fill:none`.

Rendered via `P` object and `ic()` function. Every icon is a `<svg class="i">` with the path appended. Icon calls like `ic('check')` output `<svg class="i">` + `P.check` path.

**Icon set (all 58 icons):**

- `plus` — Plus sign; add, create
- `search` — Magnifying glass; find, locate
- `mic` — Microphone; voice input, speak
- `up` — Upward arrow; navigate up, previous
- `stop` — Solid square; stop playback, pause (distinct from pause)
- `inbox` — Inbox tray; inbox, notifications
- `clock` — Clock face; time, schedule, duration
- `book` — Open book; documentation, reading material
- `sliders` — Sliders with one dragged; settings, adjustments, filters
- `gear` — Gear/cog; settings, configure
- `monitor` — Desktop monitor; computer, display, screen
- `panel` — Panel with divider; layout, customize panel
- `more` — Three vertical dots; more options, menu
- `check` — Checkmark; done, approved, success
- `chev` — Chevron right; expand, next, menu arrow
- `down` — Downward arrow; collapse, menu, navigate down
- `back` — Chevron left; back, previous, go back
- `menu` — Hamburger menu; toggle menu, sidebar
- `shield` — Shield; security, protection, locked
- `sun` — Sun with rays; light mode, brightness
- `moon` — Crescent moon; dark mode, night
- `copy` — Two overlapping squares; copy, duplicate, clipboard
- `branch` — Branch with leaves and circles; Branch app, organization, tree structure
- `edit` — Pencil on rectangle; edit, modify, change
- `retry` — Circular arrows; retry, refresh, reload
- `spin` — Incomplete circle (arc); loading, working, spinning
- `cpu` — Processor with pins; compute, CPU, performance
- `x` — X mark; close, delete, cancel
- `eye` — Open eye; show, reveal, visible
- `clip` — Paperclip; attachment, link, file
- `folder` — File folder; directory, folder
- `camera` — Camera; photo, capture, screenshot
- `at` — @ symbol; mention, tag, user reference
- `slash` — Forward slash; command, shortcut
- `ghost` — Ghost face; spooky, offline, absent
- `help` — Question mark in circle; help, documentation, faq
- `lock` — Padlock; locked, secure, restricted
- `users` — Multiple people; group, people, shared
- `keyboard` — Keyboard; keyboard shortcuts, input
- `info` — Info icon (i in circle); information, details
- `pin` — Map pin; pin, location, marker
- `pause` — Pause bars; pause, playback control
- `play` — Play triangle; play, start, resume
- `trash` — Trash can; delete, remove, discard
- `phone` — Mobile phone; phone, call, device
- `chat` — Chat bubble; message, conversation, discussion
- `room` — Room/group chat; room, group
- `bolt` — Lightning bolt; fast, power, electricity, urgent
- `plug` — Electrical plug; connection, plugin, tools
- `puzzle` — Puzzle piece; integrate, add-on, plugin
- `star` — Five-point star; favorite, rating, important
- `doc` — Document with lines; document, file, page
- `spark` — Sparkle/star; magic, highlight, feature
- `teach` — Mortarboard/graduation cap; teaching, training, learn
- `wave` — Waveform bars; audio, wave, frequency
- `globe` — Globe with meridians; internet, global, world
- `key` — Key; password, authentication, unlock
- `term` — Terminal window; terminal, command line

**Where icons appear:**
- Sidebar navigation, buttons, and tabs
- Message actions (hover)
- Buttons throughout the UI (compose, send, settings, etc.)
- Popovers and menu items
- Status indicators (paired with dots or badges)
- KeepOak site (smaller versions, different stroke width)

---

### 2.6 Logo and mascot

**Branch mascot (the "Little Branch" sprite):**
The mascot is a **green leafy creature with glowing orange orbs**, rendered as a posed video frame (`.pose11` — either `.webm` video or static image). Used in:
- Empty states (`.hero11`, `.empty11`)
- Onboarding screens (`.ob-pose11`)
- Tour guide (`.tour-pt11`)
- Splash screen (first load)
- Cheer card (`.cheer11` — celebration when an action completes)
- Conversation threads (when idle or waiting)

**Important:** The acorn was removed from all versions. No acorn appears anywhere in the app. The code still has constants named `ACORN` and `ACORN_INK`; they are legacy names and both draw the Branch face mark (`<span class="mark mark-face">`, the sprite as an embedded image that gently breathes).

**KeepOak mark (`.ko-mark`):**
A distinct logo used **only for keepoak.com** (the public website). Not used in the Branch app itself. Appears in:
- KeepOak site header (`.k10-brand`)
- KeepOak site rail/sidebar (`.k10-badge`)
- Dimensions: `26px×26px` in header, `24px×24px` in sidebar

**Avatar frames:** Separate from the mascot. User and Trunk avatars are "pebbles with eyes" (`.av`), generated with a solid background (`.peb`) and two eye circles (`.eye`, `.eye.l`, `.eye.r`). Eyes close when paused (`.sleepy`), widen when alert. Working avatars have a spinning copper ring (`.working`). Waiting avatars have a small copper dot in the corner (`.waiting`).

---

### 2.7 Motion

**Animations (use `@keyframes`; major animations listed below):**

The app defines 33 total `@keyframes`. Major animations include:

| Animation | What it does | Duration | Easing | Where used |
|-----------|-------------|----------|--------|-----------|
| `spin` | Full 360° rotation | 1.3s | `linear` | `.av.working` (loading spinner) |
| `breathe11` | Scale up and down gently | 4.6s | `ease-in-out` | `.av .peb` (avatars breathing); `infinite` |
| `blink11` | Eyes rotate and scale (blink effect) | 5.2s | `ease-in-out` | `.av .eye` (staggered per row); `infinite` |
| `bob` | Small vertical bounce | 0.9s | `ease-in-out` | `.pet.busy svg` (pet animation); `infinite` |
| `blink` (general) | 50% opacity flicker | 1s–1.2s | `ease-in-out` or `steps(2)` | `.pill.work i` (working badge pulse), `.typing i` (typing dots), `.term .cur` (terminal cursor) |
| `roam` | Circular mouse cursor movement | 5s | `ease-in-out` | `.cursor` (on screen mockup); `infinite` |
| `wave` | Vertical bar height wave | 1s | `ease-in-out` | `.wave i` (audio waveform during recording) |
| `enter11` | Fade and translate up | 0.24s | `cubic-bezier(.2,.7,.2,1)` | `.enter11 > *` (elements entering, e.g., messages) |
| `cheerIn11` | Scale in from bottom with pop | 0.45s | `cubic-bezier(.3,1.4,.5,1)` | `.cheer11` (celebration card); `both` |
| `cheerOut11` | Scale out downward | 0.45s | `ease-in` | `.cheer11.out11` (celebration exit) |
| `heroFloat` | Gentle up-down motion | 4s–3.6s | `ease-in-out` | `.ob-pose11`, `.tour-pt11` (mascot floating); `infinite` |
| `heroGlow` | Glow effect pulse | Unclear | Unclear | Unclear |
| `drift11` | Subtle scale and translate | 60s | `ease-in-out` | `.paint11.drift11` (background parallax in onboarding); `infinite alternate` |
| `grow11` | Stroke-dash animation (line drawing) | 1.2s | `ease-out` | `.grow11 path` (SVG line animation on splash); `forwards` with staggered delays |
| `zz11` | Z letter floating up and fading | 2.4s | `ease-in-out` | `.petbox.zz11::after` (sleeping pet indicator) |
| `hop11` | Vertical jump with squash | 0.9s | `cubic-bezier(.3,1.6,.5,1)` | `.petbox.hop11` (pet jumping) |

**Additional @keyframes** (passes 6–13): `bobav`, `breathe`, `cur7`, `idle13`, `ob9in`, `oops13`, `orb`, `orb8`, `rip7`, `rise`, `search13`, `sleep13`, `think13`, `type7`, `walk13`, `work13`, `yay13` (purposes in these passes unclear without full context review).

**Reduced motion rules:**
- `@media (prefers-reduced-motion:...)` is checked; no keyframe-driven animations run
- Fallback class `.calm11` disables motion; `.S.still` is a state variable
- **Safari/iPhone still-with-CSS-motion fallback:** Classes `html.move13` and `html.noalpha13` exist for devices that animate but strip alpha/transparency during animation (prevents flicker)

**Confetti and leaf burst:**
- `.burst11` — container for particle effects (absolute, inset 0, pointer-events:none, z-index 120)
- Leaf bursts on celebration (when actions complete); JavaScript generates particles via `pose11` elements
- "Cheer" card (`.cheer11`) displays a mascot pose, text, and optional sound effect

---

### 2.8 Voice and wording rules

Branch speaks in **plain words, second person, sentence case**. Copy is inferred from actual app strings.

**Core principles (from Soul / Character):**
- "Plain words. Short answers first, detail when asked."
- "Never send, delete, spend or install without a yes."
- "Say when you are unsure."
- Brief. Say what you did.
- Never pretend to be sure when you aren't.
- Ask before anything leaves this computer.

**Examples from the app (15+):**

1. **Empty states:**
   - "Nothing needs you." (idle, all clear)
   - "Nothing waits for you." (no pending items)
   - "Everything is on track." (status clear)
   - "Nothing matches." (search, no results)

2. **Approvals and permissions:**
   - "Allow" (button to grant permission)
   - "Denied." (rejection toast)
   - "Allowed once." (one-time permission)
   - "Ledger may now send email without asking; change that in Settings › Permissions." (permission granted, hint to revoke)

3. **Errors and blockers:**
   - "Stopped." (operation halted)
   - "Nothing was sent." (blockers prevent sending)
   - "Say 'carry on' when you want me to pick it back up." (invite to retry)

4. **Temporary/unsaved:**
   - "This conversation is temporary, so nothing is saved." (warning on temp threads)

5. **Status and feedback:**
   - "Try on two models" (action button)
   - "Tried on GPT-6 Sol and Opus 5.5 side by side. Both answers look right." (result toast)
   - "Say hello" (invite to interact with agent)
   - "Asked to join." (confirmation toast)

6. **Signing in:**
   - "You'll finish signing in on their site, in your browser. Branch never sees or stores your password; it only gets permission to ask on your behalf." (long explanation, reassurance)

7. **Scheduled/deferred work:**
   - "Scout is signing in to Outlook. If you quit, it stops and picks up next time you open Branch. Keep Branch in the tray to let it finish." (expectation-setting)

8. **Financial/specific data:**
   - "You paid $100 less than the invoice. It looks like the late fee in the small print. Want me to ask Hartwell to waive it?" (analysis, offer help)
   - "14 of 16 receipts match. Two are missing: Delta on Sep 5 and Oakfield on Sep 2." (specific, actionable)

9. **Recommendations:**
   - "Recommend Oakfield at $412 delivered." (short, structured)
   - "Three things worth a look; the rest is standard:" followed by numbered list (digest mode)

10. **Device and account management:**
    - "Your KeepOak computer leaves the switcher and your theme stops following you. Nothing is deleted on either side." (clarify what changes)

11. **Numbers, times, money:**
    - Amounts: `$100`, `$412` (no cents unless needed)
    - Dates: "Sep 5", "Sep 2" (month + day, no year if current year)
    - Percentages: "6%" (percent sign, no space)
    - Time: `13px`, `0.24s` (no spaces)
    - Counts: "14 of 16", "Two are missing" (numbers spelled out for clarity in prose)

12. **Buttons and actions:**
    - "Close" (dismiss)
    - "Save" (commit)
    - "Pause" (pause work)
    - "Ask to join" (engage)
    - "Try on two models" (run experiment)

13. **Settings and configuration:**
    - "What should it take on?" (prompt for task definition)
    - "Only the owner sees the terminal." (restriction)
    - "You're the owner. Only you change how Branch is set up." (reassurance, authority)

14. **Missing or unavailable:**
    - "Nothing to paste for this one." (hint, no clipboard)
    - "Only the owner sees the terminal." (permission)

15. **General tone:**
    - No exclamation marks (except very rare moments)
    - No all-caps emphasis
    - Contractions used naturally (e.g., "can't be undone", "I can't", "Here's", "It's")
    - Conditional phrasing: "Want me to...?", "Say when..."
    - Reassurance after destructive/risky actions

---

### 2.9 Characters, pets and scenes as design elements

**Pets (38 total character designs):**
Branch includes **34 original, painted 3D-like creature designs** (not borrowed from games, brands, or studios), plus **Little Branch** (the main mascot sprite), plus **3 pixel-art pet designs**. Each pet is a `.webp` still image and optional `.webm` walk cycle (animation).

All 38 pets in the library:
- Painted designs: Moss frog, Leaf hog, Fennec, Otter, Capybara, Clover bun, Owlet, Shell snail, Jelly, Cloud sheep, Pebble crab, Caterpillar, Sprig dragon, Turtle, Penguin, Puppy, Kitten, Raccoon, Koala, Sloth, Fruit Bat, Bumblebee, Beetle, Duckling, Hamster, Seal Pup, Octopus, Chameleon, Firefly, Dust bunny, Moss Golem, Narwhal, Elephant, Squirrel
- Special: Little Branch (mascot sprite), Owl, Hedgehog (status unclear in current version)
- Pixel-art designs: 3 designs (specific identities unclear)

**Visual style:**
- **Original art:** Not copied from any company, brand, or studio.
- **Painted aesthetic:** Soft, 3D-like shading; hand-painted appearance; warm, earthy tones.
- **Character framing:** Pets appear in circular frames (`.av.peb`) or grid tiles; always shown at small size in sidebar, larger in settings.
- **Pet interaction:** Pets can be clicked (`.petbox`); animations trigger on hover or interact (`.hop11`, `.zz11` for sleeping).

**Scenes (background art):**
- **Onboarding scene:** `.paint11` — full-bleed painted background with parallax scroll (`.drift11` animation, 60s cycle)
- **Visual style:** Same hand-painted aesthetic as pets; nature-themed (forests, groves, natural settings)
- **Originality rule:** All scenes are original; no licensed art or brand imagery

**Chat and messaging avatars (user-assigned):**
- Separate from pets; avatars are "pebbles with eyes" (`.av`)
- User or Trunk gets a solid-colour pebble (`.av .peb`) with auto-generated eyes and optional status indicator (working ring, waiting dot)
- Stack of avatars (`.stack`) for shared workspaces; avatars overlap, bottom-right has a box shadow to lift it

---

---

## 3. The window and every surface

### The main window grid and layout

**What it is:** The fixed window layout that holds the entire desktop app, using CSS Grid to organize the title bar, sidebar, main content area, optional right pane, and status bar. On windows wider than 760px on Desktop and Mac surfaces (outside focus mode), the title bar merges with the conversation header in a single 52px bar (pass 14).

**Layout structure (normal):** The `.app` container is a 3-row grid: `grid-template-rows: 34px minmax(0,1fr) 28px`. This divides space into:
- Title bar (`.titlebar`): exactly `34px` tall, with `border-bottom: 1px solid var(--line)`
- Body (`.body`): flexible middle area that expands to fill available space (`minmax(0,1fr)`)
- Status bar (`.statusbar`): exactly `28px` tall, with `border-top: 1px solid var(--line)`

**Layout structure (merged bar, pass 14):** When `.app.merged14` is active (on Desktop and Mac, windows ≥761px, outside focus mode):
- Title bar height: `52px` instead of `34px`
- Grid: `grid-template-rows: 52px minmax(0,1fr) 28px`
- The bar contains two sections split at the sidebar's edge:
  - **Left half** (`.tb-left14`): sidebar color, holds logo, prototype badge, and surface switcher; width = `var(--side-w, 292px)`
  - **Right half** (`.tb-head14`): conversation color, holds the conversation header (who, state, buttons); flex: 1 to fill remaining space
  - Both halves have pseudo-elements (`::before` and `::after`) rendering the background colors and borders
  - Bottom of right half: `2px` inset box-shadow in `var(--tint14)` color (the Trunk's tint line from the conversation header)

**Body column layout:** The `.body` is itself a grid with columns using `var(--side-w, 292px)` (not fixed):
- Default (sidebar + main only): `grid-template-columns: var(--side-w, 292px) minmax(0,1fr)`
  - Sidebar: resizable `180–640px` wide (default `292px`), left side, class `.side`
  - Main: flexible remaining width, class `.main`
- With right pane open (above 1100px): `grid-template-columns: var(--side-w, 292px) minmax(0,1fr) var(--pane-w, 352px)`
  - Sidebar: resizable `180–640px` (default `292px`)
  - Main: flexible
  - Pane: resizable `≥240px` (default `352px`), class `.pane`, right side

**Focus mode:** When `.app.focus` is set:
- Grid becomes: `grid-template-rows: 34px minmax(0,1fr) 0` (status bar hidden with height `0`)
- Merged bar is disabled: `.merged14` class is removed (even on wide windows), so title bar reverts to 34px
- Body becomes: `grid-template-columns: 0 minmax(0,1fr)` (sidebar width becomes `0`)
- `.side` gets `visibility: hidden`
- `.pane` gets `display: none`
- A focus-exit button appears with `display: inline-flex` at `position: absolute; left: 50%; top: 44px; transform: translateX(-50%); z-index: 30`

**Resizing and layout persistence:** Layout state is saved to `branch-proto-layout` localStorage key with fields `{sideW, paneW, dockW, rail, hidden}`. Sidebars and panes have draggable resizers (`.side > .resizer`, `.pane > .resizer`):
- Resizer width: `7px` (drag-active: `9px` on pass 9)
- Resizers hidden at breakpoint `@media (max-width: 760px)`
- Sidebar range: `180–640px` (default `292px`); dragged width persists across reloads
- Pane range: `≥240px` (default `352px`)
- Dock range: `≥260px`
- Ctrl+B toggle hides/shows sidebar (sets `S.sideHidden`); double-click resizer resets width to default

---

### Title bar in detail

**What it is:** The macOS-style window header containing app identity, surface/platform switcher, guide button, theme toggle, and window controls.

**Physical dimensions:** Height `34px`, padding-left `12px`, displays flex with `gap: 10px` and `align-items: center`. Background color `var(--title)` (light: `#E6ECEF`, dark: `#080B0D`). User-select disabled (`-webkit-user-select: none; user-select: none`).

**Elements from left to right:**

1. **Traffic lights** (macOS window controls, decorative in Windows prototype):
   - Three dots (`.traffic`), each `<i>` with styling, `aria-hidden="true"`
   - No functional behavior in prototype

2. **Branch wordmark** (`.wordmark`):
   - Displays: `flex`, `align-items: center`, `gap: 7px`
   - Contains: Branch logo SVG (`.mark mark-face`, `17px × 17px`) + text "Branch"
   - Font: `600` weight, `13px` size, `letter-spacing: -0.01em`
   - Function: visual branding and identity

3. **Prototype badge** (`.proto`):
   - Text: "Prototype · example data"
   - Font: `500 11px/1 var(--mono)`
   - Styling: `border: 1px solid var(--line-2)`, `border-radius: 999px`, `padding: 4px 8px`
   - Margin-left: `6px`
   - Hidden at breakpoint `max-width: 760px`

4. **Surface switcher** (`.surf`, rendered via `id="surf"` with popover content):
   - Visible as `<span id="surf">` filled by render function
   - Shows current platform name and icon
   - At `max-width: 760px`, switches to icon-only `.surf-one` mode
   - At `max-width: 520px`, this icon button also hides (`.titlebar { overflow: hidden; min-width: 0 }`)
   - Popover triggered by this element shows all surfaces: Windows, Mac, Terminal, iPhone, Android, Web
   - Each surface is a radio button with `data-act="surface"` and `data-v="{platform}"`

5. **Spacer** (`.tb-grow`):
   - `flex: 1` to push subsequent items to the right

6. **Guide button** (`.tb-btn` with `id="notesBtn"`):
   - Icon: question-mark-in-circle (18×18 SVG)
   - Text: "Guide" with a badge count (`.n` element, `data-hide="notes"` for tooltip)
   - Font: `12px`, color `var(--ink-2)`
   - Behavior: `data-tip="Guide: why each thing is here, and the critique it answers"`
   - Height: `24px`, padding `0 9px`, border-radius `7px`
   - Hover: background `var(--fill)`
   - When `aria-pressed="true"`: background `var(--ink)`, color `var(--bg)`

7. **Theme button** (`.tb-btn` with `id="themeBtn"`):
   - Icon: sun/moon SVG (15×15)
   - No text label
   - Aria-label: "Switch light or dark"
   - Same sizing and hover as Guide button
   - Functionality: `data-act="theme"` (action not shown in title bar markup, but rendered into this button)

8. **Focus mode button** (`.tb-btn`):
   - Icon: eye with circle (15×15)
   - Text label shown at `min-width: 760px`
   - Aria-label: "Clear the view (Ctrl .)"
   - `data-act="focus"` toggles focus mode
   - Hidden at breakpoint `max-width: 520px`

9. **Window controls** (`.win` section on far right):
   - Three buttons in a row, each `width: 46px`, vertically centered
   - Color: `var(--ink-3)`, hover background `var(--fill)`
   - SVG icons: `11px × 11px`, stroke-width `1.3`
   
   - **Minimize button:**
     - Aria-label: "Minimize"
     - Icon: horizontal line
     - `data-act="toast"` with message "Branch keeps working from the tray."
   
   - **Fullscreen/focus button:**
     - Aria-label: "Focus mode"
     - Icon: rectangle outline
     - `data-act="focus"` toggles focus mode
   
   - **Close button** (`.close`):
     - Aria-label: "Quit"
     - Icon: X shape
     - `data-act="quit"` closes the app
     - Hover background: `#C42B1C`, hover color: `#fff`

---

### Title bar merged with conversation header (pass 14)

**What it is:** On wide windows (≥761px) on Desktop and Mac surfaces outside focus mode, the conversation header moves into the title bar, creating a single 52px merged bar that splits at the sidebar edge (left: sidebar color + logo + surface picker; right: conversation color + header controls + window buttons).

**When it appears:** Conditions for `.merged14` class:
1. Window width ≥761px (`matchMedia('(min-width: 761px)')`)
2. Surface is `'desktop'` or `'mac'` (not Terminal, iPhone, Android, or Web)
3. Not in focus mode (`!S.focus`)
4. All three conditions enable it; any one disables it and reverts to the normal 34px bar

**Physical dimensions:**
- Height: `52px` (replaces the normal `34px` title bar + hidden `18px` conversation header bar = same total space)
- Grid template: `.app.merged14 { grid-template-rows: 52px minmax(0,1fr) 28px }`
- Split point: `var(--side-w, 292px)` — exactly at the sidebar's edge, so both resize together
- All elements within the bar use `align-self: stretch` to fill the 52px height

**Left section** (`.tb-left14`):
- Width: `var(--side-w, 292px)` (mirrored live from the sidebar as it's dragged)
- Background: sidebar color `var(--side)` via pseudo-element `.titlebar.merged14::before`
- Border-right: `1px solid var(--line)`
- Contents (in order): traffic lights (decorative), Branch logo/wordmark, prototype badge, surface switcher (icon-only at ≤1180px)
- Padding: `0 12px`; Mac: `padding-left: 14px` (extra space for system traffic lights)
- Overflow: `hidden` (names truncate if sidebar is narrow)
- Child elements: `display: flex`, `align-items: center`, `gap: 10px`, `flex: none` (nothing wraps)

**Right section** (`.tb-head14`):
- Width: remaining space after the left section (`flex: 1 1 auto`)
- Background: conversation/main color `var(--bg)` via pseudo-element `.titlebar.merged14::after`
- Border-bottom: `1px solid var(--line)`, plus `2px` inset box-shadow in `var(--tint14, transparent)` (the Trunk's tint color pulled from the conversation header's `--tint` variable)
- Contents: conversation header (`.head`) — shows who the conversation is with, their state, and conversation control buttons (Guide, theme, focus button)
- The header's original `.head` element is moved here by `mergeHead14()` on every render
- Padding: `0 6px 0 18px` (accounts for the left section's padding)

**Pseudo-element styling:**
- `.titlebar.merged14::before` (left background): positioned at `left: 0; width: var(--side-w, 292px); top: 0; bottom: 0`; `z-index: -1`
- `.titlebar.merged14::after` (right background): positioned at `left: var(--side-w, 292px); right: 0; top: 0; bottom: 0`; `z-index: -1`
- Both: `pointer-events: none`; both render the background and border (no hover effects on pseudo-elements)
- At `.app.has-bg` (has wallpaper): both get `backdrop-filter: blur(18px)` and blended color with `color-mix(... calc(100% - var(--see, 25%)), transparent)` for transparency/frosted-glass effect

**At ≤1180px wide** (compact mode within merged bar):
- Guide button becomes icon-only: `#notesBtn { font-size: 0; gap: 0; padding: 0 8px }`
- Guide icon `.i` has no margin; badge `.n` is hidden
- Conversation header icon buttons shrink: `width: 31px; height: 31px` (from `34px`)
- Window control buttons shrink: `width: 38px` (from `46px`)
- Conversation header padding tightens: `padding-left: 14px; gap: 0`

**JavaScript handling:**
- Function `mergeHead14()` runs on every `render()` to check conditions and toggle `.merged14` class
- `tbParts14(tb)` creates/finds `.tb-left14` and `.tb-head14` DOM containers if they don't exist
- `function headEl14()` returns the current conversation header element (either in main area or in title bar)
- `--side-w` CSS variable is mirrored from `#body` to `.titlebar` via a `MutationObserver` watching `#body`'s style attribute changes
- `--tint14` is set from the conversation header's `--tint` computed style on each render, or `transparent` if no header exists

**Source:** CSS lines 2127–2167 (`.titlebar.merged14`, `.tb-left14`, `.tb-head14` rules and ≤1180px breakpoint); JS lines 7516–7550 (`WIDE14` condition, `merged14()`, `tbParts14()`, `mergeHead14()`, sidebar edge mirroring)

---

### Sidebar in detail

**What it is:** Left-side navigation panel containing machine/computer switcher, search with filters, places/sections (Overview, Inbox, etc.), recent conversations, and owner profile row.

**Physical properties:**
- Width: resizable `180–640px` (default `292px`), stored in `var(--side-w)` CSS custom property and persisted in `branch-proto-layout` localStorage
- Background: `var(--side)` (light: `#EFF3F5`, dark: `#0C1013`)
- Border-right: `1px solid var(--line)`
- Display: `flex`, `flex-direction: column`, `min-height: 0` (ensures scrollable children work)
- Scrollbar: thin and invisible at rest; it appears while the list scrolls and fades one second after scrolling stops (pass 14, applies to every scroll area; see "Scrollbars" below)
- Resizer: `.side > .resizer` at the right edge, `7px` wide, cursor `col-resize`, hidden at `@media (max-width: 760px)`
- Toggle visibility: Ctrl+B hides/shows the sidebar (sets `S.sideHidden`); the sidebar becomes a hidden slide-over at narrow windows

**Sections from top to bottom:**

#### Machine/computer switcher (`.machine`)

- **Container:** Margin `10px 12px 0`, padding `6px 8px`, `border-radius: 10px`, hover background `var(--fill)`, text-align left
- **Components:**
  - **Icon** (`.mico`): `26px × 26px`, `border-radius: 8px`, background `var(--raise)`, border `1px solid var(--line)`, displays grid with `place-items: center`, color `var(--ink-2)`, flex-none
  - **Name** (`<b>`): `display: block`, `font-size: 13px`, `font-weight: 600`, line-height `1.2`
  - **Name and status dot** (`.mach14`, pass 14): the name ("This computer") and, right after it on the same line, an `8px` status dot: `var(--ok)` green when online, `.dot.sleep` `var(--warn)`, `.dot.off` `var(--line-2)`. No status words are shown (the owner asked for "just the green dot"): the words ("Online · you are here", "Asleep · wakes when asked"…) are the dot's tooltip and a visually hidden label (`.sr13`) for screen readers. The name never wraps; it ends with "…" if the sidebar is narrow.
  - **Chevron** (`.chev`): Margin-left auto, color `var(--ink-3)`
  - **Function:** Clicking opens popover `POPS.machines()` with list of all paired computers and a "+ Add a computer or phone" option

#### Search and filter bar (`.side-top`)

- **Container:** Display `flex`, `gap: 6px`, padding `8px 12px 6px`, flex wrapping at narrow widths
- **Search box** (`.search`):
  - Flex `1`, display `flex`, `align-items: center`, `gap: 8px`, height `34px`, padding `0 10px`
  - Border-radius: `10px`, background `var(--bg)`, `border: 1px solid var(--line)`
  - Hover: `border-color: var(--line-2)`
  - Color: `var(--ink-3)`, font-size `13px`, `min-width: 0`
  - Contains: `<input type="text" placeholder="...">` and a `<kbd>` showing "⌘K" (or Ctrl+K) with border `0` and padding `0`
  - Function: `data-act="find"` or live search filtering the conversation list
- **Filter buttons** (within `.search` or as separate `.icon-btn`):
  - Each: width/height `34px`, border-radius `10px`, display `grid`, place-items `center`, color `var(--ink-2)`, flex-none
  - Hover: background `var(--fill)`, color `var(--ink)`
  - `aria-pressed="true"` or `aria-expanded="true"`: background `var(--fill-2)`, color `var(--ink)`
  - Common filters: pinned, unread, working, waiting (visible as icon buttons)

#### New button

- **Style:** `.icon-btn` with `data-act="grp-new"` or `data-act="add-trunk"`
- Appears as single `+` icon button, `34px × 34px`

#### Places navigation (`.side-nav`)

- **Container:** Padding `6px 8px`, `border-top: 1px solid var(--line)`, display `grid`, `gap: 1px`
- **Links** (`.nav`):
  - Display `flex`, `align-items: center`, `gap: 10px`, height `34px`, padding `0 10px`, border-radius `9px`
  - Font-size `13.5px`, color `var(--ink-2)`, width `100%`, text-align left
  - Hover: background `var(--fill)`, color `var(--ink)`
  - `aria-current="true"`: background `var(--fill-2)`, color `var(--ink)`, `font-weight: 600`
  - Places shown (in order):
    1. **Overview** — `data-act="nav"` data-v="overview"`
    2. **Inbox** — shows unread count in accent color, `.cnt` badge
    3. **Automations** — show procedure count
    4. **Library** — show memory/knowledge count
    5. **Team** — visible if user has team workspace
    6. **Customize** (settings icon) — opens settings view

- **Collapsible (pass 14):** a small header "Places" with an arrow (`data-act="places14"`, `aria-expanded`) sits above the list, styled like the "Projects" header. Clicking it folds the list into **one compact row of six icon buttons** (Overview, Inbox, Automations, Library, Team, Customize): each keeps its action, gets its name as tooltip and screen-reader label, and the counts stay as small badges on the icons (Inbox, Team). Clicking again unfolds it. The choice is saved (`branch-proto-places14`). In rail mode (icons-only sidebar) the header is not added.

#### Conversations list (`.list`)

- **Container:** `flex: 1`, `overflow-y: auto`, padding `0 8px 8px`, scrollbar-width `thin`
- **Section header** (`.lh`):
  - Font-size `11.5px`, `font-weight: 500`, color `var(--ink-3)`, padding `10px 10px 4px`
  - Text: "Pinned", "Recent", etc.
- **Conversation row** (`.row`):
  - Width `100%`, display `grid`, `grid-template-columns: 42px minmax(0,1fr) auto`, `gap: 2px 10px`, align-items center, padding `8px 8px`, border-radius `12px`, text-align left
  - Hover: background `var(--fill)`
  - `aria-current="true"`: background `var(--fill-2)`
  - **Sub-elements:**
    - **Avatar** (`.avw`): `grid-row: span 2`, displays `.av` (pebble with eyes) or `.stack` (stacked avatars for rooms)
    - **Name** (`<b>`): `font-weight: 600`, `font-size: 14px`, white-space no-wrap, overflow ellipsis, display `flex`, `align-items: center`, `gap: 5px`
      - May contain `<span class="paused">` (monospace, `10.5px`, red-tinted) if trunk is paused
    - **Time** (`<time>`): `font-size: 11.5px`, color `var(--ink-3)`, font-variant-numeric tabular-nums, text "12:04", "11:52", "Yesterday", "Mon", or "now"
    - **Preview text** (`<p>`): Margin `0`, `font-size: 12.5px`, color `var(--ink-3)`, `grid-column: 2`, white-space no-wrap, overflow ellipsis
      - May have class `.attn` (color `var(--accent-ink)`, `font-weight: 500`) if highlighted
    - **Unread dot** (`.unread`): `grid-column: 3`, justify-self end, width/height `8px`, border-radius `50%`, background `var(--accent)`, only shows if `unread: true`
  - **Function:** `data-act="chat"` opens the conversation

#### Owner/profile row (`.owner-wrap` → `.owner`)

- **Container (wrapper):** `border-top: 1px solid var(--line)`, `padding-top: 8px`
- **Button (.owner):**
  - Display `flex`, `align-items: center`, `gap: 10px`, margin `0 8px 8px`, padding `8px 8px`, border-radius `12px`, border-top `0`, text-align left, width `calc(100% - 16px)`
  - Hover: background `var(--fill)`
  - **Sub-elements:**
    - **Avatar** (`.me`): `30px × 30px`, `border-radius: 50%`, background `var(--ink)`, color `var(--bg)`, display `grid`, place-items `center`, font-weight `600`, font-size `12px`, flex-none (initials like "TK")
    - **Text container** (`<span>`): `min-width: 0`
      - **Name only** (`.who14`, pass 14): the person's name ("Taofik"), `13px` `600`, one line with "…" if needed. The old second line ("Ask first · all good" / "Lockdown on") was removed at the owner's request: the permission mode is on the composer's mode chip and Lockdown has its own banner.
    - **Update badge** (`.upd`, optional): Margin-left auto, `font-size: 11px`, `font-weight: 500`, color `var(--accent-ink)`, background `var(--accent-tint)`, border-radius `999px`, padding `3px 8px`, white-space no-wrap (shows "Update: ..." if needed)
  - **Function:** `data-act="ownerMenu"` opens profile/settings menu; menu items include "Sign in", "Settings", "About Branch", "Quit", theme switcher

---

### Scrollbars (pass 14)
- **What it is:** every scroll area in the app (sidebar list, conversation, settings, galleries, phone screens, terminal) uses one scrollbar behaviour.
- **Why it exists (intent):** a permanent thick scrollbar with arrows looks out of place, especially in the phone apps where you scroll with a finger; modern apps show a thin bar only while you scroll.
- **How it works:** at rest the bar is thin and fully transparent (`scrollbar-width: thin; scrollbar-color: transparent transparent`, set with zero specificity via `:where(#app, #app *)` so strips that hide their scrollbar keep hiding it). Any scroll (wheel, touch, keys or dragging the bar) adds `.sb-on14` to that area, showing the thumb in `color-mix(in srgb, var(--ink) 34%, transparent)`; one second after the last scroll the class is removed and the bar disappears.
- **Source:** `patch14b.css`, `patch14b.js`.

### Status bar in detail

**What it is:** Footer bar displaying connection status, gateway state, plan/credit usage meter, and other system indicators.

**Physical properties:**
- Height: `28px`
- Display: `flex`, `align-items: center`, `gap: 2px`, padding `0 8px`
- Background: `var(--title)` (same as title bar)
- Border-top: `1px solid var(--line)`
- Font: `500 11.5px/1 var(--mono)`
- Color: `var(--ink-3)`
- White-space: `nowrap`, `overflow: hidden`

**Status items (left to right):**

1. **Connection indicator** (`.sb` button):
   - Height `22px`, padding `0 8px`, border-radius `6px`, display `inline-flex`, `align-items: center`, `gap: 6px`
   - Icon: globe or network (13×13)
   - Text: "Connected", "Offline", "Connecting" (varies by state)
   - Hover: background `var(--fill)`, color `var(--ink)`
   - Function: `data-act="connpop"` opens popover with connection details

2. **Gateway status** (`.sb` button):
   - Icon: server/gateway icon (13×13)
   - Text: "On", "Off", "When needed", "Restarting"
   - Color: normal `var(--ink-3)`, or `var(--bad)` if `.sb.lockd` (locked/offline state)
   - Function: `data-act="gwpop"` opens Gateway popover

3. **Room/space indicator** (`.sb` text):
   - Displays remaining space or quota (e.g., "180 GB left")
   - No interaction

4. **Running count** (`.sb` with `.cnt` badge):
   - Shows number of active tasks (e.g., "3" if three Trunks working)
   - Background: `var(--accent)`
   - Function: clickable to open Inbox or Automations

5. **Plan usage ring** (`.sb.meter` or `.sb` with popover):
   - Visual element: thin progress bar or ring (`.sb .meter`, `44px × 4px`, border-radius `2px`, background `var(--line-2)`, overflow hidden)
   - Inside: filled portion (`<u>`) with background `var(--ink-3)`, height `100%`
   - Text shown on hover/click: "What each connection has left" — shows per-account usage (e.g., "ChatGPT Pro: 95 queries left")
   - Function: `data-act="metered"` opens usage popover

6. **Version badge** (`.sb` text):
   - Displays "v0.19.4" or similar
   - No interaction

7. **Prototype label** (`.sb`):
   - Text: "Prototype"
   - Only shown in development/prototype builds
   - Color: `var(--ink-3)`

8. **Pet indicator** (`.pet` SVG):
   - Cute animated pet icon (15×15)
   - `.pet.busy` has animation `bob 0.9s ease-in-out infinite` (bobbing motion)
   - Function: decorative/easter egg

---

### Breakpoints and responsive behavior

**Overview:** The app responds to window width, height, and user preferences. The merged title bar (pass 14) uses `(min-width: 761px)` as its threshold; other features respond to max-width breakpoints. CSS rules are applied in order, with later rules overriding earlier ones. Below are all explicit media queries, listed from widest to narrowest.

**Explicit CSS media queries in order of application:**

#### `@media (min-width: 761px)` — Pass 14: Merged bar activation
- This is not a `max-width` query; it's the enabling condition for the merged title bar
- Desktop and Mac surfaces enable `.merged14` on both `.titlebar` and `.app` when this AND surface is desktop/mac AND not in focus mode
- Title bar height becomes `52px`; grid updates to `grid-template-rows: 52px minmax(0,1fr) 28px`
- Elements below the bar (`.stage7`, floating `.pane` at ≤1100px) reposition to `top: 52px`
- Narrow windows (≤760px) and focus mode keep the normal 34px bar, so merged bar is only visible at 761–infinite width

#### `@media (max-width: 1180px)`
- **Applies within merged bar (pass 14):**
  - Guide button becomes icon-only: `#notesBtn { font-size: 0; gap: 0; padding: 0 8px }`
  - Guide icon and window buttons shrink: `.tb-head14 .head .icon-btn { width: 31px; height: 31px }`, `.titlebar.merged14 .win button { width: 38px }`
  - Conversation header padding: `.tb-head14 .head { padding-left: 14px; gap: 0 }`
- **Applies to normal title bar (non-merged):**
  - Surface switcher button text hidden (`.surf-seg button span { display: none }`)
  - Surface button reduced padding to `0 8px`

#### `@media (max-width: 1100px)`
- **Right pane floating positioning:**
  - At normal title bar: `.pane { position: absolute; right: 0; top: 34px; bottom: 28px; width: min(352px, 100%); z-index: 30; box-shadow: var(--pop) }`
  - With merged bar: `.app.merged14 .pane { top: 52px }` (already set by pass 14)
- Body grid changes to `grid-template-columns: var(--side-w, 292px) minmax(0,1fr)` (pane no longer in grid)

#### `@media (max-width: 1000px)`
- Settings navigation becomes horizontal tabs: `.settings { grid-template-columns: minmax(0,1fr) }`, `.set-nav { border-right: 0; border-bottom: 1px solid var(--line); display: flex; gap: 4px; overflow-x: auto; padding: 8px }`
- Settings nav groups hidden: `.set-nav .grp { display: none }`
- Agent UI window repositions (if visible)

#### `@media (max-width: 900px)`
- Sidebar help/side panels hidden (`.ph-side { display: none }`)
- Some multi-column layouts collapse to single column

#### `@media (max-width: 860px)`
- Certain device/app screens switch to single-column layout
- Observation layout compresses: `.t9 { grid-template-columns: 1fr }`, `.t9-nav { position: static; grid-template-columns: 1fr 1fr }`

#### `@media (max-width: 760px)` — Major breakpoint: Narrow window
- **Merged bar disabled:** Even if all conditions are met, `(min-width: 761px)` is false, so `.merged14` class is not applied; title bar stays `34px`
- **Resizers hidden:** `.side > .resizer, .pane > .resizer { display: none }` (dragging disabled)
- **Sidebar becomes slide-over:**
  - Body grid changes to `grid-template-columns: 0 minmax(0,1fr)` (sidebar width becomes 0, content expands)
  - Sidebar visibility toggled by `S.sideHidden` and Ctrl+B; rendered off-screen or hidden
- **Surface switcher:**
  - `.surf-seg { display: none }` (hide the full segment selector)
  - `.surf-one { display: inline-flex }` (show icon-only mode)
  - `.proto { display: none }` (hide prototype badge)
- **Settings:**
  - Settings columns collapse (`.ced { grid-template-columns: 1fr }`)
  - Some tab rows become horizontal instead of vertical
- **Other layout changes:**
  - Various grid layouts collapse from 2 columns to 1
  - Agent window repositions: `.agent12 { right: 10px; bottom: 86px }`, shrinks to `56px × 56px`

#### `@media (max-width: 620px)`
- Channel wizard layout adjusts (`.chw-create12 { grid-template-columns: 1fr }`)
- QR code positioning changes

#### `@media (max-width: 520px)` — Mobile-sized window
- **Title bar:**
  - `.titlebar { overflow: hidden; min-width: 0 }` prevents overflow
  - Prototype badge hidden (redundant with ≤760px rule)
  - Focus mode button hidden (`.titlebar .tb-btn[data-act="focus"] { display: none }`)
  - Surface icon label hidden (`.surf-one .surf-lbl { display: none }`)
- **Various element hiding:**
  - `.tl-list { display: none }` (hide side lists)
  - `.term-stage { padding: 8px }` (tighter padding)
  - `.phone { display: none }` (don't show phone mockup)

#### `@media (max-height: 520px) and (min-width: 761px)`
- Sidebar becomes scrollable (`overflow-y: auto`)
- Sidebar children stop shrinking (`flex-shrink: 0`)
- Sidebar list becomes visible instead of auto (`overflow: visible`, `flex: none`, `min-height: 0`)
- "Keeper" section hidden (`.side .keeper { display: none }`)
- Navigation items compressed (`.side-nav .nav { height: 30px }`)
- Note: Applies only when window is very narrow AND taller windows don't trigger

#### `@media (prefers-reduced-motion: reduce)`
- All animations disabled: `* { animation: none!important; transition: none!important }`
- Alternate selector `:root[data-still] *` provides same behavior via data attribute

#### Container queries
- `@container (max-width: 640px)`: Chip labels and some UI elements hide in narrow containers
- `@container (max-width: 760px)`: Additional responsive adjustments within containers

---

### Each surface: Mac

**What it is:** Branch running natively on macOS with the same window structure and behavior as Windows, with macOS-specific chrome and conventions.

**How it differs from Windows:**
- Window chrome: macOS standard close/minimize/fullscreen buttons on the left (red/yellow/green) instead of right-side buttons
- Traffic lights are functional, not decorative
- Dock integration: shows unread count in badge
- Menubar: File, Edit, View menus for Branch
- Same sidebar, main area, status bar layout internally

**Not extensively detailed in prototype:** The prototype shows Windows. Mac surface is enumerated in the surface switcher (`SURFACES.includes('mac')`) but the full implementation is not rendered; it would be a native Electron/SwiftUI window with identical internal layout.

---

### Each surface: Terminal (TUI)

**What it is:** Branch accessible from any terminal via the `branch` command, showing the same Trunks, Inbox, and controls as the GUI using text-mode UI.

**Layout (rendered in `.tui` container):**

```
┌ Branch ─ this computer ────────────────────────────── gateway on ┐
│ ◔ Scout        Research      Signing in to Outlook…      │
│ ● Ledger       Money & receipts   Needs you: send report │
│ ○ Ada          Plans trips         Booked. Everything ok  │
│ ○ Field        Reading & notes     Summed up lease ok     │
├──────────────────────────────────────────────────────────────────┤
│ ◔ Agent (account) · 45% left · local upd                    │
└ @ call a Trunk · / skills · Shift+Tab mode · Ctrl+K find ───────┘
❯ type here in the real CLI
```

**Rendering:**
- Container: `.tui` (or `.term-stage` for larger view)
- Uses monospace font `var(--mono)`
- Background: `var(--term-bg)` (dark: `#0A0C0B`)
- Text color: `var(--term-ink)` (light: `#D5DDD6`)
- Dim text: `var(--term-dim)` (light: `#6E7A71`)
- Success text: `var(--term-ok)` (light: `#7FD39A`)

**Elements:**
- **Top border line:** `┌ Branch ─ this computer ... gateway {state} ┐`
- **Trunk rows** (4 visible):
  - Status indicator: `◐` (working), `●` (waiting), `○` (idle)
  - Name (right-padded to width)
  - Role/preview text (right-padded to ~42 chars)
  - Right border: `│`
- **Separator:** `├─...─┤`
- **Status line:** Shows agent name, account, usage percentage, update status
- **Footer:** `└ @ call · / skills · Shift+Tab · Ctrl+K find ┘`
- **Cursor:** `❯ ` prompt with greyed "type here in the real CLI" placeholder

**Keys (shown in footer):**
- `@` — call a Trunk (voice)
- `/` — skills/help
- `Shift+Tab` — mode/view switcher
- `Ctrl+K` — find/search
- Letter keys: answer Ledger with `y`, trigger automations, etc.

**When accessed:** `$ branch` from any terminal; same theme, same Trunks as the desktop window; the app syncs state across surfaces.

---

### Each surface: iPhone app

**What it is:** Branch running natively on iOS with touch-optimized layout, lock screen widgets, and iOS integration.

**Main screens (visible via tabs or navigation):**

#### Home / Chats screen
- **Header:** Status time (e.g., "12:04"), carrier/signal, battery (shown in iPhone status bar)
- **Tab bar at bottom:** Icons + labels for Chats, Inbox, Settings, More
- **Content area:** List of recent conversations (Trunk avatars, names, preview text, unread dot)
- **Floating action button:** `+` to start new chat

#### Inbox screen
- **List of pending approvals/notifications:**
  - "Ledger needs you: send report?"
  - "Scout is working on…"
- Shows count badge on tab (e.g., "Inbox · 2")

#### Chat screen (inside a conversation)
- **Top bar:** Trunk avatar, name, status ("idle", "working", "waiting")
- **Message thread:** Scrollable list of messages from you and the Trunk
- **Composer:** Text input with send button (`.c-btn` with accent color when ready)
- **Attachments:** Files displayed inline

#### Settings screen
- **Sections:** Account, Appearance (theme, accent color), Notifications, Devices
- **Toggles:** for "Lockdown", "Gateway", notifications per Trunk
- **Links:** "Pair with a computer", "Forget this Branch"

#### Appearance: Lock screen widget
- Shows one Trunk's status or next task
- Updated via iOS Widgets API
- Shows live activity during task execution

#### Appearance: Dynamic Island
- Displays small alert or status during task execution
- Example: "Scout working" with animated indicator

#### Appearance: Pairing flow
- QR code scanner to pair with desktop Branch
- Six-digit code entry if manual pairing needed
- Confirmation screen showing both device codes match (e.g., "OAK-4127")

**Colors and styling:** Uses same theme variables as desktop; respects iOS Dark Mode preference.

**Navigation:** Bottom tab bar (Chats, Inbox, Settings, More) is persistent.

**Responsive to interrupts:** Conversations update in real time if answered on desktop or another device.

---

### Each surface: Android app

**What it is:** Branch running natively on Android with Material Design 3, similar structure to iPhone but with Android conventions (bottom navigation, Material colors, etc.).

**Screens (same conceptual set as iPhone):**

#### Home / Chats
- **Top bar:** "Branch" title, search icon, more menu (⋮)
- **Content:** Conversation list (avatar + name + preview + time)
- **FAB (floating action button):** Bottom-right `+` for new chat
- **Bottom navigation:** 5 icons — Chats (active), Inbox, Voice, Team (if applicable), Settings

#### Inbox
- Notification/approval list
- Badge on bottom nav icon

#### Chat
- Message thread with bottom composer
- Send button becomes active (material ripple effect) when text entered

#### Voice
- Call/voice interaction screen
- Waveform visualization during recording
- Transcript display

#### Team
- Team workspace members list (if user has team)
- Shared Trunks/automations

#### Settings
- Device name, Gateway toggle, Lockdown
- Theme (Material You, follow system, dark, light)
- Notification settings per Trunk

#### Appearance: Lock screen widgets
- Shows next task or Trunk status
- Updated via Android AppWidgets or Jetpack Glance

#### Appearance: Dynamic Island equivalent
- Android 13+ uses predictive back and app-top alerts

**Navigation:** Bottom bar persistent across all screens.

**Colors:** Material You dynamic color theming; respects system Dark Mode.

---

### Each surface: Web (keepoak.com)

**What it is:** Branch accessible via browser at keepoak.com (or a domain owned by the user), with the same functionality as the desktop app but in a web-rendered interface.

**Access model:** Sign in with KeepOak account (email + password or passkey). No installation needed; runs on any modern browser.

**Routes and pages:**

#### `/` — Home / Sign in
- Sign-in form (email, password)
- "Sign in with passkey" option
- "Create KeepOak account" link
- Optional onboarding: model selection (Claude, ChatGPT, local), first automation template

#### `/chats` — Conversations list (after sign in)
- Same sidebar layout as desktop (if screen width allows) or collapsed/slide-over at narrow width
- Conversation list with preview
- Main area shows selected conversation

#### `/chats/{id}` — Single conversation
- Trunk info header (avatar, name, status)
- Message thread
- Composer with send button

#### `/inbox` — Approvals and pending tasks
- List of items needing your answer
- "Allow all" button for batch approvals

#### `/automations` — Procedures and workflows
- List of saved automations (procedures)
- Edit/run buttons
- Create new automation wizard

#### `/library` — Saved knowledge and memory
- Indexed notes and past conversations
- Search and filter

#### `/team` — (if user has team workspace)
- Team members list
- Shared Trunk list
- Invitations and access control

#### `/settings` — Preferences
- Account info (email, name, avatar)
- Theme and appearance (light/dark, accent color, saved skins)
- Connections (chat apps, cloud services, local models)
- Notification settings
- Danger zone: "Forget Branch", "Sign out"

#### `/pair` — Pairing with desktop or phone
- QR code for scanning from phone/desktop
- Code entry form for manual pairing
- "Show the phone code" option

**Session persistence:** Login token stored in secure HTTP-only cookie (not localStorage), valid across browser tabs.

**Responsive design:** Same breakpoints as desktop app; at narrow widths, sidebar hides, main area expands, and a menu button opens the sidebar as an overlay.

**Syncing:** Real-time updates to conversations and Trunk status via WebSocket or polling; if offline, shows "Offline" indicator in status bar and queues actions until reconnected.

**Browser support:** Modern browsers (Chrome, Firefox, Safari, Edge); no IE support; uses CSS Grid, Fetch API, Web Audio API for voice input.

---

### Edge cases and special states

#### Focus mode (`.app.focus`)
- Activates via button in title bar or `Ctrl+.` keyboard shortcut
- Hides sidebar, status bar, and right pane
- Maximizes reading area for the active conversation
- Shows "Leave focus mode · Ctrl+." button centered above main area
- Exits via button, shortcut, or ESC key

#### Locked state (`.app.locked`)
- Shows a lock screen overlay (`.lockscreen`) covering the entire app
- Displays PIN entry (`.pinbox`) with 6 input fields
- Prevents any interaction with underlying content
- Triggered by security policy or timeout

#### Offline state
- Status bar shows "Offline" or "Connecting"
- Outgoing messages queued (indicator: `.composer.temp { border-style: dashed }`)
- Incoming updates paused until reconnection

#### Narrow windows under 520px
- Various elements hidden to reduce clutter
- Single-column layouts enforced
- Bottom sheet/modal dialogs used instead of centered modals

#### High contrast / reduced motion
- `@media (prefers-reduced-motion: reduce)` disables all animations
- Text shadows, gradients, and decorative borders reduced on high-contrast mode

---

### Source reference

**Main HTML structure:** Lines 2155–2172 of `branch-redesign.html` (`.app` grid layout)

**CSS:** Lines 63–730 define `.app`, `.titlebar`, `.body`, `.side`, `.main`, `.pane`, `.statusbar` grid and flex layouts; lines 730–2152 define media queries for all breakpoints

**Surfaces rendering:** `POPS.surfaces()` returns radio menu, `S.surface` state variable, `SURFACES` array holds `['desktop', 'mac', 'terminal', 'iphone', 'android', 'web']`

**Surface-specific templates:** `PANE.terminal`, `PANE.iphone`, `PANE.android`, `phonePreview()`, `phoneFrame()`, `phoneStage()`, `terminalPane()` functions render each surface's UI

**Phone mockup styles:** `.phone` class (lines 4851–4882), `.iphone`/`.android` variants with platform-specific styling

**Terminal styles:** `.tui`, `.term`, `.term-stage`, `.tw-*` classes for terminal window chrome

**Actions:** `data-act="surface"` with `data-v="{platform}"` switches surfaces; `data-act="focus"` toggles focus mode; `data-act="gwpop"` opens gateway popover, etc.

---

## 4. Conversations and agents

### 4.1 Chat view: header, thread column, scrolling, naming

#### Chat header

- **What it is:** The bar showing the Trunk's avatar, name, status, and control buttons, identifying the conversation and providing quick access to viewing modes and settings.
- **Why it exists:** Identifies the conversation and provides quick access to viewing modes and settings.
- **When it appears:** Always visible when `S.view === 'chat'`.
- **Where it lives:** On wide windows (width > 760px), the header is integrated into the title bar (pass 14, `mergeHead14`). On narrow windows (≤760px), it appears as `<div class="head">` at the top of `#main` above the conversation (CSS: `.head`).
- **Layout:**
  - Wide windows: Merged into title bar; `height: 58px` with `display: flex`
  - Narrow windows: Separate bar above conversation; `height: 58px` with `display: flex`
- **How it works:**
  1. Left side: Avatar button (icon-btn) with `data-act="side"` to show/hide the conversation list (menu-only on narrow screens).
  2. Center: Avatar `av(c, 32)` and `.who` div containing Trunk name and status line.
  3. Right side: Icon buttons with `data-act="pane"` for Computer view (`data-p="computer"`) and Side panel (`data-p="activity"`), and `data-act="chatmenu"` for the More menu.
  4. Name editing: If `S.renaming === c.id`, renders `<input class="rename-in" id="rename-in">` instead of `<b>name</b>`.
  5. Status line: From `statusLine(c)`, showing one of:
     - `'Paused · won't start anything new'` if `c.paused`
     - `'attn' class` and `'Working · using the computer'` if `c.status === 'working'`
     - `'attn' class` and `'Waiting for you'` if `c.status === 'waiting'`
     - `'${c.role} · ready'` otherwise (e.g. `'Deep Researcher · ready'`)

- **How it looks:**
  - Height: `58px`
  - Background: `var(--bg)` with optional tint: `--tint: ${c.color}66` (color + 66% opacity)
  - Border-bottom: `1px solid var(--line)`
  - Avatar: 32px with flex layout
  - Name: `font-weight: 600; font-size: 15px`
  - Status line: `font-size: 12px; color: var(--ink-3)` with optional status dot `<i>` (6px circle)
  - Icon buttons: 34x34px, `icon-btn` class, `color: var(--ink-2)` on hover `background: var(--fill)`
  - When pressed (aria-pressed="true"): `background: var(--fill-2)`

- **What it says:**
  - Aria-labels: `"Show conversations"`, `"Computer view"`, `"Side panel"`, `"More for [name]"`
  - Status examples: `"Waiting for you"`, `"Working · using the computer"`, `"Scout · ready"`

- **States and edge cases:**
  - Narrow windows: Menu button is `menu-only`, hidden on wider screens (CSS display: none); avatar may be replaced with the Trunk's animated character (living agent) if one is assigned
  - Renaming: Input field auto-focuses and auto-selects when `S.renaming === c.id`
  - Room conversations: Status line shows `c.role` instead of standard status
  - Paused trunk: Status shows `"Paused"` class
  - Tint visible: When `c.color` is set, the header gets a subtle color wash behind the name

- **Source:** `renderChat()` in the HTML file; CSS classes `.head`, `.who`, `.icon-btn`, `.tb-grow`; status from `statusLine(c)`

---

#### Thread column

- **What it is:** The scrollable container for all messages in a conversation, `<div class="scroll" id="scroll">` with `flex: 1` and `overflow-y: auto`.
- **Why it exists:** Displays the full conversation history with automatic scrolling to newest messages.
- **When it appears:** When `S.view === 'chat'` and the conversation has messages.
- **Where it lives:** Inside `#main`, between the header and the dock (composer).
- **How it works:**
  1. If `list.length > 0`, renders `<div class="thread">` containing all blocks from `renderChat()`.
  2. If empty, renders `emptyChat()`: a welcome card with 4 suggested tasks as `<button class="chipb">` and a row of recent Trunk avatars with `data-act="chat"`.
  3. Scrolls automatically to bottom after rendering: `sc.scrollTop = sc.scrollHeight`.
  4. Each block is generated by `block(b, c, first, fromChanged)` switch statement based on `b.k` (block kind).
  5. Blocks are wrapped with `<div class="b">` for bot messages, containing avatar and content.

- **How it looks:**
  - Container: `overflow-y: auto; flex: 1; min-height: 0`
  - Scrollbar: `scrollbar-width: thin` (Firefox)
  - Thread: `max-width: 720px; margin: 0 auto; padding: 26px 24px 20px; display: flex; gap: 14px`
  - Background: `var(--bg)`
  - Empty state: centred Branch face mark, heading "What should Branch do?", chip buttons styled `.chipb`

- **What it says:**
  - Empty state heading: `"What should Branch do?"`
  - Suggested tasks: `"Tidy my Downloads folder"`, `"Find a cheap refundable flight to Lisbon in March"`, `"Summarise the PDFs on my desktop"`, `"Plan my week from my calendar"`
  - Row label: `"Or ask a Trunk:"`

- **States and edge cases:**
  - Empty conversation: Shows welcome card with suggestions
  - Fresh messages: `fresh` class is added and removed after first render (CSS: shows entry animation)
  - Narrow windows: Thread width is responsive (CSS variable `--thread-w`)
  - Room conversations: Bot messages show `<div class="from">${esc(who.name)}</div>` when sender changes

- **Source:** `renderChat()` main body; `block()` function for individual blocks; `emptyChat()` for initial state

---

#### Scrolling

- **What it is:** Auto-scroll behavior that keeps the newest messages visible.
- **Why it exists:** Ensures the user always sees the latest activity without manual scrolling.
- **When it appears:** After every `renderChat()` call (in `render()`).
- **How it works:**
  1. After building the HTML, `const sc = $('#scroll'); sc.scrollTop = sc.scrollHeight;` sets the scroll position to the bottom.
  2. Saved scroll position is restored after render: if `savedChatScroll !== null`, it is applied to `#scroll`.
  3. On window focus and visibility changes, scroll is preserved across redraws.

- **How it looks:** Invisible; behavior is seamless, just the messages appear.

- **Source:** Line `sc.scrollTop = sc.scrollHeight;` in `renderChat()` and `savedChatScroll` tracking in `render()`

---

#### Naming a conversation

- **What it is:** The ability to rename a Trunk or conversation inline.
- **Why it exists:** Allows the user to customize conversation identities without opening settings.
- **When it appears:** When the user clicks the name in the header, or via keyboard shortcut.
- **How it works:**
  1. User action sets `S.renaming = c.id`.
  2. Next render calls `renderChat()`, which checks `if (S.renaming === c.id)` and renders an input field instead of `<b>name</b>`.
  3. Input is auto-focused and auto-selected: `r?.focus(); r?.select();`.
  4. On blur or Enter, the new name is saved: `const r = $('#rename-in'); if (r && c && r.value.trim()) c.name = r.value.trim();` (via `saveRename()` or similar).
  5. `S.renaming = null` clears the editing mode, and the next render shows the updated name.

- **How it looks:**
  - Input field: `height: auto`, `border: none`, `outline: 0`, `background: none`, `color: var(--ink)`, `font-weight: 600`, `font-size: 15px`
  - Inherits from `.rename-in` class
  - Appears inline in the `.who` div

- **What it says:**
  - Aria-label: `"Name"`
  - Placeholder: none (defaults to current name)

- **States and edge cases:**
  - Empty name: Ignored (checks `.trim()`)
  - Escape key: Not handled; blur/Enter only (no cancel)
  - Very long names: Allowed (no max length in rendering)

- **Source:** `S.renaming` state check in header render, `saveRename()` function

---

### 4.2 Message block kinds: u, b, steps, plan, computer, ask, suggest, img, check, choice, typing

All message blocks are generated by the `block(b, c, first, fromChanged)` function, which routes on `b.k` (block kind). User messages are aligned right; bot messages are aligned left with an avatar.

#### User message (k: 'u')

- **What it is:** A message from the user, displayed on the right side of the conversation.
- **Why it exists:** Shows what the user asked or said.
- **When it appears:** Every time the user sends a message (or when a block with `k: 'u'` is in the thread).
- **Where it lives:** `<div class="u">` with `align-self: flex-end`, right-aligned in the thread.
- **How it works:**
  1. Content is either `b.html` (if pre-formatted) or `esc(b.text)` (plain text with HTML escaping).
  2. Optionally shows a "via" label if `b.via` (e.g., `"via Telegram"`) as `<div class="via">`.
  3. Message actions (copy, retry, etc.) are shown on hover: `msgActs('u')`.

- **How it looks:**
  - Container: `.u` class with `align-self: flex-end`, `max-width: min(520px, 86%)`, `background: var(--fill)`, `border-radius: 18px 18px 5px 18px` (rounded except bottom-right), `padding: 9px 14px`, `white-space: pre-wrap`, `overflow-wrap: anywhere`
  - Text: `color: var(--ink)`, `font: 14.5px/1.45` (via inherited `.txt` styles or inline)
  - Via label: `font-size: 11.5px`, `color: var(--ink-3)`, `margin-bottom: -10px`, `display: flex`, `gap: 5px`

- **What it says:**
  - The user's text, as entered
  - Via label example: `"via Telegram"` (from `b.via`)

- **States and edge cases:**
  - Empty text: Rendered as empty bubble (should not occur in practice)
  - HTML content: If `b.html` is set, it overrides `b.text` (used for rich formatting)
  - Multiple lines: Pre-wrap preserves line breaks
  - Long URLs: `overflow-wrap: anywhere` breaks them

- **Source:** `case 'u': return \`...\`;` in `block()`; CSS `.u`

---

#### Bot message (k: 'b')

- **What it is:** A text response from a Trunk, displayed on the left side with the sender's avatar.
- **Why it exists:** Shows the Trunk's reply to the user.
- **When it appears:** Every time a Trunk sends a message.
- **Where it lives:** `<div class="b">` with two-column layout: avatar on left, content on right.
- **How it works:**
  1. Avatar is shown only on the first message from a sender (`first` parameter) or when the sender changes (`fromChanged`).
  2. In rooms, the sender's name is shown as `<div class="from">${esc(who.name)}</div>` if `fromChanged`.
  3. Content is in `<div class="txt">${b.html}</div>` (always HTML, pre-formatted).
  4. Message actions (copy, etc.) are shown on hover: `msgActs('b')`.

- **How it looks:**
  - Container: `.b` with `display: grid`, `grid-template-columns: 28px minmax(0, 1fr)`, `gap: 10px`, `align-items: start`
  - Avatar (`.gut`): 28px avatar, shown only if `first`
  - Content (`.txt`): `font-size: 14.5px`, `line-height: 1.6`, `max-width: 62ch`
  - Paragraphs in `.txt`: `margin: 0 0 6px`, last paragraph has `margin: 0`
  - Sender label (`.from`): `font-size: 12px`, `font-weight: 600`, `color: var(--ink-2)`, `margin-bottom: 2px`

- **What it says:**
  - The Trunk's response text (from `b.html`)
  - Sender name (in rooms): Name of the Trunk (from `C(who).name`)

- **States and edge cases:**
  - Room mode: Sender name shown when sender changes
  - Mention styling: Mentions in text are styled `.mention` with `color: var(--accent-ink)`, `font-weight: 500` (CSS class, must be in HTML)
  - Narrow windows: `max-width: 62ch` ensures readability

- **Source:** `case 'b': return \`...\`;` in `block()`; CSS `.b`, `.txt`

---

#### Steps (k: 'steps')

- **What it is:** A collapsible list of steps a Trunk has completed, with a summary and detailed descriptions.
- **Why it exists:** Shows the work a Trunk did in a task, breaking it into checkpoints.
- **When it appears:** When a Trunk finishes a series of steps, or after major milestones.
- **Where it lives:** `<details class="steps">` with a collapsible `<summary>` and an `<ol>` inside.
- **How it works:**
  1. Summary shows: chevron icon (rotated 90° when open), then `b.summary` (e.g., `"Archived 171 files"`).
  2. On click, details toggle open/closed: `<details>` native behavior.
  3. Each item in `b.items` (array of `[action, description]`) is rendered as `<li>`.
  4. Each `<li>` has a check icon, the action text, and a small description.

- **How it looks:**
  - Container: `.steps` with `border: 0`, `margin: 0`
  - Summary: `display: inline-flex`, `gap: 7px`, `font-size: 12.5px`, `color: var(--ink-3)`, `cursor: pointer`, `padding: 3px 8px 3px 6px`, `border-radius: 8px`, on hover: `background: var(--fill)`, `color: var(--ink-2)`
  - Chevron: `.chev` icon with `transition: transform 0.15s`; when `details[open]`, rotates 90°: `transform: rotate(90deg)`
  - List (`ol`): `margin: 6px 0 2px 13px`, `padding: 0 0 0 14px`, `border-left: 1.5px solid var(--line-2)`, `gap: 7px`
  - List item (`li`): `font-size: 13px`, `grid-template-columns: 18px 1fr`, `gap: 8px`, check icon in first column
  - Description (`small`): `display: block`, `color: var(--ink-3)`, `font: 12px/1.45 var(--mono)` (monospace, smaller)

- **What it says:**
  - Summary: e.g., `"Archived 171 files"`
  - Each item: `[action, description]`, e.g., `["Listed Downloads", "214 files · 3.1 GB"]`

- **States and edge cases:**
  - Closed (default): Only summary is visible
  - Open: Full list shown, chevron rotates
  - Reduced motion: Chevron rotates without animation if `prefers-reduced-motion: reduce`

- **Source:** `case 'steps': return \`<details class="steps">...\`;` in `block()`; CSS `.steps`, `details[open]`

---

#### Plan (k: 'plan')

- **What it is:** A checklist of tasks the Trunk is working on, showing completed, in-progress, and pending items.
- **Why it exists:** Displays the Trunk's roadmap for the task, updated in real-time.
- **When it appears:** At the start of a task, and updated as steps complete.
- **Where it lives:** `<div class="card">` with `.plan` (unordered list inside).
- **How it works:**
  1. Each item in `b.items` is an array `[text, state]` where state is one of: `'todo'`, `'now'`, `'done'`.
  2. Each `<li>` has class matching the state: `<li class="${state}">`.
  3. Box icon (`.box`) shows a checkmark for done items: `${s === 'done' ? ic('check') : ''}`.
  4. `<span>` contains the item text.

- **How it looks:**
  - Container: `.card` with `.plan` inside; `padding: 12px 14px`
  - List (`ul.plan`): `list-style: none`, `margin: 0`, `padding: 0`, `gap: 6px`
  - List item (`li`): `display: flex`, `gap: 9px`, `align-items: flex-start`, `font-size: 13.5px`
  - Box (`.box`): `width: 16px`, `height: 16px`, `border-radius: 5px`, `border: 1.5px solid var(--line-2)`, `flex: none`, `margin-top: 3px`, `display: grid`, `place-items: center`
  - Done item: `.box` has `background: var(--ok)`, `border-color: var(--ok)`, `color: #fff`; `<span>` has `color: var(--ink-3)`, `text-decoration: line-through`
  - Now item (`.now`): `.box` has `border-color: var(--accent)`, `box-shadow: 0 0 0 3px var(--accent-tint)`; `<span>` has `font-weight: 500`
  - Todo item: `.box` is hollow, unfilled

- **What it says:**
  - Item texts, e.g., `"Signing in to Outlook"`, `"Finding the Hartwell invoice"`, `"Comparing with the statement"`

- **States and edge cases:**
  - Empty plan: Not normally rendered (would show empty `<ul>`)
  - All done: All items have `.done` class with strikethrough
  - One item marked `.now`: Highlighted with accent border and glow
  - Narrow windows: Text wraps; `.box` stays fixed at 16px

- **Source:** `case 'plan': return wrap(\`<div class="card" ...><ul class="plan">...\`);` in `block()`; CSS `.plan`, `li.done`, `li.now`

---

#### Computer (k: 'computer')

- **What it is:** A card showing that a Trunk is using the computer, with a live screen preview and control buttons.
- **Why it exists:** Lets the user watch and control computer use in real-time.
- **When it appears:** When a Trunk starts using the computer.
- **Where it lives:** `<div class="card">` with a `.screen` (16:9 aspect ratio) inside, and buttons below.
- **How it works:**
  1. State is one of: `'working'`, `'yours'`, `'done'`, `'stopped'`.
  2. A pill shows the current state with icon and label.
  3. `screen(b.state)` renders a live preview (mock UI showing the computer's current activity).
  4. Buttons depend on state:
     - `'working'`: `"Take over"` (`.btn pri`) and `"Watch in the side panel"` (`.btn`)
     - `'yours'`: `"Hand back to Scout"` (`.btn pri`)
     - `'done'`: No buttons
     - `'stopped'`: `"Carry on"` (`.btn`)

- **How it looks:**
  - Card: `.card` with `.computer` note
  - Header (`.card-h`): Title `"Computer"` and a pill
  - Pill (`.pill`): Matches state:
    - `'working'`: `.pill.work` with blinking dot, text `"Working"`
    - `'yours'`: `.pill.you`, text `"You have control"`
    - `'done'`: `.pill.done`, text `"Done"`
    - `'stopped'`: `.pill.idle`, text `"Stopped"`
  - Screen (`.screen`): `aspect-ratio: 16/9`, `max-width: 100%`, `border-radius: 11px`, shows a mock desktop UI (gradient background with window and cursor)
  - Sub (`.sub`): `font-size: 13.5px`, `color: var(--ink-2)`, shows the activity, e.g., `"Signing in to Outlook to find the Hartwell invoice"`
  - Acts (`.acts`): Buttons flex below the screen

- **What it says:**
  - Title: `"Computer"`
  - Activity: `b.title` (e.g., `"Signing in to Outlook to find the Hartwell invoice"`)
  - Button labels: `"Take over"`, `"Watch in the side panel"`, `"Hand back to Scout"`, `"Carry on"`

- **States and edge cases:**
  - Live update: `b.state` changes as the Trunk works; the card is re-rendered on each update
  - Screen preview: Mock UI only (not a real screenshot in this prototype)
  - Narrow windows: Screen shrinks; buttons stack on mobile

- **Source:** `computerCard(b)` function; CSS `.card`, `.pill`, `.screen`

---

#### Ask / Approval (k: 'ask')

- **What it is:** A request for user approval, showing what the Trunk wants to do (e.g., send an email) and options to allow, deny, or set a standing rule.
- **Why it exists:** Ensures the user controls sensitive actions like sending messages or changing files.
- **When it appears:** When a Trunk asks for permission (e.g., `"Send this email to Dana?"`).
- **Where it lives:** `<div class="card ask">` with a distinctive border and glow (lifted accent ring).
- **How it works:**
  1. If `b.state !== 'pending'`, shows a decided state: pill + text.
  2. If pending:
     - Header shows question (`b.q`) and a red `.pill.work` with `"Needs you"`.
     - Key-value list (`.kv`) shows details (from `b.fields`, an array of `[key, value]` pairs).
     - If `b.body`, shows it as `.mailbody` (e.g., the email body).
     - Three buttons: `"Send it"` (primary), `"Always allow for Ledger"` (secondary), `"Don't send"` (ghost).

- **How it looks:**
  - Card: `.card.ask` with `border-color: var(--accent)`, `box-shadow: 0 0 0 3px var(--accent-tint)` (lifted border effect)
  - Header (`.card-h`): Question text (`.q`) with `font-weight: 600`, `font-size: 14.5px`; pill on right (`.pill.work`)
  - Pill: `.pill.work` with blinking dot (animation: `blink 1.2s`), `background: var(--accent-tint)`, `color: var(--accent-ink)`
  - Key-value (`.kv`): `display: grid`, `grid-template-columns: auto 1fr`, `gap: 3px 14px`, `background: var(--fill)`, `border-radius: 10px`, `padding: 10px 12px`
  - `dt` (labels): `color: var(--ink-3)`, `grid-column: auto`
  - `dd` (values): `margin: 0`, `min-width: 0`, `overflow-wrap: anywhere`
  - Mail body (`.mailbody`): `grid-column: 1 / -1`, `margin-top: 4px`, `padding-top: 8px`, `border-top: 1px solid var(--line-2)`, `color: var(--ink-2)`
  - Acts (`.acts`): Buttons below, `display: flex`, `gap: 8px`

- **What it says:**
  - Question: `b.q` (e.g., `"Send this email to Dana?"`)
  - Fields: Key-value pairs from `b.fields` (e.g., `["To", "dana@example.com"]`, `["Subject", "August report"]`)
  - Mail body: Content of `b.body` (e.g., the full email text)
  - Button labels: `"Send it"`, `"Always allow for Ledger"`, `"Don't send"`
  - Decided state: `b.state` mapped to label (e.g., `'allowed' → "Sent"`, `'denied' → "Not sent"`, `'always' → "Sent · Ledger may now send email without asking"`)

- **States and edge cases:**
  - Pending: Shows buttons and key-value list
  - Allowed: Shows green pill with `"Sent"`
  - Always (Ledger rule): Shows green pill with `"Sent · Ledger may now send email without asking"`
  - Denied: Shows red pill with `"Not sent"`
  - No body: Mail body row is omitted
  - Multiple fields: Listed as rows in the grid

- **Source:** `askCard(b)` function; CSS `.card.ask`, `.pill.work`

---

#### Suggest (k: 'suggest')

- **What it is:** A proposal to turn a repeated action into an automation, e.g., "Make it a routine?"
- **Why it exists:** Learns from the user's behavior and offers to automate repeated tasks.
- **When it appears:** After a task the Trunk thinks is repeatable.
- **Where it lives:** `<div class="card">` with `.suggest` note.
- **How it works:**
  1. If `b.state === 'pending'`:
     - Header: `"Make it a routine?"` and a pill `.pill.idle` labeled `"Automation"`
     - Subtitle (`.sub`): Description (e.g., `"Run "Tidy the Downloads folder" every Friday at 5 PM"`)
     - Two buttons: `"Every Friday at 5 PM"` (primary) and `"Not now"` (ghost)
  2. If decided (`b.state === 'made'` or `'no'`):
     - Shows a single pill with the outcome: `"Routine added · Fridays 5 PM"` or `"Not now"`

- **How it looks:**
  - Card: `.card` with `.suggest` note; `padding: 12px 14px`
  - Header (`.card-h`): `<b>` with text `"Make it a routine?"`, pill on right
  - Pill (`.pill.idle`): `background: var(--fill)`, `color: var(--ink-3)`
  - Subtitle (`.sub`): `font-size: 13.5px`, `color: var(--ink-2)`
  - Buttons: Primary `.btn pri sm` and ghost `.btn ghost sm`
  - Decided state: Single pill with state-based styling

- **What it says:**
  - Question: `"Make it a routine?"`
  - Description: e.g., `"Run \"Tidy the Downloads folder\" every Friday at 5 PM"`
  - Button labels: `"Every Friday at 5 PM"`, `"Not now"`
  - Decided: `"Routine added · Fridays 5 PM"` or `"Not now"`

- **States and edge cases:**
  - Pending: Interactive, buttons shown
  - Made: Shows success pill with schedule
  - No: Shows neutral pill
  - Empty description: Should not occur

- **Source:** `case 'suggest': return wrap(...);` in `block()`; CSS `.card`, `.pill.idle`

---

#### Image (k: 'img')

- **What it is:** A generated or provided image with version selection and controls.
- **Why it exists:** Shows pictures generated by the Trunk (e.g., via an image generation API).
- **When it appears:** When a Trunk creates an image.
- **Where it lives:** `<div class="card img6">` with an image preview and thumbnail grid.
- **How it works:**
  1. Main image: `<img class="img6-main" src="${b.urls[b.pick || 0]}">` shows the selected version.
  2. Versions grid (`.img6-vars`): Thumbnail buttons, each with `data-act="img-pick"`, `data-i="${i}"`, showing the alternative versions.
  3. Buttons below:
     - `"Save to Library"` (secondary)
     - `"Use as background"` (secondary, with `data-act="img-bg"`)
     - `"Make it again"` (ghost)
  4. Hint text explains the image was made with the user's account and this is a stand-in.

- **How it looks:**
  - Card: `.card.img6` with note `"imagine6"`; `max-width: 560px`
  - Header (`.card-h`): `<b>` with prompt text, pill `.pill.idle` labeled `"Picture"` on right
  - Main image: `<img class="img6-main">`, responsive width, displayed below header
  - Versions grid (`.img6-vars`): `display: flex` or grid of small button thumbnails, each `<img src="${url}">` showing the alternative
  - Version buttons: `data-act="img-pick"`, `aria-pressed` toggles on selection
  - Acts (`.acts`): Three buttons below the versions
  - Hint (`.hint`): Small text below, `font-size: 12.5px`, `color: var(--ink-3)`, `margin: 6px 0 0`

- **What it says:**
  - Prompt: e.g., `"A quiet valley at dawn, soft light"`
  - Pill label: `"Picture"`
  - Button labels: `"Save to Library"`, `"Use as background"`, `"Make it again"`
  - Hint: `"Made with your ChatGPT account (Settings › Models › Media). This prototype paints a stand-in."`

- **States and edge cases:**
  - Multiple versions: All shown as thumbnails; one is selected (`aria-pressed="true"`)
  - Single version: One button shown
  - Narrow windows: Image shrinks; buttons stack

- **Source:** `imgCard(b)` function; CSS `.card.img6`

---

#### Check (k: 'check')

- **What it is:** A verification list showing that the Trunk has confirmed specific details or conditions.
- **Why it exists:** Summarizes verification steps (e.g., "Found 3 invoices", "All from 2024").
- **When it appears:** After the Trunk checks conditions before proceeding with a task.
- **Where it lives:** `<div class="check">` with check icons and key-value-like pairs.
- **How it works:**
  1. Each item in `b.lines` is an array `[label, detail]`.
  2. Each is rendered as `<div>` with a check icon (`.check` has `svg.i`) and a `<span>` containing `<b>label</b> · detail`.

- **How it looks:**
  - Container: `.check` with `background: var(--raise)`, `border: 1px solid var(--line)`, `border-radius: 14px`, `padding: 10px 14px`, `gap: 4px`
  - Each line: `display: grid`, `grid-template-columns: 16px 1fr`, `gap: 8px`
  - Check icon: `.check svg`, `color: var(--ok)`, `margin-top: 3px`, `width: 14px`, `height: 14px`
  - Label (`<b>`): `font-weight: 600`
  - Text: `font-size: 13.5px`, flows with the icon and label

- **What it says:**
  - Each line: `[label, detail]`, e.g., `["Files", "171 older than six months"]`, `["Duplicates", "12 found, none deleted"]`

- **States and edge cases:**
  - Empty check list: Not normally rendered (would show empty container)
  - Long details: Text wraps; grid layout maintains alignment

- **Source:** `case 'check': return wrap(\`<div class="check">...\`);` in `block()`; CSS `.check`

---

#### Choice (k: 'choice')

- **What it is:** Multiple-choice question with lettered options (A, B, C, D, E) and the ability to type a custom answer.
- **Why it exists:** Lets the Trunk ask the user to pick from predefined answers or supply their own.
- **When it appears:** When a Trunk needs the user to choose between alternatives.
- **Where it lives:** `<div class="card choice">` with a grid of `.opt` buttons and an optional text input.
- **How it works:**
  1. Question (`.q`): `b.q` at the top.
  2. Optional subtitle (`.sub`): `b.sub` if present.
  3. Options grid (`.opts`): Each option is a button `.opt` with:
     - Letter keyboard shortcut (A–E) in a `<kbd>`
     - Bold title (`<b>`) from `b.options[i][0]`
     - Small description (`<small>`) from `b.options[i][1]`
     - `data-act="pick"`, `data-id="${b.id}"`, `data-i="${i}"`
     - `aria-pressed` toggles when selected; button becomes `disabled` after selection
  4. If `b.picked === null`, shows an `<input>` form (`.own`) for typing a custom answer.
  5. If `b.picked != null`, the selected option has `.picked` class, input is hidden.

- **How it looks:**
  - Card: `.card.choice`; `padding: 12px 14px` (inherited from card)
  - Question (`.q`): `font-weight: 600`, `font-size: 14.5px`
  - Subtitle (`.sub`): `font-size: 13px`, `color: var(--ink-3)`, `margin-top: -6px`
  - Options grid (`.opts`): `display: grid`, `gap: 4px`
  - Option button (`.opt`): `display: grid`, `grid-template-columns: 22px 1fr`, `gap: 1px 10px`, `align-items: center`, `padding: 8px 10px`, `border-radius: 10px`, `border: 1px solid transparent`, on hover: `background: var(--fill)`, `border-color: var(--line)`, `cursor: pointer`
  - Option `.picked`: `background: var(--fill-2)` (selected state)
  - Keyboard hint (`<kbd>`): `width: 22px`, `height: 22px`, `border-radius: 6px`, `background: var(--bg)`, `grid-row: span 2`, displays the letter (A–E)
  - Picked `<kbd>`: `background: var(--btn)`, `color: var(--on-btn)`, `border-color: var(--btn)`
  - Title (`<b>`): `font-weight: 500`, `font-size: 13.5px`
  - Description (`<small>`): `font-size: 12px`, `color: var(--ink-3)`
  - Custom input form (`.own`): `display: flex`, `gap: 6px`, shown if no selection; hidden after selection
  - Custom input (`<input>`): `height: 34px`, `border-radius: 12px`, `background: var(--bg)`, `padding: 0 10px`, `font-size: 13px`, placeholder: `"Or type your own answer"`
  - Submit button: `.btn sm`

- **What it says:**
  - Question: `b.q` (e.g., `"Which supplier is cheapest?"`)
  - Subtitle: `b.sub` (e.g., `"Based on the quotes"`)
  - Options: `[title, description]` pairs (e.g., `["Oakfield", "$412 / 10 cases"]`)
  - Keyboard letters: A, B, C, D, E
  - Input placeholder: `"Or type your own answer"`

- **States and edge cases:**
  - Unpicked: All buttons are clickable, input is visible
  - Picked: Selected button has `.picked` class, others are `disabled`, input is hidden
  - Disabled buttons: Cursor changes to `default`, no hover effect
  - No subtitle: Omitted
  - Custom answer: Typed into the input and submitted via form submit

- **Source:** `choiceCard(b)` function; CSS `.card.choice`, `.opt`, `.opt.picked`

---

#### Typing (k: 'typing')

- **What it is:** An animated indicator that a Trunk is typing a response.
- **Why it exists:** Shows the user that the Trunk is thinking/composing and to expect a message soon.
- **When it appears:** While the Trunk is working and composing a response (temporary block, replaced by actual message).
- **Where it lives:** `<span class="typing">` with three animated dots.
- **How it works:**
  1. Renders three `<i>` elements (dots).
  2. Each dot has a staggered animation: `blink 1s infinite` with animation-delay.
     - First dot: no delay
     - Second dot: `0.15s` delay
     - Third dot: `0.3s` delay
  3. Animation: dots fade in and out (opacity cycles 100% → 35% → 100%).

- **How it looks:**
  - Container: `.typing` with `display: inline-flex`, `gap: 4px`, `padding: 10px 0`, `aria-label: "Typing"`
  - Each dot (`<i>`): `width: 6px`, `height: 6px`, `border-radius: 50%`, `background: var(--ink-3)`, animated
  - Animation (`blink` keyframes): `50% { opacity: 0.35 }` (from 100% to 35% and back)

- **What it says:**
  - Aria-label: `"Typing"`

- **States and edge cases:**
  - Temporary: Removed when the actual message arrives
  - Reduced motion: Still animated (no special handling for `prefers-reduced-motion`)

- **Source:** `case 'typing': return wrap('<span class="typing">...');` in `block()`; CSS `.typing`, `@keyframes blink`

---

#### Other block kinds

- **stamp** (k: `'stamp'`): Timestamp/divider (e.g., `"Sep 24"`), centered and dimmed
- **roomline** (k: `'roomline'`): In group rooms, shows which members are speaking (e.g., `"Messages from Scout and Ledger"`)
- **file** (k: `'file'`): A file artifact (e.g., a PDF or document the Trunk created), clickable to open in Library
- **ckpt** (k: `'ckpt'`): Checkpoint notification (e.g., `"Put back: all 171 files are where they were"`) with optional restore button
- **done** (k: `'done'`): Celebration message when a task finishes (e.g., `"Done! 171 files archived"`), styled with the Branch face mark icon
- **mem** (k: `'mem'`): Memory suggestion (e.g., `"Remember this?"`) with buttons to keep or forget
- **ask2** (k: `'ask2'`): Multiple approvals from different Trunks in one card
- **art** (k: `'art'`): An artifact chart/visualization (e.g., a bar chart) with copy and expand buttons
- **think** (k: `'think'`): Thinking/reasoning block (shown only if working), with spark icon and text
- **saved** (k: `'saved'`): Checkpoint saved notification (e.g., `"Saved progress: ..."`), styled like ckpt

---

### 4.3 Composer: controls, slash commands, mentions, drafts, temporary chats, shell mode, task dock, context meter

#### Composer container and textarea

- **What it is:** The message input area at the bottom of the chat, with a textarea and control buttons.
- **Why it exists:** Allows the user to type and send messages to a Trunk.
- **When it appears:** Always visible in chat view (when `S.view === 'chat'`).
- **Where it lives:** `<div class="dock">` at the bottom of `#main`, containing `<form class="composer" id="composer">`.
- **How it works:**
  1. Textarea ID: `#msg`, placeholder depends on conversation type:
     - Room: `"Message the room · @ to call a Trunk"`
     - Trunk: `"Message [name]"`
  2. Content is stored in `S.drafts[S.chat]` (auto-saved as the user types).
  3. Escape key: Clears the draft if not empty.
  4. Enter key: Submits the message (form submit).
  5. Form submit: Calls an action that sends the message and clears `S.drafts[S.chat]`.

- **How it looks:**
  - Dock: `.dock` with `flex: none`, `padding: 6px 24px 16px`, `position: relative`
  - Form: `.composer` with `max-width: 720px`, `margin: 0 auto`, `display: flex`, `align-items: flex-end`, `gap: 4px`, `padding: 6px`, `border-radius: 24px`, `background: var(--raise)`, `border: 1px solid var(--line-2)`, `transition: border-color 0.15s, box-shadow 0.15s`
  - Focused: `border-color: var(--ink-3)`, `box-shadow: 0 6px 24px -14px rgba(0, 0, 0, 0.35)`
  - Temporary chat: `.composer.temp` with `border-style: dashed`
  - Textarea: `flex: 1`, `min-width: 0`, `border: 0`, `outline: 0`, `background: none`, `resize: none`, `padding: 7px 4px`, `font-size: 14.5px`, `line-height: 1.45`, `max-height: 160px`, `placeholder: var(--ink-3)`, `color: var(--ink)`
  - Grows with content (CSS: `rows="1"`, JS: auto-resize)

- **What it says:**
  - Placeholder: `"Message [Trunk name]"` or `"Message the room · @ to call a Trunk"`

- **States and edge cases:**
  - Empty: Placeholder is shown
  - Focused: Border and shadow change
  - Multiline: Grows up to 160px max-height, then scrolls
  - Temporary chat: Border is dashed (e.g., for drafts not yet saved)
  - Dictation active: Textarea is hidden, replaced by dictation UI

- **Source:** `renderChat()` form section; CSS `.dock`, `.composer`, `<textarea>`

---

#### Composer controls

- **Plus menu (data-act="plusmenu")**
  - Icon button `.c-btn` at the left of composer
  - Opens popover menu with slash commands and quick actions
  - Options include: `/goal` (set a goal), `/bg` (set background), `/imagine` (make a picture), etc.
  - Each is a menu item (`.mi`) with icon and label

- **Flags (c-flags)**
  - Small pills shown below the textarea, indicating settings
  - `"Temporary"` if `S.temp === true` (message not saved to conversation history)
  - `"Asks first"` if `S.askQs === true` (Trunk asks for approval before taking action)
  - `"${S.think}"` if `S.think !== 'Normal'` (e.g., `"Medium"` or `"Deep"`, showing reasoning level)
  - Styled `.flag` with `font: 500 11px/1 var(--mono)`, `color: var(--ink-3)`, `border: 1px solid var(--line-2)`, `border-radius: 999px`, `padding: 4px 7px`

- **Dictate button (data-act="dict")**
  - Icon button `.c-btn` before send button
  - Label: `"Dictate"`
  - When clicked, starts dictation; textarea is hidden and replaced by dictation UI (`.dict` div with wave animation)

- **Send/Stop button (id="send", class="c-btn send")**
  - Changes appearance based on state:
    - No text and not working: disabled, dark gray icon
    - Has text: `.send.ready` with `background: var(--accent)`, `color: #fff`, clickable
    - Working and no text: `.send.stop` with `background: var(--btn)`, `color: var(--on-btn)`, clickable to stop
  - Label: `"Send"` or `"Stop"` (aria-label)
  - Icon: up arrow for send, stop icon for stop

- **How they look:**
  - Plus button: 34x34px, `.c-btn` class, `color: var(--ink-2)`, on hover: `background: var(--fill)`, on open: `background: var(--fill-2)`
  - Send button: 34x34px, circular (`.send` is rounded), transitions between states
  - Ready state: `.send.ready` with accent color, white icon
  - Stop state: `.send.stop` with dark background
  - Dictate button: 34x34px, `.c-btn` class, shows microphone icon

- **What it says:**
  - Aria-labels: `"Add"`, `"Dictate"`, `"Send"` / `"Stop"`
  - Flags: `"Temporary"`, `"Asks first"`, `"Deep"`, etc.

- **States and edge cases:**
  - Empty message: Send is disabled (not `.ready`), appears grayed out
  - Working: Send changes to stop button (`.send.stop`)
  - Temporary chat: Shows `"Temporary"` flag in red/orange
  - No dictation permission: Dictate button may be hidden or disabled

- **Source:** Buttons in `renderChat()` form; CSS `.c-btn`, `.send`, `.flag`

---

#### Slash commands

- **What it is:** Commands starting with `/` that trigger special actions or set options.
- **Why it exists:** Provides quick access to frequent actions without navigating menus.
- **When it appears:** When user types `/` in the composer.
- **How it works:**
  1. User types `/command arguments`.
  2. On form submit, the message is parsed.
  3. If recognized, the command is executed; otherwise, the message is sent as-is.
  4. Common commands:
     - `/goal` – Start a goal-driven task (rounds until success)
     - `/bg` – Set the background
     - `/imagine` – Create a picture
     - `/@` – Mention a Trunk (same as `@Trunk`)
     - `/teach` – Learn from user demonstration
     - Various others for settings, automations, etc.

- **How it looks:** Text-based; no visual rendering beyond the input

- **What it says:** `/goal`, `/bg`, `/imagine`, etc.

- **States and edge cases:**
  - Recognized command: Executed, may open a dialog or set state
  - Unrecognized: Sent as a regular message to the Trunk
  - Space after slash: `/ command` is treated as text, not a command

- **Source:** Action handlers in `ACTS` object; parsed in form submit handler

---

#### Mentions (@mention)

- **What it is:** A way to call or reference another Trunk, using `@TrunkName` syntax.
- **Why it exists:** Lets the user easily switch context or ask one Trunk to coordinate with another.
- **When it appears:** When user types `@` in the composer.
- **How it works:**
  1. User types `@` or clicks the mention button (part of plus menu).
  2. A popover opens showing available Trunks (`.mi` list of Trunk names).
  3. User clicks a Trunk name.
  4. `@TrunkName ` is inserted into the textarea, replacing `@` partial match.
  5. On message send, the mention is recognized; the Trunk being called is notified.

- **How it looks:**
  - Popover: `.pop` menu with list of Trunks
  - Each item: `.mi` button with Trunk avatar and name
  - In text: `@TrunkName` is styled `.mention` with `color: var(--accent-ink)`, `font-weight: 500`

- **What it says:**
  - Popover header: (implicit) list of Trunk names
  - Inserted text: `@TrunkName ` (with trailing space)

- **States and edge cases:**
  - Partial match: Popover shows only matching Trunks
  - Already mentioned: Can mention the same Trunk again
  - Escape key: Closes popover without inserting

- **Source:** `mention-pick` action in ACTS; `.mention` CSS class; popover rendering in `drawSlash()` or similar

---

#### Drafts

- **What it is:** Automatic saving of unsent messages to `S.drafts[S.chat]`.
- **Why it exists:** Preserves the user's work if they switch conversations or close the app.
- **When it appears:** Draft is stored as the user types; restored when the chat is reopened.
- **How it works:**
  1. On input to textarea, the value is stored: `S.drafts[S.chat] = $('#msg').value`.
  2. On render, the textarea is populated: `${esc(draft)}` in the HTML.
  3. On message send, the draft is cleared: `S.drafts[S.chat] = ''`.
  4. On chat switch, the current draft is saved; the new chat's draft (if any) is loaded.

- **How it looks:** Draft is invisible; only the textarea content changes when switching chats

- **States and edge cases:**
  - Multi-line draft: Textarea grows to accommodate
  - Special characters: HTML-escaped and stored safely
  - Persistence: Draft is kept in memory during the session (not saved to disk unless localStorage is used)

- **Source:** `S.drafts` object, textarea input handler, `renderChat()` placeholder restoration

---

#### Temporary chats

- **What it is:** A conversation mode where messages are not saved to the conversation history.
- **Why it exists:** Allows experimental or private conversations without cluttering the record.
- **When it appears:** When `S.temp === true` for the current chat.
- **How it works:**
  1. User enables temporary mode (e.g., via `/temp` command or settings toggle).
  2. `S.temp` flag is set to `true`.
  3. Composer border becomes dashed (`.composer.temp`).
  4. A `"Temporary"` flag is shown below the textarea.
  5. Messages sent are processed but not added to `threads[S.chat]`; they disappear when the conversation is closed.

- **How it looks:**
  - Composer: `.composer.temp` with `border-style: dashed` instead of solid
  - Flag: `"Temporary"` pill below textarea, styled `.flag`

- **What it says:**
  - Flag label: `"Temporary"`

- **States and edge cases:**
  - Toggled on: Border changes to dashed
  - Toggled off: Border returns to solid
  - Messages disappear: When chat is switched or closed (no undo)

- **Source:** `S.temp` state check in composer render; CSS `.composer.temp`

---

#### Context meter (status bar)

- **What it is:** A display of how much "context" (tokens) the conversation has used.
- **Why it exists:** Informs the user about conversation length and when context might run out (old messages get archived).
- **When it appears:** In the status bar (bottom right of window), always visible.
- **How it looks:**
  - Bar: Small progress bar with `width: 44px`, `height: 4px`, `border-radius: 2px`, `background: var(--line-2)`, `overflow: hidden`
  - Fill (`<u>`): `height: 100%`, `background: var(--ink-3)`, `border-radius: 4px`, width set as percentage (e.g., `86%`)
  - Label: Button with percentage (e.g., `"Room left "` + percentage + meter)

- **What it says:**
  - Button label: `"Room left [percentage]%"`
  - Example: `"Room left "` + bar + `" 86%"`

- **States and edge cases:**
  - Full (100%): Bar is full
  - Empty (0%): Bar is empty
  - Narrow screens: Meter is hidden on very narrow viewports (`.hide-sm`)

- **Source:** Status bar render; CSS `.meter`, `<u>` fill element

---

### 4.4 Approvals (ask blocks) and permission modes

#### Ask blocks (approval requests)

Already covered above as message block type `'ask'`. Key points:

- **Pending state:** Shows a distinctive bordered card with question, key-value details, and three buttons.
- **Decided states:** Shows a pill with the outcome (`"Sent"`, `"Not sent"`, `"Sent · Always for [Trunk]"`).
- **User actions:** Click one of the three buttons to allow, deny, or set a rule.
- **Standing rule:** `"Always allow for [Trunk]"` sets a rule so the Trunk doesn't ask again for that action.

---

#### Permission modes
- **What it is:** how much a Trunk may do in a conversation without asking first.
- **Why it exists (intent):** trust grows gradually; the person decides per conversation, or everywhere, how free a Trunk is.
- **Where it lives:** the mode chip in the composer (`modeChipHTML()`, `data-act="modemenu2"`, tooltip "How much it may do in this conversation (Shift+Tab)"), which opens the menu "How much may it do in this conversation?".
- **The four modes** (`PMODES`, set with `data-act="set-mode"`):
| Value | Label | Description (exact) | Icon |
|---|---|---|---|
| `auto` | Auto | "Branch decides what’s safe and only asks about risky things." | spark |
| `ask` | Ask first | "Always asks before changing files, running commands or using the internet." | shield |
| `plan` | Plan first | "Writes a plan and waits for your OK before doing anything." | plan |
| `none` | Full access | "Does anything on this computer without asking: files, commands, the internet." | unlock |
- **Applies to** (`data-act="scope"`): "This conversation" (`here`, stored per conversation in `S.convMode[id]`) or "Everywhere" (`everywhere`, sets `S.modeDefault`). A conversation's mode is `S.convMode[id]`, falling back to `S.modeDefault` (`modeFor(id)`). The default is Ask first.
- **Shift+Tab** in the message box cycles through the modes, skipping any that are blocked.
- **Blocked modes (shown greyed with the reason):**
  - Auto is not available with a local Qwen model: "Not available with <model> on this computer. Pick another model to use Auto." (`autoBlocked()`).
  - Full access is owner-only: "Only the owner can give full access. People on this computer and chat apps never can." (`fullBlocked()`).
- **Lockdown** (the last item in the menu, `S.locked`): overrides every mode. Trunks cannot send, change files or spend. The chip shows a lock icon and "Lockdown", and a banner shows across the app until it is turned off.
- **How the chip looks:** label = the mode name; the chip gets class `full` in Full access (a warning style) and `lockd` in Lockdown.
- **Older menu kept in the code:** `POPS.modemenu` ("How much may Trunks do?" with "Ask for everything", "Ask first", "Just do it") is from the base layer. Nothing in the final layout opens it; the chip above replaced it.

---

### 4.5 Computer / browser: per-Trunk computer choice, multiple computers, full-size stage, picture-in-picture, All screens grid, take over, watch

#### Computer selection for a Trunk

- **What it is:** Choosing which computer a Trunk uses when working.
- **Why it exists:** Allows running tasks on different machines (local, cloud, remote).
- **When it appears:** When a Trunk is about to use the computer, or via settings.
- **How it works:**
  1. User clicks the Computer view button in the chat header (data-act="pane", data-p="computer").
  2. A popover (POPS.comps()) lists available computers.
  3. User selects one: data-act="comp-set", data-v="[computer-id]".
  4. `S.compFor[S.chat]` is set to the computer ID.
  5. On next task, the Trunk uses that computer.

- **How it looks:**
  - Popover menu (.pop) with list of computers (.mi)
  - Each computer: Name, status (e.g., "Online · connected"), online indicator

- **What it says:**
  - Computer names (e.g., "This computer", "KeepOak computer", "Remote server")
  - Status: "Online", "Offline", etc.

- **States and edge cases:**
  - No computer selected: Defaults to this computer
  - Computer offline: Cannot be selected
  - Multiple Trunks: Each can have a different computer

- **Source:** POPS.comps() popover, comp-set action, S.compFor state

---

#### Multiple computers

- **What it is:** Support for running Trunks on different computers (local, cloud, paired devices).
- **Why it exists:** Distributes load and allows running tasks on always-on machines.
- **When it appears:** In Settings › Computer & browser; in computer selection menus.
- **How it works:**
  1. Computers are listed in COMPUTERS array (with id, name, os, icon, status).
  2. Each Trunk has S.compFor[trunk_id] = computer_id.
  3. When a Trunk works, it uses that computer.
  4. User can switch computers for a Trunk anytime.

- **Computer types:**
  - `'this'` – The current Windows/Mac machine
  - `'cloud'` – A KeepOak cloud computer
  - `'linux'` – A remote Linux server
  - `'network'` – A paired device

- **Status values:**
  - `'ok'` – Online and ready
  - `'wait'` – Connecting
  - `'off'` – Offline
  - `'sleep'` – Sleeping (can wake up)

- **Source:** COMPUTERS array, S.compFor state, computer selection popover

---

#### Full-size stage

- **What it is:** A large, dedicated screen showing a Trunk's real-time computer activity.
- **Why it exists:** Allows the user to watch and control computer work in detail.
- **When it appears:** When user clicks "Watch in the side panel" or opens a dedicated computer view.
- **How it works:**
  1. The computer block is shown in full size in the side pane or a modal.
  2. Mock screen (.screen) with 16:9 aspect ratio shows a simulated desktop.
  3. Updates in real-time as the Trunk works.
  4. User can click "Take over" to pause the Trunk and control the computer.

- **How it looks:**
  - Screen: .screen class with `aspect-ratio: 16/9`, `max-width: 100%`, `border-radius: 11px`
  - Background: Gradient (representing desktop background)
  - Foreground: Mock window with title bar, content area, cursor animation
  - Cursor: Small animated pointer that moves across the screen (data-st attribute, animation)

- **What it says:**
  - Activity description (b.title): e.g., "Signing in to Outlook to find the Hartwell invoice"
  - Button label: "Take over"

- **States and edge cases:**
  - Working: Screen is live, updates show activity
  - Done: Screen is frozen, shows final state
  - Your control: Screen is grayed out or shows "You have control" (Trunk paused)

- **Source:** screen() function, .screen CSS class, computer block in pane render

---

#### Picture-in-picture

- **What it is:** A small, always-visible window showing the computer screen while the user interacts with the chat.
- **Why it exists:** Lets the user keep an eye on Trunk activity without switching views.
- **When it appears:** When the computer pane is toggled on while viewing the chat.
- **How it works:**
  1. The side pane (S.pane) is set to 'computer'.
  2. renderPane() renders the computer block in the pane.
  3. Screen is scaled down to fit the pane width (typically 352px).
  4. Updates automatically as the Trunk works.

- **How it looks:**
  - Container: .pane on right side (border-left, background: var(--side))
  - Screen: Smaller .screen, scaled to fit pane width
  - Title and buttons below screen

- **States and edge cases:**
  - Visible: Pane is open, screen is shown
  - Hidden: Pane is closed, screen is not visible
  - Narrow windows: Pane may collapse or be full-screen

- **Source:** renderPane() when S.pane === 'computer', .pane CSS

---

#### All screens grid

- **What it is:** A grid view showing all computers and their current activity (multiple screens at once).
- **Why it exists:** Lets the user monitor multiple machines simultaneously.
- **When it appears:** In a dedicated view or modal, showing all computers.
- **How it works:**
  1. User action sets S.stageGrid = true.
  2. render() shows a grid of screens, one per computer.
  3. Each screen shows the computer's current state (mock activity).
  4. User can click a screen to focus on that computer.

- **How it looks:**
  - Grid: CSS grid, 2 columns on wide screens, 1 on narrow
  - Each screen: .screen with `aspect-ratio: 16/9`
  - Below each: Computer name and status

- **States and edge cases:**
  - Multiple computers: Grid scales with number of machines
  - No activity: Screens show idle state (desktop)
  - One computer active: Highlights with border or animation

- **Source:** S.stageGrid state, grid rendering in render(), CSS grid layout

---

#### Take over

- **What it is:** User pauses a Trunk and takes manual control of the computer.
- **Why it exists:** Allows manual intervention if the Trunk gets stuck or the user wants to do something manually.
- **When it appears:** When a Trunk is working and has control of the computer.
- **How it works:**
  1. User clicks "Take over" button in the computer card.
  2. Action: data-act="takeover", data-id="[computer_id]".
  3. Trunk's computer state changes to 'yours'.
  4. Trunk pauses (status becomes 'idle').
  5. Button changes to "Hand back" (data-act="handback").
  6. User can now control the computer (in the real app, this opens a control interface).

- **How it looks:**
  - Computer state pill: Changes from .pill.work to .pill.you with text "You have control"
  - Button: Changes from "Take over" (primary) to "Hand back to [TrunkName]" (primary)

- **What it says:**
  - Pill: "You have control"
  - Button: "Hand back to Scout" (example)

- **States and edge cases:**
  - User has control: Pill shows "You have control", button is "Hand back"
  - Hand back: Trunk resumes from where it paused
  - Timeout: If user doesn't act for a while, Trunk may resume automatically

- **Source:** takeover and handback actions in ACTS

---

#### Watch

- **What it is:** Real-time monitoring of a Trunk's computer activity without taking control.
- **Why it exists:** Allows the user to observe progress and verify the Trunk is working correctly.
- **When it appears:** When the computer pane is open or in full-size stage.
- **How it works:**
  1. Trunk is working (status === 'working').
  2. Screen updates show activity (mock cursor movement, window changes).
  3. Activity description (b.title) shows what the Trunk is doing.
  4. Plans and steps in the side pane show progress.

- **How it looks:**
  - Screen: Updates in real-time, cursor moves, content changes
  - Activity text: Updates to reflect current action
  - No button to interrupt (read-only view)

- **States and edge cases:**
  - Working: Screen shows activity
  - Done: Screen freezes, shows "Done" pill
  - Error: Screen shows error state, "Hit a snag" pill

- **Source:** Computer block rendering, auto-updates from renderPane() and render()

---

### 4.6 Search and find: sidebar search, Ctrl+F find in chat, past sessions

#### Sidebar search

- **What it is:** A search box in the conversation list that filters conversations by name or recent content.
- **Why it exists:** Helps the user quickly find a conversation among many.
- **When it appears:** Always visible in the sidebar (.side-top).
- **How it works:**
  1. User clicks or types in the search box (`.search input`).
  2. Input value is stored (no data attribute; event handler filters in real-time).
  3. Conversations are filtered: only show those matching the query.
  4. Matching is case-insensitive, substring match on name and recent preview text.
  5. Clear button (X icon) resets the search.

- **How it looks:**
  - Container: .search with `flex: 1`, `display: flex`, `gap: 8px`, `height: 34px`, `padding: 0 10px`, `border-radius: 10px`, `background: var(--bg)`, `border: 1px solid var(--line)`, on hover: `border-color: var(--line-2)`
  - Icon: Search icon (magnifying glass) on left
  - Input: No visible borders, `flex: 1`, placeholder: (generic, e.g., "Search conversations")
  - Keyboard hint: Ctrl K or Cmd K (shown on right side as `.kbd`)

- **What it says:**
  - Placeholder: (implicit, e.g., search or find icon)
  - Keyboard shortcut: Displayed as kbd element

- **States and edge cases:**
  - Empty: All conversations shown
  - Typed: Filtered list shows matching conversations
  - No matches: "No conversations found" message or empty list

- **Source:** Sidebar render; filter applied in renderSide()

---

#### Ctrl+F find in chat

- **What it is:** A find-in-page feature that searches the visible conversation for text.
- **Why it exists:** Lets the user locate specific messages or mentions in a long conversation.
- **When it appears:** When user presses Ctrl+F (or Cmd+F on Mac).
- **How it works:**
  1. Pressing Ctrl+F toggles S.find = {q: '', i: 0} (if off, sets to null).
  2. A find bar appears at the top/bottom of the chat (.find-bar or similar).
  3. User types in the search input (id="find9-q").
  4. On input, the chat is searched for matches; all matches are marked with `<mark class="hit9">`.
  5. The current match is highlighted: `.hit9.cur9`.
  6. Previous/Next buttons step through matches (data-act="find-step", data-v="+1" or "-1").
  7. Count shows "X of Y" matches (e.g., "3 of 7").

- **How it looks:**
  - Find bar: Fixed or floating bar with input, prev/next buttons, count, close button
  - Input: Text box for search term (id="find9-q")
  - Navigation buttons: Prev (`<`) and Next (`>`) arrows
  - Count: "X of Y" in monospace font
  - Close button: X icon to hide the find bar
  - Marked text: Highlighted with background color (yellow or highlight color)
  - Current match: Brighter highlight or outline

- **What it says:**
  - Count: "1 of 5" (example)
  - Button labels: Prev/Next arrows (no text, icons only)

- **States and edge cases:**
  - No matches: Count shows "0 of 0"
  - One match: Count shows "1 of 1"
  - Scroll into view: When moving to a match, the chat scrolls to show it (`.hit9[f.i].scrollIntoView()`)

- **Source:** find-open and find-step actions in ACTS; .hit9 and .cur9 CSS classes

---

#### Past sessions / History

- **What it is:** A view showing previous conversations and completed tasks, searchable by date or Trunk name.
- **Why it exists:** Allows the user to review past work and restart a previous task.
- **When it appears:** In the Inbox › History tab.
- **How it works:**
  1. User navigates to Inbox › History (data-v="inbox", tab="history").
  2. A list of past sessions/tasks is shown, each with: Trunk avatar, task name, date/time, duration, cost, "Watch again" and "Compare" buttons.
  3. Optional search box filters by task name or Trunk name.
  4. Clicking a row shows details (in a modal or separate view).
  5. "Watch again" plays back the task step-by-step.

- **How it looks:**
  - Container: .rows in .place (same layout as other list views)
  - Each row: .prow with avatar, grow (name/description), meta (duration and cost), buttons
  - Search input: .inp with placeholder "Search what ran"
  - Avatar: .av avatar of the Trunk
  - Name: Task title, e.g., "Tidy the Downloads folder"
  - Description: "Scout · 1m 12s · $0.00" (Trunk, duration, cost)
  - Buttons: "Watch again" (ghost) and "Compare" (ghost)

- **What it says:**
  - Placeholder: "Search what ran"
  - Button labels: "Watch again", "Compare"
  - Empty state: "Nothing matches."

- **States and edge cases:**
  - No history: Empty message "Nothing matches."
  - Filtered: Shows only matching tasks
  - Sorting: Can be by date (newest first) or custom order

- **Source:** renderInbox() with tab === 'history'; .rows CSS; REPLAY data structure

---

### 4.7 Group chats (rooms), A2A (agents talking to each other and creating agents), teammates and sharing

#### Group chats (rooms)

- **What it is:** A conversation with multiple Trunks, where each can participate and send messages.
- **Why it exists:** Allows coordination between multiple Trunks on a complex task.
- **When it appears:** When user creates a room (Customize › Trunks › "A new room").
- **How it works:**
  1. Room is created with name (e.g., "Supplier quotes") and members (list of Trunk IDs).
  2. In the chat view, the header shows the room name instead of a single Trunk name.
  3. Messages include sender info: `.from` label shows who sent it.
  4. Mentions: `@TrunkName` calls a specific Trunk in the room.
  5. All messages are shared; no private messages within a room.

- **How it looks:**
  - Chat header: Shows room name instead of Trunk name
  - Chat header role: Shows room description (e.g., "Room for coordinating supplies")
  - Messages: Each bot message shows `.from` label with sender name
  - `.roomline`: Visual indicator when new members are added (e.g., "Messages from Scout and Ledger")

- **What it says:**
  - Room name: e.g., "Supplier quotes"
  - Role: e.g., "A room for comparing quotes"
  - Sender labels: Trunk names (e.g., "Scout", "Ledger")
  - Mention: `@Scout` (to call Scout specifically)

- **States and edge cases:**
  - Room creation: Takes room name and member list
  - Room rename: Same as Trunk rename
  - Add/remove members: Changes who can participate
  - No members: Room is idle (no messages)

- **Source:** `c.kind === 'room'` check throughout; message rendering includes `.from` label

---

#### A2A (Agent-to-Agent)

- **What it is:** Agents (Trunks, specialists, or external services) that can talk to each other and create sub-agents.
- **Why it exists:** Enables complex multi-agent workflows where Trunks delegate work to other agents.
- **When it appears:** In advanced setups; Customize › Specialists or via automation rules.
- **How it works:**
  1. A Trunk can call another Trunk or a specialist using `@TrunkName` mention.
  2. The called Trunk gets a notification and can respond.
  3. A Trunk can create a new temporary agent for a specific task (via `ag-add` action).
  4. Temporary agents handle the delegated work and report back.
  5. Team rooms support A2A: multiple agents collaborate in one conversation.

- **Specialist agents:** Pre-built agents that handle specific domains (e.g., "Invoice matcher", "PDF summarizer")
  - Selected from Customize › Specialists
  - Called on-demand by a Trunk
  - Disappear after the task is done

- **How it looks:**
  - Mention: `@SpecialistName` in a message
  - Specialist response: Shows in the conversation, attributed to the specialist
  - Team room: All agents visible in header avatars or status
  - Agent card (.ag-ask or similar): When a specialist is created, shows its icon, name, and capabilities

- **What it says:**
  - Mentions: e.g., `"@Ledger, check the total again"`
  - Specialist names: e.g., "Invoice Matcher", "PDF Summarizer"
  - Agent description: e.g., "Searches for similar invoices and flags duplicates"

- **States and edge cases:**
  - Agent created and dismissed: Appears only for that task
  - Permanent specialist: Stays in the list for future use
  - Nested A2A: An agent can call another agent (complex workflows)

- **Source:** Mentions trigger A2A; `ag-add` action creates agents; team rooms show all agents

---

#### Teammates and sharing

- **What it is:** A multi-person workspace where conversations, agents, and settings are shared.
- **Why it exists:** Enables team-based work on Branch, with shared Trunks and centralized management.
- **When it appears:** When the workspace is connected to keepoak.com (team mode enabled).
- **How it works:**
  1. User creates a team workspace on keepoak.com.
  2. Teammates are invited (email or direct link).
  3. Each teammate logs in with their own account.
  4. Shared Trunks appear in the Trunk list for all teammates.
  5. Conversations can be shared: click Share in the chat menu to give another teammate access.
  6. Settings (like models and automations) can be shared across the team.
  7. Team view (Team nav button) shows all team members and their running tasks.

- **Sharing a conversation:**
  - Menu option: "Share" or "Invite"
  - Dialog: Asks who to share with (team member list)
  - Recipient: Gets access to the conversation (read-only or edit, depending on setting)
  - Revoke: Original owner can remove access anytime

- **Team view:**
  - Shows all team members and their current activity
  - Running tasks are listed with Trunk name, member name, and progress
  - Global inbox: All approvals and notifications are visible to the team

- **How it looks:**
  - Team nav: Team button in sidebar with live count of running tasks (e.g., "Team 3" if 3 tasks running)
  - Team view: Rows of team members with avatars, roles, and activity
  - Shared conversation: Badge or indicator showing it's shared (e.g., "Shared with [name]")

- **What it says:**
  - Team button label: `"Team"` (with optional count)
  - Member names and roles: e.g., "Alice · Admin", "Bob · Member"
  - Activity: e.g., "Scout is researching flights" (visible to all)

- **States and edge cases:**
  - Team owner: Can invite, manage members, set shared settings
  - Team member: Can see shared Trunks and conversations
  - Not in team: Regular single-user mode
  - Shared conversation revoked: Member loses access

- **Source:** Team view rendering; share actions in ACTS; team data from keepoak.com

---

### 4.8 Agents as characters: AG_STATES (10 states and their labels), agentState(c) logic, LOOKS (11 characters: Branch + 10), default looks per Trunk, floating agent window, minimize/hide, living header avatar on narrow windows and phones, pausing figures across redraws, look picker in Trunk editor, Shuffle, classic pebble

#### Agent states (AG_STATES)

Ten visible states that reflect what a Trunk is doing:

```
const AG_STATES = [
  ['idle', 'Here'],
  ['think', 'Thinking it over'],
  ['work', 'Working on it'],
  ['search', 'Searching'],
  ['read', 'Reading'],
  ['talk', 'Explaining'],
  ['wait', 'Needs you'],
  ['yay', 'Done'],
  ['oops', 'Hit a snag'],
  ['sleep', 'Resting']
];
```

Each state has:
- **ID** (first value): Used in CSS and state tracking (e.g., `data-st="work"`)
- **Label** (second value): Human-readable text shown in the UI (e.g., `"Working on it"`)

States are assigned by `agentState(c)` based on the Trunk's current activity.

---

#### agentState(c) logic

The function `agentState(c)` determines a Trunk's visible state based on its status and activity:

1. **yay** (7s timeout): If a task just finished (`S.doneAt[c.id]` within last 7 seconds), show celebration
2. **oops** (error): If `c.status === 'error'` or `c.failed`, show error state
3. **wait**: If `c.status === 'waiting'`, Trunk is waiting for user
4. **sleep**: If `c.paused`, Trunk is resting
5. **talk** (4.5s timeout): If `S.call === c.id` (in voice call) or just sent a message (`S.saidAt[c.id]` within 4.5 seconds)
6. **think**: If last block is `typing` (k === 'typing'), Trunk is composing
7. **work** (with subcases): If `c.status === 'working'`:
   - **search**: If activity mentions "search", "browse", "web", "outlook", "sign in"
   - **read**: If activity mentions "read", "pdf", "document", "contract"
   - **think**: If activity mentions "plan", "think", "decide"
   - **work** (default): Generic work state
8. **talk**: If last message is fresh and from the Trunk
9. **sleep** (2 min timeout): If no input for >120 seconds
10. **idle** (default): Fallback state

---

#### LOOKS (11 characters)

Eleven available character designs for Trunks:

```
const LOOKS = [
  {id: 'branch', name: 'Branch', description: '...', still: ART('wave'), states: BRANCH_ANIM},
  ...DATA12.agents  // 10 more agents, e.g., Scout, Ledger, Ada, etc.
];
```

Each look has:
- **id**: Unique identifier (e.g., `'branch'`, `'scout'`, `'ledger'`)
- **name**: Display name (e.g., `"Branch"`, `"Scout"`)
- **description**: Tooltip text
- **still**: Image to show when motion is off (static portrait)
- **states**: Object mapping state IDs to video files:
  ```
  {
    idle: 'assets/anim-idle.webm',
    work: 'assets/anim-work.webm',
    yay: 'assets/anim-yay.webm',
    sleep: 'assets/anim-sleep.webm',
    ...
  }
  ```

Default looks per Trunk (set in `S.look`):
- Scout: `'ember'` (orange character)
- Ledger: `'tock'` (blue character)
- Ada: `'kite'` (green character)
- Fieldnotes: `'morel'` (brown character)
- Quill: `'lumen'` (yellow character)
- Branch: `'branch'` (the leafy spirit)

---

#### Character rendering: figure12()

The function `figure12(look, st, cls)` renders a character figure:

1. Gets the video URL from `look.states[st]` (state-specific animation file)
2. If motion is reduced (`calm11()` or `S.still`), renders a static image instead:
   ```html
   <img class="fig12" src="${look.still}" alt="" draggable="false">
   ```
3. If motion is allowed, renders a video:
   ```html
   <video class="fig12" src="${src}" poster="${look.still}" muted loop autoplay playsinline data-st="${st}"></video>
   ```
4. The `data-st` attribute tracks the current state, used by CSS for styling (e.g., color, opacity)

---

#### Floating agent window (agentWin12)

The agent window displays one or more living figures beside the conversation:

- **What it is:** A floating sidebar showing Trunks' characters acting out their states.
- **Where it lives:** Right side of the chat (`.agent12` div).
- **How it works:**
  1. When `S.view === 'chat'`, `S.surface === 'desktop'`, and `S.agentUI.show === true`, the window is rendered.
  2. For each Trunk in the conversation (or room members), a `.ag-one12` div is created.
  3. Each shows the figure, name, and state label.
  4. Figures update every 1 second via `refreshAgents12()`.

- **How it looks:**
  - Container (`.agent12`): Position: absolute or fixed, right side, variable size
  - Size classes: `.size-s`, `.size-m`, `.size-l` (small, medium, large)
  - Minimized: `.min12` (shows only icons, not names)
  - Row (`.ag-row12`): `display: flex`, `gap: 10px`, contains one or more agents
  - Agent (`.ag-one12`): Figure (`.fig12`), label (`.ag-lab12` with name and state)
  - Label (`.ag-lab12`): Shows `<b>name</b>` and `<small>` with state dot and label
  - State dot (`.ag-dot12`): Small colored circle, class `st-${state}` (e.g., `st-work`, `st-yay`)
  - Controls (`.ag-ctl12`): Minimize button (`ag-min`, toggles `.min12`) and hide button (`ag-hide`)

- **What it says:**
  - Name: e.g., `"Scout"`, `"Ledger"`
  - State label: e.g., `"Working on it"`, `"Done"`, `"Waiting for you"`
  - Button labels: Minimize (`+` or `−`), Hide (`×`)

- **States and edge cases:**
  - One Trunk: Shows one figure and label
  - Multiple Trunks (room): Shows all, in a row
  - Minimized: Only icon visible, label hidden (`.min12`)
  - Hidden: Window is removed from the page (`.agent12` is `display: none`)
  - Off-screen: Figures pause to save CPU

---

#### Minimize and hide

- **Minimize** (`ag-min` action):
  - Toggles `S.agentUI.min` (boolean)
  - When true, `.agent12` gets `.min12` class
  - Label is hidden, only icon/figure is shown
  - Can be undone by clicking again

- **Hide** (`ag-hide` action):
  - Sets `S.agentUI.show = false`
  - Window is removed from the page
  - Toast message: `"Hidden. Bring it back in Appearance › Agents."`
  - Can be re-enabled in Settings › Appearance › Agents

---

#### Living header avatar on narrow windows

- **What it is:** On narrow screens (phones), the Trunk's animated character replaces the static avatar in the chat header.
- **When it appears:** When the viewport is narrow (`width < 768px` or similar) and the Trunk has a look assigned.
- **How it works:**
  1. Instead of a static avatar (`.av` circle with initials or photo), the header shows a small animated figure.
  2. The figure uses the same `figure12()` rendering as the agent window.
  3. Figure updates with state changes (via `refreshAgents12()`).
  4. Size is small: 32px or less.

- **How it looks:**
  - Avatar area in header: Shows a video or image instead of the usual pebble
  - Animation: Same as agent window (idle, work, yay, etc.)
  - Size: 32px square, fits in the header

- **States and edge cases:**
  - Wide screen: Static avatar is shown instead
  - No look assigned: Static avatar is shown (fallback to `.av`)
  - Reduced motion: Still image is shown

- **Source:** `av()` function is overridden to check for `lookOf(c)` and render a figure if present

---

#### Figures persist across redraws

- **What it is:** When the page is re-rendered (after an update), animated figures keep playing without restarting.
- **Why it exists:** Prevents jarring interruptions in animations; figures feel alive and continuous.
- **How it works:**
  1. Before re-rendering, the code finds all `.fig12` elements and saves them in a `keep` Map.
  2. Key: `figSpot13()` = `${id}|${state}|${location}` (identifies the figure uniquely)
  3. After rendering new HTML, the code looks for new `.fig12` elements.
  4. If a new figure matches a saved one (same key, same tag type), the old one is reused.
  5. This prevents videos from being re-inserted and restarting their playback.

- **How it looks:** Seamless animation; figures don't flicker or restart

- **States and edge cases:**
  - State change: Video changes to the new state's file (this restarts playback, which is expected)
  - Figure moved: Identified by location (window, phone, chat header), kept separate
  - Off-screen: Paused to save CPU (IntersectionObserver); resumed when scrolled into view

- **Source:** `_render13()` override in pass 13; `figSpot13()` key function; `keep` Map

---

#### Look picker in Trunk editor

- **What it is:** A UI for choosing a character design for a Trunk.
- **When it appears:** In the Trunk editor dialog, under the "Look" tab.
- **How it works:**
  1. User opens a Trunk's settings (data-act="edit", data-id="[trunk_id]").
  2. Clicks the "Look" tab in the editor.
  3. A gallery of characters is shown: `.looks12` with buttons for each design.
  4. Each button has `data-act="look-set"`, `data-id="[trunk_id]"`, `data-v="[look_id]"`.
  5. User clicks a character.
  6. `S.look[trunk_id]` is set to the look ID.
  7. Tooltip: "It moves by itself: thinking, searching, reading, working, waiting for you, celebrating, resting. You never pick an animation; it follows what the Trunk is doing."

- **How it looks:**
  - Section (`.sec` with note `"look12"`):
    - Heading: `"How it looks"`
    - Lede text: Explains that animations are automatic
    - Gallery (`.looks12`): Grid or flex row of buttons
    - Each button (`.look-c12`): Shows character portrait (`.still` image), name below
  - Classic pebble: Shown as a separate option (no image, just the pebble avatar)
  - Hover: On hover, the character's idle animation plays (via `data-hov` attribute)

- **What it says:**
  - Heading: `"How it looks"`
  - Lede: `"It moves by itself: thinking, searching, reading, working, waiting for you, celebrating, resting. You never pick an animation; it follows what the Trunk is doing."`
  - Character names: e.g., `"Scout"`, `"Ledger"`, `"Branch"`, `"Classic pebble"`

- **States and edge cases:**
  - Selected: Button has `aria-pressed="true"`, highlighted
  - Hover animation: If the look has an idle video (`.data-hov`), it plays on mouse-over
  - No look set: Falls back to classic pebble (default)

- **Source:** `lookPicker12(id)` function; `.look-c12` buttons; look-set action

---

#### Shuffle

- **What it is:** A button or menu option to randomly assign looks to all Trunks.
- **When it appears:** In settings or the look picker (implied; not shown in the code snippet, but mentioned as a feature).
- **How it works:**
  1. User clicks "Shuffle" (in Appearance or Look settings).
  2. For each Trunk, a random look is chosen from the available LOOKS array.
  3. `S.look` is updated with new assignments.
  4. Characters in the UI immediately change to their new looks.

- **How it looks:** Settings button, labeled "Shuffle"

- **What it says:** `"Shuffle"` (button label)

- **States and edge cases:**
  - All random: Every Trunk gets a new random look
  - No duplicates: Same look can be assigned to multiple Trunks (no restriction)
  - Can undo: User can manually reassign looks after shuffling

---

#### Classic pebble

- **What it is:** The default, static avatar option for a Trunk (traditional multi-color circle).
- **When it appears:** Always available as a fallback; shown in the look picker as an option.
- **How it works:**
  1. If `S.look[trunk_id] === 'classic'` or is not set, the Trunk uses the classic pebble.
  2. Rendered as a `.av` circle with initials or color gradient (no animation).
  3. No state changes; the pebble is always the same.

- **How it looks:**
  - Avatar circle: `.av` class, gradient or solid color, initials or icon in the center
  - No animation: Static image
  - Styling: `--c` variable for color, `--r` for border-radius (default 50% for circle)

- **What it says:** `"Classic pebble"` (in the look picker)

- **States and edge cases:**
  - Default: If no look is assigned, classic pebble is shown
  - No animation: Never moves, always idle appearance
  - Always visible: Works on all devices and browsers (no video support required)

- **Source:** In `lookOf()`, if result is `'classic'`, returns null (no look), fallback to `.av` avatar

---

### 4.9 Notifications, done cheer card, Scout demo job (scheduleScout), notifications over time

#### Notifications

- **What it is:** Alerts that appear when a Trunk needs attention or a task completes.
- **Why it exists:** Keeps the user informed of important events without constant checking.
- **When it appears:** Based on settings (Settings › Notifications › "Tell me when...") and the user's calendar.
- **How it works:**
  1. A Trunk finishes a task or reaches a milestone.
  2. If notification is enabled for that event, a toast or alert is shown.
  3. On desktop: Native OS notification (if permission granted).
  4. In app: Toast message at the bottom or a modal alert.
  5. Sound: Optional chime (Settings › Notifications › "Play a sound").
  6. Quiet hours: If `quietHours.start` to `quietHours.end` (e.g., 10 PM–7 AM), no interruptions (Inbox still shows approvals).

- **Notification types:**
  - `'need'` (n-need): A Trunk needs a yes/approval (shown on desktop + phone)
  - `'done'` (n-done): A long task finishes (only tasks >2 min)
  - `'sound'` (n-sound): Play a chime (disabled by default)

- **How it looks:**
  - Toast: `.toast` div at the bottom center, `font-size: 13px`, `color: var(--ink)`, auto-dismiss after 3–4 seconds
  - Alert: Modal-style popup with title and message
  - Sound: Silent by default; if enabled, plays a short chime (no UI change)

- **What it says:**
  - Examples:
    - `"Scout needs you · Approve the email"` (Needs you)
    - `"Tidy the Downloads folder · done"` (Task done)
    - No text for sound notifications

- **States and edge cases:**
  - Quiet hours on: Toast shown, no sound, approval still waits in Inbox
  - Day off: If `quietDays` includes today (e.g., "Sun"), no notifications
  - Muted: If `n-sound` is off, no chime
  - Multiple notifications: Each is shown sequentially or as a list

- **Source:** PAGES.notifications settings; toast() function; quiet hours check in `(S.gw.asked ? ... : recBar('gw'))`

---

#### Done cheer card

- **What it is:** A celebratory message and visual when a task completes successfully.
- **Why it exists:** Reinforces success and gives the user a moment of satisfaction.
- **When it appears:** When a Trunk finishes a major task and `c.status` changes from `'working'` to `'idle'`.
- **How it works:**
  1. A `'done'` block is added to the conversation with a celebratory message.
  2. Block type: `k: 'done'`, containing the final summary (e.g., `"171 files archived"`)
  3. Rendered with the Branch face mark (`ACORN_INK`, a legacy name) and green styling.
  4. Agent window shows the `'yay'` state for 7 seconds (celebration pose).
  5. Optional sound effect (if enabled).

- **How it looks:**
  - Block: `.done-line` with green styling
  - Icon: the Branch face mark (small)
  - Text: Final summary message, e.g., `"171 files archived · checkpoint kept"`
  - Animation: Agent celebrates in the floating window (yay state)

- **What it says:**
  - Message: e.g., `"Done! 171 files archived"` or `"Finished! 2 bookings made, refundable until Oct 3"`

- **States and edge cases:**
  - Task failed: `'oops'` state shown instead, with error message
  - Long task: More detailed summary
  - Short task: Brief message, e.g., `"Done"`

- **Source:** `.done-line` rendering in `block()`; `'done'` message added via `botSay()` on task completion

---

#### Scout demo job (scheduleScout)

- **What it is:** A special demo task that shows the Scout Trunk's capabilities in action.
- **When it appears:** On first launch or in a demo mode.
- **How it works:**
  1. A pre-built task is enqueued for Scout: `"Find the Hartwell invoice from August in Outlook and check the total against the statement."`
  2. The task runs through a series of preset steps (mock steps, since this is a prototype):
     - "Signing in to Outlook"
     - "Finding emails from Hartwell"
     - "Reading the invoice PDF"
     - "Comparing totals"
     - "Done"
  3. Each step is shown in the conversation with timing and details.
  4. The agent window shows Scout moving through states (search, read, think, done).
  5. After completion, the task is marked done, and notifications show.

- **How it looks:**
  - Computer block: Shows the mock "signing in" screen
  - Steps block: Shows the progress as `<details>` with summary
  - Timeline (activity pane): Shows "Step 1 of 6: Signing in to Outlook", etc.
  - Agent: Scout's character goes through work, read, think states, ends in yay

- **What it says:**
  - Task description: `"Finding the Hartwell invoice from August in Outlook..."`
  - Steps: `["Signing in to Outlook", "Waiting for the page"]`, `["Reading the invoice PDF", "checking totals"]`, etc.
  - Final message: `"Done in 1m 12s"` (example timing)

- **States and edge cases:**
  - Demo mode: Task is pre-written, not real work
  - Replay: User can watch again via Inbox › History › "Watch again"
  - Timeline shown: Activity pane shows each step with checkmark (done) or spinner (in progress)

- **Source:** `scheduleScout()` function; REPLAY data structure (array of steps); computer and steps blocks in threads.scout

---

### 4.10 Pins, side by side, media, material and background work

#### Pinning a message

- **What it is:** A way to keep a message visible at the top of a conversation whilst the assistant runs, so important instructions or data stay in front.
- **Why it exists:** In long conversations, earlier context scrolls away. Pinning keeps it visible.
- **When it appears:** Hover over any message in a conversation (any `block` with `data-i15` attribute); a pin icon appears in the message actions.
- **How it works:**
  1. Every block in the thread knows its position via `data-i15="${i}"` set when rendering.
  2. Clicking `data-act="pin15"` on a message toggles it between pinned and unpinned.
  3. Pinned messages are stored in `S.pins15[chat_id]` (an array of block indices).
  4. The pinned strip appears above the conversation if `pins.length > 0`.
  5. Clicking the pinned message jumps to it in the thread with a 1.4 s fade highlight (`flash15` class).
  6. Each message shows its send time in a label (`.ts15`, `aria-label="Sent at HH:MM"`), visible on hover.
  
- **How it looks:**
  - **Pin button (in message hover actions):** `data-act="pin15"`, icon `ic('pin')`, `aria-label="Pin this message"` or `"Unpin"`, `aria-pressed="true/false"`.
  - **Pinned message timestamp (on hover):** `<span class="ts15">HH:MM</span>`, `11.5px` font, muted colour, alongside pin button.
  - **Pinned strip (above conversation, if any pinned):** `.pins15` region role, contains:
    - Pin icon (small): `ic('pin', 's')`
    - Main button (`.pin-t15`): shows "Pinned" label + first 90 characters of the pinned message's plain text
    - Count badge (`.pin-n15`): shows number of pinned messages (e.g., "3") if more than one pinned
    - Clicking either opens the pinned popover or jumps to that message
  - **Pinned popover (`.POPS.pins15()`):** List of pinned messages:
    - Each row (`.pinrow15`): message text (`.mi-t`, first 70 chars), send time (`.mi-s`, HH:MM format), unpin button (X icon)
    - Clicking a row jumps to that message; clicking X unpins it

- **What it says:**
  - Hover label: `"Pin this message"` or `"Unpin"`
  - Toast on pin: `"Pinned. It stays in front of the assistant however long this runs."`
  - Toast on unpin: `"Unpinned."`
  - Pinned strip button: `"Pinned [text]"` + count if multiple
  - Popover header: `"Pinned in this conversation"`

- **States and edge cases:**
  - A message can be pinned and unpinned at any time during a conversation.
  - Pinned messages scroll with the conversation; their strip stays visible above the thread.
  - If the pinned message is deleted or the conversation clears, the pin reference is cleaned up via `pinsOf15()` filter.
  - Multiple pinned messages are shown in a popover (accessed via count badge).

- **Source:** `patch15b.js` lines 19–41; `.pins15` CSS in `patch15b.css`.

---

#### Side by side (open another conversation beside)

- **What it is:** Two conversations open at once, side-by-side, so the user can reference one while working with the other.
- **Why it exists:** Comparing two automations, reading instructions in one chat whilst acting in another, or monitoring parallel work.
- **When it appears:** User selects "Open another conversation beside" from the conversation menu (`.chatmenu` popover).
- **How it works:**
  1. Clicking the menu action (`.icon-btn` with `data-act="chatmenu"`) opens the chat menu popover.
  2. The popover includes a "Open another conversation beside" menu item with icon `cols15`.
  3. Clicking that item opens another popover (`POPS.beside15()`) listing up to 8 other conversations.
  4. Selecting a conversation sets `S.beside15 = conversation_id`.
  5. `afterChat15()` wraps the main conversation scroll in a `.split15` div and appends an `.beside15` aside.
  6. The `.split15` layout uses CSS grid or flex to show both conversations.
  7. If the window is narrower than 1000px, a toast warns "Side by side needs a wider window."

- **How it looks:**
  - **Chat menu item:** "Open another conversation beside" with icon `ic('cols15')` and optional count showing current beside conversation.
  - **Beside popover:** Header "Open beside this one", list of 8 most recent conversations (each showing avatar, name, preview text).
  - **Side-by-side layout:** `.split15` container with main conversation (`.scroll` in `.thread`) on left, `.beside15` aside on right:
    - `.beside15` header (`.bs-h15`): avatar (26px), name, role, "Open" button (opens in main view), close button (X).
    - `.beside15` body (`.bs-body15`): scrollable thread with all messages from that conversation, rendered via `_block15()`.
  - **CSS:** `.split15 { display: grid; grid-template-columns: 1fr 1fr; }` (or similar); `.beside15 { border-left: 1px solid var(--line); padding-left: 14px; }`.

- **What it says:**
  - Menu item: `"Open another conversation beside"`
  - Popover header: `"Open beside this one"`
  - Close label: `"Close the conversation beside"`
  - Toast (if narrow): `"Side by side needs a wider window. It opens when there is room."`
  - Close button: `aria-label="Close the conversation beside"`

- **States and edge cases:**
  - Only one conversation can be open beside the main one at a time. Selecting a different conversation replaces the beside one.
  - The beside conversation is read-only (no composer in the aside). To chat with it, click "Open" to switch to it in the main view.
  - If the window is resized below 1000px, the beside conversation automatically hides and a toast shows.
  - Closing the app or navigating away clears `S.beside15`.

- **Source:** `patch15b.js` lines 43–62; `.split15` and `.beside15` CSS in `patch15b.css`.

---

#### Audio and video playback in the conversation

- **What it is:** Media files (audio recordings and video clips) play directly inside the conversation with playback controls, a waveform for audio, and a poster image for video.
- **Why it exists:** Voice memos, video tours, and recordings from agents or the user should be accessible without leaving the chat.
- **When it appears:** When a message includes a `{k: 'media', kind: 'audio'|'video', ...}` block.
- **How it works:**
  1. Media blocks are added to threads via `mediaRow15(b, c, first)`, which renders them as `.b` (bot message) or `.u` (user message).
  2. Each media item shows:
     - Play/pause button (`.m-play15`): `data-act="mplay15" data-id="${block_id}"`
     - Progress bar or waveform (`.m-wave15` for audio, `.m-track15` for video): `data-act="mseek15"` for clicking/dragging to seek
     - Time display (`.m-time15`): `"HH:MM / HH:MM"` (current / duration)
     - Filename and metadata
  3. Audio waveform is generated from the block name via `wave15(seed)` function: returns an array of 38 bar heights (0–100%).
  4. Playing is toggled via `S.media15[block_id] = {t: 0, on: false}` (time in seconds, playing status).
  5. A `mediaT15` interval runs `tickMedia15()` every 250 ms, advancing `.t` by 0.25 s if `on: true`, and re-rendering the media block.
  6. Seeking via arrow keys (left/right) adjusts `.t` by ±5 seconds; clicking the bar sets `.t` proportionally.

- **How it looks:**
  - **Audio media (`.media15.audio`):**
    - Play/pause button (left): icon `ic('play15')` or `ic('pause15')`, square button style (`.m-play15`)
    - Waveform (center): `.m-wave15` SVG with 38 bars, each bar `<i>` with height in %, filled bars have class `on`
    - Time (right): `.m-time15` showing `"0:00 / 1:34"` etc. (monospace font)
    - Below: filename (`.m-name15`) with chip icon and filename text
  - **Video media (`.media15.video`):**
    - Poster image (`.m-poster15`): large tappable image with tint gradient (`--g` CSS var), play icon, optional caption
    - Below poster: play button, progress bar, time, filename
  - **Progress bar (`.m-track15`):** thin bar with `<u>` fill (width proportional to progress)
  - **Keyboard seeking:** arrow keys work when focus is on the bar element; left/right ±5 s.

- **What it says:**
  - Play button aria-label: `"Play [filename]"` or `"Pause [filename]"`
  - Progress slider aria-label: `"Position"`
  - Filename label: e.g., `"Walk-through notes.m4a · from [Trunk name]"` (if from an agent) or just filename (if from user)
  - Duration format: `"MM:SS"` (e.g., `"1:34"`, `"0:42"`)

- **States and edge cases:**
  - Only one media file can play at a time (if another starts, the previous one stops).
  - Seeking beyond the duration clamps to the end and stops playback.
  - If the media block is removed from the thread, playback stops and the state is cleaned up.
  - On phone and terminal surfaces, media is shown as a single-line indicator (`.pmedia15`) with icon, filename, and duration.

- **Source:** `patch15b.js` lines 64–106; `.media15` and related CSS in `patch15b.css`.

---

#### Material (@mentions of files, changes, links — read as material, not instructions)

- **What it is:** A way to reference files, diffs, URLs, and other resources in a message without the assistant treating them as commands or instructions. Material is shown as chips in a dock below the composer.
- **Why it exists:** Users need to reference documents, code changes and links without accidentally triggering actions. Material is explicitly marked "read as material, not instructions".
- **When it appears:** User types `@` in the composer followed by a filename, path, URL or keyword like `diff`. As they type, a mention menu offers suggestions.
- **How it works:**
  1. Typing `@` opens the mention menu (`POPS.mention()`) showing:
     - Section "On other computers": other Trunks' machines (e.g., "Scout-legion", "Ledger-taofik-ai")
     - Section "Material": files (e.g., `Downloads/INV-0826.pdf`, `Documents/Lease-2026.pdf`), `diff` (code changes), and URLs
  2. Clicking a material item adds `@<identifier>` to the message.
  3. The composer's `dockrow15` automatically shows:
     - Chips for each material reference (`.mat15`): icon + filename/identifier + close button (X)
     - A label below: `"read as material, not instructions"` (small, muted)
  4. `matOf15()` parses the message for `@\S+` patterns and filters for valid material (contains `/`, `.`, or is `diff`).
  5. When the message is sent, material references are passed to the assistant but explicitly marked as context, not commands.

- **How it looks:**
  - **Mention menu item (for material):** Icon (doc/globe/branch for files/links/diffs) + text (filename or "A link") + description + section header
  - **Material chips (in dock):** `.mat15` span with:
    - Icon (`ic('doc', 's')` or appropriate icon)
    - Filename or identifier text
    - Close button (`.icon-btn` with X, `data-act="matrm15"`)
  - **Dock row (`.dockrow15`):** flex row below composer, contains material chips and label `"read as material, not instructions"` (small, dimmed)
  - **CSS:** chips are horizontal, each with inline padding, border-radius; label is `11.5px`, `color: var(--ink-3)`.

- **What it says:**
  - Mention menu header: `"On other computers"`, `"Material"`
  - Menu item: `"Downloads/INV-0826.pdf"`, `"Changes (diff)"`, `"A link"` (for URLs), etc.
  - Dock label: `"read as material, not instructions"`
  - Description in menu: e.g., `"Invoice · 142 KB"`, `"Lease · 42 pages"`, `"The changes in this project"`, `"A web page: type or paste the link"`

- **States and edge cases:**
  - Material can be removed by clicking the X on a chip; this removes the `@identifier` from the message.
  - Valid material identifiers must contain `/`, `.`, or be exactly `diff`, or start with `https://`.
  - If no material is referenced, the dock row does not appear.
  - Multiple material references can be added to a single message.
  - The dock is hidden by the message box on windows under 1000px width; material still works but is less visible.

- **Source:** `patch15b.js` lines 108–122; `.dockrow15`, `.mat15` and dock styling in `patch15b.css`.

---

#### Background work (run in the background, up to 3 at once)

- **What it is:** Long-running tasks that can start in their own conversation while the user keeps working in the current one. Up to 3 can run at once.
- **Why it exists:** Users need to run parallel automations or research tasks without interrupting their current chat.
- **When it appears:** User types `/bg` and a task description, or clicks "Run it in the background" from the plus menu.
- **How it works:**
  1. Typing `/bg <description>` or clicking the plus menu item `data-act="bgrun15"` initiates a background task.
  2. `startBg15()` creates an entry in `S.bg15` array: `{id, name, trunk, state, step}`.
  3. State progresses: `'working'` → `'done'` → `'gone'` (removed from list).
  4. A chip appears in the dock (`.bgchip15`): shows either a spinner (if working) or checkmark (if done), with text "N in the background" or "N finished".
  5. Clicking the chip opens a popover listing all background tasks and their current step.
  6. User can click "Open" to switch to a background task's conversation, or "Stop" to cancel a working one.
  7. Background tasks auto-finish after 9 seconds (in prototype; real tasks would run until complete).

- **How it looks:**
  - **Plus menu item:** `"Run it in the background"` with icon `ic('bg15')` and hint `"/bg"`
  - **Background chip (in dock, `.bgchip15`):**
    - Icon: `ic('check', 's')` (done) or `<i class="bgdot15"></i>` (working, animated spinner)
    - Text: `"N in the background"` (working count) or `"N finished in the background"` (done count)
    - Clickable: `data-act="bglist15"`
  - **Background popover (`POPS.bglist15()`):**
    - Header: `"Running in the background"`
    - Each row (`.bgrow15`): avatar (22px), name, status line (step or "Finished · ready to read"), action button
    - Working task: button `"Stop"` (`data-act="bgstop15"`)
    - Done task: button `"Open"` (`data-act="bgopen15"`)
    - Hint (below list): `"Start one with /bg or + › Run in the background. Up to three at once."`

- **What it says:**
  - Slash command: `/bg <task description>`
  - Plus menu: `"Run it in the background"`
  - Dock chip: `"N in the background"` or `"N finished in the background"`
  - Popover: task name, `"Running: [step]"` (e.g., "Reading the second provider's page"), or `"Finished · ready to read"`
  - Toast on start: `"Running in the background. Keep talking here."`
  - Toast on stop: `"Stopped. Nothing it started was left half done."`

- **States and edge cases:**
  - Maximum 3 background tasks running at once. Starting a 4th shows a toast `"Three are already running in the background. Stop one first."` and blocks the action.
  - Stopping a task sets its state to `'gone'` and removes it from the list after the popover closes.
  - Opening a background task closes the popover and switches to that task's conversation.
  - If the user quits Branch while tasks are running, they resume on next open (not shown in prototype, but real app would handle this).

- **Source:** `patch15b.js` lines 123–141; `/bg` slash command, `.bgchip15`, `.bgrow15` styling in `patch15b.css`.

---

#### The waiting line (messages sent while a Trunk works)

- **What it is:** When a Trunk is busy, what you send next waits its turn. A chip over the message box, **"N waiting"** (clock icon), shows how many.
- **Why it exists:** The real app lets you reword, reorder or remove queued messages and tasks before they are sent. Without it, a second thought means stopping the task.
- **When it appears:** Only in a conversation that has queued messages (the example: Scout, while it signs in to Outlook, has two: "Also check the July invoice while you’re in Outlook" and "Then tell Ledger what you found"). It sits first in the row over the message box, before the background chip and material chips.
- **How it works:** `data-act="queue15"` opens a popover headed **"Waiting line · sent after this step"**. Each row: its number, an editable text field, an up arrow (`qup15`, disabled on the first) and × (`qrm15`). Editing a field and leaving it saves the new words and toasts "Reworded. It goes as you wrote it now." Moving or removing redraws and reopens the list. When the list is empty the chip disappears.
- **Source:** `patch15h.js` (`S.queue15`, `queueChip15`, `POPS.queue15`).

#### Room left: round by round

- **What it is:** The status bar's "Room left" popover gains a small chart under "Tidy up this conversation": **"Round by round"** with "71% reused from the cache" on the right, eight bars for the last eight rounds, and a key ("new" in ink, "from the cache" in green).
- **Why it exists:** The real app shows a token chart per round and cache metrics. One glance tells you whether a long task is getting expensive.
- **How it looks:** Bars are 48 px tall at most, 4 px apart, ink with a green lower part for the share that came from the cache. Each bar's tooltip: "Round N: 31K words".
- **Source:** `patch15h.js` (wraps `POPS.roommenu`).

### Summary

| Kind | Use | Appearance | Interactive |
|------|-----|------------|-------------|
| `u` | User message | Right-aligned bubble, fill color | Copy, retry (hover actions) |
| `b` | Bot response | Left-aligned, avatar on first | Copy, try again (hover actions) |
| `stamp` | Timestamp divider | Centered, dimmed | No |
| `roomline` | Room members indicator | Centered, avatars | No |
| `plan` | Task checklist | Card with ul, todo/now/done states | Click to mark done (in future) |
| `steps` | Completed steps | Collapsible details with ol | Click to expand/collapse |
| `computer` | Computer usage | Card with screen preview, buttons | Take over, hand back, watch |
| `ask` | Approval request | Lifted card (accent border), pending or decided | Send it, Always allow, Don't send |
| `choice` | Multiple choice | Card with lettered buttons A–E, or text input | Click option or type custom |
| `check` | Verification list | Card with check icons and lines | No |
| `file` | Artifact/file | Button-style with icon and filename | Click to open in Library |
| `ckpt` | Checkpoint saved | Card with shield icon, put-back button | Put back (if available) |
| `done` | Task completion | Celebration message with the Branch face mark | No |
| `mem` | Memory suggestion | Card with "Remember this?" and buttons | Remember, Don't (or decided state) |
| `suggest` | Automation suggestion | Card with "Make it a routine?" and buttons | Every Friday at 5 PM, Not now (or decided) |
| `ask2` | Multiple approvals | Card with two rows, yes/no buttons per row | Yes to both (if multiple pending) |
| `art` | Chart/visualization | Card with SVG chart, buttons | Open larger, Copy code, Save |
| `img` | Generated image | Card with main image and thumbnail grid | Save, Use as background, Make it again |
| `think` | Reasoning block | Text with spark icon, only shown when working | No |
| `saved` | Checkpoint saved notification | Card with shield icon, text | No |
| `typing` | Typing indicator | Three animated dots | No |

---

Source references: `block()` function; message rendering in `renderChat()`; character animation in `figure12()`, `agentWin12()`, `refreshAgents12()`; agent state in `agentState(c)`.

---

## 5. Places, Customize and Settings

Branch organizes work into **Places** (top-level sections), each with optional tabs. The **Customize** place lets you set up Trunks, Tools, Specialists, Channels, and Everywhere settings. The **Settings** place holds configuration organized in four groups with 19 total pages. All 20 popovers are context menus opened by actions.

### 5.1 Places

Each Place is a distinct section of the app, navigable via the main sidebar or via the `view` action.

#### Overview

- **What it is:** A dashboard showing live status and recent activity across all Trunks.
- **When it appears:** By default when Branch opens; always available in the sidebar.
- **Where it lives:** Main app body after sidebar, full-width when selected. Reachable via `data-act="view" data-v="overview"`.
- **How it works:**
  1. Displays the current **Trunk** running (Scout in the example), its state (Signing in…), and mode (Ask first).
  2. Shows **Health** section: Computer state (Online), Model loaded, Telegram connectivity, last backup time, and available updates.
  3. Displays **Spend this week** with a running total by Trunk (Ada $1.10, Scout $0.42, etc.).
  4. Lists **Recent activity** (4 most recent tasks with durations). "All history" button navigates to `data-act="ptab" data-place="inbox" data-v="history"`.
  5. Shows **Controls**: current mode (clickable to change via `data-act="setgo" data-v="permissions"`), buttons to "Lockdown" and "Pause all Trunks" (both toggle controls via `data-act="lock"` and `data-act="pauseall"`).
  6. Lists **Who is using Branch**: people and their status ("Here now", "On their phone · 2 h ago"). "Invite someone" button triggers `data-act="invite"`.
  7. Shows **Milestones** (achievements): badges with titles and lock states; a count at the bottom.
- **Controls on page:**
  - Button: "Settings" `{act=view v=settings}` — opens Settings
  - Button: "Answer 2 waiting" `{act=view v=inbox}` — navigates to Inbox with count
  - Button: "All history" `{act=ptab place=inbox v=history}` — shows all past tasks
  - Button: "change" `{act=setgo v=permissions}` — opens permissions to change mode
  - Button: "Lockdown" `{act=lock}` — toggles Lockdown on/off
  - Button: "Pause all Trunks" `{act=pauseall}` — pauses or resumes all Trunks
  - Button: "Invite someone" `{act=invite}` — invites new person to Branch
- **States and edge cases:**
  - Empty state: when no Trunks exist, Overview shows a placeholder.
  - Multiple users: each user's status and time-since-last-seen.
  - Locked state: "Lockdown" button shows "Turn Lockdown off" when active.
  - Paused state: "Pause all Trunks" shows "Resume all Trunks" when all are paused.

#### Inbox

- **What it is:** A task inbox with three tabs: "Needs you", "Finished", and "All history".
- **When it appears:** Sidebar navigation; always available.
- **How it works:**
  1. Click a tab: `data-act="ptab" data-place="inbox" data-v="needs"` (or "finished", "history").
  2. **Needs you** tab shows tasks waiting for user approval (count shown in badge, e.g., "Needs you2").
  3. **Finished** tab shows completed tasks with results.
  4. **All history** tab shows all past activity with timestamps and costs.
  5. Default tab is "needs" (set by `S.tabs['inbox'] = 'needs'`).
- **Controls:**
  - Tab buttons: "Needs you", "Finished", "History" — click to switch tabs
  - "Allow all 2…" button `{act=allowall}` — approves all pending items at once
  - "Open" button on each item `{act=chat id=...}` — opens related Trunk
  - "Allow" / "Don't" buttons on approvals `{act=ask id=... v=allowed/denied}` — responds to requests
- **States and edge cases:**
  - Empty: When no tasks exist in a tab, the list is empty.
  - Task items show: title, Trunk name, description, and duration/cost.

#### Automations

- **What it is:** A view of scheduled and triggered automations (recurring tasks and event-driven workflows).
- **When it appears:** Sidebar navigation.
- **How it works:**
  1. **Scheduled tab** (`data-v="scheduled"`): Shows recurring automations with on/off toggles per item.
  2. **Procedures tab** (`data-v="procedures"`): Shows saved step-by-step routines and saved prompts (custom commands).
  3. **Triggers tab** (`data-v="triggers"`): Shows event-triggered automations (when X happens, run Y).
  4. **Check-ins tab** (`data-v="checkins"`): Heartbeat checks that run on a schedule and report only when there's news.
  5. Navigation via `data-act="ptab" data-place="automations" data-v=..."`.
- **Scheduled tab controls:**
  - Text input: "Describe a new automation" — create new automation
  - Button: "Add" — adds automation from text
  - Checkbox per automation: on/off toggle `{sw=auto tab=scheduled i=...}`
  - Automation items show: title, schedule (e.g., "Weekdays at 7:30 AM"), and Trunk name
- **Procedures tab controls:**
  - Button: "Show a Trunk how, once" `{act=teach-start}` — teaches a new procedure
  - "Run now" button per procedure `{act=toast msg=Running...}` — executes immediately
  - "Open" button `{act=flow i=...}` — opens procedure editor
  - Saved prompts section shows custom commands (e.g., `/weekly`, `/invoice`)
  - "Use" button per prompt `{act=prompt-use v=...}` — inserts command in chat
  - "New prompt" button `{act=prompt-new}` — creates custom command
- **Triggers tab controls:**
  - Checkbox per trigger: on/off toggle `{sw=auto tab=triggers i=...}`
  - Trigger items show: title, trigger condition (e.g., "When an email from X arrives"), and Trunk name
- **Check-ins tab controls:**
  - Buttons: "Every 15 min", "Every 30 min", "Every hour", "Off" — sets check frequency `{act=hb-every v=...}`
  - Buttons: "8 AM – 8 PM", "Always", "Work hours" — sets time window
  - Checkbox: "Quiet on weekends" `{sw=set}` — skip checks on Sat/Sun
  - Text input: "Add something to check" — adds new check item
  - "Remove" button per item `{act=hb-rm i=...}` — removes check item
  - Last check-ins section shows history of what was found

#### Library

- **What it is:** A repository of Trunk memories (chat history, notes) and documents.
- **When it appears:** Sidebar navigation.
- **How it works:**
  1. **Memory tab** (`data-v="memory"`): Shows facts and information Trunks learned, with "Forget" button per item.
  2. **Documents tab** (`data-v="documents"`): Shows generated or uploaded documents (Markdown, etc.).
  3. **Made for you tab** (`data-v="made"`): Shows generated outputs (Excel, charts, PDFs, etc.).
  4. Navigation via `data-act="ptab" data-place="library" data-v=..."`.
- **Memory tab controls:**
  - List items show: memory text, Trunk name, date added, source (typed, from file, learned)
  - "Forget" button per item `{act=forget i=...}` — deletes memory
- **Documents tab controls:**
  - Button: "Write a new document" `{act=toast}` — creates blank doc
  - Document items show: file type (MD), name, author Trunk, date
  - "Open" button per item `{act=toast}` — opens in external app
- **Made for you tab controls:**
  - Generated items show: type (XLSX, SVG, PDF, MD), filename, author Trunk, date
  - "Open" button per item `{act=toast}` — opens in external app

#### Team

- **What it is:** A view of shared work across team members and their Trunks (requires KeepOak connection).
- **When it appears:** Sidebar navigation.
- **How it works:**
  1. **Live now tab** (`data-v="live"`): Shows active work currently executing on the team.
  2. **People tab** (`data-v="people"`): Team member list (same as Settings › People).
  3. **Groups tab** (`data-v="groups"`): Permission groups limiting multiple people at once.
  4. **Shared tab** (`data-v="shared"`): Shared conversations, Trunks, skills, automations.
  5. **Teams of specialists tab** (`data-v="agents"`): Multi-Trunk workflows with handoffs.
  6. **Activity tab** (`data-v="activity"`): Log of team approvals and changes.
  7. **Usage tab** (`data-v="usage"`): Cost per team member this month.
  8. **Rules tab** (`data-v="rules"`): Spending limits, service restrictions, sign-in method.
  9. **Signing in tab** (`data-v="signin"`): How external users join (PIN, passkey, identity service).
  10. Navigation via `data-act="ptab" data-place="team" data-v=..."`.
- **Live now tab controls:**
  - Work items show: person name, device, Trunk and task title, mode (Working/Waiting), progress, time/cost, model used
  - "Watch" button per item `{act=run-watch i=...}` — shows task execution
  - "Ask to join" button per item `{act=toast}` — requests permission to see the task
- **Rules tab controls:**
  - Buttons: "Over $10", "Over $25", "Over $100" — sets spending approval threshold `{act=seg v=...}`
  - Checkbox: "Only these services for shared Trunks" `{sw=set}` — restricts to ChatGPT, Claude, local models
  - Checkbox: "Only Admins install skills and plugins" `{sw=set}` — requires approval for installs
  - Checkbox: "Sign in with keepoak.com" `{sw=set}` — forces KeepOak account for all team members
  - Buttons: "30 days", "1 year", "Forever" — sets retention for team conversations `{act=seg}`
- **Signing in tab controls:**
  - Buttons: "Off", "When needed", "On" — allows external device sign-in `{act=seg v=...}`
  - Buttons: "PIN", "Passkey", "An identity service" — authentication method `{act=seg}`
  - Buttons: "1 hour", "8 hours", "A week" — session duration `{act=seg}`
  - Checkbox: "Lock a profile after five wrong PINs" `{sw=set}` — security
  - Checkbox: "Ask for my PIN when switching back to me" `{sw=set}` — owner re-auth

#### Customize

- **What it is:** The configuration hub for Trunks, Tools, Specialists, Channels, and Everywhere settings.
- **When it appears:** Sidebar navigation.
- **How it works:**
  1. Click a tab: `data-act="ptab" data-place="customize" data-v=..."` for each section.
  2. Default tab: `S.tabs['customize'] = 'trunks'` (shows Trunks first).
- **Tabs:** Trunks, Tools, Specialists, Channels, Everywhere

##### Customize: Trunks tab

- **What it is:** A list of all Trunks (assistants) with controls to create, edit, and manage them.
- **How it works:**
  1. **List:** Shows all Trunks by name (e.g., Scout, Ada, Ledger, Fieldnotes, and newly created Trunks).
  2. Each Trunk card shows: name, purpose/role (one-liner), "Edit" button, "Pause" button.
  3. **Edit button** `{act=edit id=...}` opens the **Trunk editor** (modal).
  4. **Pause button** `{act=pausetrunk id=...}` toggles Trunk on/off.
  5. **New Trunk button** `{act=chat id=new}` creates a new Trunk (opens editor).
  6. **New room button** `{act=toast}` — note: Rooms are created by picking 2+ Trunks together.
  7. **START FROM A JOB section** shows job templates (Inbox Manager, Expense Manager, Researcher, Chief of Staff, Bug Reproduction, Trip Planner) with "Use this job" buttons `{act=tmpl i=...}`.
- **Trunk editor (modal):** Opens when Edit or New Trunk is clicked.
  - **Look tab:** "Appearance/agent" for the Trunk.
    - **Fields:**
      - Trunk name (text input) — e.g., "Scout"
      - Purpose / role (text input) — one-line description, e.g., "Research"
      - **Appearance section:** Shows available agent looks (branch, ember, tock, kite, morel, pebble, wisp, lumen, tide, juniper, bolt) — click to select
      - **Color picker:** Accents (orange, yellow, green, teal, blue, purple, magenta, dark) — click to select
    - **Buttons:** "Save", "Cancel"
  - **What it may do tab:** "Capabilities/role" for the Trunk.
    - **Fields:**
      - Role/description (text area) — detailed instructions for this Trunk's purpose
      - Allowed computers (checkboxes) — which computers this Trunk may use
      - Allowed tools/specialists (checkboxes or list) — which tools and agents it has access to
      - Model preference (dropdown or selector) — which model(s) this Trunk uses by default
    - **Buttons:** "Save", "Cancel"
  - **Behavior:**
    - Changes apply immediately when saved.
    - Trunk name is used everywhere: Inbox, Automations, chat sidebar.
    - Purpose is shown in Inbox, Team, and Customize lists.
    - Appearance (agent look and color) is shown in chat header and sidebar.

##### Customize: Tools tab

- **What it is:** Sub-configuration for MCP connectors, Skills, Plugins, and Command-line tools.
- **How it works:**
  1. Sub-tabs (four): "Connectors", "Skills", "Plugins", "Command-line tools".
  2. Navigation via `data-act="ptab place=customize v=tools"` then sub-tabs show.
  3. Each sub-tab lists available and enabled tools, with on/off toggles or status.
- **Connectors sub-tab:**
  - List of 5 MCP servers with status (e.g., "GitHub · Remote server · signed in with GitHub").
  - Button: "Add a server" `{act=...}` — connects new MCP server.
  - Items show: name, type (Remote server / Local command), auth status, icon (single letter or mark).
  - Examples: GitHub (O icon, remote, signed in), Outlook (O, remote, Microsoft), Google Drive (no auth shown), Files on this computer (Local command), Browser control (Local command, Playwright), Brave Search (B icon, remote, needs API key).
- **Skills sub-tab:**
  - List of 6 skills (reusable know-how as SKILL.md files).
  - Items show: title, description/action, icon (S mark or similar).
  - Toggle or button to enable/disable per skill.
- **Plugins sub-tab:**
  - List of 2 plugins (bundles of skills, servers, tools).
  - Items show: name, what it includes, toggle.
- **Command-line tools sub-tab:**
  - List of 5 command-line tools (programs on this computer a Trunk may run).
  - Items show: name, command/executable, toggle.

##### Customize: Specialists tab

- **What it is:** A list of specialized agents that can be assigned to Trunks.
- **How it works:**
  1. Shows available Specialists.
  2. Allows assignment/unassignment to Trunks via selection or button.
  3. Note: Specialists are other assistants over A2A (Agent-to-Agent protocol).

##### Customize: Channels tab

- **What it is:** Setup and pairing for 55 chat platforms (Telegram, Discord, Slack, etc.).
- **How it works:**
  1. Grid or list of 55 channels (see table below).
  2. Each channel card shows: name, icon, family (core / social / code / work / media), and status.
  3. Click a channel to pair it:
     - If "turnOn": "guided", a pairing wizard appears (e.g., Telegram: send a message to your bot, type the code here).
     - If "turnOn": "file", a file-upload dialog appears (e.g., Discord: upload bot token file).
  4. Status: "Connected" (green), "Not connected" (gray), "Error" (red).
  5. Each channel has fields to fill (e.g., Slack: Bot User OAuth Token, app-level token).
- **Channel families:** core (5: Telegram, Discord, Slack, WhatsApp, Signal), social (7: Twitter, Bluesky, Threads, Mastodon, Lemmy, Reddit, and 1 more), code (8: GitHub and 7 more), work (10), media (13), other (12). Total = 55 channels.

**55 Chat Channels (from dump.json and harvest-channels.txt):**

| # | ID | Name | Family | Turn On | Status Example |
|---|---|---|---|---|---|
| 1 | telegram | Telegram | core | guided | Token from BotFather |
| 2 | discord | Discord | core | file | Bot token file upload |
| 3 | slack | Slack | core | file | Bot + app token |
| 4 | whatsapp | WhatsApp | core | guided | Phone-based pairing |
| 5 | signal | Signal | core | file | Bot account setup |
| 6 | twitter | Twitter | social | file | API keys |
| 7 | bluesky | Bluesky | social | guided | Username + password |
| 8 | threads | Threads | social | file | Meta OAuth token |
| 9 | mastodon | Mastodon | social | guided | Instance + token |
| 10 | lemmy | Lemmy | social | guided | Instance + token |
| 11 | reddit | Reddit | social | file | API credentials |
| 12 | linkedin | LinkedIn | work | file | OAuth |
| 13 | github | GitHub | code | file | PAT (Personal Access Token) |
| 14–55 | ... | ... | ... | ... | (41 more channels: see dump.json for complete list) |

##### Customize: Everywhere tab

- **What it is:** Global settings for Branch across all Trunks and surfaces.
- **How it works:**
  1. Shows options for default Trunk, gateway behavior, keyboard shortcuts, surface configuration.
  2. Settings apply to all Trunks unless a specific Trunk overrides them in its own editor.

---

### 5.2 Settings

The Settings place holds configuration for the app itself, organized in four groups with 19 pages total. Settings are navigable via a sidebar with four collapsible groups, a search box, and three visibility levels (Regular, Advanced, Technical).

#### Settings Navigation and Levels

The settings sidebar shows four groups, each with sub-pages:

1. **General** (4 pages)
   - General
   - People
   - Appearance
   - Notifications

2. **Your assistant** (5 pages)
   - Instructions & personality
   - Models
   - On this computer
   - Accounts
   - Voice

3. **Safety** (3 pages)
   - Permissions
   - Computer & browser
   - Saved sign-ins

4. **Care** (5 pages)
   - Data & usage
   - Gateway
   - Branch itself
   - Updates & about
   - Achievements

**Hidden pages accessible via level toggle:**
- **advanced** — Regular: hidden; Advanced or higher: visible
- **developer** — Regular and Advanced: hidden; Technical only: visible

**Visibility levels:** Controlled by three buttons at top-right of Settings sidebar:
- **Regular** (level 0, default): "The essentials, in plain words." Shows 14 pages (all four groups, no advanced or developer).
- **Advanced** (level 1): "Every feature and the fine controls." Adds "Advanced" page under MORE section; shows "Advanced" button in sidebar instead of "Regular"; developer page remains hidden.
- **Technical** (level 2): "File paths, raw keys, launch variables, config and logs." Shows all 19 pages including "developer"; shows "Technical" button.

**Level buttons behavior:** Buttons are `{act=setlevel v=regular/advanced/technical}` with tooltips. Clicking changes `S.level` and rerenders Settings pages to show/hide level-specific controls.

**How the level control looks (pass 14):** under a small uppercase label "HOW MUCH TO SHOW", a segmented control: a rounded track (`var(--fill)`, `1px` line, radius `12px`, `3px` inner padding) with three equal segments "Regular", "Advanced", "Technical" on one row (`11.5px`, the chosen one `600` weight in `var(--ink)`, the others `var(--ink-3)`). A raised pill (`var(--raise)`, soft shadow, radius `9px`) slides under the chosen segment in `0.28s` (no slide with reduced motion). One line under the track says what the level shows: "The essentials, in plain words." / "Every feature and the fine controls." / "File paths, raw keys, launch variables, config and logs." When the settings list is a tab row (windows up to 1000px wide), the control stays visible as a compact 228px switch at the end of the row, without label or hint. (Before pass 14 it wrapped "Technical" onto a second line and was hidden below 1000px.)

**Search box:** Text input `{act=...}` filters Settings pages by title and keywords.

**Navigation:** Pages are reachable via `data-act="setpage" data-v="PAGE_ID"` (keeps sidebar open) or `data-act="setgo" data-v="PAGE_ID"` (closes all dialogs).

#### Settings Pages: General Group

##### General

- **Page ID:** "general" — Navigable via `data-act="setpage v=general"`
- **What it is:** Basic app configuration (startup, projects, keyboard shortcuts).
- **Controls:**

1. **STARTING UP section:**
   - Checkbox: "Start with Windows" `{sw=set}` [on/off] — Opens quietly in the tray when Windows boots. Persists in `S` state.
   - Checkbox: "Keep working when the window closes" `{sw=set}` [on/off] — Trunks finish what they started; requires gateway.

2. **PROJECTS section:**
   - Shows list of projects (e.g., "Hartwell: 3 conversations · its own instructions").
   - Button per project: "Edit" `{act=toast}` — Opens project instructions editor.

3. **KEYBOARD section:**
   - Button: "Show all" `{act=shortcuts}` — Opens keyboard shortcuts help.
   - Text snippet: "Ctrl K to find anything, Ctrl N for a new conversation."

- **Visibility:** All controls visible at Regular level. Advanced level adds "Advanced" page button in sidebar.
- **Source:** `renderSettings()`, `renderGeneral()` function.

##### People

- **Page ID:** "people"
- **What it is:** User profile and team member management (multi-user on this computer, team members on their own devices, KeepOak team members).
- **Controls:**

1. **ON THIS COMPUTER section:**
   - List of users (each user an avatar and name, e.g., "T Taofik · you · Owner · last used Now").
   - Button per user: "TTaofik · youOwner · last used Now" `{act=p-sel v=...}` — Selects this user (switches profile).

2. **ON THEIR OWN DEVICE section:**
   - List of users signed in on their own devices with device and status (e.g., "Dana Okafor · Adult · last used 5 min ago").

3. **FROM YOUR KEEPOAK.COM TEAM section:**
   - List of team members from KeepOak (if connected).

4. **Invite button:** "Invite someone" `{act=p-invite}` — Opens dialog to add new person.

5. **Selected user details card (e.g., Dana Okafor):**
   - Device: "Her own MacBook · signs in with a passkey"
   - Role selector: Buttons "Adult" / "Child" `{act=p-role v=...}` — Sets user type.
   - Permissions checkboxes (for selected user's capabilities when using Branch on this computer):
     - Checkbox: "Look things up" [on] — Can use web search and tools.
     - Checkbox: "Use web pages" [on] — Can open browsers.
     - Checkbox: "Write files" [on] — Can create/edit documents.
     - Checkbox: "Run commands" [on] — Can execute terminal commands.
     - Checkbox: "Send messages" [on] — Can send emails and messages.
     - Checkbox: "Spend money" [off] — Can approve purchases.
     - Checkbox: "Change how Branch is set up" [off] — Can access Settings.
   - Trunks: "Ledger, Fieldnotes" — Which Trunks this person uses.
   - Projects: "Hartwell" — Which projects.
   - Daily allowance: "$5 a day" — Spending limit.
   - PIN: "Set" / "Change" `{act=pin-change}` — Sets/changes PIN for this user.
   - Signed in on: "MacBook" — Device they last used.
   - Button: "Switch to Dana" `{act=toast}` — Switches to this user's profile.
   - Button: "Make a one-time code" `{act=toast msg=One-time code: ...}` — Generates 15-min code.
   - Button: "Sign out everywhere" `{act=toast}` — Logs out user on all devices.
   - Button: "Remove" `{act=toast}` — Removes user; conversations kept for 30 days.

6. **EACH PERSON section (settings for all users):**
   - Checkbox: "Ask for a PIN when switching person" `{sw=set}` [on] — Requires PIN for profile switch (4–8 digits; 5 wrong tries = 5-min lock).
   - Checkbox: "Keep conversations separate" `{sw=set}` [on] — Users can't read each other's chats unless shared.
   - Button: "Groups" `{act=p-open-team v=groups}` — Opens Team › Groups (on KeepOak).
   - Button: "Signing in from other devices" `{act=p-open-team v=signin}` — Opens Team › Signing in.
   - Button: "What you share" `{act=p-open-team v=shared}` — Opens Team › Shared.

- **Visibility:** All controls at Regular level. Advanced level shows same controls.
- **Source:** `renderPeople()` function.

##### Appearance

- **Page ID:** "appearance"
- **What it is:** Visual customization (light/dark, themes, agents, backgrounds, pets, text size, language).
- **Controls:**

1. **LIGHT OR DARK section:**
   - Buttons (radio group): "Light · live mirror of Scout", "Dark · live mirror of Scout", "Match this computer" [selected] `{act=themeset v=light/dark/system}` — Sets theme mode. "Light" and "Dark" are live previews showing sample chat text.

2. **THEME section:**
   - Current theme display: "Branch Slate · Branch · Daylight"
   - Button: "Browse all 46 themes" `{act=skins}` — Opens theme gallery modal.
   - Button: "Make your own" `{act=ce-new}` — Opens custom theme editor.
   - **Theme list** (46 total): branch (default), paper, t-forest, t-earth, t-slate, t-nocturne, t-arctic, t-terracotta, t-lavender, t-mint, t-cherry, t-ocean, t-sunset, t-sepia, t-meadow, t-stone, t-harbor, t-signal, t-mono, t-amber-crt, t-green-crt, t-catppuccin, t-nord, t-dracula, t-solarized, t-gruvbox, t-rose-pine, t-rose-pine-moon, t-tokyo-night, t-everforest, t-one-dark, t-monokai, t-ayu, t-ayu-mirage, t-kanagawa, t-palenight, t-material-ocean, t-github, t-horizon, t-synthwave, t-night-owl, t-poimandres, t-vesper, t-flexoki, t-oceanic, t-nightfox.
   - Selection via `data-act="themeset" data-v="SKIN_ID"` or "system".

3. **Accent colour section:**
   - Label: "A" (single letter accent indicator).
   - Description: "Only for what wants you: the working ring, the waiting dot, the yes button. Save as a theme"
   - Buttons (radio group): "The theme's own accent" [selected], "Accent #D8612A" (orange), "Accent #E0A526" (yellow), "Accent #2F8F5B" (green), "Accent #2F8C86" (teal), "Accent #4F6FA8" (blue), "Accent #8A5AA8" (purple), "Accent #C0467A" (magenta), "Accent #16212A" (dark) `{act=acc-set v=...}`.
   - Input: Color picker (text field showing hex) `#d8612a` — Manual color entry.
   - Button: "Save as a theme" `{act=acc-save}` — Saves custom accent as new theme.

4. **More contrast option:**
   - Checkbox: "More contrast" [off] — Stronger lines and text, from each theme's own high-contrast colours.

5. **AGENTS section:**
   - Checkbox: "Show the agent beside the conversation" [on] `{sw=set}` — Shows animated agent (Trunk's look) in chat.
   - Description: "It acts out what the Trunk is doing: thinking, searching, reading, working, waiting for you, celebrating, resting."
   - **Size radio buttons:** "Small" / "Medium" [selected] / "Large" `{act=ag-size v=s/m/l}` — Sets agent size on screen.
   - Description: "Small keeps it out of the way."

6. **BACKGROUND section:**
   - **Behind the glass radio buttons:** "None" [selected], "Painted grove", "The grove", "The oak in 3D", "Growth rings", "Your own" `{act=bgset v=...}`.
   - Description: "The grove and the oak wear the theme's colours. A scrim in the theme's own colour keeps text readable."

7. **PAINTED SCENES section:**
   - **Scene selector (radio buttons):** "By the season", "Spring grove", "Autumn grove", "Winter grove", "Firefly night", "Summer Meadow", "Rainy Forest", "Mountain Lake", "Blossoming Grove", "Desert Canyon", "Snowy Night", "Bamboo Grove", "Sunflower Hills" `{act=scene-set v=...}`.

8. **Background overlay controls:**
   - Slider: "How much the theme covers the background" (disabled if "None" selected) — Opacity percentage, default 35%.
   - Description: "More keeps text calmer; less shows more of the background."
   - Slider: "See-through panels" (disabled if "None") — Panel transparency, default 25%. Description: "Panels blur what's behind them."
   - Button: "See it clearly" [disabled] `{act=bg-peek}` — Temporarily clears view to show background. Click anywhere to return.

9. **READING section:**
   - **Conversation width radio buttons:** "Comfortable", "Wide" [selected], "Full" `{act=widthset v=...}`.
   - Description: "Wide uses more of a big screen."
   - **Text size radio buttons:** "Small", "Regular" [selected], "Large" `{act=size v=...}`.
   - Description: "Changes every screen."

10. **THE PET section:**
    - **Pet selector buttons:** "—None", "Little Branch" [selected], "Moss frog", "Leaf hog", "Fennec", "Otter", "Capybara", "Clover bun", "Owlet", "Shell snail", "Jelly", "Cloud sheep", "Pebble crab", "Caterpillar", "Sprig dragon", "Turtle", "Penguin", "Puppy", "Kitten", "Raccoon", "Koala", "Sloth", "Fruit Bat", "Bumblebee", "Beetle", "Duckling", "Hamster", "Seal Pup", "Octopus", "Chameleon", "Firefly", "Dust bunny", "Moss Golem", "Narwhal", "Squirrel", "Elephant", "Pixel squirrel", "Pixel owl", "Pixel hedgehog" `{act=petset v=...}`.
    - Total: 1 special (Little Branch) + 34 painted pets + 3 pixel pets = 38 pets.
    - Text input: "Pet name" (placeholder) — Custom name for the pet.
    - Description: "Pat it for a tip."

11. **WHAT'S SHOWN section (visibility toggles):**
    - Checkbox: "The usage ring" [on] `{sw=hide k=usage}` — Shows cost ring; right-click to hide too.
    - Checkbox: "The gateway in the status bar" [on] `{sw=hide k=gateway}` — Shows gateway icon; right-click to hide too.
    - Checkbox: "The pet" [on] `{sw=hide k=pet}` — Shows animated pet; right-click to hide too.
    - Checkbox: "Projects in the list" [on] `{sw=hide k=projects}` — Shows project group; right-click to hide too.
    - Checkbox: "The Guide button" [on] `{sw=hide k=notes}` — Shows help button; right-click to hide too.
    - Checkbox: "The whole status bar" [on] `{sw=hide k=statusbar}` — Shows status bar; Lockdown's banner and "Stop while a task runs" can never be hidden.
    - Checkbox: "Keep things still" [off] `{sw=still}` — Stops pet walking, working ring, logo float, and background moving.
    - Checkbox: "Scenery behind the list" [off] `{sw=scenery}` — Small pixel oak at the foot of the list.

12. **LANGUAGE section:**
    - Dropdown: "Language" `{sw=lang}` options: English*, Français, Español, Deutsch, Yorùbá.
    - Description: "Dates and numbers follow it too."

- **Visibility:** All controls at Regular level.
- **Source:** `renderAppearance()` function.

##### Notifications

- **Page ID:** "notifications"
- **What it is:** Alert preferences (sound, desktop notifications, quiet hours).
- **Controls:**

1. **TELL ME WHEN section:**
   - Checkbox: "A Trunk needs a yes" [on] `{sw=set}` — Shows on this computer and your phone.
   - Checkbox: "A long task finishes" [on] `{sw=set}` — Only tasks over two minutes.
   - Checkbox: "Play a sound" [off] `{sw=set}` — A short soft chime.

2. **QUIET section:**
   - **Days off radio buttons:** "Sat", "Sun" [selected], "None" `{act=seg}` — No notifications at all on these days.
   - Description: "No notifications at all on these days."

- **Visibility:** All controls at Regular level.
- **Source:** `renderNotifications()` function.

#### Settings Pages: Your Assistant Group

##### Instructions & personality

- **Page ID:** "instructions"
- **What it is:** System prompt and personality settings for all Trunks, or per-Trunk overrides.
- **Controls:**

1. **WHOSE FILES section:**
   - Radio buttons: "Every Trunk" [selected], "Scout", "Ledger", "Ada", "Fieldnotes" `{act=if-owner v=...}` — Selects whose instructions to edit.

2. **Files to edit:**
   - List of 8 editable files (Markdown files Branch reads before Trunks work):
     - `SOUL.md` — "Who your assistant is: tone and boundaries" — 5 lines · 1 earlier version — Button: "Edit" `{act=if-open f=SOUL.md}`
     - `IDENTITY.md` — "Its name and how it introduces itself" — Empty — Button: "Write" `{act=if-open f=IDENTITY.md}`
     - `USER.md` — "Who you are and what you prefer" — 5 lines — Button: "Edit" `{act=if-open f=USER.md}`
     - `AGENTS.md` — "House rules for every Trunk (also reads CLAUDE.md, .hermes.md)" — Empty — Button: "Write" `{act=if-open f=AGENTS.md}`
     - `TOOLS.md` — "Notes on the tools it has" — Empty — Button: "Write" `{act=if-open f=TOOLS.md}`
     - `SOP.md` — "Your standing steps, read before each task" — Empty — Button: "Write" `{act=if-open f=SOP.md}`
     - `MEMORY.md` — "Notes you wrote for it" — Empty — Button: "Write" `{act=if-open f=MEMORY.md}`
     - `HEARTBEAT.md` — "What it checks on when it wakes on a schedule" — 5 lines — Button: "Edit" `{act=if-open f=HEARTBEAT.md}`

3. **Note:** "A file can't widen what Branch may do; Permissions still decides. A Trunk's own copy replaces the shared one for that Trunk only."

- **Visibility:** All controls at Regular level.
- **Source:** `renderInstructions()` function.

##### Models

- **Page ID:** "models"
- **What it is:** LLM and voice model configuration; shows accounts and which Trunks use each.
- **Controls:**

1. **Sub-tabs (5 tabs):**
   - Button: "Connections" `{act=mtab v=connections}` — Account list and setup.
   - Button: "Defaults" `{act=mtab v=defaults}` — Default model per Trunk.
   - Button: "On this computer" `{act=mtab v=local}` — Local models (Ollama, etc.).
   - Button: "Second opinion" `{act=mtab v=second}` — Fallback model for hard questions.
   - Button: "Media" `{act=mtab v=media}` — Image and voice models.

2. **Connections tab (default):**
   - Description: "You can sign in to the same service more than once. When one account runs low, Branch moves to the next. The order is in Settings › Accounts."
   - Grouped by provider:
     - **ChatGPT section:**
       - Item: "ChatGPT · Account 1 — Plus plan · used by Scout, Ada — Answers first"
       - Item: "ChatGPT · Account 2 — Plus plan · used by anyone, next — Next in line"
       - Item: "ChatGPT · Account 3 — Pro plan · used by Fieldnotes — Next in line"
       - Button: "Add another ChatGPT account" `{act=addacct v=openai}`
       - More menu button per account: "More for ChatGPT · Account N" `{act=acct-menu i=...}`
     - **Claude section:** (similar structure, 3 accounts)
       - Item: "Claude · Account 1 — Max plan · used by Ledger — Answers first"
       - Item: "Claude · Account 2 — Pro plan · used by anyone — Next in line"
       - Item: "Claude · Account 3 — Pro plan · used by anyone — Next in line"
       - Button: "Add another Claude account" `{act=addacct v=anthropic}`
     - **Gemini section:**
       - "Not set up"
       - Button: "Sign in to Gemini" `{act=addacct v=gemini}`
     - **OpenRouter section:**
       - "Not set up"
       - Button: "Sign in to OpenRouter" `{act=addacct v=openrouter}`
     - **GitHub Copilot section:**
       - "Not set up"
       - Button: "Sign in to GitHub Copilot" `{act=addacct v=github}`
   - Button: "Add an account" `{act=addacct}` — Generic add button.
   - Link: "Settings › Accounts" `{act=setpage v=accounts}` — Opens Accounts page.

- **Visibility:** All controls at Regular level.
- **Source:** `renderModels()` function.

##### On this computer

- **Page ID:** "local"
- **What it is:** Local runtime setup (Ollama, LM Studio, vLLM, etc.) and local models.
- **Controls:**

1. **Hardware info (read-only display):**
   - "Processor: AMD Ryzen 7 7800X3D"
   - "Memory: 32 GB"
   - "Graphics: NVIDIA GeForce RTX 4070 · 12 GB"
   - "Free space: 212 GB"
   - "Runtime: Ollama 0.12"

2. **RECOMMENDED FOR YOU section:**
   - Suggested model cards (e.g., Llama 3.2 3B, Qwen3 4B, Gemma 3 4B, Llama 3.1 8B, Qwen3 8B, Qwen3 14B, Qwen2.5 14B, gpt-oss 20B, Mistral Small 3.2 24B, Qwen3 30B A3B).
   - Card structure per model:
     - Title: Model name
     - Description: "Runs great on your graphics card" or "Runs, a little slower (uses memory)" or "Too big for this computer"
     - Capability tags: "TOOLS", "SEES PICTURES"
     - Memory: "3B", "4B", "8B", etc.
     - Context window: "128K WORDS OF MEMORY", "40K WORDS OF MEMORY", "32K WORDS OF MEMORY"
     - **Size options (radio buttons):** "small · X.X GB" [selected], "balanced · X.X GB", "full · X.X GB" (if applicable) `{act=lm-v id=... v=Q4_K_M/Q8_0/F16}` — Size/quality trade-off.
     - **Action buttons:**
       - If not installed: "Install X.X GB" [may be disabled] `{act=lm-get id=...}`
       - If running: "Say hello" `{act=lm-chat}` — Opens chat with local model.
       - If installed: "Remove" `{act=lm-rm id=...}` — Uninstalls model.

3. **RUNTIMES section:**
   - List of 7 available local runtimes:
     - "OL Ollama" — "Runs on this computer, so nothing leaves it and nothing is charged. Install Ollama and run `ollama serve`. No key needed." — Status: "Found"
     - "LS LM Studio" — "Runs on this computer. Load a model in LM Studio and start its server. Any placeholder key works." — Button: "Look for it" `{act=toast msg=...}`
     - "VL vLLM" — "Runs on this computer. Start vLLM with its OpenAI-compatible server. Any placeholder key works." — Button: "Look for it"
     - "LC llama.cpp" — "Runs on this computer. Start llama-server from llama.cpp. Any placeholder key works." — Button: "Look for it"
     - "LO LocalAI" — "Runs on this computer and can also make speech and pictures. Any placeholder key works." — Button: "Look for it"
     - "JA Jan" — "Runs on this computer. Turn on Jan's local server. Any placeholder key works." — Button: "Look for it"
     - "LI LiteLLM proxy" — "A proxy you run yourself that speaks OpenAI's shape and forwards to whichever service you configured behind it. Point this at wherever you run it." — Button: "Look for it"

- **Visibility:** All controls at Regular level.
- **Source:** `renderLocal()` function.

##### Accounts

- **Page ID:** "accounts"
- **What it is:** API keys and authentication for LLM providers, connectors, etc.; account order.
- **Controls:**

1. **Summary:** "Your model accounts, the order Branch uses them in, which Trunks use each, and your keepoak.com account."
2. **Note:** "Branch never sees your passwords. Each account is billed by its own site."

3. **ORDER BRANCH USES THEM IN section:**
   - List of 6 accounts (same as Connections tab in Models page):
     - Item structure per account: "ChatGPT · Account 1 — Plus · used by Scout, Ada"
     - Move buttons: "Move up" [disabled for first] `{act=acct-up i=...}` — Reorder accounts.
     - More menu button: "More for ChatGPT · Account 1" `{act=acct-menu i=...}` — Account actions (edit, delete).
   - Button: "Add an account" `{act=addacct}` / "Another ChatGPT account" `{act=addacct v=openai}` / "Another Claude account" `{act=addacct v=anthropic}`

4. **WHEN ONE RUNS OUT section:**
   - Checkbox: "Move to the next account in the list" [on] `{sw=set}` — Only between accounts you own and pay for, within each provider's terms. No account's allowance is shared with another person.
   - Checkbox: "Fall back to this computer" [on] `{sw=set}` — When every account is out, keep going on Qwen3.6 35B instead of stopping.

5. **KEEPOAK.COM section:**
   - Description: "Your keepoak.com account — Have a KeepOak computer or a team on keepoak.com? Connect it once."
   - **Proposal bullets:**
     - "Your KeepOak computer joins the computer switcher, with its agents."
     - "Your theme, saved colours and season follow you between computers and keepoak.com."
     - "Your team workspace: members, shared Trunks and what they're running."
     - "Conversations, memory and keys stay on each computer. Nothing else is shared."
   - Button: "Connect your keepoak.com account" `{act=ko-start}`

- **Visibility:** All controls at Regular level.
- **Source:** `renderAccounts()` function.

##### Voice

- **Page ID:** "voice"
- **What it is:** Speech synthesis and recognition settings; push-to-talk key.
- **Controls:**

1. **TALKING section:**
   - **Listening radio buttons:** "Off", "Push to talk" [selected], "Wake word" `{act=seg}`.
   - Description: "Push to talk holds the key; wake word listens for 'Hey Branch'."
   - **Push-to-talk key field:**
     - Display: "Right Ctrl"
     - Button: "Change" `{act=toast msg=Press the key you want to use.}` — Prompts user to press new key.
     - Description: "Hold it anywhere in Windows."

2. **SPEAKING BACK section:**
   - **Voice radio buttons:** "Oak" [selected], "Birch", "Off" `{act=seg}`.
   - Description: "Read replies out loud in this voice."
   - Checkbox: "Dictation in the message box" [on] `{sw=set}`.
   - Description: "The microphone button turns speech into text."

- **Visibility:** All controls at Regular level.
- **Source:** `renderVoice()` function.

#### Settings Pages: Safety Group

##### Permissions

- **Page ID:** "permissions"
- **What it is:** Consent and privacy controls (what Trunks may do without asking).
- **Controls:**

1. **Info:** "What Trunks may do without asking you first."
2. **Ask first toggle:** "Ask first is on — Trunks ask before they send, delete, spend money or install anything. Ledger has one exception."

3. **WITHOUT ASKING, TRUNKS MAY section:**
   - Checkbox: "Read files in Documents and Downloads" [on] `{sw=set}` — Reading never changes a file.
   - Checkbox: "Use the browser on this computer" [on] `{sw=set}` — Signs in with your saved sign-ins. You can take over any time.
   - Checkbox: "Send email and messages" [off] `{sw=set}` — Off means every message waits for your yes. (Ledger is allowed to send email = exception).
   - Checkbox: "Install tools and packages" [off] `{sw=set}` — Off means a request shows up in your Inbox.
   - Checkbox: "Record tasks so you can watch them again" [on] `{sw=set}` — Recordings stay on this computer.

4. **Advanced section (visible at Regular level, collapsible or always shown):**
   - Label: "Lockdown"
   - Description: "One switch that stops every Trunk from sending, changing or spending anything."
   - Button: "Turn Lockdown on" `{act=lock}` — Activates Lockdown mode.

5. **Automatic safety limits section (Advanced level or below):**
   - **Retry limit radio buttons:** "Never" / "When needed" [selected] / "Always" `{act=seg}` — Automatic detection of looping/repetition.
   - Checkbox: "Stop a Trunk that repeats itself" [on] `{sw=set}` — Auto-stop after N loops.
   - Button: "Add" `{act=toast}` — Adds a folder Trunks may change without asking.

6. **PINNED SETTINGS section:**
   - Description: "A pinned setting is fixed. Someone else who uses this computer sees it pinned and can't change it any way."
   - Example: "Full access — Nobody but you can choose Full access for a conversation. — Unpin" `{act=pin-rm8 i=...}`
   - Example: "Lockdown — Only you can switch Lockdown off. — Unpin"
   - Button: "Pin a setting" `{act=pin-add8}` — Opens dialog to pin a new setting.

- **Visibility:** All controls at Regular level. Advanced level shows same controls.
- **Source:** `renderPermissions()` function.

##### Computer & browser

- **Page ID:** "computer"
- **What it is:** System access and browser extension settings; computer assignment to Trunks.
- **Controls:**

1. **COMPUTERS THEY MAY USE section:**
   - Description: "The computers your Trunks may use, and the browser they work in. Which Branch you talk to is the switcher at the top of the list."
   - Grouped by location:
     - **ON THIS PC:**
       - Item: "Private computer 1 — Windows · a sealed box on this PC — Its own desktop, apps and browser. Your files only when you share a folder. — Used by Scout, Branch, Supplier quotes — Ready"
       - Item: "Private computer 2 — Windows · a second sealed box on this PC — Its own desktop and browser, separate from Private computer 1. — Used by Scout, Supplier quotes — Ready"
       - Item: "This computer — Your Windows desktop — Your screen, mouse and apps. It asks before an app it hasn't used, and you can take over any time. — Used by Ledger, Branch — Ready"
     - **YOUR OTHER COMPUTERS:**
       - Item: "taofik-ai — Linux · home server · no screen — A terminal and a headless browser only. — Used by Fieldnotes — Ready · no screen"
       - Item: "Legion — Windows · gaming PC · asleep, wakes when asked — Your apps on that PC. It wakes it, works, and lets it sleep again. — Used by Ada — Asleep"
       - Item: "Office Mac mini — macOS · at the office · online — Its screen, apps and browser. Needs someone to allow it once at the Mac. — Ready"
     - **IN THE CLOUD:**
       - Item: "KeepOak computer — Linux · in the cloud · stays on — Keeps working while this PC sleeps. Hermes Agent and OpenClaw run there too. — Used by Ada — Connect keepoak.com"
   - Button: "Connect keepoak.com" `{act=ko-start}` — Connects KeepOak cloud computer.
   - Button: "Add a computer" `{act=comp-add}` — Adds new computer.

2. **WHICH TRUNK USES WHICH section:**
   - Description: "A Trunk can use several computers, one task on each, side by side."
   - Table structure per Trunk (e.g., Scout, Ledger, Ada, Fieldnotes, Branch):
     - Trunk name (column header)
     - Computer checkboxes: "Private computer 1" [selected], "Private computer 2" [selected], "This computer", "taofik-ai", "Legion", "Office Mac mini" — Each is a chip button `{act=comp-chip id=... v=...}`
     - Task limit radio buttons: "1", "2" [selected], "3", "4" `{act=comp-max id=... v=...}` — Max parallel tasks per Trunk.

3. **ON A COMPUTER section:**
   - Checkbox: "See the screen and use the mouse" [on] `{sw=set}` — Needed for apps without a connection. You can always take over.
   - Checkbox: "Ask before opening an app it hasn't used" [on] `{sw=set}` — Once per app, per Trunk.
   - **Where scripts run radio buttons:** "Sealed box" [selected] / "This computer" `{act=seg}`.
   - Description: "Sealed box — This computer — A sealed box keeps scripts away from your files unless a task needs them."

4. **THE BROWSER section:**
   - **Which browser radio buttons:** "Branch's own" [selected] / "Your Chrome" `{act=seg}` — Its own profile keeps your tabs and sign-ins separate.
   - Checkbox: "Ask before a site it hasn't visited" [on] `{sw=set}` — You say yes once per site.
   - Checkbox: "Open the browser full size when a task starts" [off] `{sw=set}` — Otherwise it stays small in the corner.

5. **Note:** "Switch to Technical (bottom left) to see file paths, ports and raw settings."

- **Visibility:** All controls at Regular level.
- **Source:** `renderComputer()` function.

##### Saved sign-ins

- **Page ID:** "secrets"
- **What it is:** Stored authentication tokens and passwords (Bitwarden-integrated or local).
- **Controls:**

1. **Info:** "Sign-ins Branch may fill for you. It never sees or stores the passwords."
2. **Status:** "Bitwarden is connected — Branch asks Bitwarden to fill a sign-in; you approve each one the first time."

3. **BRANCH MAY FILL section:**
   - List of saved sign-ins:
     - Item: "Outlook — outlook.office.com · used by Scout — •••••••• — Remove" `{act=toast msg=...}`
     - Item: "Delta — delta.com · used by Ada — •••••••• — Remove"
     - Item: "Oakfield — oakfield.example · used by Scout, Ledger — •••••••• — Remove"
   - Button per item: "Remove" `{act=toast}` — Deletes sign-in from list.

- **Visibility:** All controls at Regular level.
- **Source:** `renderSecrets()` function.

#### Settings Pages: Care Group

##### Data & usage

- **Page ID:** "usage"
- **What it is:** API usage stats, billing, spending limits, data retention, and model testing.
- **Controls:**

1. **WHAT EACH CONNECTION HAS LEFT section:**
   - Description: "How much of each service's allowance is still there: one row per connection, one row per account. Every figure arrived on traffic Branch was already sending."
   - Table structure (detailed in `usagepop` popover — same content):
     - Provider · Plan — Status (Measured/Estimate/Not published/Not asked) — Used next status — Time window (e.g., "This 5-hour window") — Percentage left and reset time — Time window (e.g., "This week") — Percentage left and reset time — Data source (e.g., "from headers on answers Branch was getting anyway").
   - Detailed per-account entries (see `usage` page harvest for full list).

2. **The ring bottom right section:**
   - Checkbox: "Show the ring" [on] `{sw=ring}` — Shows usage ring (connection used next, percentage left).
   - Description: "The connection used next, how much of its window is left, and when it refills."

3. **Offer to save progress section:**
   - Checkbox: "Offer to save progress at 95%" [on] `{sw=ckpt}` — It only asks, once per connection per window, and never for an estimate.
   - Button: "Show me" `{act=ckpt-demo}` — Shows a checkpoint demo.

4. **Asking a service what is left section:**
   - Checkbox: "Asking a service what is left" [off] `{sw=set}` — Only OpenRouter documents a way to ask. Off until you switch it on. Subscriptions are never asked.

5. **Show usage in the tray section:**
   - Checkbox: "Show usage in the tray" [on] `{sw=set}` — A small ring by the clock opens the same list. Example: "ENG 12:04 ChatGPT plan Account 1 · 12% left ChatGPT plan Account 2 · 88% left ChatGPT plan Account 3 · 100% left Claude plan Account 1 · 41% left"

6. **SPEND, LAST 7 DAYS section:**
   - Display: "Ada $1.10, Scout $0.42, Ledger $0.18, Branch $0.00"
   - Note: "This month: $14.20. Plans are billed by their own sites; work on this computer is free."

7. **KEEPING THINGS section:**
   - **Keep conversations radio buttons:** "30 days" / "1 year" / "Forever" [selected] `{act=seg}` — Retention period.
   - Description: "Older ones are deleted for good."
   - **Checkpoints section:**
     - Button: "See all" `{act=toast msg=3 checkpoints kept this week.}` — Shows checkpoint list.
     - Description: "Kept before a Trunk changes files. Put any of them back."

8. **TEST THE MODEL YOU USE section:**
   - Description: "Run a ready-made set of tasks against the model you use now, see which it got right, what it cost, and whether anything that used to work has stopped."
   - **Test set radio buttons:** "Everyday · 20" [selected] / "Money · 12" / "Research · 15" `{act=seg}`.
   - Description: "Each task is checked the same way every time."
   - Button: "Run the test" `{act=eval-run}` — Executes test suite.

- **Visibility:** All controls at Regular level.
- **Source:** `renderUsage()` function.

##### Gateway

- **Page ID:** "gateway"
- **What it is:** Settings for keeping Branch running in the background (background service).
- **Controls:**

1. **Info:** "A small helper that keeps Branch running in the background, starts it again if it stops, and carries interrupted work on."
2. **Status display:** "The gateway is off — Off. When you close Branch, your Trunks stop, and Telegram and automations go quiet until you open it again."

3. **KEEP BRANCH RUNNING section:**
   - **Gateway radio buttons:** "Off" [selected] / "When needed" / "On" `{act=gw-mode v=...}`.
   - Description: "Recommended: On. Telegram, your phone and automations keep working when the window is closed."

4. **Carry on interrupted work section:**
   - Checkbox: "Carry on interrupted work by itself" [on] `{sw=set}` — After a restart, safe steps carry on. Anything that sends or changes something asks you first.

5. **Show the gateway section:**
   - Checkbox: "Show the gateway in the tray" [on] `{sw=set}` — A small Branch icon by the clock with Restart and Quit.

6. **WHAT IT HAS BEEN DOING section:**
   - Display: "Nothing is watching Branch — The gateway is off, so a stopped engine stays stopped"

7. **Button:** "Restart the engine" `{act=gw-restart}` — Manually restarts the gateway.

8. **Note:** "Switch to Technical (bottom left) to see file paths, ports and raw settings."

- **Visibility:** All controls at Regular level.
- **Source:** `renderGateway()` function.

##### Branch itself

- **Page ID:** "self"
- **What it is:** Branch app configuration (app name, icon, behavior, recovery).
- **Controls:**

1. **Running status display:** "Running · up 3 days, 4 hours"
2. **Engine info:** "Engine 0.19.4 · process 18244 · 412 MB · the gateway watches it and starts it again if it stops."

3. **Maintenance buttons:**
   - Button: "Check and fix" `{act=doctor}` — Runs diagnostic and fixes issues.
   - Button: "Restart the engine" `{act=gw-restart}` — Restarts Branch.
   - Button: "Reload without dropping work" `{act=toast msg=Reloaded without dropping work: N tasks carried on.}` — Refreshes without losing tasks.

4. **WHAT BRANCH MAY CHANGE ABOUT ITSELF section:**
   - **Its own settings radio buttons:** "Ask me first" [selected] / "Never" `{act=seg}` — It shows you the change first, tried on a throwaway copy.
   - **Loosening what it may do radio buttons:** "Ask every time" [selected] `{act=seg}` — Asked every time; the answer is never kept.
   - **The gateway's timings radio buttons:** "Suggest" [selected] / "Never" `{act=seg}` — It can suggest; you decide.
   - **Restarting its own engine radio buttons:** "Allowed" [selected] / "Ask me first" `{act=seg}` — When it's stuck. Safe steps carry on after.
   - **Updating itself radio buttons:** "Allowed" [selected] / "Ask me first" / "Never" `{act=seg}` — Only when nothing is working, with a safety copy.
   - **Its own program and your saved work:** "Never, by itself" (fixed) — This one can't be switched on.

5. **Work on its own code section:**
   - Checkbox: "Work on its own code in a separate copy" [off] `{sw=set}` — A private copy of Branch's source. The installed app is never touched. Off until you switch it on.

6. **NEVER DIES section:**
   - Description: "If the engine stops: The gateway starts it again, holding messages for up to 20 seconds"
   - Description: "If it keeps crashing: After 4 quick crashes it rolls back to the last good settings and tells you"
   - Description: "Interrupted work: Safe steps carry on by themselves; anything that sends or changes something asks first"

7. **LAST GOOD SETTINGS section:**
   - Display: "Today 09:00 · kept automatically"

8. **EVERY CHANGE section:**
   - Log of recent changes:
     - "The engine stopped answering; the gateway started it again in 0.5 s — Today 09:14"
     - "You: Scout may use Opus 5.5 for hard tasks — Mon 18:02 — Roll back" `{act=toast msg=Rolled back to before that change.}`
     - "Branch suggested: wait 30 s before deciding the engine is stuck · tried on a throwaway copy — Sun 10:40"

- **Visibility:** All controls at Regular level.
- **Source:** `renderSelf()` function.

##### Updates & about

- **Page ID:** "updates"
- **What it is:** Version info, update checks, and release notes.
- **Controls:**

1. **Header:** "Branch Agent 0.19.4 on Windows."

2. **Update status display:** "0.20.0 is ready to install — It installs when no task is running, and keeps a safety copy first."

3. **Buttons:**
   - Button: "Install when nothing is running" `{act=install}` — Installs update.
   - Button: "What's new" `{act=toast msg=Release notes open in the browser.}` — Shows release notes.

4. **UPDATING section:**
   - Checkbox: "Keep Branch up to date by itself" [on] `{sw=set}` — Checks every day.
   - Button: "Undo" `{act=toast msg=Goes back to 0.19.3 from the safety copy.}` — Reverts last update.
   - Display: "Undo the last update — Undo — 0.19.4 installed Sep 20."

5. **REMOVE BRANCH section:**
   - Description: "The app — Removed · 412 MB"
   - Description: "Programs it downloaded to run models — Removed · 1.1 GB"
   - Description: "Models on this computer — Removed · 19.8 GB"
   - Checkbox: "Keep my conversations and settings" [on] — Kept · 86 MB. Branch finds them again if you install it later.
   - Text input: "Type Branch Agent to confirm" — Confirmation field to prevent accidental deletion.
   - Button: "Remove Branch and everything it installed" [disabled] `{act=toast msg=Prototype: Branch would close and remove itself now. Nothing was removed.}` — Uninstall button.

- **Visibility:** All controls at Regular level.
- **Source:** `renderUpdates()` function.

##### Achievements

- **Page ID:** "achievements"
- **What it is:** Milestones and badges earned through use of Branch.
- **Controls:**

1. **Header:** "Private to you, never nagging. 7 of 505 unlocked."

2. **Progress display:**
   - "Bronze · 4/100"
   - "Silver · 2/100"
   - "Gold · 0/100"
   - "Diamond · 0/100"
   - "Godly · 0/100"
   - "SSS+ · 0/5"

3. **Category tabs (buttons):**
   - "All" [selected] `{act=achcat v=All}` — All achievements.
   - "Getting started" `{act=achcat v=Getting started}` — First-time actions.
   - "Trunks & devices" `{act=achcat v=Trunks & devices}` — Trunk setup and management.
   - "Automations" `{act=achcat v=Automations}` — Scheduling and triggers.
   - "Looks & fun" `{act=achcat v=Looks & fun}` — Customization and aesthetics.
   - "Streaks" `{act=achcat v=Streaks}` — Consistency over time.
   - "Safety" `{act=achcat v=Safety}` — Security and permissions.
   - "Explorer" `{act=achcat v=Explorer}` — Discovery and advanced features.
   - "Secrets" `{act=achcat v=Secrets}` — Hidden and rare achievements.
   - And more (20+ categories total).

4. **Achievement list (filtered by category):** Displays 505 total achievements with title, description, tier (Bronze/Silver/Gold/Diamond/Godly/SSS+), and lock/unlock state. Examples:
   - "Look – Send your first message" (Bronze, unlock)
   - "It did the thing – A task finished for the first time" (Bronze, unlock)
   - "First words – Send your first message" (Bronze, unlock)
   - "The whole tree – Unlock every one of the other 500 achievements" (SSS+, locked)
   - Many more (see harvest data for complete list).

5. **SETTINGS section:**
   - Checkbox: "Keep achievements quiet" [off] `{sw=achquiet}` — No pop-ups. They still unlock. Bronze and Silver pop small for 7 seconds; Gold and up get the big one with confetti.
   - Description: "Hints: Bronze and Silver get a pet hint at most once an hour; Gold and up get none. 128 of 505 are drawn in this prototype."

- **Visibility:** All controls at Regular level.
- **Source:** `renderAchievements()` function.

#### Settings Pages: Advanced (shown from the Advanced level)

##### Advanced
- **Page ID:** `advanced`.
- **When it appears:** the settings list gains a group called "More" with "Advanced" when "How much to show" is Advanced or Technical (`LV[S.level] >= 1`). At Regular it is hidden, and opening it falls back to General.
- **What it is:** "What’s running under the hood, for when something needs a look."
- **What it shows:**
  - **Branch service:** "Running"; Version `0.19.4`; Address `127.0.0.1:3210`; Process `27540`; buttons "Restart" and "Open logs".
  - **Model on this computer:** "Loaded on first request"; Model "Qwen3.6 35B"; Room "256K words of context"; Size "19.8 GB"; buttons "Restart" and "Open logs".
  - **Browser:** "Ready"; Profile "Branch’s own"; Windows open `1`; buttons "Restart" and "Open logs".
  - **Seeing more** (switches): "Show the thinking" ("Adds the model’s reasoning under each reply, folded."); "Keep an activity log" ("Every step, kept for 30 days on this computer."); "Send crash reports" ("Only the error, never your conversations.").

#### Settings Pages: Developer (shown at the Technical level)

##### Developer
- **Page ID:** `developer`.
- **When it appears:** under "More" only when "How much to show" is Technical (`LV[S.level] >= 2`).
- **What it is:** "For people building on Branch."
- **What it shows:**
  - **Local address:** `127.0.0.1:3210` with a "Copy" button. "Only this computer can reach it. Requests need your session key."
  - **Session key:** shown as dots, with "Make a new one". "Never shown in full here."
  - **Help with code:** "Use language servers" ("Programs you already installed, one per line.") and "Use a debugger" ("Nothing downloads, and nothing runs until this is on.").

#### Settings Navigation Behavior

- **Level toggle behavior:**
  - Regular level (default): Shows 17 pages (General, People, Appearance, Notifications, Instructions & personality, Models, On this computer, Accounts, Voice, Permissions, Computer & browser, Saved sign-ins, Data & usage, Gateway, Branch itself, Updates & about, Achievements). Buttons show "Regular" [selected], "Advanced", "Technical".
  - Advanced level: Adds "Advanced" page button. Sidebar shows four groups PLUS "MORE" section with "Advanced" button. Level buttons show "Regular", "Advanced" [selected], "Technical".
  - Technical level: Adds "Developer" page button. Sidebar shows all 19 pages. Level buttons show "Regular", "Advanced", "Technical" [selected].

- **Search functionality:** Text input at top of sidebar filters pages by name/keyword in real-time.

- **Persistence:** Selected level is stored in `S.level` and persists across sessions.

---

### 5.3 Popovers (20 Total)

Popovers are context menus and dialogs that appear on demand, opened by `data-act="..."` attributes or user interactions. Below are all 20 popovers with their items and behavior.

#### Popover: chatmenu

- **Opens via:** `data-act="chatmenu"` on a Trunk/chat header (menu button or right-click).
- **Items (12 total):**
  1. "Share…" `{act=share10}` — Shares Trunk or conversation.
  2. "Share this Trunk…" `{act=share10}` — Shares Trunk with team.
  3. "Who it knows" `{act=roster10}` — Shows Trunk's learned contacts.
  4. "Unpin" `{act=pin}` — Unpins Trunk from sidebar.
  5. "Pause this Trunk" `{act=pausetrunk}` — Pauses Trunk temporarily.
  6. "Rename" `{act=rename}` — Renames Trunk.
  7. "Edit Trunk…" `{act=edit}` — Opens Trunk editor.
  8. "Show it how, once" `{act=teach-start}` — Teaches Trunk a procedure by watching.
  9. "Talk out loud" `{act=call}` — Initiates voice call with Trunk.
  10. "Look inside the last reply" `{act=inspect}` — Shows execution details.
  11. "Export conversation" `{act=toast}` — Exports chat history.
  12. "Remove Trunk…" `{act=remove}` — Deletes Trunk.
- **Purpose:** Manage a Trunk: pause, edit, teach, call, inspect, share, remove.

#### Popover: comps

- **Opens via:** `data-act="comps"` — Computer selector.
- **Items (9 total):**
  1. "Private computer 1Windows · a sealed box on this PC" `{act=comp-toggle v=sandbox}` — Toggles computer for current Trunk.
  2. "Private computer 2Windows · a second sealed box on this PC" `{act=comp-toggle v=sandbox2}` — Toggles computer.
  3. "This computerYour Windows desktop" `{act=comp-toggle v=this}` — Toggles computer.
  4. "KeepOak computerConnect keepoak.com first" `{act=comp-toggle v=keepoak}` — Toggles KeepOak computer (requires connection).
  5. "taofik-aiLinux · home server · no screen" `{act=comp-toggle v=server}` — Toggles computer.
  6. "LegionWindows · gaming PC · asleep, wakes when asked" `{act=comp-toggle v=legion}` — Toggles computer.
  7. "Office Mac minimacOS · at the office · online" `{act=comp-toggle v=mac}` — Toggles computer.
  8. "Add a computer" `{act=comp-add}` — Adds new computer.
  9. "Manage computers" `{act=setgo v=computer}` — Opens Computer & browser settings.
- **Purpose:** Select or toggle which computers a Trunk may use.

#### Popover: gateway

- **Opens via:** `data-act="gateway"` in Gateway settings or tray icon.
- **Items (5 total):**
  1. "Off" `{act=gw-mode v=off}` — Turns gateway off.
  2. "When needed" `{act=gw-mode v=when-needed}` — Runs gateway when needed.
  3. "On" `{act=gw-mode v=on}` — Keeps gateway always on.
  4. "Restart the engine" `{act=gw-restart}` — Manually restarts gateway.
  5. "Gateway settings…" `{act=setgo v=gateway}` — Opens Gateway settings page.
- **Header text:** "Gateway — Off. When you close Branch, your Trunks stop, and Telegram and automations go quiet until you open it again. — Keep Branch running"
- **Status display:** "What it has been doing — Nothing is watching Branch — The gateway is off, so a stopped engine stays stopped"
- **Purpose:** Control gateway mode and manually restart.

#### Popover: guide

- **Opens via:** `data-act="help"` or Guide button (top right).
- **Items (5 total):**
  1. "What's newthis version" `{act=whatsnew13}` — Shows what's new in current version.
  2. "Set up Branch3 min" `{act=onboard}` — Launches setup wizard.
  3. "Take the walkthrough2 min" `{act=tour}` — Runs guided tour.
  4. "Show the design noteswhy each part is here" `{act=notes-toggle}` — Toggles design notes display.
  5. "Start the prototype overforgets your choices" `{act=proto-reset}` — Resets all settings to defaults.
- **Purpose:** Access onboarding, tour, and help resources.

#### Popover: machines

- **Opens via:** `data-act="machines"` in Workspace switcher (top of sidebar).
- **Items (11 total):**
  1. "PersonalJust you and this household" `{act=ws v=personal}` — Switches to personal workspace.
  2. "Hartwell teamSample · connect keepoak.com" `{act=ws v=team}` — Switches to team workspace (sample).
  3. "This computer Online · you are here" `{act=machine v=0}` — Shows this computer status.
  4. "" (rename field) `{act=renamecomp}` — Renames this computer.
  5. "taofik-ai Online · home server" `{act=machine v=1}` — Shows server status.
  6. "" (rename field) `{act=renamecomp}` — Renames server.
  7. "Legion Asleep · wakes when asked" `{act=machine v=2}` — Shows Legion status.
  8. "" (rename field) `{act=renamecomp}` — Renames Legion.
  9. "KeepOak computer Connect keepoak.com to use it" `{act=machine v=3}` — Shows KeepOak status.
  10. "" (rename field) `{act=renamecomp}` — Renames KeepOak computer.
  11. "Add a computer or phone…" `{act=addcomp}` — Adds new device.
- **Purpose:** Switch workspaces and manage multi-device setup.

#### Popover: mention

- **Opens via:** `@mention` typed in chat or `@` button in message box.
- **Items (4 total):**
  1. "ScoutResearch" `{act=mention-pick v=Scout}` — Mentions Scout Trunk.
  2. "LedgerMoney & receipts" `{act=mention-pick v=Ledger}` — Mentions Ledger Trunk.
  3. "AdaPlans trips" `{act=mention-pick v=Ada}` — Mentions Ada Trunk.
  4. "FieldnotesReading & notes" `{act=mention-pick v=Fieldnotes}` — Mentions Fieldnotes Trunk.
- **Header:** "Call a Trunk"
- **Purpose:** Mention another Trunk in chat.

#### Popover: modelmenu

- **Opens via:** `data-act="modelmenu"` in Models settings or model selector in chat.
- **Items (5 total):**
  1. "Qwen3.6 35BOn this computer · free · private" `{act=model v=Qwen3.6 35B}` — Selects local model.
  2. "Your ChatGPT accountSigned in" `{act=model v=Your ChatGPT account}` — Selects ChatGPT.
  3. "Your Claude accountSigned in" `{act=model v=Your Claude account}` — Selects Claude.
  4. "Second opinion on hard questions" (heading/note)
  5. "Manage models…" `{act=setgo v=models}` — Opens Models settings.
- **Header:** "Which model answers"
- **Purpose:** Quick model selector for conversation.

#### Popover: modelmenu2

- **Opens via:** `data-act="modelmenu"` in expanded model settings (detailed view).
- **Items (12 total):**
  1. "GPT-6 SolChatGPT plan · Account 1 · used next" `{act=pick-model v=GPT-6 Sol}` — Selects GPT-6.
  2. "Opus 5.5Claude plan · Account 1" `{act=pick-model v=Opus 5.5}` — Selects Opus 5.5.
  3. "QQwen3.6 35BOn this computer · free · private" `{act=pick-model v=Qwen3.6 35B}` — Selects Qwen3.6.
  4. (Thinking options heading)
  5. "Low" `{act=pick-think v=Low}` — Sets thinking level to Low.
  6. "Medium" `{act=pick-think v=Medium}` — Sets thinking to Medium.
  7. "High" `{act=pick-think v=High}` — Sets thinking to High.
  8. "Extra high" `{act=pick-think v=Extra high}` — Sets thinking to Extra high.
  9. "Thinking options depend on the model. When Account 1 runs out, Branch moves to Account 2." (note)
  10. "Accounts and order…" `{act=setgo v=accounts}` — Opens Accounts settings.
  11-12. (Additional items if present)
- **Header:** "Which model answers"
- **Purpose:** Detailed model and thinking level selector.

#### Popover: modemenu

- **Opens via:** `data-act="mode"` or mode button in conversation header.
- **Items (8 total):**
  1. "Ask for everythingEvery step waits for you" `{act=mode v=Ask for everything}` — Sets mode to Ask for everything.
  2. "Ask firstAsks before sending, deleting, spending or installing" `{act=mode v=Ask first}` — Sets mode to Ask first.
  3. "Just do itTells you after; Lockdown still stops it" `{act=mode v=Just do it}` — Sets mode to Just do it.
  4. (Applies to heading)
  5. "This conversation" `{act=scope v=here}` — Scope: this conversation only.
  6. "Everywhere" `{act=scope v=everywhere}` — Scope: all conversations.
  7. " Lockdown" (note)
  8. "All permissions…" `{act=setgo v=permissions}` — Opens Permissions settings.
- **Header:** "How much may Trunks do?"
- **Purpose:** Set execution mode (Ask for everything, Ask first, Just do it) for conversation or globally.

#### Popover: modemenu2

- **Opens via:** `data-act="set-mode"` in conversation settings (advanced mode selector).
- **Items (8 total):**
  1. "AutoBranch decides what's safe and only asks about risky things.1" `{act=set-mode v=auto}` — Sets mode to Auto.
  2. "Ask firstAlways asks before changing files, running commands or using the internet." `{act=set-mode v=ask}` — Sets mode to Ask first.
  3. "Plan firstWrites a plan and waits for your OK before doing anything.3" `{act=set-mode v=plan}` — Sets mode to Plan first.
  4. "Full accessDoes anything on this computer without asking: files, commands, the internet.4" `{act=set-mode v=none}` — Sets mode to Full access.
  5. (Applies to heading)
  6. "This conversation" `{act=scope v=here}` — Scope: this conversation.
  7. "Everywhere" `{act=scope v=everywhere}` — Scope: globally.
- **Header:** "How much may it do in this conversation?"
- **Purpose:** Detailed per-conversation execution mode control.

#### Popover: newmenu

- **Opens via:** `data-act="newmenu"` on "+" button in sidebar or top bar.
- **Items (7 total):**
  1. "New conversationCtrl N" `{act=newconv}` — Creates new conversation.
  2. "New Trunk" `{act=chat id=new}` — Creates new Trunk.
  3. "New room" `{act=toast}` — Creates new room (pick 2+ Trunks).
  4. "New automation" `{act=ptab v=scheduled}` — Creates new automation.
  5. "A Trunk from a job…" `{act=ptab v=trunks}` — Uses job template.
  6. "New group chatpeople, Trunks, agents" `{act=grp-new}` — Creates group chat.
  7. "Have Branch make a Trunk" `{act=mk-new}` — AI-generated Trunk creation.
- **Purpose:** Create new items (conversation, Trunk, room, automation, group chat).

#### Popover: owner

- **Opens via:** `data-act="owner"` on user avatar (top-left sidebar).
- **Items (16 total):**
  1. "TTaofik" `{act=switchto}` — Switches to Taofik.
  2. "GGuest" `{act=switchto}` — Switches to Guest.
  3. "+Add" `{act=invite}` — Adds new person.
  4. (Look heading)
  5. "Light" `{act=themeset v=light}` — Sets light mode.
  6. "Dark" `{act=themeset v=dark}` — Sets dark mode.
  7. "Auto" `{act=themeset v=system}` — Sets auto (system) mode.
  8. "SettingsCtrl ," `{act=view v=settings}` — Opens Settings.
  9. "Achievements8" `{act=setgo v=achievements}` — Opens Achievements.
  10. "Keyboard shortcuts?" `{act=shortcuts}` — Shows keyboard shortcuts.
  11. "Guide: why each thing is here" `{act=help}` — Opens Guide popover.
  12. "Update to 0.20.0" `{act=updmenu-go}` — Opens Update menu.
  13. "Replay the first run" `{act=firstrun}` — Replays first-time setup.
  14. "About Branch" `{act=about}` — Shows about dialog.
  15. "Lock Branch" `{act=lockscreen}` — Locks Branch to owner profile.
  16. (Additional items possible)
- **Header:** "Who is using Branch"
- **Purpose:** User profile switcher, theme, settings, and help.

#### Popover: plusmenu

- **Opens via:** `data-act="plusmenu"` on message box "+" button.
- **Items (13+ total):**
  1. "Attach files" `{act=toast}` — Attaches files from disk.
  2. "Add a folder" `{act=toast}` — Adds a folder for context.
  3. "Take a screenshot" `{act=toast}` — Captures screen.
  4. "Mention a Trunk@" `{act=insert v=@}` — Inserts @ mention.
  5. "Use a skill/" `{act=insert v=/}` — Inserts / command.
  6. (Who answers heading)
  7. "BranchThe assistant on this computer" `{act=who v=Branch}` — Selects Branch.
  8. "Scout" `{act=who v=Scout}` — Selects Scout.
  9. "Ledger" `{act=who v=Ledger}` — Selects Ledger.
  10. "Ada" `{act=who v=Ada}` — Selects Ada.
  11. "Fieldnotes" `{act=who v=Fieldnotes}` — Selects Fieldnotes.
  12. "Make a picture" `{act=imagine}` — Generates image.
  13. "Set a goal/goal" `{act=goal-fill}` — Sets goal.
  14. "Saved prompts/" `{act=prompts-fill}` — Shows saved prompts.
- **Purpose:** Attach files, mention Trunk, insert command, select Trunk, image/goal.

#### Popover: roommenu

- **Opens via:** `data-act="roommenu"` on conversation/room header.
- **Items (2–3 total):**
  1. "Room left in this conversation — 86% of 256K words of context is free." (heading/info)
  2. "Conversation — 9% — Instructions — 3% — Tools — 2%" (context breakdown)
  3. "Tidy up this conversation" `{act=toast}` — Cleans up old messages to save context.
- **Purpose:** Show context usage and tidy conversation.

#### Popover: rowmenu
- **Opens via:** right-clicking a conversation or Trunk row in the sidebar (or its menu button). `POPS.rowmenu(id)`.
- **Items for every row:** "Open" (`chat`), "Pin to top" / "Unpin" (`pin-id`), "Rename" (`rename-id`).
- **Rooms also get:** "Leave and archive" (toast "Archived. Find it in search.").
- **Trunks also get:** "New conversation with <name>" (`new-with`), "Pause" / "Resume" (`pausetrunk`), "Edit Trunk…" (`edit`), and "Remove…" in red (`remove`).

#### Popover: slash

- **Opens via:** `/` typed in message box.
- **Items (4+ total):**
  1. "/briefShort brief with sources" `{act=slash-pick v=/brief}` — Picks /brief command.
  2. "/tidyTidy a folder" `{act=slash-pick v=/tidy}` — Picks /tidy command.
  3. "/reportExpense report" `{act=slash-pick v=/report}` — Picks /report command.
  4. "/learnRemember something from this conversation" `{act=slash-pick v=/learn}` — Picks /learn command.
- **Header:** "Skills"
- **Purpose:** Quick command/skill picker.

#### Popover: spendmenu

- **Opens via:** `data-act="spendmenu"` in Data & usage settings or usage ring.
- **Items (2 total + data):**
  1. "Spend — Today $0.00 · this week $1.70. Work on this computer is free." (header)
  2. Cost breakdown: "Ada $1.10, Scout $0.42, Ledger $0.18" (spending per Trunk)
  3. "Data & usage…" `{act=setgo v=usage}` — Opens Data & usage settings.
- **Purpose:** Show current spending and costs per Trunk.

#### Popover: surfaces

- **Opens via:** `data-act="surface"` in Everywhere settings or app switcher.
- **Items (6 total):**
  1. "WindowsThe Windows app" `{act=surface v=desktop}` — Switches to Windows.
  2. "MacThe Mac app" `{act=surface v=mac}` — Switches to Mac.
  3. "Terminalbranch, in any terminal" `{act=surface v=terminal}` — Switches to terminal.
  4. "iPhoneThe iPhone app" `{act=surface v=iphone}` — Switches to iPhone.
  5. "AndroidThe Android app" `{act=surface v=android}` — Switches to Android.
  6. "Webkeepoak.com in a browser" `{act=surface v=web}` — Switches to web.
- **Header:** "Show Branch as"
- **Purpose:** Switch between app surfaces/platforms.

#### Popover: updmenu

- **Opens via:** `data-act="updmenu"` on update notification.
- **Items (2 total):**
  1. "Install when nothing is running" `{act=install}` — Installs update.
  2. "Remind me tomorrow" `{act=closepop}` — Closes popover and delays.
- **Header:** "Branch 0.20.0 is ready — Installs when nothing is running and keeps a safety copy first. — Rooms can have rules / Faster first answer on this computer / Checkpoints before every file change"
- **Purpose:** Install or defer update.

#### Popover: usagepop

- **Opens via:** `data-act="usagepop"` or usage ring click.
- **Items (detailed table + button):**
  - "What each connection has left" (header)
  - Table with rows per account (ChatGPT Account 1, ChatGPT Account 2, …, Claude accounts, Gemini, OpenRouter, Qwen, etc.) showing:
    - Provider · Plan — Status (Measured/Estimate/Not published/Not asked) — Used next status — Time window — Percentage left and reset time — Data source
  - Bottom row: "7 of 9 connections report a limit. The other 2 do not publish one. Accounts are never added together. This month: $14.20"
  - Button: "Open Usage" `{act=setgo v=usage}` — Opens detailed Data & usage settings.
- **Purpose:** See detailed usage and limits for all accounts.

---

### 5.4 Places, more (pass 15)

Each Place gains new tabs and features to display deeper information and controls.

#### Inbox › History: the verification record

- **What it is:** A log of every action and message, with a "Record intact" button that verifies nothing was deleted or rewritten.
- **When it appears:** Always visible in Inbox › History tab.
- **How it works:**
  1. A button (`.rec15`) appears with shield icon and text "Record intact" and blue link "Verify".
  2. Clicking opens a verification dialog that checks all 1,284+ entries in the record.
  3. A spinning arc (`.ver-arc15`) animates for 1.3 seconds, then shows the result: `"All 1,284 entries link up, from the first on June 3 to the one at 11:58 today. Nothing was cut or rebuilt."`.
  4. At Technical level (`lvl15() >= 2`), a code hash is shown: `"chain head 3f9a…c21e · sha-256"`.

- **How it looks:**
  - Button: `.rec15` with shield icon, text "Record intact", clickable "Verify" link.
  - Dialog: `.ver15` container with spinner ring (`.ver-ring15`), title `"Checking the record"`, status text.
  - Result: green check, heading "Record intact", paragraph with details and optional code.

- **What it says:**
  - Button: `"Record intact · Verify"`
  - Dialog title: `"Checking the record"`
  - While checking: `"Checking 1,284 entries… Each entry carries a fingerprint of the one before it."`
  - Result: `"All 1,284 entries link up, from the first on June 3 to the one at 11:58 today. Nothing was cut or rebuilt."`

- **Source:** `patch15c.js` lines 9–20.

---

#### Automations › scheduled: health sparklines

- **What it is:** A small line chart for each automation showing how long each of the last 12 runs took, and whether it needs your attention.
- **When it appears:** In Automations › scheduled tab, next to each automation's name.
- **How it works:**
  1. For each automation, `HEALTH15` stores: run count, status ("all fine" or "1 needed you"), and an array of 12 run times (seconds).
  2. `spark15()` generates an SVG sparkline: polyline with points scaled to fit a small box.
  3. If status is "all fine", the chart is plain; if not, it has a `.warn15` class (orange/amber tint).

- **How it looks:**
  - Sparkline: 64px wide × 18px tall, SVG polyline in dark text color.
  - Label: count ("12 runs"), status ("all fine" or "1 needed you"), right-aligned next to the automation name.
  - Class: `.health15` (plain or `.warn15` if status is not "all fine").

- **What it says:**
  - Status: `"all fine"` or `"1 needed you"` (singular/plural based on count).
  - Tooltip: `"Time per run, last N runs"`.

- **Source:** `patch15c.js` lines 22–31.

---

#### Automations › scheduled: 13 ideas to start from

- **What it is:** A gallery of 13 pre-written automation templates grouped by purpose (Money, Mornings, Home, Research, Work), with short descriptions.
- **When it appears:** In Automations › scheduled tab, below the list of existing automations.
- **How it works:**
  1. A "Ideas" section shows 3 template cards (`.idea15`).
  2. Each card has icon, category, title, description, and `data-act="idea15" data-i="INDEX"`.
  3. Clicking "See all 13" opens a dialog grouped by category (5 groups: Money, Mornings, Home, Research, Work).
  4. Clicking a template fills the "describe what to do" input at the bottom with that template's prompt, and shows toast "Filled in. Change anything, then Add."
  5. The 13 templates cover: Receipts into folders, Subscription watch, Bill reminders, Morning brief, Inbox triage, Tidy Downloads, Backup check, Photo clean-up, Price tracker, News on a topic, Page change alert, Meeting notes, Weekly report.

- **How it looks:**
  - Idea card (`.idea15`): small tile with category label (small, muted), bold title, description, optional button.
  - Dialog: Title "Ideas for automations", grouped sections (Money, Mornings, Home, Research, Work), each section with 1–3 cards, arranged in a grid.
  - Section header: group name (e.g., "Money", "Mornings").

- **What it says:**
  - Card button: `"See all 13"`
  - Examples: `"Receipts into folders"`, `"Morning brief"`, `"Tidy Downloads"`, etc.
  - Category: `"Money"`, `"Mornings"`, `"Home"`, `"Research"`, `"Work"`.

- **Source:** `patch15c.js` lines 33–52.

---

#### Automations › Board tab (task board with 5 columns)

- **What it is:** A Kanban-style board showing work that spans multiple days, organized in columns: To do, Doing, To check, Done, Stuck.
- **When it appears:** In Automations › Board tab.
- **How it works:**
  1. The board renders from `S.board15` array, each entry `{id, t, who, col, note}`.
  2. Five columns are defined in `COLS15`: `['todo', 'doing', 'check', 'done', 'stuck']`.
  3. Cards (`.card15`) are draggable (`draggable="true"`); drag-and-drop listeners on the page handle reordering.
  4. Each card shows: title, avatar + note (who + status), and a menu button (three dots, `data-act="bmove15"`).
  5. Clicking the menu opens a popover (`POPS.bmove15(id)`) listing the 5 columns as radio options.
  6. Selecting a column calls `bto15` action: `data-v="${column_key}"`, moves the card, and shows toast `"Moved to ${column_name}."`.

- **How it looks:**
  - Board: `.board15` grid with 5 columns side-by-side, each column (`.col15`) has a header with title + count.
  - Card: `.card15` with title (bold), footer with avatar (18px), note text, and menu button.
  - Empty state per column: `<p class="c-empty15">Nothing here</p>`.
  - Drag indication: `.dragging15` class on the card being dragged, `.over15` class on the column being hovered.

- **What it says:**
  - Column headers: `"To do"`, `"Doing"`, `"To check"`, `"Done"`, `"Stuck"` (each with count).
  - Menu option: column name as a radio option (e.g., "Move to Doing").
  - Toast: `"Moved to [column name]."`
  - Hint above board: `"Work that takes more than one sitting. Trunks move their own cards; drag one to move it yourself."`

- **States:** Cards in each column show a running count; empty columns show a placeholder.

- **Source:** `patch15c.js` lines 54–76.

---

#### Automations › Flow editor: time travel (go back to a step)

- **What it is:** When editing an automation's flow, a track below the editor shows the last 12 runs, so the user can inspect what the automation was doing at any step.
- **When it appears:** In Automations › [automation name] › Flow tab (when editing a saved automation with run history).
- **How it works:**
  1. A `.tt15` section appears below the flow diagram.
  2. It shows "Last run" with the date/time (e.g., "Friday 5:00 PM") and the number of steps in that run.
  3. A track (`.tt-track15`) shows buttons for each step (e.g., 5 steps → 5 buttons).
  4. Clicking a step button (`data-act="tt15" data-v="${step_index}"`) sets `S.tt15` to that step index.
  5. A panel below shows: the step number, its text, and what the automation had at that step (e.g., "214 files listed").
  6. A button `"Go back to this step"` (`data-act="ttback15"`) starts a copy of the automation from that step, leaving the original untouched.

- **How it looks:**
  - Header: `<b>Last run</b>` + date and step count in small text.
  - Track: horizontal row of step buttons (`<button>`), separated by spacers (`<u></u>`), each button shows:
    - A dot indicator (`<i></i>`, filled if past, outlined if current)
    - Step number (e.g., "1", "2")
    - Button has class `on15` if current, `past15` if before the selected step
  - Detail panel (when a step is selected): `<div class="tt-at15">` showing step number, step text, status, and button.

- **What it says:**
  - Header: `"Last run"`, e.g., `"Friday 5:00 PM · 5 steps"`
  - Detail: `"At step [N]"`, followed by the step's text and result.
  - Button: `"Go back to this step"`
  - Toast after clicking: `"Running a copy from step [N]. The real run is untouched; the copy shows in its conversation."`
  - Placeholder (no step selected): `"Pick a step to see what it had at that moment."`

- **Source:** `patch15c.js` lines 78–90.

---

#### Library › Memory: capacity ring and tidy-up

- **What it is:** A visual ring showing how full memory is (out of 500 facts), a "Tidy up" button that finds duplicates and unused facts, and an "Archived facts" dialog.
- **When it appears:** In Library › Memory tab.
- **How it works:**
  1. A ring (`.ring15`) is drawn via SVG: outer circle (transparent), arc overlay with dash-array showing usage percentage.
  2. A "Tidy up" button (`data-act="tidy15"`, shows count "3" if 3 issues found) opens a dialog.
  3. The dialog lists issues (`.tidy15`): duplicates ("Said twice"), disagreements ("Disagree"), unused ("Not used in 120 days").
  4. Each issue shows the conflicting fact text and two action buttons: "Leave it" or an action (e.g., "Merge them", "Keep the newer one", "Archive it").
  5. Clicking an action updates that row (adds class `.done15`) and disables further actions on that row.

- **How it looks:**
  - Ring: SVG with viewBox "0 0 36 36", outer circle (`.r-arc15`), filled arc showing usage.
  - Status text: `"N of 500 remembered"` below the ring.
  - Tidy button: primary button with count badge (`.n15`), e.g., "Tidy up 3".
  - Dialog: title "Tidy up memory", intro hint, rows for each issue.
  - Issue row (`.td-row15`): category badge (`.td-k15`), fact text, two action buttons (ghost + primary).

- **What it says:**
  - Ring label: `"N of 500 remembered"` (e.g., "342 of 500 remembered").
  - Tidy intro: `"Found by comparing what each fact means, not only its words. Nothing changes until you choose."`
  - Issue categories: `"Said twice"`, `"Disagree"`, `"Not used in 120 days"`.
  - Action buttons: `"Leave it"`, `"Merge them"`, `"Keep the newer one"`, `"Archive it"`.
  - Status after action: `"Merged."`, `"Done"`, `"Kept."`, `"Archived."`.
  - More menu: Export (JSON Lines), Save a full archive (.zip), Archived facts, Memory settings.

- **Source:** `patch15c.js` lines 92–119.

---

#### Library › Documents: list or map view

- **What it is:** Two views of documents: a traditional list, or a knowledge map showing how documents and topics connect.
- **When it appears:** In Library › Documents tab.
- **How it works:**
  1. A segmented control (`.dv15`) lets users toggle between "List" and "Map" views (`data-act="dv15" data-v="list|map"`).
  2. In Map view, an SVG graph is drawn (`<svg class="kmap15">`):
     - Nodes for topics (large dots) and documents (small dots).
     - Edges (lines) connecting related documents and topics.
     - Each node has a label (centered below or beside it).
  3. The map is built from `MAP15.nodes` (array of `[name, x, y, type]`) and `MAP15.edges` (array of `[from_idx, to_idx]`).

- **How it looks:**
  - Toggle buttons: "List" and "Map", each with icon (`ic('list15', 's')` and `ic('map15', 's')`).
  - List view: standard row list (unchanged from before).
  - Map view: SVG graph with:
    - Lines (edges) in a light stroke colour.
    - Topic circles: larger (r=9), filled with a topic colour (e.g., `var(--fill)`).
    - Document circles: smaller (r=6), filled differently (e.g., `var(--line-2)`).
    - Labels: text beneath or beside each node.
  - Hint below map: `"Topics are the larger dots. Built from what each document says; it updates when a document changes."`

- **What it says:**
  - Toggle: `"List"`, `"Map"`
  - SVG aria-label: `"How your documents connect"`
  - Hint: `"Topics are the larger dots. Built from what each document says; it updates when a document changes."`

- **Source:** `patch15c.js` lines 121–135.

---

#### Library › Made for you (Word, Excel, PowerPoint files)

- **What it is:** Files created by Trunks (.docx, .xlsx, .pptx) are listed here. A "Write a file" dialog lets the user request a new document.
- **When it appears:** In Library › Made for you tab, and via plus menu "Write a document, spreadsheet or slides".
- **How it works:**
  1. Example files are added to `library.made` if not already present.
  2. A "Write a file" dialog (`data-act="office15"`) opens from the plus menu.
  3. The dialog shows three radio-style buttons (`.office15`) for Document (docx), Spreadsheet (xlsx), Slides (pptx).
  4. A text input below asks "What should it be?" with a placeholder.
  5. Clicking "Write it" (`.btn.pri` with `data-act="offgo15"`):
     - Validates input is not empty.
     - Collects kind (docx/xlsx/pptx) and description.
     - Closes dialog and shows toast: `"Writing it. The .docx will be in Library › Made for you."`

- **How it looks:**
  - Dialog: Title "Write a file", radiogroup with 3 buttons.
  - Each button shows: file-type abbreviation (`.fi`, e.g., "docx"), name (e.g., "Document"), description (e.g., "Word · .docx").
  - Input field: label "What should it be?", placeholder with example.
  - Buttons: Cancel (ghost), Write it (primary).

- **What it says:**
  - Dialog title: `"Write a file"`
  - Button label: `"Document"`, `"Spreadsheet"`, `"Slides"`
  - Descriptions: `"Word · .docx"`, `"Excel · .xlsx"`, `"PowerPoint · .pptx"`
  - Input label: `"What should it be?"`
  - Toast: `"Writing it. The .docx will be in Library › Made for you."`

- **Source:** `patch15c.js` lines 137–143.

---

### 5.5 The fine controls (Advanced and Technical)

> Pass 16 changed several defaults to match "What ships on" (1.9). Where this section and 5.8 disagree, 5.8 is right.

#### Settings pages: fine controls overview

Every Settings page includes fine-grained controls for power users. At Advanced level, "Every feature and the fine controls" appear. At Technical level, "File paths, raw keys, launch variables, config and logs" are visible. Below is a summary of the new Advanced and Technical controls added in pass 15.

**Control types:**
- `switch`: On/off toggle
- `segmented`: Mutually exclusive options (radio buttons styled as tabs)
- `number`: Text input accepting numeric values
- `button`: Clickable action
- `code`: Read-only monospace code (copy-on-click)

---

#### General › Keyboard

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Vim keys in the message box | 1 (Advanced) | switch | Off | Enables Vim normal and insert modes for text editing. |
| Message times | 1 (Advanced) | segmented | On hover | Shows when messages were sent and when tasks started/ended: Always, On hover, or Never. |
| Summarise older turns by themselves | 1 (Advanced) | switch | On | Automatically summarises old messages to keep conversations fast. |
| Summarise when it's this full | 1 (Advanced) | number | 80 | Percentage of model's context used before summarisation triggers. |
| Always keep the latest | 1 (Advanced) | number | 20 | Number of recent messages to always keep word-for-word (not summarised). |
| Room to plan for | 2 (Technical) | segmented | Model's own | Overrides the model's stated context size: Model's own / 128k / 200k / 1M. |
| Repair the history before each call | 2 (Technical) | switch | On | Fixes broken tool calls or half-written answers before sending to the model. |

---

#### Your assistant › Models › Budgets

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Most steps in one task | 1 (Advanced) | number | 60 | Task stops and asks for approval if it reaches this many tool calls. |
| Spend cap per task | 1 (Advanced) | number | 2.00 | Maximum USD to spend on a single task (for pay-per-use accounts). |
| Sub-tasks at once | 1 (Advanced) | segmented | 3 | How many parts of a big task can run in parallel: 1 / 3 / 5. |

---

#### Your assistant › Models › Models for smaller jobs

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Sub-tasks and side jobs | 1 (Advanced) | segmented | GPT-6 Mini | Which model to use for titles, summaries, searches inside a task: Same model / GPT-6 Mini / Qwen3.6 here. |
| Pick the model per task | 1 (Advanced) | switch | On | Easy tasks use a fast model; hard ones use the best available. |
| Planning model | 1 (Advanced) | segmented | Same model | Which model writes the plan in Plan-first mode: Same model / Claude Opus / GPT-6 Sol. |
| Mix models on hard questions | 1 (Advanced) | switch | Off | Asks two models and merges the best answers (costs more). |

---

#### Your assistant › Models › Compare models

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Model arena | 1 (Advanced) | button | — | Opens a dialog to run the same task on two models and pick the better answer. Ratings build up over time. |
| Test suites | 1 (Advanced) | button | — | Opens history of user-defined task suites with per-test results (checked/failed). |

---

#### Your assistant › Models › Retries and timeouts (Technical)

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Retries when a service fails | 2 (Technical) | number | 3 | How many times to retry a failed API call. |
| Wait for the first word | 2 (Technical) | number | 60 | Timeout in seconds before trying the next account if no response starts. |
| Model rounds per step | 2 (Technical) | number | 25 | Maximum number of model calls per tool step. |
| Tool and command timeout | 2 (Technical) | number | 120 | Timeout in seconds for external tools and shell commands. |
| Largest tool answer kept whole | 2 (Technical) | number | 32 | KB limit for keeping tool outputs inline; larger outputs are saved to a file. |

---

#### Your assistant › Models › Per connection (Technical)

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Thinking effort | 2 (Technical) | segmented | Medium | For the active connection: Low / Medium / High (affects reasoning depth). |
| Service tier | 2 (Technical) | segmented | Standard | Priority costs more and is faster; Flex is cheaper and slower: Standard / Priority / Flex. |
| Slow down near a rate limit | 2 (Technical) | switch | On | Spreads requests when approaching rate limits instead of hitting the wall. |
| Keep Claude's cache warm | 2 (Technical) | switch | On when a Claude account is connected (pass 16) | Sends tiny requests every 4 minutes during long tasks to keep cached inputs fresh (reduces repeat costs). |
| OpenRouter picks | 2 (Technical) | segmented | Cheapest | Which OpenRouter provider serves a model: Cheapest / Fastest / Only ones I list. |
| Fewer rounds | 2 (Technical) | switch | On | Groups non-dependent tool calls into a single round. |

---

#### Permissions › Rules for each tool and folder

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Allow/Ask/Never rules | 1 (Advanced) | rule rows | See list | First-match rules: [Action · Tool/Folder · Scope]. Example: Allow git status / Ask any write in Code / Never Delete in Documents. |
| Add a rule | 1 (Advanced) | button | — | Opens a dialog to create a new rule (pick action, tool, scope, then Allow/Ask/Never). |
| Practice runs | 1 (Advanced) | switch | On | A Trunk can show what it would do without actually doing it (via "Tell me what you would do"). |
| Messages per hour | 1 (Advanced) | number | 60 | Max messages per conversation per hour (stops runaway loops). |

---

#### Permissions › Checks before anything runs

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Scan commands for hidden characters | 1 (Advanced) | switch | On | Detects invisible and lookalike characters that could hide command intent. |
| Scan for personal details | 1 (Advanced) | switch | On | Holds back card numbers, ID numbers and addresses from external services. |
| Authenticator code for sensitive tools | 1 (Advanced) | switch | On when two people use Branch or a money tool is connected (pass 16) | Requires a six-digit code before sending money or deleting large amounts. |

---

#### Permissions › Isolation (Technical)

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| A container per Trunk | 2 (Technical) | segmented | For code | Sandbox isolation: Off / For code / Always. |
| System sandbox for commands | 2 (Technical) | segmented | When needed | Sandbox shell commands: Off / When needed / Always. |
| Add sign-ins from outside the sandbox | 2 (Technical) | switch | On | Sandbox never holds a password; Branch injects it from outside on the way out. |
| Verify each release | 2 (Technical) | switch | On | Check update signatures before installing. |
| Pin SSH hosts | 2 (Technical) | switch | On | Refuse to connect to a remote computer if its fingerprint changed. |
| Downloads may come from | 2 (Technical) | segmented | Known sites | Restrict download origins: Anywhere / Known sites / Ask each time. |

---

#### Computer & browser › The browser, more

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Run the browser in a sandbox | 1 (Advanced) | segmented | When needed | Sandbox level for browser automation: Off / When needed / On. |
| Record browser tasks | 1 (Advanced) | switch | On | Saves a step-by-step trace of browser interactions (replayable). |
| Number the clickable things | 1 (Advanced) | switch | On | Shows numbers on clickable elements for faster, steadier clicking on busy pages. |
| Site skills | 1 (Advanced) | button | — | Opens "Site skills" dialog showing learned behaviours for 6+ websites. |
| Page notes and "Send to Branch" | 1 (Advanced) | switch | Off; on when the browser extension is installed | Enables right-click in Chrome/Edge to send page text to a Trunk. |

---

#### Computer & browser › Code

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Try ideas on a branch | 1 (Advanced) | switch | On | Plans can be tried, compared and merged; tasks get their own forked conversation. |
| Code map | 1 (Advanced) | switch | On | Auto-generates a ranked outline of a repository so Trunks navigate it faster. |
| Check and format files after editing | 1 (Advanced) | switch | On | Automatically lints and formats files after a Trunk edits them. |
| AI! and AI? comments start tasks | 1 (Advanced) | switch | On when GitHub is connected (pass 16) | Comments like "AI! add tests" in code trigger a task automatically. |
| Draft a pull request from a task | 1 (Advanced) | switch | On | Generates a pull-request draft (never auto-merged). |
| Remember the shell | 1 (Advanced) | switch | On | Saves shell environment (PATH, aliases, functions) so commands behave as in terminal. |

---

#### Computer & browser › Code, technical

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Files Branch never reads | 2 (Technical) | code | `.branchignore` | Like .gitignore; paths never read by Branch. |
| Read a file before editing it | 2 (Technical) | switch | On | Refuses to edit a file it hasn't read in the current task. |
| Keep large tool outputs | 2 (Technical) | switch | On | Saves large tool outputs to a file instead of truncating. |
| Branch in CI | 2 (Technical) | button | — | Opens a dialog to copy setup for GitHub Actions or GitLab component. |

---

#### Gateway › Chat apps, more

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Pause a chat app from the chat | 1 (Advanced) | switch | On | Lets user run `/pause` and `/resume` commands in that chat app. |

---

#### Gateway › From scripts (Technical)

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Send a message | 2 (Technical) | code | `branch send --to telegram "..."` | Copy-able command to send a message from scripts. |
| Connect a chat app | 2 (Technical) | code | `branch connect telegram` | Copy-able command to set up a chat app. |

---

#### Advanced › Memory

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Most facts it keeps | 1 (Advanced) | number | 500 | Max facts in memory (tidy up shows when approaching this limit). |
| Match by meaning | 1 (Advanced) | switch | On | Finds "invoice" when a fact says "bill" (semantic matching). |
| Share memory between Trunks | 1 (Advanced) | switch | Off | Off: each Trunk keeps its own; On: all Trunks share one memory. |
| Outside memory | 1 (Advanced) | segmented | None | Connect external memory: None / Mem0 / Honcho / Hindsight. |
| Keep a history in Git | 1 (Advanced) | switch | Off | Saves every memory change as a git commit on this computer. |
| Archive facts unused for | 1 (Advanced) | segmented | 180 days | Auto-archive threshold: 90 days / 180 days / Never. |

---

#### Advanced › Automations

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Report only what changed | 1 (Advanced) | switch | On | Checks compare with last time and stay silent if nothing changed. |
| Checks and retries in procedures | 1 (Advanced) | switch | On | A step can check its own result, retry, and clean up. |
| Procedures that start themselves | 1 (Advanced) | switch | On (pass 16) | A procedure can start on a clock or after a task. Only procedures you set a time for. |
| Start when a USB device is plugged in | 1 (Advanced) | switch | On (pass 16); only for triggers you make | Trigger automations on USB device insertion. |
| Reach webhooks from outside | 1 (Advanced) | segmented | Off | Webhook access mode: Off / cloudflared / ngrok / Tailscale. |
| Use what the trigger sent | 1 (Advanced) | switch | On | Automations can access `{{payload}}` and `{{field.path}}` from triggers. |

---

#### Advanced › Tools and skills

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Check a skill is ready first | 1 (Advanced) | switch | On | Checks that required programs, keys and systems exist before running. |
| Only signed skill packages | 1 (Advanced) | switch | Off | Runs only cryptographically signed skills. |
| Check install requests for malware | 1 (Advanced) | switch | On | Scans package against the OSV (Open Source Vulnerability) database. |
| Web search | 1 (Advanced) | segmented | DuckDuckGo (pass 16: needs no key) | Search engine: DuckDuckGo / Brave / SearXNG / Tavily / Exa. |
| Search X | 1 (Advanced) | switch | Off; on when an X account is connected | Enables searching X (formerly Twitter). |
| Video tools | 1 (Advanced) | switch | On (pass 16) | Enables downloading, reading captions, and making short videos. |

---

#### Developer › Tools, technical

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Turn an OpenAPI file into tools | 2 (Technical) | button | — | Opens a dialog to select an openapi.yaml and auto-generate tools. |
| Tool scripts and WebAssembly | 2 (Technical) | switch | Off | Enables sandboxed JavaScript and .wasm custom tools. |
| Tools that join over a WebSocket | 2 (Technical) | switch | Off | Enables tools over WebSocket at `ws://127.0.0.1:3210/tools`. |
| Hardware adapters | 2 (Technical) | segmented | Off | Enable hardware interfaces: Off / Serial / GPIO / I2C / SPI. |
| Load tools only when needed | 2 (Technical) | switch | On | Loads thousands of tools at the cost of dozens (lazy loading). |
| Playground | 2 (Technical) | button | — | Opens a form to test any tool interactively. |

---

#### Developer › Automations, technical

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Flow search | 2 (Technical) | switch | Off | Tries four versions of an automation flow and keeps the best. |
| Loop a prompt | 2 (Technical) | code | `/loop 10m check the build` | Copy-able command to run a prompt on a schedule (or `/heartbeat`). |

---

#### Developer › System

| Control | Level | Type | Default | What it does |
|---------|-------|------|---------|--------------|
| Portable mode | 2 (Technical) | switch | Off | Stores data beside the program (for USB stick deployments). |
| Send metrics with OpenTelemetry | 2 (Technical) | code | `otlp://127.0.0.1:4317` | OpenTelemetry endpoint for metrics export. |
| Status line | 2 (Technical) | segmented | Default | Status bar style: Default / Minimal / My script. |
| Find Branch on other computers nearby | 2 (Technical) | switch | On | Discovers Branch instances on the network (for tools and models). |
| Is Branch keeping up | 2 (Technical) | switch | On | Warns if the engine stalls for >5 seconds. |
| Save task trajectories | 2 (Technical) | switch | Off | Logs every step as JSON Lines for analysis. |

---

#### Customize › Specialists fleet line

- **What it is:** A summary showing how many Trunks exist on how many computers, and a section titled "How Trunks work together" with 6 pattern diagrams.
- **When it appears:** At the top of Customize › Specialists tab.
- **How it works:**
  1. Fleet line shows: avatar dots for available Trunks, name, count of active and available Trunks, and count of specialist groups.
  2. Below that, a section with 6 radio-choice patterns (`.pat15` buttons), each with SVG diagram and description.
  3. Clicking a pattern updates `S.pat15` and shows toast with the pattern name and purpose.
  4. Patterns: One at a time, A lead and helpers, Swarm, Router, In parallel, Teams.

- **How it looks:**
  - Fleet summary: `.fleet15` with avatar dots (inline), text "N Trunks on M computers", subtext "K working now · L specialists on call".
  - Pattern buttons (`.pats15`): radiogroup with 6 buttons, each button has:
    - SVG diagram (small, `viewBox="0 0 60 60"`) showing circles and lines
    - Title (bold)
    - Description (small text)

- **What it says:**
  - Fleet: `"5 Trunks on 3 computers"`, `"2 working now · 3 specialists on call"`.
  - Section heading: `"How Trunks work together"`
  - Hint: `"The pattern a room or a big task uses. Branch picks one; you can choose."`
  - Pattern names: `"One at a time"`, `"A lead and helpers"`, `"Swarm"`, `"Router"`, `"In parallel"`, `"Teams"`.

- **Source:** `patch15e.js` lines 4–17.

---

#### Customize › Tools › Skills: suggested skills

- **What it is:** A "Suggested for you" section showing 3 skills that match the person's Trunks (e.g., "Meeting notes" for Fieldnotes).
- **When it appears:** In Customize › Tools › Skills tab.
- **How it works:**
  1. For each suggested skill (`.sg-row15`), show: title, description, "Add" button.
  2. Clicking "Add" sets `S.sugg15[skill_id] = 1` and shows toast `"Added [skill name]. It's off for every Trunk until you pick who may use it."`.

- **How it looks:**
  - Row: `.sg-row15` with two columns: left (title + description), right (button).
  - Button: `.btn.sm` with text "Add".

- **What it says:**
  - Examples: `"Meeting notes"` → "Notes and follow-ups after a call. Fits Fieldnotes.", `"Invoice check"`, `"Visa check"`.
  - Toast: `"Added [name]. It's off for every Trunk until you pick who may use it."`

- **Source:** `patch15e.js` lines 19–29.

---

#### Customize › Trunk editor: emoji faces

- **What it is:** Alternative to character artwork: an emoji selected from a palette of 12 emojis (🦊🦉🐢🍄🌿🐝🦔🐙🌻🪴🐧🦜).
- **When it appears:** In the Trunk editor Look tab, below the standard character picker.
- **How it works:**
  1. A new section "Or an emoji face" shows a radiogroup of 12 buttons, each displaying an emoji.
  2. Each button (`data-act="emo15" data-v="${emoji}"`): shows the emoji centered, large.
  3. Clicking a button sets `C(st.id).emoji15 = el.dataset.v`, forces the look to 'classic', and re-renders.
  4. If an emoji is selected, a "None" button appears to clear it.
  5. When rendering avatars, if `c.emoji15` is set, the avatar uses the emoji instead of the character art: `<span class="av emoji15"><span class="peb"></span><i>${emoji}</i></span>`.

- **How it looks:**
  - Section heading: `"Or an emoji face"`
  - Radiogroup: 12 buttons, each button is pill-shaped (rounded), showing just the emoji (large font ~28px).
  - Selected button: has a ring or highlight (`.on15` class).
  - Avatar with emoji: colored background (`.peb`), emoji overlay (`<i>`), optional status dot (if working/waiting).

- **What it says:**
  - Section heading: `"Or an emoji face"`
  - Button aria-label (if selected): `"[emoji]"`.
  - None button (when emoji is selected): `"None"`.

- **States:** Only one emoji (or no emoji) can be selected at once. Selecting a character clears the emoji.

- **Source:** `patch15e.js` lines 31–45.

---

#### Customize › Appearance: where the pet walks

- **What it is:** A control to choose where the pet appears: In the sidebar list, in the status bar, or beside the message box.
- **When it appears:** In Customize › Appearance tab (if a pet is selected).
- **How it works:**
  1. A segmented control (via `segAct()`) with three options: "The list" / "Status bar" / "By the message box".
  2. Default: `'side'` (the list).
  3. Clicking an option sets `S.petWhere15 = el.dataset.v` and re-renders.
  4. The pet element (`.petbox`) is moved via `placePet15()` to the appropriate container, and CSS classes are toggled on `document.body`.

- **How it looks:**
  - Segmented control with three equal buttons: icon + label for each location.
  - When pet is placed: it moves to that location and is repositioned with CSS grid or flex.

- **What it says:**
  - Label: `"Where it walks"`
  - Hint: `"It keeps out of the way of your messages wherever it is."`
  - Options: `"The list"`, `"Status bar"`, `"By the message box"`.

- **Source:** `patch15e.js` lines 47–57.

---

#### Customize › Accounts (Advanced): bulk select and move

- **What it is:** When Advanced level is enabled, a "Select several" link in the Accounts section header opens checkboxes to select multiple accounts and perform bulk actions.
- **When it appears:** In Settings › Accounts, when `lvl15() >= 1` (Advanced).
- **How it works:**
  1. A link (`.acsel15`, `data-act="acsel15"`) in the Accounts section heading toggles selection mode.
  2. When `S.acSel15` is an array, checkboxes appear on each account row (`.chk15`).
  3. Checkboxes are linked to `S.acSel15` array (indices of selected accounts).
  4. A bulk bar (`.bulk15`) appears above the accounts list with buttons: "Move to the top", "Pause", "Sign out".
  5. Clicking "Move to the top" reorders `ACCTS` array (selected accounts moved to front).
  6. Clicking "Pause" marks selected accounts as paused (Branch skips them).
  7. Clicking "Sign out" removes selected accounts.

- **How it looks:**
  - "Select several" link (blue, underlined): in the `.h2row15` heading area.
  - Bulk bar (`.bulk15`): flex row with:
    - Count text (`"N selected"` or `"Tick the accounts"`).
    - Spacer (flex-grow).
    - Three buttons: Move to the top (ghost), Pause (ghost), Sign out (danger, red).
  - Checkboxes: standard HTML `<input type="checkbox">`, one per account row.

- **What it says:**
  - Link: `"Select several"` (or "Done" if already selecting).
  - Bulk bar: `"N selected"` (e.g., "3 selected") or `"Tick the accounts"` (when none selected).
  - Button tooltips: `"Move to the top"`, `"Pause"`, `"Sign out"`.
  - Toast (after action): `"Moved 3 to the top. They're used first now."`, `"Paused 2. Branch skips them until you resume."`, `"Signed out of 1. Their keys stay in your password manager."`.

- **Source:** `patch15e.js` lines 59–76.

---

### 5.6 From the open pull requests, the phone, and the usage report (pass 15)

#### Install dialog: let running work finish (PR #163)

- **What it is:** Clicking "Install when nothing is running" (or the update popover's install) while tasks are working opens **"Install 0.20.0"** instead of starting at once.
- **Body:** "N tasks are working right now. Branch keeps a safety copy either way." Two option cards (radio-like, the chosen one has an ink outline):
  - **"Let them finish first"** — "Installs by itself when the last one is done. Nothing is cut off." (default)
  - **"Install now"** — "Stops them at a safe point. Afterwards Branch offers to pick each one up where it was."
- **Footer:** "Not now" (ghost) and "Continue" (primary). Continue with the first option closes and toasts "It installs when the running tasks finish. You can keep working." With the second, the normal install walk runs, and afterwards every Inbox tab shows a card: Scout's face, **"Pick up what the update cut off"**, "Find the Hartwell invoice · stopped while searching Outlook", with "Leave it" and "Pick it up". Pick it up opens Scout's conversation and toasts "Picked up “Find the Hartwell invoice” where it stopped: searching Outlook."
- **When nothing is running** the install starts straight away, as before.
- **Source:** `patch15d.js` (wraps `ACTS.install`; `updpick15`, `updgo15`, `cutgo15`, `cutno15`).

#### Branch proposes a change to its own code (PRs #271 and #273)

- **Where:** Inbox › Needs you, after the approvals: a card with a branch icon, **"Branch wants to improve itself"**, "Skip files that are open when tidying Downloads · 2 files, +14 −3 · waiting for you", and "Review". Its border is tinted green.
- **Review dialog "A change to Branch’s own code"** (wide): "From your conversation on Friday: the sweep moved a spreadsheet you had open. Branch wrote a fix and will only touch what’s listed." Four scope tiles: "Files it may edit · 2, listed below", "Outside that · Refused", "Tests · 14 of 14 pass on a copy", "Where it lands · A draft pull request, never main". Then one diff box per file (file name in mono and "+12 −3" on a grey bar; added lines green, removed lines red). Under them the two stages as numbered steps: **1 Approve the edits**, **2 Publish a draft pull request**.
- **Buttons:** "Decline" (ghost) and "Approve the edits". Approving keeps the dialog open, ticks stage 1, the card's line changes to "edits approved, ready to publish", and the button becomes **"Publish the draft"**. Publishing closes and toasts "Draft pull request #291 opened on GitHub. Merging stays with you."; the card goes away. Decline toasts "Declined. The fix is thrown away."
- **Rule:** two separate yeses, and it can never merge. This mirrors the bounded-diff approval in the PRs.
- **Source:** `patch15d.js` (`S.selfdev15`, `DIFF15`, `selfDlg15`).

#### Keyboard shortcuts you set by pressing them (PR #179)

- **Where:** the "Keyboard shortcuts" dialog (Settings › General › Keyboard › "Show all", the ? key, or the palette).
- **Top line:** "Click a shortcut, then press the keys you want."
- **Ten actions you can change:** Find anything (Ctrl K), New conversation (Ctrl N), Settings (Ctrl ,), Show or hide the side panel (Ctrl Shift K), Focus mode (Ctrl .), Talk live (Ctrl Shift V), Stop the current task (Ctrl Shift S), Lockdown (Ctrl Shift L), Open the Inbox (Ctrl I), Next conversation (Ctrl Tab). Each shows its keys as key caps in a button on the right.
- **Changing one:** click it (`key15`); it turns accent-tinted and reads "Press the keys…". The next key press with Ctrl or Alt becomes the shortcut and a toast confirms ("New conversation: Ctrl Shift N."). A bare key is refused ("Use Ctrl or Alt with it, so typing never sets it off."), a clash is refused ("Ctrl K already does “Find anything”."), Esc cancels. A changed shortcut gets a small × to put the default back.
- **Five fixed ones** stay listed underneath, not changeable: New line in a message (Shift Enter), Call a Trunk (@), Use a skill (/), This list (?), Close anything (Esc).
- **Source:** `patch15d.js` (`KEYS15`, `showShortcuts`, a capture-phase keydown listener).

#### Telegram: topics, photos and reliability (PRs #264–#267, #269)

- **Where:** Customize › Channels › Telegram when it is already set up ("Manage Telegram", the Save step).
- **Adds under "Who may message it":** two switches, **"Keep forum topics apart"** ("Each topic in a group becomes its own conversation.", on) and **"Photos and files reach the task"** ("What you send in Telegram is handed to the Trunk as material.", on), then one quiet line with a green tick: "Delivery receipts on · messages sent while Branch was off are caught up · old buttons say they’ve expired".
- **Source:** `patch15d.js` (wraps `chWizard`).

#### An empty key is refused (PR #283)

- **Where:** Add an account › a service that uses a key › "Add key".
- **Behaviour:** with the field empty, nothing advances; the field is marked invalid, focused, and a red line appears under it: **"Paste a key first. Branch never guesses one."**
- **Source:** `patch15d.js` (wraps `ACTS['aa-key']`).

#### Data & usage: the report card

- **Where:** the first thing under the page's intro, at every level.
- **Card:** small "Last 30 days", a large figure "$16.84", and "164 tasks · estimated from each model’s price"; a segmented control "7 days / 30 days / 90 days"; and "Open the report". Figures: 7 days $4.12 and 38 tasks; 90 days $41.30 and 472 tasks.
- **Report dialog "Usage · last N days"** (wide): four tiles (Spent, Tasks, Cheapest per task "Qwen3.6 · free", Busiest day "Friday"), then three bar groups: "By model" (GPT-6 Sol, Claude Opus, Qwen3.6 (this computer) "free", Gemini Flash), "By where it came from" (This window 52%, Telegram 27%, Automations 16%, The phone 5%), "By person" (Taofik 86%, Sam 14%). Footnote: "Estimated from each model’s published price. Plans you already pay for, like ChatGPT Plus, count as $0." Footer: "Save as a spreadsheet" (toast) and "Close".
- **Source:** `patch15d.js` (`REP15`, `repDlg15`).

#### Lend this phone

- **On the phone:** Settings › "Lend this phone to Branch" opens its own screen (`S.ph.scr = 'lend15'`, back to Settings). A short note ("Branch can ask this phone for the things switched on below. Each use shows here and on the lock screen."), four rows with On/Off values — Camera ("Take a photo when a Trunk asks", on), Location ("Where you are, when it matters", on), Photos ("Pick from your library", off), Notifications ("Read the ones you choose", on) — and a red row **"Stop lending this phone"**. When stopped, the rows are disabled and the last row reads "Lend this phone to Branch".
- **On the desktop:** Settings › Computer & browser ends with **"Phones lent to Branch"**: "Taofik’s iPhone", the abilities that are on, "last used 12 min ago", and "Stop lending". When nothing is lent: "No phone is lent. Turn it on from the phone: Settings › Lend this phone."
- **Source:** `patch15d.js` (`S.lend15`, `phLend15`).

#### Voice › Listening, more (Advanced)

| Control | Level | Type | Default | What it does |
|---|---|---|---|---|
| Wake word | 1 | switch | Off, offered after three dictations (pass 16) | "Hey Branch", heard on this computer only. Off until you choose: it keeps the microphone open. |
| Stop listening after silence | 1 | number (s) | 1.5 | For live dictation. |
| Answer aloud | 1 | segmented | When I talk | Never / When I talk / Always. |
| Spoken morning brief | 1 | switch | Off | The written brief, read out at 7:30 on the speaker you choose. |

#### The last rows (pass 15h)

| Page › group | Control | Level | Type | Default |
|---|---|---|---|---|
| Advanced › Trunks, more | Projects pick up matching work | 1 | switch | On |
| | Follow-up tasks | 1 | switch | On |
| | Standing orders ("See 2") | 1 | button | — |
| | "From now on" for a specialist ("Add one") | 1 | button | — |
| | Share a Trunk ("Export…": Git, skill bundle, or export with memory details removed) | 1 | button | — |
| | Custom modes (`.branch/modes.json`; a mode can hand work back when done) | 1 | code | — |
| | Agent marketplace ("Browse"; each Trunk has a fingerprint) | 1 | button | — |
| Advanced › Library, more | Search documents by meaning | 1 | switch | On |
| | A local index of mail, calendar and messages | 1 | switch | Off |
| | Keep versions of what Trunks make (versions and a checksum) | 1 | switch | On |
| | Rewrite short notes ("Try it") | 1 | button | — |
| Advanced › Pinned skills | Always read in full: None / file-receipts / brief | 1 | segmented | file-receipts |
| Computer & browser › On a computer, more | Work in apps in the background (accessibility tree) | 1 | switch | On |
| | Read Jupyter notebooks | 1 | switch | On |
| | Review checks and a checklist per task | 1 | switch | On |
| | Write AGENTS.md for a project (`/init`) | 1 | code | — |
| Gateway › Chat apps, even more | Send files into chats | 1 | switch | On |
| | Relay for chat-app accounts | 1 | switch | Off |
| | Push to your phone and browser | 1 | switch | On |

Also in pass 15h: the flow editor's step kinds gain **"Repeat"**, **"Split and gather"** and **"Run a flow"**, drawn in the picture as "Repeat (up to 5): …", "Split and gather: …" and "Run the flow “…”"; the "Price check" procedure now has a "Split and gather: one supplier page each" step. The slash list gains `/loop <every> <what>` ("repeat a prompt on a clock") and `/handoff <device>` ("carry on this conversation on another device or the terminal").

---

### 5.7 This Mac and This PC: the operating system's own permissions (pass 16)

#### What it is and why
On macOS, reaching other apps, the screen or private files needs permissions that **only the person can grant**, in System Settings ›
Privacy & Security. An app cannot grant them to itself. It can only show the system's own prompt (for some) or open the right pane (for
the rest), where it appears in a list under its own name and icon. Branch's list entry shows the leaf Branch face. Windows needs far
fewer, so its list is short.

Rules:
1. **Ask when a feature first needs it, not all at once in setup.** The request always says who needs it and why.
2. **One checklist shows every permission** with its real status and the one button that can change it.
3. **Check again when you come back** to Branch, so the status updates without a restart. Screen Recording is the exception: macOS
   applies it only after Branch reopens, so Branch says "Restart to finish" and offers "Restart Branch".
4. **A refusal is respected.** macOS will not show the same prompt twice; after "Don't Allow" the only way back is System Settings, so
   the button changes to "Open System Settings".

#### The seven permissions on a Mac
| Permission | Icon | What it unlocks (the row's second line) | How Branch asks | Starting status in the example |
|---|---|---|---|---|
| Accessibility | cursor | "Clicking and typing in other apps" | Opens the pane | Not yet |
| Screen Recording | screen | "Seeing the screen, so a Trunk can find what to click" | Opens the pane; needs a restart after | Not yet |
| Automation | wand | "Controlling Mail, Finder, Safari and other apps, one app at a time" | Per app, the first time Branch controls it; the pane lists apps under Branch | "2 apps" (Mail and Finder) |
| Full Disk Access | disk | "Reading beyond Documents, Desktop and Downloads" | Opens the pane (it can never be prompted) | Not yet |
| Microphone | mic | "Talking to Branch and the wake word" | The system prompt ("Allow…") | Not yet |
| Camera | camera | "Photos and scanning a code" | The system prompt | Turned off |
| Notifications | bell | "Telling you when a Trunk needs you" | The system prompt | Granted |

Status pills: green **Granted**, grey **Not yet**, grey **2 apps**, amber **Restart to finish**, red **Turned off**. The button beside a
row: none when granted; **"Allow…"** for a prompt-type permission never asked; **"Restart Branch"** while Screen Recording waits; otherwise
**"Open System Settings"**.

#### Settings › Permissions › This Mac
- Sits directly under the page's intro, at every level (it is the gate for using the computer, so it is never hidden).
- Heading "This Mac"; hint "N of 7 granted. macOS keeps these in System Settings › Privacy & Security; Branch asks for each one the first
  time a Trunk needs it."; then the seven rows (icon tile, name, one line, pill, button).
- On Windows the same place shows **"This PC"**: "Windows asks for very little. Seeing the screen and using the mouse need nothing here;
  Branch still asks you before it takes over." Rows: Microphone (Granted), Camera (Turned off, "Open Windows Settings"), Notifications
  (Granted), and "Installing tools" ("Windows asks for an administrator yes each time. Branch asks you first.", pill "Each time").
- Other surfaces (terminal, phones, web) show neither; the phones have their own "Lend this phone" screen (5.6).

#### Asked at the moment it's needed
In a conversation on a Mac, when a Trunk needs the screen and the permission is missing, a card appears **right after the computer card**:
- **"Scout needs to see the screen and use the mouse"** (or only one of the two), "To sign in to Outlook on this Mac. macOS asks you to
  allow this once, in System Settings. Branch still asks before anything is sent.", with "Not now" and "Open System Settings" (opens the
  first missing one).
- While Screen Recording waits for a restart: **"Restart Branch so Scout can see the screen"**, "macOS turns Screen Recording on after
  Branch reopens. Your conversations stay where they are.", with "Later" and "Restart Branch".
- "Not now" / "Later" hides the card for this session and toasts "Scout will use the sealed browser instead. You can allow it later in
  Settings › Permissions."
- The card goes away once both are granted.

#### Setup on a Mac
Setup never asks for these. On a Mac the "Two more things" step is titled **"Two more things, and this Mac"** and gains a third tile,
**"Permissions on this Mac"** (shield icon, pill "N of 7"): "Branch asks for each one the first time a Trunk needs it, and says why.
Nothing is granted now." A "See the list" button shows all seven with their statuses, read-only.

#### An offer at the moment it's useful
This is how "Off until you choose" features stay findable. Example: after the **third dictation**, a card appears at the end of the
conversation: microphone icon, **"Turn on the wake word?"**, "You've dictated three times. Say "Hey Branch" instead; it's heard on this
Mac only." (or "this computer"), with "Not now" and "Turn on". Turn on switches the wake word on; on a Mac without the microphone it
first shows the microphone prompt. It is offered once. The same pattern fits every "Off until you choose" row: offer it the moment the
person's own behaviour shows it would help, never as a nag.

#### In the real app (Electron): how to ask and read each permission
Verify these at build time against the current macOS and Electron docs.
| Permission | Read the status | Ask | Open the pane |
|---|---|---|---|
| Accessibility | `systemPreferences.isTrustedAccessibilityClient(false)` | `isTrustedAccessibilityClient(true)` shows the system prompt that leads to the pane | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` |
| Screen Recording | `systemPreferences.getMediaAccessStatus('screen')` | Trying to capture triggers the system prompt; then a restart | `…?Privacy_ScreenCapture` |
| Automation | Only by trying (Apple Events return a permission error) | The first Apple Event to each app shows the prompt (needs `NSAppleEventsUsageDescription`) | `…?Privacy_Automation` |
| Full Disk Access | Try reading a protected path | Cannot be prompted | `…?Privacy_AllFiles` |
| Microphone / Camera | `getMediaAccessStatus('microphone' / 'camera')` | `systemPreferences.askForMediaAccess(...)` (needs the usage strings in Info.plist) | `…?Privacy_Microphone` / `…?Privacy_Camera` |
| Notifications | The notification permission state | The first notification request | `x-apple.systempreferences:com.apple.preference.notifications` |
| Windows microphone / camera / notifications | The privacy settings state | The system asks on first use | `ms-settings:privacy-microphone`, `ms-settings:privacy-webcam`, `ms-settings:notifications` |

Re-check the statuses when the window regains focus (`browser-window-focus`). The app must be signed, so macOS lists it as "Branch"
with its icon and remembers the grant across updates.

#### In the prototype (demo only; see 1.8)
The System Settings window is drawn by the prototype so the flow can be clicked through:
- A macOS-style window over Branch: traffic lights (red closes), "Privacy & Security" title, a sidebar of the seven panes, the pane
  title and Apple's description, a list with **Branch** (leaf face icon) and two other apps, and "+ −" buttons. "Back to Branch" or Esc
  closes it; closing re-checks and toasts what changed ("Accessibility: granted · Screen Recording: restart Branch to finish.").
- Switching Branch on shows a Touch ID sheet ("System Settings is trying to change your Privacy & Security settings." / "Touch ID or enter
  your password to allow this.", with the fingerprint, "Cancel" and "Use Password…"). The prototype has no password field.
- For Screen Recording a second sheet: **"“Branch” may not be able to record the contents of your screen until it is quit."** with
  "Later" and "Quit & Reopen". Quit & Reopen shows "Reopening Branch…" for about 1.4 s, then the toast "Branch reopened. Screen Recording
  is on; your conversations are where you left them."
- Prompt-type permissions show a small centred alert with Branch's icon: **"“Branch” would like to access the microphone."** (camera, or
  "send you notifications"), a reason line, "Don't Allow" and "Allow". Don't Allow toasts "Turned off. macOS won't ask again; you can
  change it in System Settings."
- State lives in `S.perm16` (`yes`, `no`, `part`, `off`, `restart`); actions `sys16`, `sysflip16`, `syssheet16`, `systouch16`,
  `sysquit16`, `sysclose16`, `restart16`, `ask16`, `askdo16`, `jit16`, `wake16`. Source: `patch16a.js`, `patch16a.css`.

### 5.8 What ships on: every settings row, by group
**On** = ships on. **Asks** = on, asks each time. **Connected** = on when the thing it needs is connected (its sub-line says so).
**Off** = off until you choose, with the reason. "Always there" = a feature with no switch. Level: R Regular, A Advanced, T Technical.

| Where | Row | Level | Group | Reason when not On |
|---|---|---|---|---|
| Conversation | Pins, timestamps on hover, @ material, `/bg`, the waiting line, the summary card, the cost line, side by side | – | Always there | |
| General | Start with the computer; keep working when the window closes | R | On | |
| General › The conversation | Vim keys in the message box | A | Off | A typing preference, not a feature everyone wants |
| | Message times: On hover | A | On | |
| General › Summaries | Summarise older turns by themselves (80%, keep the latest 20) | A | On | |
| | Room to plan for: Model's own; Repair the history before each call | T | On | |
| Models › Budgets | Most steps 60; spend cap $2.00 per task; 3 sub-tasks at once | A | On | |
| Models › Smaller jobs | Side jobs on GPT-6 Mini; pick the model per task; planning model: same | A | On | |
| | Mix models on hard questions | A | Off | It doubles the cost |
| Models › Compare | Model arena; test suites | A | Off (buttons) | Each run costs money |
| Models › Retries and timeouts | 3 retries, 60 s first word, 25 rounds, 120 s tool timeout, 32 KB answers kept whole | T | On | |
| Models › Per connection | Thinking effort Medium; Standard tier; slow down near a rate limit; fewer rounds | T | On | |
| | Keep Claude's cache warm | T | Connected | A small cost, so only with a Claude account |
| | OpenRouter picks: Cheapest | T | Connected | Only with OpenRouter |
| Voice | Dictation, push-to-talk | R | On | |
| Voice › Listening, more | Wake word | A | Off (offered after three dictations) | It keeps the microphone open |
| | Stop listening after 1.5 s of silence; answer aloud when I talk | A | On | |
| | Spoken morning brief | A | Off | It plays sound at a fixed time |
| Permissions › This Mac / This PC | The system permissions | R | Asks (the system's own prompt) | Only the person can grant them |
| Permissions › Without asking | Read files in Documents and Downloads; use the browser; record tasks | R | On | |
| | Send email and messages; install tools and packages | R | Asks | They act on the world |
| | Full access | R | Off, never shipped on | |
| Permissions › Rules | Rules per tool and folder (3 examples); practice runs; 60 messages per conversation per hour | A | On | |
| Permissions › Checks | Scan commands for hidden characters; scan for personal details | A | On | |
| | Authenticator code for sensitive tools | A | On when two people or money tools | |
| Permissions › Isolation | A container for code; system sandbox when needed; sign-ins added outside the sandbox; verify releases; pin SSH hosts; downloads from known sites | T | On | |
| Computer & browser | See the screen and use the mouse | R | Asks | On a Mac also needs Accessibility and Screen Recording |
| Computer & browser › The browser, more | Sandbox when needed; record browser tasks; number the clickable things; site skills | A | On | |
| | Page notes and "Send to Branch" | A | Connected | Needs the browser extension |
| Computer & browser › Code | Try ideas on a branch; code map; check and format; draft pull requests; remember the shell | A | On | |
| | AI! and AI? comments | A | Connected | Needs GitHub (connected in the example) |
| Computer & browser › Code, technical | `.branchignore`; read before editing; keep large outputs; Branch in CI | T | On | |
| Computer & browser › On a computer, more | Work in apps in the background; Jupyter; review checks and a checklist; `/init` | A | On | Background apps need Accessibility on a Mac |
| Gateway | The gateway: When needed | R | On | |
| Gateway › Chat apps | Pause a chat app from the chat; send files into chats | A | Connected | Only with a chat app |
| | Push to your phone and browser | A | Connected | Only with a paired phone |
| | Relay for chat-app accounts | A | Off | Your number would go through the relay |
| Gateway › From scripts | `branch send`, `branch connect` | T | Always there | |
| Advanced › Memory | Limit 500; match by meaning; archive after 180 days | A | On | |
| | Share memory between Trunks; outside memory; history in Git | A | Off | They change where your data goes |
| Advanced › Automations | Report only what changed; checks and retries; procedures that start themselves; USB triggers; use what the trigger sent | A | On | Only for procedures and triggers you make |
| | Reach webhooks from outside | A | Off | It opens a door from the internet |
| Advanced › Tools and skills | Readiness check; malware check on installs; web search on DuckDuckGo (no key needed); video tools | A | On | |
| | Only signed skill packages | A | Off | Would block most community skills; the malware check stays on |
| | Search X | A | Connected | Needs an X account |
| Advanced › Pinned skills | Always read in full: file-receipts | A | On | |
| Advanced › Trunks, more | Projects pick up matching work; follow-up tasks | A | On | |
| Advanced › Library, more | Search documents by meaning; keep versions | A | On | |
| | A local index of mail, calendar and messages | A | Off | Heavy on disk, and it reads everything |
| Developer › Tools | Load tools only when needed | T | On | |
| | Tool scripts and WebAssembly; WebSocket tools; hardware adapters | T | Off | Developer plumbing |
| Developer › Automations | Flow search | T | Off | It runs four versions, four times the cost |
| Developer › System | Find Branch on other computers nearby; is Branch keeping up | T | On | |
| | Portable mode; OpenTelemetry; save task trajectories | T | Off | Developer plumbing, or disk |
| Updates | Keep Branch up to date by itself (only when nothing is running) | R | On | |
| Appearance | The pet, characters, scenes | R | On | |

### Summary

This section documents all 19 Settings pages, 20 popovers, all Places (Overview, Inbox, Automations, Library, Team, Customize), the Trunk editor (Look and What it may do tabs), and all controls with exact labels, types, defaults, visibility levels, and actions. Each page specifies which controls appear at Regular, Advanced, and Technical levels. The Customize place fully documents the Trunk editor with its two tabs and all fields. Popovers are listed with their item counts and purposes. All data is sourced from `harvest-settings.txt`, `harvest-pops.txt`, and `harvest-places.txt`.

---

## 6. Journeys, step by step

Every flow that takes a person through multiple screens, with exact text, controls, and state changes.

### 6.1 First visit
- **What it is:** what a person sees the first time they open Branch, and once after each new version.
- **Why it exists (intent):** a beginner should not have to find setup; it comes to them once, then gets out of the way.
- **When it appears:** 0.7 seconds after the page loads, **setup opens by itself** if the key `branch-proto-seen13` is not in the browser's storage, and nothing else is open (no setup, walkthrough or dialog already showing). It does not open when the page is driven by automation (`navigator.webdriver`), so tests are not interrupted. Closing setup in any way ("Skip for now", Escape, or finishing with "Open Branch and take the walkthrough") saves `branch-proto-seen13`, so it does not open again until the next version changes that key. Because the key is new in this version, a person who finished setup before sees it once more.
- **The older welcome card (still in the code, now a fallback):** if setup did not open first and `branch-proto-welcomed` is missing, after 1.2 seconds a small card appears at the bottom right: the Branch face, "New to Branch?", "Set it up in three minutes, or take a two-minute walkthrough.", and the buttons "Set up" (`onboard`), "Walkthrough" (`tour`) and a Dismiss X (`welcome-x`, which saves `branch-proto-welcomed`). When setup opens by itself, this card is removed and never shows.
- **Coming back later:** Guide (the bulb button in the top bar) › "What’s new" lists every recent feature with a jump to each; "Set up Branch" and "Take the walkthrough" reopen them; "Start the prototype over" forgets every saved choice and reloads, so the first visit happens again.
- **Replay the first run:** the account menu item "Replay the first run" (`firstrun`, `startFirst()`) replays an older, shorter five-dot first-run sequence ("Hi, I’m Branch." … "Let’s start" / "Skip for now").
- **Source:** `patch13b.js` (first visit, What's new, Start over), pass 10 (`welcome10`, onboarding), base (`startFirst`).

### 6.2 Setup (Onboarding wizard, 11 steps)

- **What it is:** A guided multi-step configuration that covers appearance and permission preferences, models, Trunks, chat apps, gateways, people, email and calendar, and health checks.
- **Why it exists:** First-time users configure Branch’s core settings without manual system hunting, and personalise the look and permission behaviour.
- **When it appears:** Opens by itself on the first visit (see 6.1), from Guide › "Set up Branch", from What’s new, or from the welcome card’s "Set up" button (`onboard`).
- **Where it lives:** Full-screen dialog with a left rail and right main section, appended to `#app` as `.ob9` element.
- **How it works:**
  1. **Initialization:** `openOnboarding(i = 0)` creates or updates `S.ob` object with defaults:
     ```
     {i:0, trust:false, where:'this', brains:[true, true, true], tpls:[1, 2], gw:'on', people:null, checked:0}
     ```
     Pass 15 adds keys as they are chosen: `look` (unset reads as `'system'`), `asks` (unset reads as `'ask'`), `mail15`, `restore15`.
     ```
     ```
  2. **Layout (all steps):**
     - **Left rail (`.ob-rail`):** "Set up Branch" heading with the Branch face mark, ordered list of all 11 steps (OB_STEPS array), "Skip for now" link.
     - Each step button: `data-act="ob-go"` with `data-v="INDEX"`. Buttons for steps after current step are disabled unless `S.ob.trust` is true (except step 0).
     - Completed steps show a checkmark icon; current step shows its index; upcoming steps are dimmed.
     - **Main section (`.ob-main`):** Step-specific body content, footer with Back/Continue buttons.
     - All steps except step 0 show a Back button (`data-act="ob-go" data-v="INDEX-1"`).
     - Steps 0–9 show Continue/Start button (`data-act="ob-next"`); step 10 shows "Open Branch and take the walkthrough" button (`data-act="ob-done"`, disabled until health checks reach 6).
  3. **Step 0: Welcome**
     - **Body text:** "An assistant that lives on this computer, with Trunks that each take one job. This takes about three minutes; you can change everything later."
     - "How Branch stays safe" section with three checkmarks:
       - "It asks before it sends, deletes, spends or installs anything."
       - "Your conversations and keys stay on your computers."
       - "You can take over, stop it, or roll back any change."
     - Checkbox: `<input type="checkbox" id="ob-trust">`; label: "I understand Branch can act on this computer when I allow it"
     - Back button is hidden (replaced by `<span></span>`).
     - Continue button is disabled until checkbox is checked.
     - Changing the checkbox triggers `change` event on `#ob-trust`, setting `S.ob.trust = el.checked` and re-rendering the step.
  4. **Step 1: Where**
     - **Heading:** "Where should Branch run?"
     - **Body:** "The engine and the gateway live here. You can talk to it from anywhere."
     - Four radio-style buttons (`.prov` buttons):
       - `data-act="ob-set" data-k="where" data-v="this"`: "This computer" (monitor icon), "Recommended. Private, free, fast."
       - `data-v="remote"`: "Another computer" (key icon), "Over Tailscale or SSH: a home server or a desk PC."
       - `data-v="keepoak"`: "A KeepOak computer" (globe icon), "In the cloud, always on. Needs a keepoak.com account."
       - `data-v="later"`: "Decide later" (clock icon), "Start here and move it any time."
     - Default selection is `"this"`.
     - Clicking a button sets `S.ob.where = el.dataset.v` and re-renders the step.
  5. **Step 2: Brains (Models)**
     - **Heading:** "Which models should answer?"
     - **Subheading:** "Found on this computer:"
     - Three checkboxes for OpenAI, Anthropic (Claude), and Qwen:
       - Each row: provider logo (32px), name, description.
       - `<input class="sw" type="checkbox" data-sw="ob-brain" data-i="INDEX" aria-label="...">`
       - Default state: all three checked.
       - Changing a checkbox updates `S.ob.brains[+t.dataset.i] = t.checked`.
     - Two buttons:
       - `data-act="addacct"`: "Add another account" (plus icon).
       - `data-act="ob-test"`: "Say hello to test it".
     - If tested (`S.ob.tested = true`): Show status "It answered in 1.2 s" with quote: "Hi Taofik. Ready when you are." · GPT-6 Sol, Account 1
  6. **Step 3: Make it yours (pass 15, from PR #283)**
     - **Heading:** "Make it yours"
     - **Body:** "Two quick choices. Both can change any time in Settings."
     - **"How it looks"** (small grey label): three cards in one row (`.ob-card15`), each a 92 × 48 px swatch of three stripes and a name: "Match Windows" (light and dark stripes, the middle one split), "Light", "Dark". `data-act="ob15" data-k="look" data-v="system|light|dark"`. Choosing one changes the theme at once (`setTheme`). Default: Match Windows.
     - **"How much it asks"**: three full-width rows (`.ob-row15`), each an icon tile, the mode's name in bold and its one-line description underneath, taken from the permission modes: Auto, Ask first, Plan first. `data-k="asks"`. Choosing one sets the default mode (`S.modeDefault`). Default: Ask first.
     - Hint under the rows: "Full access stays off until you turn it on yourself." (Full access is deliberately not offered in setup.)
     - The chosen card or row has a 1 px ink outline plus a 1 px ink ring. Continue works without choosing; nothing is required.
  7. **Step 4: Trunks**
     - **Heading:** "Your first Trunks"
     - **Subheading:** "Pick a few, or tell Branch about your life and work and it proposes them."
     - Grid of template buttons (`.ob-tpl`): Each shows `<span class="ob-dot" style="background:COLOR"></span>`, name, and short description. `data-act="ob-tpl" data-i="INDEX" aria-pressed="..."`.
     - Clicking toggles the template's inclusion in `S.ob.tpls` array.
     - Text area with label "Or describe what you do", placeholder "I'm a finance student with a part-time job at Hartwell. I travel a lot.", `id="ob-life"`.
     - Button: `data-act="ob-propose"` ("Let Branch propose Trunks", with spark icon).
     - Clicking propose button sets `S.ob.life = $('#ob-life')?.value || ''`, sets `S.ob.proposed = true`, pre-selects three templates, and re-renders.
     - If proposed, show hint: "Branch proposed: **Ledger** (money and receipts), **Scout** (research), **Ada** (trips). They're selected above."
  8. **Step 5: Reach (Chat apps)**
     - **Heading:** "Reach Branch anywhere"
     - **Subheading:** "Message a Trunk from Telegram, WhatsApp, Discord, Slack."
     - Four tiles (`.tile`) for each popular chat app:
       - Logo (28px), name (e.g., "Telegram"), description (e.g., "Message a Trunk from Telegram").
       - Checkbox: `data-sw="set"` (generic toggle).
     - Phone section: "Your phone", "Scan the square code with the Branch app", button `data-act="pair"` ("Show the code").
  9. **Step 6: Tools**
     - **Heading:** "Tools to start with"
     - **Subheading:** "Recommended for the Trunks you picked. Everything else is under the plug."
     - Rows for Outlook, Google Drive, GitHub (with logos, 28px):
       - Each has name, description ("Mail and calendar", etc.), checkbox `data-sw="set"`.
       - Outlook and Google Drive default checked; GitHub default unchecked.
     - Additional row: "Command-line tools found" (terminal icon), list "gh, git, ffmpeg, python, bws", checkbox checked.
  10. **Step 7: Keep (Gateway & updates)**
     - **Heading:** "Keep it running"
     - **Subheading:** "Enables Telegram, phone, and automations when Branch is closed."
     - **Control 1: The gateway**
       - Label: "The gateway"
       - Description: "Keeps Telegram, your phone and automations working when the window is closed, and starts Branch again if it ever stops."
       - Radio buttons (via `segAct()`): Off / When needed / On
       - Default: "On"
       - `data-act="ob-gw" data-v="off|when-needed|on"`
       - Sets `S.ob.gw = el.dataset.v`.
     - **Control 2: Start with Windows**
       - Checkbox with label "Quietly, in the tray."
       - `data-sw="set"` generic toggle.
       - Defaults to checked.
     - **Control 3: Keep Branch up to date by itself**
       - Checkbox with label "It waits until no task is working and keeps a safety copy."
       - `data-sw="set"`.
       - Defaults to checked.
  11. **Step 8: People**
      - **Heading:** "Anyone else?"
      - **Subheading:** "People on this computer, teammates on theirs, or your keepoak.com team. Skip it if it's just you."
      - Three radio-style buttons:
        - `data-act="ob-set" data-k="people" data-v="local"`: "Someone on this computer" (users icon), "A household profile with its own PIN".
        - `data-v="invite"`: "A teammate on their computer" (chat icon), "An invite link or a six-digit code".
        - `data-v="keepoak"`: "Your keepoak.com team" (globe icon), "Everyone in your workspace".
      - Default: no selection (unset).
  12. **Step 9: Two more things (pass 15, from PR #186)**
      - **Heading:** "Two more things"
      - **Body:** "Both optional. Skip them and Branch works the same."
      - **Tile "Email and calendar"** (mail icon): "So Trunks can find invoices, draft replies and see when you’re free. They still ask before sending." Two small buttons, "Outlook" (Outlook logo) and "Gmail" (mail icon), `data-act="ob15" data-k="mail15" data-v="Outlook|Gmail"`. After choosing, the buttons are replaced by "<name> · signed in on their site" and a green "Connected" pill appears in the tile title.
      - **Tile "Bring back your Branch"** (clock icon): "Moving from another computer? Restore Trunks, memory and automations from a backup." Button "Choose a backup…" (folder icon) sets `restore15 = 'ask'`, which swaps the button for an amber confirmation box: **"Replace this setup with the backup from Sep 20?"** / "What you chose in the last few steps is swapped for the backup. Keys come from your password manager, not the file." with "Cancel" (ghost) and "Restore" (primary). Restore shows a green pill "Restored from Sep 20 · 6 Trunks, 212 facts". Cancel returns to the button.
      - Restoring is the only destructive choice in setup, so it always asks first, inline, without opening a second dialog over the wizard.
  13. **Step 10: Health check**
      - **Heading:** "All set?"
      - **Subheading:** "Branch checks everything before you start."
      - Ordered list (`.tl .ob-checks`) of six checks:
        1. "The engine" — "answering in 4 ms"
        2. "GPT-6 Sol" — "answered in 1.2 s"
        3. "The gateway" — "on, holding for 20 s" or "off, as you chose" (depends on `S.ob.gw`)
        4. "Telegram" — "connected"
        5. "Bitwarden" — "ready to fill sign-ins"
        6. "Disk" — "212 GB free"
      - Checks progress: initially all show spinner icon, as `S.ob.checked` increments, each check shows checkmark and its completion text.
      - Every 380 ms, if still on the check step, `S.ob.checked++` and the step re-renders.
      - Final button: "Open Branch and take the walkthrough" (disabled until `S.ob.checked >= 6`).
- **Controls in all steps:**
  - Left rail: Step buttons navigate via `data-act="ob-go" data-v="INDEX"`.
  - "Skip for now" link in rail: `data-act="ob-close"` → removes `.ob9`, sets localStorage flag (`branch-proto-welcomed`), calls `render()`.
  - Back button (if not step 0): `data-act="ob-go" data-v="INDEX-1"`.
  - Continue button: `data-act="ob-next"` (steps 0–9) → increments `S.ob.i` and re-renders.
  - Final button (step 10): `data-act="ob-done"` → removes dialog, sets localStorage, sets `S.gw.mode = S.ob.gw`, calls `render()`, shows toast "Branch is ready. Here's the two-minute walkthrough.", waits 700 ms, then calls `startTour()`.
  - **Escape key (pass 13):** Closes onboarding (if no dialog or popover is open) by calling `ob-close` action. If focus is in a text input with content, first Escape keypress blurs the input instead.
- **How it looks:**
  - Dialog (`.ob9`, `role="dialog"`) covers the window.
  - Left sidebar (`.ob-rail`, `<aside>`): fixed width, scrollable list, "Skip for now" at bottom.
  - Right main (`.ob-main`): larger flex area, `<section>`.
  - Title and body area (`.ob-body`) with form controls (text inputs, checkboxes, radio buttons styled as buttons, grids).
  - Footer (`.ob-foot`): flex row with Back button (left), spacer (grow), Continue button (right).
  - Colors: uses `--accent`, `--ink`, standard control colors.
  - Fonts: body text 14–15px, headings larger (h2).
- **States and edge cases:**
  - If user un-checks the "I understand" checkbox on step 0, Continue button is re-disabled.
  - If user goes back to a previous step from step 10, the health checks reset and progress disappears (unless they jump forward again, which re-triggers checks).
  - The onboarding can be cancelled at any time with "Skip for now" or Escape, which saves `branch-proto-seen13` (and `branch-proto-welcomed`) so it does not open by itself again.
  - Navigating via rail steps skips intermediate steps (jump to step 5 directly).
  - All form data in `S.ob` is retained when navigating back.
  - **Focus management (pass 13):** When a new step is displayed, keyboard focus automatically moves to the step's heading (h1 or h2) with `tabIndex = -1` and `preventScroll: true`, so screen readers announce the step title. Tab key keeps focus within onboarding (not the app behind it).
- **Source:** Lines 6040–6082 (OB_STEPS array, openOnboarding function, obBody function, action handlers); pass 10b.

---

### 6.3 Walkthrough (Guided tour, 28 cards)

- **What it is:** A sequential, interactive tour of 28 Branch features, each highlighting a screen element and explaining its purpose in 1–2 sentences.
- **Why it exists:** Users learn the app's structure and key workflows in 2 minutes, without manual reading.
- **When it appears:** Triggered by "Take the walkthrough" action or after setup completes; appears on top of the main interface.
- **Where it lives:** Full-screen overlay (`.tour-layer` div, `position: fixed`) with a card overlay, appended to `#app`.
- **How it works:**
  1. **Start:** `startTour()` closes all dialogs, turns off notes display, shows the tour, and calls `goTour(0)` to load the first card.
  2. **Navigation:**
     - `goTour(i)` moves to card index `i`, clamps it to `[0, TOUR.length - 1]`.
     - If the card has `stage7: true`, it switches `S.stage = null` (shows the stage instead of list during that card).
     - If the card has `surf: true`, it switches `S.surface = 'desktop'` (ensures desktop view).
     - Then it calls `placeTour()` to render the card on screen.
  3. **Each card in TOUR array:**
     - **sel** (selector): CSS selector of the element to highlight (e.g., `".list"`, `"[data-note=\"computer\"]"`).
     - **title** (string): Main heading of the card.
     - **text** (string): Explanation (1–2 sentences).
     - **Optional flags:**
       - `stage7: true`: This card features the stage/computer view.
       - `surf: true`: This card shows cross-surface comparison (e.g., phone, terminal).
  4. **Card 0: "Your Trunks are contacts"**
     - Highlights `.list` (the left sidebar).
     - Text: "Each Trunk is an assistant with one job. Message it like a teammate. A moving ring means it's working; a dot means it needs you."
  5. **Card 1: "Your Trunks, in person"**
     - Highlights `.agent12` (avatar animation).
     - Text: "Each Trunk can have a character. It acts out what the Trunk is really doing: thinking, searching, reading, working, waiting for you, celebrating, resting. Change it in the Trunk's Look tab."
  6. **Card 2: "Watch it work"**
     - Highlights `[data-note="computer"]` (the stage/computer view).
     - Text: "When a Trunk uses the browser you see it live, with Take over one click away. Its plan and folded steps sit just above."
  7. **Card 3: "Its own computer, full size"** (`stage7: true`)
     - Highlights `.stage7 .st7-screen`.
     - Text: "Pick which computer a Trunk may use: a private sandbox, this PC, the KeepOak computer or a home server. Watch it live, take over, or shrink it to a small window."
  8. **Card 4: "It asks before it acts"**
     - Highlights `.ask` (approval blocks).
     - Text: "Anything that sends, deletes, spends or installs waits for your yes: Send it, Always allow, or Don't. The Inbox collects them all."
  9. **Card 5: "Rooms: Trunks together"**
     - Highlights `.g-ask` (group approvals).
     - Text: "Several Trunks in one conversation. Call one with @, choose who answers, and answer two asks with Yes to both."
  10. **Card 6: "Model and thinking"**
      - Highlights `[data-note="modelchip"]`.
      - Text: "GPT-6 Sol, Opus 5.5 or the model on this computer, and how long it thinks. The choices change with the model."
  11. **Card 7: "How much it may do"**
      - Highlights `[data-note="modechip"]`.
      - Text: "Auto, Ask first, Plan first or Full access, per conversation. Shift+Tab switches; Lockdown stops everything."
  12. **Card 8: "Everything else is in +"**
      - Highlights `[data-act="plusmenu"]`.
      - Text: "Attach files, @mention a Trunk, use a skill, go Temporary, have it ask questions first, or choose who answers."
  13. **Card 9: "The side panel"**
      - Highlights `#pane` (Activity, Plan, Files, Memory tabs).
      - Text: "Activity, Plan, Files and Memory beside the conversation. Drag its edge to any width; double-click to reset. The browser and computer open full size instead."
  14. **Card 10: "What each account has left"**
      - Highlights `[data-note="codexbar"]`.
      - Text: "The ring shows the account used next. Click it for every plan's 5-hour, daily and weekly limits."
  15. **Card 11: "The gateway"**
      - Highlights `[data-note="gateway"]`.
      - Text: "Keeps your Trunks running when Branch is closed, and starts Branch again if it ever stops."
  16. **Card 12: "Five places"**
      - Highlights `.side-nav`.
      - Text: "Overview at a glance, Inbox for what needs you, Automations for work on its own, Library for what it remembers and made, Customize for Trunks, skills and chat apps."
  17. **Card 13: "Search everything"**
      - Highlights `.sq9`.
      - Text: "Chats, Trunk names, words inside messages and past sessions, as you type. Ctrl F finds words in a conversation; Ctrl K opens every command."
  18. **Card 14: "Settings, your way"**
      - Highlights `[data-note="gear"]`.
      - Text: "Regular, Advanced or Technical: just the essentials, or every file, port and raw key."
  19. **Card 15: "Models on this computer"**
      - Highlights `.lm-grid12`.
      - Text: "Branch looks at your memory and graphics card and only offers what fits. One click installs it; it runs free and private."
  20. **Card 16: "Every chat app"**
      - Highlights `.ch-wrap12`.
      - Text: "55 of them, each with its real recipe: make the bot, paste what it gives you, Branch checks it, you approve a six-digit code, save."
  21. **Card 17: "Pets and painted scenes"**
      - Highlights `.pets12`.
      - Text: "Pick one of dozens of pets to walk along the list, and a painted scene to sit behind the glass. They nap, cheer and follow what your Trunks are doing."
  22. **Card 18: "Your team"**
      - Highlights `[data-note="teamnav"]`.
      - Text: "Who's here and what their Trunks are running right now, shared Trunks, teams of Trunks, usage and rules. It comes from your keepoak.com workspace."
  23. **Card 19: "People"**
      - Highlights `.t10` (people and roles).
      - Text: "On this computer with a PIN, on their own devices with a passkey or a one-time code, or from your keepoak.com team. Seven kinds of action each; groups only take away."
  24. **Card 20: "Group chats, and Trunks that talk"**
      - Highlights `.a2a10`.
      - Text: "People, Trunks and agents on other computers in one conversation. Trunks can ask each other and sort it out; you see it folded up, and you choose who answers."
  25. **Card 21: "Branch changes itself, safely"**
      - Highlights `.self10`.
      - Text: "Ask it to change its own settings or gateway. It tries the change on a throwaway copy, shows you before and after, and every change can be rolled back."
  26. **Card 22: "Your layout"**
      - Highlights `.titlebar [data-act="side-toggle"]`.
      - Text: "Ctrl B hides the list. Drag any edge: narrow the list to icons, widen the side panel, or give the computer more room. Double-click an edge to reset."
  27. **Card 23: "Every surface, one switch"**
      - Highlights `#surf`.
      - Text: "Windows, Mac, Terminal, iPhone, Android and keepoak.com. Switch and judge: they share the same Trunks, Inbox and theme."
  28. **Card 24: "Branch in a terminal"** (`surf: true`)
      - Highlights `.tui-win`.
      - Text: "Type branch anywhere. The same places as a tab row, y/a/n to answer, /usage, /theme and every other command."
  29. **Card 25: "On your phone"** (`surf: true`)
      - Highlights `.phone6`.
      - Text: "Pair with a square code. Answer Ledger from the lock screen, send files from the share sheet, talk with one button."
  30. **Card 26: "keepoak.com, as it is"** (`surf: true`)
      - Highlights `.web6`.
      - Text: "The real portal: your computer, agents, approvals and plan. Branch has its own place next to Agents, with every computer it runs on and every Trunk you can talk to."
  31. **Card 27: "That's Branch"** (final card, `sel: null`)
     - No highlight (covers full screen).
     - Text: "Everything here is example data. Explore freely, and turn on the Guide's design notes to see why each part is where it is."
- **Controls during tour:**
  - **Top of card:** Back (if not card 0), Next (if not final card), Skip (close tour), Close (X).
  - Back button: `data-act="tour-back"` → calls `goTour(S.tourI - 1)`.
  - Next button: `data-act="tour-next"` → calls `goTour(S.tourI + 1)`.
  - Skip: `data-act="tour-skip"` → closes tour.
  - Close (X): `data-act="tour-end"` → calls `endTour()`.
  - Also: pressing Escape calls `endTour()`.
- **How it looks:**
  - Full-screen overlay (`.tour-layer`, `position: fixed`, dark background, high z-index).
  - Spotlight around the target element (CSS clipping or shadow cutout).
  - Card box (`role="dialog"`, `aria-label="..."`) positioned near the highlight.
  - Card contains: title (`<h3>`), text (`<p>`), control buttons at bottom.
  - Colors: card background `--bg`, text `--ink`, buttons use standard styles.
  - Font: title 18px bold, text 14–15px.
  - Transition: slides or fades as the user navigates.
- **States and edge cases:**
  - Pressing Escape closes the tour immediately.
  - If a card's selector does not match anything on screen (hidden or missing), the spotlight is skipped and the card text still displays.
  - If the user opens a dialog or navigates to a different view during the tour, the tour may be disrupted (e.g., if they open Settings, the next card's selector may not be found).
  - The tour is dismissed when the user clicks "Skip" or "Close", or when it reaches the final card and the user clicks "Close".
- **Source:** Lines 3974–4003 (TOUR array, startTour, endTour, goTour, placeTour functions); passes 6, 7.

---

### 6.4 Adding an account (Model account wizard, 3 steps)

- **What it is:** A dialog-based wizard to sign into a model provider (ChatGPT, Claude, Anthropic Gemini, etc.) or paste an API key.
- **Why it exists:** Users need to authenticate with multiple model providers to use them in Branch.
- **When it appears:** User clicks "Add an account" button in Models › Connections, or selects a provider from the accounts list, or clicks an "Add another" button.
- **Where it lives:** Full-screen modal dialog (`.dlg` overlay with `.dlg-box` inner), appended to `#app`.
- **How it works:**
  1. **Start:** `addAcct(prov)` initializes `S.addAcct = {step: prov ? 2 : 1, prov: prov || null, name:'', trunks:[], pos:'last', low:true}`, then calls `drawAddAcct()`.
  2. **Step 1: Choose provider** (if no provider passed)
     - If `prov` is null, start at step 1.
     - **Body:** "Which service is the new account with? You can have several accounts with each one."
     - Grid of provider buttons (`.prov` buttons):
       - Each button has `data-act="aa-prov" data-v="PROVIDER_KEY"`.
       - Each shows: provider logo (36px), provider name (e.g., "ChatGPT"), count of existing accounts, description ("a key" or "your plan").
       - Clicking a button sets `S.addAcct.prov = el.dataset.v`, sets `S.addAcct.step = 2`, calls `drawAddAcct()`.
       - If the provider's `how === 'plan'` (e.g., ChatGPT, Claude), also call `addAcctSignin()` (simulates a 1.8 s sign-in delay).
     - **Buttons:** No Back, no Continue; wizard advances only via provider selection.
  3. **Step 2: Authenticate** (sign in or paste key)
     - **Two paths based on provider type:**
     - **Path A: Key-based (Gemini, local Ollama, etc.; `how === 'key'`):**
       - **Body text:** "Paste the key from {{site}}. It goes straight into your password manager; Branch shows only the last four characters after this."
       - Label with input:
         - `<label class="fld">` with `<span>Key</span>`.
         - `<input class="inp" id="aa-key" type="password" autocomplete="off" placeholder="sk-or-…" aria-label="Key">`.
       - Hint: "Prototype: nothing you type here is kept."
       - **Buttons:** Back (`data-act="aa-back"`), Add key (`data-act="aa-key"`, primary).
       - Clicking "Add key" sets `S.addAcct.step = 3` and calls `drawAddAcct()`.
     - **Path B: Browser sign-in (ChatGPT, Claude; `how === 'plan'`):**
       - **Body shows a fake browser window (`.aa-site`):**
         - Address bar mockup: `{{site}}/signin?for=branch` with lock icon.
         - Page content: provider logo (40px), heading "Sign in to {{name}} to continue to Branch", instructional text.
         - Loading indicator: "Waiting for you to finish on {{site}}…"
       - **Hint:** "Branch never sees or stores your password. Prototype: this finishes by itself in a moment."
       - **Behavior:** After 1.8 seconds (via `addAcctSignin()`), automatically advance to step 3.
       - **Buttons:** Back, no Continue (auto-advances).
  4. **Step 3: Name and permissions**
     - **Header row:**
       - Provider logo (36px), name (e.g., "ChatGPT · Account 2"), status pill "Connected".
     - **Form fields:**
       - **Name input:** Label "Call it", input `id="aa-name"` with default `"{{provider}} · Account {{N}}"`.
       - **Quick names:** Three chips: "Personal", "Work", "Side project" (each with `data-act="aa-nm" data-v="{{provider}} · {{role}}"`, pre-fills the name input).
       - **Which Trunks use it:** Chips for each Trunk plus "Anyone who needs it":
         - Each chip has `data-act="aa-tr" data-v="{{trunk_id}}"`, toggles `aria-pressed` and adds/removes from `S.addAcct.trunks` array.
       - **Where it goes in order:** Radio buttons via `segAct()`:
         - "First" (`data-v="first"`): "First in the usage order".
         - "Last" (`data-v="last"`): "Last in the usage order".
         - Default: "Last".
         - `data-act="aa-pos"`.
       - **Use it when the others run low:** Checkbox with label and hint about account fallback.
     - **Buttons:** Back (`data-act="aa-back"`), Add account (`data-act="aa-done"`, primary).
     - Clicking "Add account" calls `finishAcct()`.
  5. **Finish:**
     - `finishAcct()` collects data:
       - Name from input, defaults to `"{{provider}} · Account {{N}}"`.
       - Trunks from `S.addAcct.trunks` (or "anyone" if empty).
       - Plan from `PROVS[provider].plans[0]`.
     - Adds row to `ACCTS` array (unshift if "first", push if "last").
     - Creates or updates a row in `LIMITS` array for plan-based accounts.
     - Clears `S.addAcct = null`.
     - Closes dialog.
     - Calls `render()`.
     - Shows toast: `"{{name}} is added. {{It's last in the order / It answers first now}}"`.
     - Unlocks achievement "Spare key".
- **Controls:**
  - **Step 1:** Provider buttons (each advances to step 2).
  - **Step 2:** Back button (`aa-back`) resets to step 1; "Add key" / auto-advance to step 3.
  - **Step 3:** Back button resets to step 1; "Add account" button finishes.
  - All steps show dialog title: "Add an account" (step 1) or "Add a {{provider}} account" (steps 2–3).
- **How it looks:**
  - Modal dialog (full-screen overlay with centered box).
  - Title at top.
  - Progress dots (`.wiz-dots`): three dots, filled for current and previous steps.
  - Body content: form inputs, labels, chips, radio buttons (styled as outlined buttons).
  - Footer: Back button (left), spacer (grow), action button (right, primary).
  - Colors: accent for action buttons, muted colors for disabled steps.
  - Font: body 14–15px, labels bold, hints small (12px).
- **States and edge cases:**
  - Clicking Back from step 3 goes back to step 1 (not step 2), clearing the provider selection.
  - Clicking Back from step 2 (key-based) goes to step 1.
  - The "Add key" step auto-advances if the provider is plan-based; key-based requires manual click.
  - If no Trunks are selected in step 3, `"anyone"` is used.
  - The name field has a 40-character limit (`maxlength="40"`).
  - The order selection uses radio buttons styled as toggle buttons; only one can be selected at a time.
- **Source:** Lines 4496–4538 (addAcct, drawAddAcct, addAcctSignin, finishAcct functions, ACTS handlers); pass 9.

---

### 6.5 Installing a local model

- **What it is:** A guided process to download and install an on-device language model (e.g., Qwen3.6, Gemma).
- **Why it exists:** Users can run models locally, free and private, if their hardware supports it.
- **When it appears:** User clicks a model in Settings › Models › On this computer, or selects "On this computer" in the first-run sequence.
- **Where it lives:** Dialog or progress overlay (exact layout depends on when it's triggered; in first-run, it's an inline progress bar).
- **How it works:**
  1. **Selection:**
     - User sees available models in a grid (`.lm-grid12`).
     - Each model shows: icon (CPU), name (e.g., "Gemma 4 27B"), size (e.g., "16.2 GB"), brief description (e.g., "good at writing").
     - Clicking "Download" on a model opens a download dialog.
  2. **Download dialog (`.downloadDlg()`):**
     - **Title:** "Get another model".
     - **Body:** Two rows of models (examples: Gemma 4 27B, Qwen3.6 7B).
       - Each row has: icon (CPU), name, size, description, "Download" button (`data-act="dl-go" data-i="{{index}}"`).
     - **Progress area:** `<div class="progress" id="dl-p" hidden>` with a progress bar `<u id="dl-bar" style="width:0%"></u>`.
     - **Status text:** `<p class="hint" id="dl-t">` showing "Downloads carry on if the computer sleeps."
  3. **Download process:**
     - Clicking "Download" button calls `dl-go` action.
     - Progress bar appears (`dl-p.hidden = false`).
     - Every 220 ms, `dl-bar.style.width` increments by ~9% (simulated).
     - Status text updates to `"{{pct}}% · {{size}}"`; when pct reaches 100, text becomes "Ready. It shows under On this computer."
     - After 100%, no further UI changes (model is available).
  4. **First-run integration:**
     - In the first-run "How should Branch think?" step, if user selects "On this computer":
       - `S.first = 2`, `S.frPct = 0`, and `renderFirst()` displays inline progress.
       - Progress bar fills from 0 to 100% over ~1.7 seconds (every 200 ms, increment by ~6%).
       - Text shows `"{{pct}}% · 19.8 GB"`.
       - When complete, auto-advance to next step.
  5. **One at a time:**
     - Only one model can be installing at a time; starting a second install cancels the first (though not explicitly shown in the code).
  6. **Remove:**
     - In Settings › Models › On this computer, installed models have an X or delete button.
     - Clicking it calls a remove action (not fully detailed in source).
- **How it looks:**
  - Download dialog: standard dialog layout with title, body, hidden progress section.
  - Progress bar: `<u>` element filling a track, `width: X%` style.
  - Status text: small font, muted color.
  - In first-run: inline progress bar and text in the step content.
  - Colors: accent color for the progress bar.
- **States and edge cases:**
  - Multiple models can be listed; only one download dialog is shown at a time.
  - Download progress is not paused if the user closes the dialog; the assumption is that the model continues downloading in the background (per the hint text).
  - In first-run, the download is blocked by the progress indicator; the user can still interact with other UI elements, but the step doesn't advance until the download is complete.
- **Source:** Lines 2946–2998 (downloadDlg, dl-go action); first-run step 2.

---

### 6.6 Connecting a chat app (Chat app wizard, 5 steps)

- **What it is:** A guided multi-step wizard to set up a messaging bot in Telegram, Slack, Discord, etc., and link it to Branch.
- **Why it exists:** Users can message their Trunks from the apps they already use (Telegram, Slack, Discord, WhatsApp, etc.).
- **When it appears:** User clicks a chat app in Customize › Reach, or the "Set up" button for a chat app that's not yet connected.
- **Where it lives:** Full-screen modal dialog with progress steps, appended to `#app`.
- **How it works:**
  1. **Start:** `chWizard(id, step)` is called with the chat app's `id` (e.g., `'telegram'`) and step number.
  2. **Step detection:**
     - The wizard determines which steps apply based on the chat app's configuration:
       - `create` (steps): "Create" the bot/app on the service's site (if the service requires setup).
       - `paste` (fields): "Paste" a token or credential from the service.
       - `check`: "Check" that the connection works (automated validation).
       - `pairing`: "Pair" with a phone or device via a six-digit code.
       - `save`: "Save" the connection and configure who answers.
     - Example: Telegram has `[Create, Paste, Check, Pair, Save]`; Slack might have `[Create, Check, Save]`.
  3. **Step 0: Create** (if applicable)
     - **Title:** "Set up {{app name}}" or "Make the bot on {{service}}".
     - **Body:** Instructions and one or two buttons.
       - Instruction text (multi-line or numbered list).
       - Button 1: "Open {{service}}" (link, `href="{{create.url}}"`, opens in new tab, blue primary button).
         - If `create.prefilled`, append text "with Branch's settings filled in".
       - Button 2: Optional "Get the {{app}} app" (link, gray secondary button).
     - **QR code (optional):** If `create.url` is set, show a QR code (148×148 px) below with hint "Or scan to do this on your phone".
     - **No navigation buttons** for this step; user must click "Open" to proceed (simulated, or manually click Next in prototype).
  4. **Step 1: Paste** (if applicable)
     - **Title:** "Set up {{app name}}" or "Add {{app}} to Branch".
     - **Body text:** "Paste what {{service}} gave you. Secrets go straight into your password manager; Branch shows only the last four characters afterwards."
     - **Form fields:** One input per required field (e.g., TELEGRAM_BOT_TOKEN):
       - `<label class="fld chf12 {{validation-state}}">` (state: `ok12`, `bad12`, or empty).
       - `<span>{{field label}}</span>` (e.g., "Token").
       - `<span class="chf-in12">` containing:
         - `<input class="inp" data-chf="{{key}}" type="{{password or text}}" placeholder="{{example}}" autocomplete="off" spellcheck="false">`.
         - If secret field: `<button>` with `data-act="chf-eye" data-k="{{key}}"` (show/hide icon).
       - `<small>` with validation hint:
         - If valid: "Looks right."
         - If invalid pattern: "That doesn't look like it. Check you copied all of it."
         - If no pattern: "Branch checks the shape as you paste."
     - **Validation (live, as user types):**
       - If field has `pattern` regex, test the input value against it.
       - Classes update: `ok12` (passes), `bad12` (fails), or empty (not yet filled).
       - Field with required data and no value is empty.
       - A field matching `/optional/i` in its description can be skipped.
     - **Buttons:** Back, Continue (disabled until all required fields are valid).
  5. **Step 2: Check** (if applicable)
     - **If auto-check (`c.check === true`):**
       - Initially show spinner: "Checking with {{service}}…", "A read-only request, nothing is sent to anyone."
       - After 1.3 seconds, update to: checkmark icon, "It answers.", "Found the bot: @hartwell_branch_bot" (if `checkName` flag) or "The service accepted the details.".
     - **If no check (`c.noCheck` message):**
       - Show hint text from `c.noCheck` (e.g., "No automated check for this one.").
     - **Buttons:** Back, Continue (enabled after check completes or immediately if no check).
  6. **Step 3: Pair** (if applicable, for apps with real-time codes)
     - **Body text:** {{pairing message}} (e.g., "Enter the six-digit code {{service}} shows on the other side.").
     - **Code input:** Six single-digit inputs (`.code12`):
       - Each input: `inputmode="numeric" maxlength="1" data-code="{{0-5}}"`.
       - User types or pastes digits; non-digits are filtered.
       - As digits are entered, focus moves to the next input.
       - If user pastes a 6-digit string, it's split across the inputs.
       - Hint: "The code works once, for ten minutes, and only for the person who sent the message."
     - **Validation:**
       - Continue button is enabled once all 6 digits are filled (regex `/^\d{6}$/`).
     - **Buttons:** Back, Approve (becomes enabled when all 6 digits are filled).
  7. **Step 4: Save** (final step)
     - **Header:** Checkmark icon, "{{service}} is ready", "Choose who answers there and who may use it, then save."
     - **Form fields:**
       - **Who answers in {{service}}:** Radio buttons (via `segAct()`) for each Trunk (plus Branch itself):
         - Each button shows Trunk avatar (20–30 px) and name.
         - Default: first Trunk.
       - **Who may message it:** Dropdown (via `ctlSeg()`):
         - Options: "Only me" (default), "People I approve", "Anyone in my workspace".
       - **Capabilities hint:** "Can: {{files, voice notes, buttons, or 'text only'}}" (if `c.can` is set).
     - **Buttons:** Back, Save (`data-act="chw-save"`, primary).
  8. **Finish:**
     - Clicking "Save" calls `chw-save` action:
       - Sets `S.ch12.on[id] = 'ok'`.
       - Clears `S.chw = null`.
       - Closes dialog.
       - Calls `render()`.
       - Shows toast: "{{service}} is connected. Messages there reach Branch."
       - Calls `leafBurst?.()` (particle effect).
       - Unlocks achievement "Pen pal".
- **Controls:**
  - Progress indicator at top: Dots or checkmarks for each step, showing completed, current, and upcoming steps.
  - Back button: returns to the previous step (except step 0, which has a Cancel button).
  - Next/Continue button: advances to the next step (disabled until conditions are met for the current step).
  - On step 0 (Create): clicking "Open {{service}}" is required before user can manually advance (in prototype, may auto-advance).
  - On step 1 (Paste): validations happen in real-time; Continue is disabled until all fields are valid.
  - On step 2 (Check): spinner auto-completes after 1.3 seconds.
  - On step 3 (Pair): code input auto-focuses and auto-advances focus between digits.
  - On step 4 (Save): "Save" button finishes the wizard.
  - Escape or clicking X anywhere: closes the dialog without saving (in prototype, not fully implemented).
- **How it looks:**
  - Modal dialog (full-screen overlay, centered box).
  - **Header row:** Service logo (40 px), service name, brief description (family, app name).
  - **Step indicator:** Row of steps with circles/checkmarks; filled for completed, outline for current, dimmed for upcoming.
  - **Body:** Form fields with labels, help text, hints.
    - Paste step: field validation colors (green border for ok12, red for bad12).
    - Check step: spinner icon (animated rotation) or checkmark icon.
    - Code step: six input boxes in a row, monospace font, large text.
    - Save step: button groups for radio selection (Trunks), dropdown for permissions.
  - **Footer:** Back button (if not step 0), spacer, action button (Continue/Approve/Save, primary style).
  - Colors: accent for buttons, muted for labels, green (#22c55e or similar) for validation ok, red for validation bad.
  - Font: title 16–18px bold, labels 14px, hints 12px, code inputs 24px monospace.
- **States and edge cases:**
  - A chat app can be "managed" if already connected (`S.ch12.on[id] === 'ok'`); clicking its button re-opens the wizard at step 99 (a special state showing only the Save step with current settings).
  - Pasting into code inputs: non-digit characters are stripped; if user pastes a 7-digit string, only the first 6 are used.
  - If a required field is left blank, the Continue button is disabled.
  - Validation runs on every keystroke; invalid state is shown immediately.
  - If the user navigates back from step 2 (Check) to step 1 (Paste), the validation state of fields is preserved.
  - Steps can be skipped in the wizard's internal array if the chat app doesn't have that capability (e.g., no `create` step means `create` is not in the steps array).
- **Source:** Lines 6866–6935 (chWizard, chWizard handler, Paste/Check/Pair/Save logic, event listeners for input); pass 12b.

---

### 6.7 Pairing a phone

- **What it is:** A QR code and set of steps for syncing the Branch app on a phone with the desktop installation.
- **Why it exists:** Users can message and approve tasks from their phone, seeing the same Trunks and conversations.
- **When it appears:** User clicks "Show the code" in Customize › Reach, or "Pair" in the onboarding wizard's Reach step.
- **Where it lives:** Modal dialog with QR code and instructions, appended to `#app`.
- **How it works:**
  1. **Trigger:** `pairPhone()` is called by a "Pair" button with `data-act="pair"`.
  2. **Dialog:**
     - **Title:** "Pair a phone".
     - **Body:**
       - **QR code:** Canvas element `<canvas class="qr" id="qr" width="148" height="148" aria-label="Example pairing code, not a real one">`.
         - Generated with simple procedural QR-like pattern (seeded random, not real QR encoding).
       - **Instructions** (ordered list, `.steps-list`):
         1. "Open the Branch app on your phone."
         2. "Tap **Pair with a computer**."
         3. "Point the camera at this code."
         4. "Check that both screens show **OAK-4127**." (example code for prototype).
       - **Hint:** "Example code for the prototype. A real code works once and expires in 5 minutes."
     - **Buttons:** Cancel button (`data-act="dlg-close"`).
  3. **QR generation (canvas-based):**
     - The QR code is drawn on a 148×148 px canvas using a seeded pseudorandom generator.
     - Pattern: 29×29 grid, 7 blocks used for position detection (finder patterns), rest randomly filled.
     - Colors: white background, black foreground.
     - Not a real QR code; for prototype purposes, it's a visual placeholder.
  4. **Real behavior (implied):**
     - In a real app, the dialog would stay open and wait for the phone to scan and confirm the code.
     - A six-digit code would appear on both the desktop and phone screens; the user must verify they match before pairing completes.
     - No automatic timeout is enforced in the prototype (but real app would expire the code after 5 minutes).
- **Controls:**
  - Cancel button: closes the dialog without pairing.
  - Pressing Escape: closes the dialog.
  - No "Pair" button; pairing in the real app would happen when the phone confirms.
- **How it looks:**
  - Modal dialog (centered, small).
  - Title at top.
  - QR code in the center (canvas, 148×148, white background, black pattern, monospace aspect ratio).
  - Instructions below: `<ol class="steps-list">` with `<li>` items; steps 2 and 4 have bold text (`<b>`).
  - Hint text below instructions (small, muted color).
  - Cancel button at bottom (secondary style).
  - Layout: vertical stack, centered.
  - Colors: `--ink` for text, `--bg` for background, black/white for QR pattern.
  - Font: title 16px bold, steps 14px, hint 12px.
- **States and edge cases:**
  - The QR code is a static placeholder, not functional.
  - The dialog does not auto-close after a successful pair (in a real app, it would).
  - The code text "OAK-4127" is hardcoded for the prototype and doesn't change.
  - Multiple phone pairings are not shown in the prototype (but the real app would support multiple phones).
- **Source:** Lines 2866–2874 (pairPhone function); pass 1.

---

### 6.8 Adding a connector (Connector catalog)

- **What it is:** A searchable catalog of 52 integrations (GitHub, Gmail, Slack, Notion, etc.) that users can add to allow Branch to access those services.
- **Why it exists:** Users can connect work tools, file storage, chat apps, and developer platforms without writing code.
- **When it appears:** User clicks "Add a connector" in Customize › Tools, or the "+" button in the Tools section.
- **Where it lives:** Full-screen modal dialog with search, category tabs, and a grid of services, appended to `#app`.
- **How it works:**
  1. **Trigger:** `toolAdd('mcp')` is called (or `toolAdd('mcp', 'own')` to add a custom server).
  2. **Dialog layout:**
     - **Title:** "Add a connector".
     - **Intro text:** "52 ready to connect, or add your own server."
     - **Search bar:** Label with search icon, input `id="mcp-q"` with placeholder "Search connectors", `aria-label="Search connectors"`, `autocomplete="off"`.
       - As user types, `S.mcpQ` is updated and the dialog re-renders with filtered results.
       - Search is case-insensitive and checks both service name and description.
     - **Category tabs:** Tab-style buttons for "All" and each category (Work, Mail & calendar, Files, Chat, Developer, Design & media, Business, Home & web).
       - Each button: `data-act="mcp-cat" data-v="{{category}}"`.
       - Clicking a tab filters results to that category.
     - **Results grid (`.aa-list12`):** For each category with matches:
       - Category heading: `<h3>{{category}} <span>{{match count}}</span></h3>`.
       - Service buttons (`.prov .prov12`):
         - Logo (32 px), name, description.
         - `data-act="mcp-add" data-v="{{service name}}"`.
         - Clicking adds the service to the connectors list (implementation not detailed in source).
     - **Empty state:** If no results match the search, show message "Nothing matches. Add your own server below."
  3. **Service catalog (MCP12 array):**
     - 8 categories with 12–14 services each:
       - **Work:** GitHub, GitLab, Linear, Jira, Confluence, Asana, Trello, ClickUp, Monday.com, Notion, Airtable, Todoist.
       - **Mail & calendar:** Gmail, Outlook, Google Calendar, Fastmail, Proton Mail.
       - **Files:** Google Drive, OneDrive, Dropbox, Box, Files on this computer, Obsidian.
       - **Chat:** Slack, Discord, Microsoft Teams, Telegram.
       - **Developer:** Sentry, Vercel, Cloudflare, Supabase, Postgres, SQLite, Docker, Kubernetes, Hugging Face, Playwright.
       - **Design & media:** Figma, Canva, YouTube, Spotify.
       - **Business:** Stripe, Shopify, HubSpot, Salesforce, QuickBooks, Zendesk.
       - **Home & web:** Home Assistant, Brave Search, Weather, Maps, Zapier.
  4. **Add your own server:**
     - **Button at footer:** `data-act="tool-add" data-v="mcp" data-step="own"`.
     - Clicking opens a second dialog or form for entering a custom server URL, authentication details, etc. (details not fully specified in source).
  5. **Service selection:**
     - Clicking a service button adds it to the tools list.
     - Toast confirms: "{{service}} added." (details not in source).
- **Controls:**
  - **Search input:** Real-time filtering; input event updates `S.mcpQ` and re-renders.
  - **Category tabs:** Each tab filters results to that category.
  - **Service buttons:** Each adds the service (details vary by service).
  - **Cancel button:** Closes the dialog.
  - **"Add your own server" button:** Opens a form for custom connectors.
- **How it looks:**
  - Modal dialog (wide, scrollable for long lists).
  - **Header:** Title, intro text, search bar with icon.
  - **Tabs:** Horizontal row of category buttons, "All" selected by default.
  - **Grid:** Category headings with match counts, service buttons below each heading.
    - Service buttons: logo (left), name (bold), description (small), aligned in columns.
    - Buttons use standard `.prov` styling.
  - **Footer:** "Add your own server" button (secondary style).
  - Colors: `--ink` for text, `--accent` for active tab, muted for descriptions.
  - Font: heading 14px bold, service name 14px, description 12px.
- **States and edge cases:**
  - Searching by partial text: "slack" matches "Slack", "Slack", "slack-related"; search is substring-based, case-insensitive.
  - Filtering by category: only services in that category are shown; search is applied within the category.
  - If category has no results, the category heading and grid are not shown.
  - If no services match the search across all categories, the empty state message is shown.
  - Multiple selection is not shown in the prototype; typically, one service at a time is added.
  - The catalog includes popular tools; clicking a service may open an external authentication flow (not detailed in source).
- **Source:** Lines 7020–7060 (MCP12 array, toolAdd override, mcp-cat action, input event); pass 12c.

---

### 6.9 Choosing a pet, scene, and character look

- **What it is:** Settings pages for customizing the visual appearance of pets, backgrounds, and Trunk avatars.
- **Why it exists:** Personalization makes the app feel more alive; visual feedback helps users connect with their Trunks.
- **When it appears:** User navigates to Appearance, Trunks › Looks, or Customize › {{Trunk}} › Look.
- **Where it lives:** Settings pages (`.place` content in `#main`), or inline dialogs when editing a specific Trunk.
- **How it works (overarching state management):**
  - **Pet state:** `S.pet` (boolean: show/hide), `S.petKind` (string: 'squirrel', 'owl', 'hedgehog', or 'none'), `S.petName` (string: custom name).
  - **Background state:** `S.bg` (string: 'none', 'grove', 'oak3d', 'rings', 'own'), `S.season` (string: 'auto', 'spring', 'summer', 'autumn', 'winter'), `S.scrim` (number: 0–90, opacity of color overlay), `S.see` (number: 0–60, see-through level), `S.own` (object: {name, kind, size, url}).
  - **Trunk look state:** `S.look` (object: {trunk_id: character_id, ...}), e.g., `{branch:'branch', scout:'ember', ledger:'tock', ...}`.
  - **Character data (LOOKS array):** Each character has `{id, name, description, still (image), states: {idle, work, yay, sleep, ...} (videos), ...}`.
- **Pet selection (Appearance › The pet):**
  - **Control:** Segmented buttons (`.seg` role group) with four options:
    - "None" (`data-v="none"`), "Squirrel" (`data-v="squirrel"`), "Owl" (`data-v="owl"`), "Hedgehog" (`data-v="hedgehog"`).
    - `data-act="petset"` (action that sets `S.pet = true` if not 'none', or `S.pet = false` if 'none', and sets `S.petKind = value`).
  - **Name field:** Input `id="pet-name"` with current value `S.petName`, placeholder, width 140px.
    - User can type a custom name for the pet.
    - Label: "Name", hint: "Pat it for a tip."
    - On input, the name is stored but not immediately persisted (implicit save).
  - **Behavior:**
    - Selected pet appears at the bottom of the Trunk list, walking back and forth.
    - Clicking the pet shows a random tip (5 rotating tips).
    - Pet follows Trunks' activity: idle, thinking, working, etc.
    - Pet animation loops (if not still/reduced-motion).
- **Background selection (Appearance › Background):**
  - **Behind the glass (scene):** Radio buttons via `segAct()`:
    - "None" (no background, transparent or white).
    - "The grove" (pixel forest with changing seasons).
    - "The oak in 3D" (3D rendered oak tree).
    - "Growth rings" (concentric rings).
    - "Your own" (custom uploaded image, video, or 3D model).
    - Default: "grove" or "none".
    - `data-act="bgset" data-v="{{value}}"`.
  - **Season (if grove is selected):** Radio buttons via `segAct()`:
    - "By the date" (auto-detect), "Spring" (petals), "Summer" (fireflies), "Autumn" (leaves), "Winter" (snow).
    - Default: "auto".
    - `data-act="season" data-v="{{value}}"`.
  - **Custom file upload (if 'own' is selected):**
    - Label: "Choose a file", file input `id="bg-file6"` with `accept="image/*,video/*,.glb,model/gltf-binary"`.
    - Allowed types: pictures, animations, videos (up to 25 MB), 3D models (.glb, up to 5 MB).
    - Display current file if set: name, file type, size (MB), optional note for 3D.
    - Button: "Remove" (`data-act="bg-remove"`), opens confirmation dialog.
    - If 3D model, show hint: "this prototype can't read .glb, so the oak turns instead".
  - **Fit (if background is not 3D):** Radio buttons via `segAct()`:
    - "Fill" (scales to fill, may crop).
    - "Fit" (scales to fit, may letterbox).
    - "Tile" (repeats for pictures and animations, only if not video).
    - Default: "fill".
    - `data-act="bgfit" data-v="{{value}}"`.
  - **Scrim (opacity of overlay):** Range slider:
    - Input `id="scrim6" type="range" min="0" max="90" step="5"` with current `S.scrim` value.
    - Label: "How much the theme covers it", hint: "More keeps text calmer; less shows more of the background."
    - Disabled if background is "none".
    - On change, `S.scrim = value`.
  - **See-through (transparency of panels):** Range slider:
    - Input `id="see" type="range" min="0" max="60" step="5"` with current `S.see` value.
    - Label: "See-through panels", hint: "Panels blur what's behind them."
    - Disabled if background is "none".
    - On change, `S.see = value`.
  - **Preview:** Button with `data-act="bg-peek"` ("See it clearly", with eye icon):
    - Clicking adds class `.peek` to `#app`, clearing the view to see the full background without UI.
    - Clicking again or pressing Escape removes the `.peek` class.
    - Disabled if background is "none".
- **Trunk character selection (Customize › {{Trunk}} › Look):**
  - **Edit dialog (triggered by edit button on Trunk card):**
    - Opens `editTrunk()` with state stored in `editTrunk.state`.
  - **Character selector:** Grid or list of available character figures (LOOKS array):
    - Each shows: still image or animation, name, description.
    - Clicking a character updates `S.look[trunk_id] = character_id`.
  - **Additional customizations (if applicable):**
    - **Color:** Buttons for each available color (e.g., `#2F8F5B`, `#3A5A99`, ...).
      - `data-act="st-colour" data-v="{{hex_color}}"` → sets `editTrunk.state.d.color = value`.
    - **Shape:** Buttons for each available shape (abstract shapes, proportions).
      - `data-act="st-shape" data-v="{{index}}"` → sets `editTrunk.state.d.shape = value`.
    - **Eyes:** Buttons for eye styles ('round', 'wide', 'sleepy').
      - `data-act="st-eyes" data-v="{{style}}"` → sets `editTrunk.state.d.eyes = value`.
    - **Shuffle:** Button `data-act="st-shuffle"` randomizes color, shape, and eyes.
  - **Preview:** Live preview updates as user changes settings (calls `editTrunk.state.draw()`).
  - **Name field:** Input for renaming the Trunk.
  - **Role field:** Text input or multi-line for job description.
  - **Save:** Button `data-act="st-save"` → updates `C(id)` with the new values, closes dialog, shows toast.
  - **States:**
    - State object: `editTrunk.state = {id, d: {name, color, shape, eyes, role}, tab, draw()}`.
    - `tab` field switches between tabs (e.g., Look, Activity, Automations, etc.).
    - `draw()` re-renders the preview.
- **How it looks:**
  - **Pet:** Small animated figure (20–50 px) at the bottom of the list, walking left-right.
  - **Background:** Full-screen scene behind the UI, with theme-colored overlay and blur effects on panels.
  - **Trunk character:** Avatar (30–60 px) in the list and conversation header, animated or static based on state and reduced-motion preference.
  - **Settings pages:**
    - Pet section: heading, segmented button group, name input field.
    - Background section: heading, "Behind the glass" buttons, season buttons (conditional), file upload (conditional), sliders, preview button.
    - Trunk edit dialog: side-by-side preview (left) and controls (right), or stacked on narrow screens.
  - **Colors:** Pet uses theme colors; background imagery is custom; Trunk colors from a palette (see source data).
  - **Font:** Section headings 16–18px bold, labels 14px, hints and descriptions 12–13px.
- **States and edge cases:**
  - If pet is set to "none", no pet appears and the name field is hidden.
  - If background is "none", the scrim and see-through sliders are disabled (grayed out).
  - If background is "own" and no file is uploaded, show file chooser.
  - If background is "own" and file is uploaded (image/video/3D), show filename, size, and remove button.
  - If 3D model (.glb) is uploaded, hide the "Fit" control and show a note that the prototype doesn't render it.
  - Trunk avatars change appearance instantly when a setting is updated (not animated transitions).
  - Pet and background settings are saved to localStorage and persist across sessions (via implicit save on state change).
  - If reduced-motion is enabled (OS preference), animations are replaced with static images.
- **Source:** 
  - Pet: lines 4614–4616 (Appearance › The pet section).
  - Background: lines 4607–4612 (Appearance › Background section).
  - Trunk looks: lines 4716–4757 (editTrunk function, st-tab, st-colour, st-shape, st-eyes, st-shuffle, st-save actions); pass 9.

---

### 6.10 Sending a message and watching an agent work

- **What it is:** The main interaction loop: user types a message, Trunk processes it with visible steps and thinking, replies, and optionally asks for approval before acting.
- **Why it exists:** This is the core workflow; transparency and control are built in.
- **When it appears:** Whenever a user is in a conversation (view === 'chat').
- **Where it lives:** Conversation area in `#main`, message composer at bottom.
- **How it works:**
  1. **Composition:**
     - User types into `#msg` textarea (composer input).
     - Textarea auto-expands up to 160px as user types (calculated from `scrollHeight`).
     - `data-act="send"` is the button that submits (or stops if working).
     - As user types, the button changes appearance: `ready` class if text, `stop` class if empty and working.
  2. **Sending:**
     - User clicks Send button or presses Enter (form submit event).
     - `send()` function collects text from `#msg`, trims it.
     - If empty and Trunk is working, calls `stopWork()` instead.
     - Otherwise, creates a message block `{k:'u', html: esc(text), fresh:true}` and pushes to `threads[S.chat]`.
     - Conversation name is auto-generated from first few words of message if this is the first message.
     - Shows typing animation, then simulated reply with a 900 ms delay.
     - Clears the composer, re-renders.
  3. **Agent response:**
     - Simulated in the prototype; real app would process via model.
     - **Typing phase:** Shows a `{k:'typing', from, fresh:true}` block (spinner, "Thinking…").
     - **Reply phase:** After delay, removes typing block, adds multiple blocks:
       - `{k:'steps', from, summary:'Thought about it · 1 step · 2s', items:[...]}` — folded plan.
       - `{k:'b', from, html:'<p>...reply text...</p>'}` — the main reply.
     - Updates Trunk status: `C(id).status = 'idle'`, `c.preview = 'reply text'`, `c.unread = false` (if viewing).
  4. **Approval blocks (if applicable):**
     - If a Trunk tries to send mail, delete files, install software, or spend money, an approval block appears:
     - `{k:'ask', id:'unique-id', state:'pending', title:'Send the September report to Dana?', items:[{state: 'pending', text:'option 1'}, ...]}`
     - Block shows:
       - Title and context (e.g., "$1,286.40", amount).
       - Options: "Send it", "Always allow", "Don't" (or custom button text).
       - `data-act="ask" data-v="allowed|always|denied"` buttons for each option.
     - Clicking an option updates `b.state` and shows confirmation.
  5. **Approvals in inbox:**
     - All pending approvals are collected in the Inbox tab.
     - "Allow all" button (`data-act="allowall"`) approves all pending at once.
  6. **Agent working:**
     - While Trunk is working, conversation shows:
       - Working status ring around avatar.
       - `c.status = 'working'`.
       - Steps block shows progress: `items:[['step name', 'status'], ...]` where status is 'todo', 'now', 'done'.
       - Meter bar shows progress percentage.
     - Computer view (if applicable): live browser/stage window showing Trunk's actions.
       - Blocks can show: `{k:'computer', state:'working|yours|done', title:'...'}`.
       - Buttons: "Take over" (`data-act="takeover" data-id="..."`) pauses Trunk and gives user mouse/keyboard.
       - "Hand back" (`data-act="handback"`) resumes Trunk.
  7. **Completion:**
     - When finished, `c.status = 'idle'`, status ring stops.
     - Reply shows final result, e.g., "Found 3 invoices. Attached here."
     - Completion block: `{k:'done', text:'Done in 3m 31s'}`.
     - Achievement unlocked (if applicable).
  8. **Stopping:**
     - User clicks the Send button while working → calls `stopWork()`.
     - Sets `c.status = 'idle'`, `c.preview = 'Stopped by you.'`.
     - Shows "Stopped" message: "Nothing was sent. Say 'carry on' when you want me to pick it back up."
- **Controls:**
  - **Composer:**
    - Input `#msg` (textarea).
    - Send button with id/action `data-act="send"`.
    - Icon changes: up arrow (ready), stop icon (stop).
    - On Enter (no Shift), submits form.
  - **Message block controls (from reply):**
    - Copy button (hover).
    - Try again button (hover).
    - Expand/collapse for long replies.
  - **Step blocks:**
    - Next/back arrows to step through details.
    - Collapse/expand to see full step list or summary only.
  - **Approval blocks:**
    - Three option buttons.
    - Clicking an option updates state and shows toast confirmation.
  - **Computer view:**
    - "Take over" button pauses Trunk.
    - "Hand back" button resumes.
    - Browser window shows live content.
- **How it looks:**
  - **Composer:** Text input at bottom, Send button (icon only, changes based on state).
  - **Message:** User message in light bubble (right-aligned or left, depending on design), text left-aligned.
  - **Typing:** Spinner icon, "Thinking…" text, muted color.
  - **Reply:** Trunk avatar (left), message bubble with text and optional formatting.
  - **Steps block:** Folded by default (shows summary line), expandable to show numbered list of steps and their status.
  - **Approval block:** Title, amount/detail, option buttons (styled as choices, not just generic buttons).
  - **Computer view:** Full-width browser window, screenshot or live content, Take over / Hand back buttons above.
  - **Status ring:** Around avatar, animated rotation while working, solid color when idle.
  - **Colors:** User message `--accent` or light background, reply `--bg` with border, approval block highlighted with accent.
  - **Font:** Message text 14–15px, step title 13px, approval title bold 14px.
- **States and edge cases:**
  - If user types `@trunk_name`, composer shows a mention autocomplete popup (see slash commands section, covered elsewhere).
  - If user types `/skill_name`, composer shows a slash command popup.
  - If message is empty and user clicks Send, the button is disabled (no-op).
  - If a Trunk is paused (`c.paused = true`), the status ring doesn't animate and working blocks are hidden.
  - If a Trunk has an error (`c.status = 'error'`), the avatar shows an error state and steps show "Hit a snag".
  - Approval blocks persist in Inbox until approved or denied; "Allow all" allows all pending at once.
  - If the user navigates away from a conversation while a Trunk is working, the background task continues (status shown in Inbox).
  - Multiple approvals in one task can be answered in sequence; answering all advances the task.
  - Computer view can be taken over, releasing control returns to Trunk.
- **Source:** Lines 3076–3092 (send, stopWork), 3051–3053 (botSay), 3107–3112 (ask action), 3105–3106 (takeover/handback); multiple passes.

---

### 6.11 Other flows: lock screen, focus mode, updates, gateway changes, Branch changing itself, sharing, and achievements

#### 11a. Lock screen (Lockdown)

- **What it is:** A PIN-protected state that pauses all Trunk activity and blocks approvals.
- **Why it exists:** Fast way to prevent accidental actions when stepping away.
- **When it appears:** User clicks "Lockdown" button in Overview or presses a keyboard shortcut, or activity is blocked by a parent/admin.
- **Where it lives:** Full-screen overlay (`role="dialog"`) appended to `#app`.
- **How it works:**
  1. **Activation:** `toggleLock()` toggles `S.locked`.
     - If `true`, creates a lock screen with PIN input (`<form data-form="pin">`).
     - If `false`, removes it.
  2. **Lock screen:**
     - **Title:** "Branch is locked".
     - **Status:** Shows whether anything is running ("Scout keeps working while it's locked." or "Nothing is running.").
     - **PIN input:** Four single-digit inputs (`<input inputmode="numeric" maxlength="1">`), labeled "PIN digit 1–4".
     - **Hint:** "Prototype: any four digits unlock."
  3. **Unlocking:**
     - User types four digits.
     - When all four are entered, auto-checks them.
     - If valid (any four digits in prototype, real code would check actual PIN), clears the lock screen and resumes normal operation.
     - Shows toast: "Welcome back."
  4. **Behavior while locked:**
     - All buttons are disabled except PIN input.
     - No new approvals are shown.
     - Running Trunks continue in the background but do not ask for approval.
     - Conversations are readable but not writable.
- **Controls:**
  - PIN input fields (focus moves to next field as digit is entered).
  - Escape key cancels (returns focus to previous screen, remains locked).
- **How it looks:**
  - Full-screen overlay (black or semi-transparent background).
  - Central dialog box with the Branch face mark, title, status text.
  - PIN input: four boxes in a row, large font (24–32px), monospace.
  - Colors: white on dark, or accent highlight on inputs.
- **Source:** Lines 3037–3042 (renderLockScreen, lock toggle action).

#### 11b. Focus mode (Hide distractions)

- **What it is:** A toggle that hides the sidebar, status bar, or other UI elements to reduce visual clutter.
- **Why it exists:** Helps users concentrate on a single conversation.
- **When it appears:** User clicks a Focus button or presses Ctrl+Shift+F (not explicitly coded in source).
- **Where it lives:** Button in the titlebar or menu, state persisted in `S.focus`.
- **How it works:**
  1. **Toggle:** `toggleFocus()` flips `S.focus` between true and false.
  2. **Rendering:** `app.classList.toggle('focus', S.focus)` applies CSS to hide elements.
  3. **Hidden elements:** Sidebar, status bar, side panel (in some designs).
  4. **Behavior:** Conversation takes up full width; minimal UI.
- **Controls:**
  - Toggle button (`data-act="focus"`).
- **How it looks:**
  - When enabled: conversation maximizes, sidebar and status bar disappear (or are hidden with very low opacity).
  - Chat area expands to fill screen.
  - Subtle "Focus mode" indicator or button to exit.
- **Source:** Lines 3030, 3059 (focus toggle, renderChat logic).

#### 11c. Updates (Gateway and Branch version)

- **What it is:** Notifications for new versions of Branch and triggers for the gateway to restart or change mode.
- **Why it exists:** Users can stay current without manual checking; gateway keeps background tasks alive.
- **When it appears:** A new version is available, or user changes gateway settings.
- **Where it lives:** Status bar, overview, or settings pages; menus for update actions.
- **How it works:**
  1. **Updates:**
     - A version check (not detailed in source) determines if a new version is available.
     - Status bar shows "Update {{version}} ready".
     - Clicking opens a menu (`updmenu` pop) with "Install when nothing is running" option.
     - Clicking "Install" shows toast "0.20.0 will install when nothing is running." Later, "Update cancelled. You stay on 0.19.4." (in prototype, manual undo).
  2. **Gateway mode:**
     - User can set `S.gw.mode` to 'off', 'when-needed', or 'on'.
     - Changes persist in settings.
     - Indicator in status bar shows current mode.
     - Clicking opens `gwpop` menu with options and info.
     - "Restart engine" action (`gw-restart`) shows toast "Engine restarted in 0.6 s. The gateway carried on 1 task."
- **Controls:**
  - Update menu (`data-act="updmenu"`): "Install when nothing is running", toast feedback.
  - Gateway menu (`data-act="gwpop"`): radio buttons for mode, restart button.
  - Both have toast feedback.
- **How it looks:**
  - Status bar item: "Update {{version}} ready", icon (bell or notification).
  - Menu: buttons for each option, status text below.
  - Toast: temporary message at bottom-right.
- **Source:** Lines 3136, 3130–3131 (updmenu action, install action); gateway not fully shown.

#### 11d. Branch changing itself (Branch autonomously updates settings)

- **What it is:** Branch can modify its own settings (e.g., add a new Trunk, enable a feature) if given approval.
- **Why it exists:** Advanced use case for power users; demonstrates Branch's self-modification capability.
- **When it appears:** User asks Branch to change itself (e.g., "Add a reminder Trunk"), and an approval block appears.
- **Where it lives:** Approval block in conversation, with "Try it", "Allow", "Don't" buttons.
- **How it works:**
  1. **Proposal:** Branch suggests a change and shows before/after preview.
  2. **Approval:** User clicks "Try it" to see the change on a copy, then "Apply" to make it real, or "Don't" to reject.
  3. **Execution:** If approved, the change is applied to settings (e.g., a new Trunk is created) and shown in the UI.
  4. **Rollback:** User can undo the change from Activity tab.
- **Controls:**
  - Approval block buttons: "Try it", "Apply", "Don't".
  - Undo button in Activity.
- **How it looks:**
  - Side-by-side before/after comparison in the approval block.
  - New Trunk appears in the list if approved.
  - Toast confirms: "New Trunk added."
- **Source:** Not fully detailed in source (`.self10` reference).

#### 11e. Sharing (Sharing conversations or Trunks with others)

- **What it is:** Users can share a conversation, Trunk, or file with others on their computer or team.
- **Why it exists:** Collaboration: teams can see each other's progress.
- **When it appears:** User clicks Share button in a conversation menu or Trunk menu.
- **Where it lives:** Dialog or menu with sharing options.
- **How it works:**
  1. **Share dialog:** Opens `shareDlg(kind, id)` where `kind` is 'chat', 'trunk', etc.
  2. **Options (tabs):**
     - **With people:** Checkboxes for each team member; select permissions (No/Read/Write).
     - **As a file:** Downloads a copy (no scripts, keys blanked out).
     - **As a link:** Generates a link with expiration (1 hour, 1 day, 7 days).
     - **Hand off:** Gives another Trunk the task (for team coordination).
  3. **Saving:** Clicking "Share" or "Make the link" applies the change and shows toast.
- **Controls:**
  - Share button (`data-act="share"`).
  - Dialog with tabs, checkboxes, permission dropdowns, "Share" button.
- **How it looks:**
  - Dialog with tabs at top, content below, action button at bottom.
  - Checkboxes for people, permission pills (No/Read/Write).
  - Link display (copiable text or button "Copy link").
- **Source:** Lines 6183–6189 (shareDlg, sharing tabs and options).

#### 11f. Achievements (128 unlockable badges)

- **What it is:** A gamification system with 128 achievements across 8 categories, shown when unlocked.
- **Why it exists:** Encourages exploration and use of features; celebratory feedback.
- **When it appears:** Toast pops up when an achievement is unlocked (e.g., "First words" on first message).
- **Where it lives:** Toast notifications (temporary), Achievements page in settings/sidebar.
- **How it works:**
  1. **Categories (8):** Getting started (20), Trunks & devices (16), Automations (12), Looks & fun (28), Streaks (8), Safety (14), Explorer (11), Unlisted.
  2. **Unlocking conditions:**
     - Send first message → "First words".
     - Finish a task → "It did the thing".
     - Answer approval → "Yes, please".
     - Stop a task → "Stop right there".
     - Undo from Activity → "Undo, undo".
     - Rename a Trunk → "Name tag".
     - Edit SOUL.md → "A soul of its own".
     - Edit AGENTS.md → "House rules".
     - Add account → "Connected" or "Spare key".
     - Use setup/tour → "Tour guide".
     - Pair phone → "In your pocket".
     - Connect chat app → "Pen pal".
     - Try all 44 themes → "Every leaf on the tree".
     - Use "Ask me questions first" → "Asked first".
     - Attach file → "Picture this" / "Paper trail".
     - Create Trunk → "A Trunk of your own".
     - Pair second computer → "Paired".
     - Use focus mode → custom.
     - Open every settings page → "Every page".
     - Earn badges across days → "Back again", "Week of work", "Weekend off", etc.
  3. **Display:**
     - On unlock, show toast with achievement icon, name, description.
     - Achievements page shows grid of badges, filtered by category.
     - Locked badges are dimmed/greyed out.
     - Category tabs: All, Getting started, Trunks & devices, Automations, Looks & fun, Streaks, Safety, Explorer.
  4. **UI (Achievements page):**
     - Sidebar or settings subsection.
     - Grid of badges (32–50px), each with icon, name, description.
     - Tabs to filter by category.
     - Count: "{{N}} of 128".
     - Sorted by unlock date or category.
- **Controls:**
  - Category tabs: `data-act="achcat" data-v="{{category}}"`.
  - Each badge clickable for details (shows description, unlock condition if not yet earned).
- **How it looks:**
  - **Toast:** Small card with badge icon (32–48px), name (bold, 14px), description (12px, muted), appears 2–3 seconds.
  - **Achievements page:** Grid layout, 4–8 columns, badges 50–64px with label below.
    - Locked badge: greyed out, lock icon overlay.
    - Unlocked badge: color, star or trophy icon.
  - **Colors:** Badge icons use tier colors (Bronze, Silver, Gold, Diamond = #CD7F32, #C0C0C0, #FFD700, #7F7FFF or similar).
  - **Font:** Name 12–14px bold, description 11–12px, category headings 14px bold.
- **Tiers (visual distinction):**
  - Bronze: 20 achievements (Getting started).
  - Silver: 44 achievements (Trunks & devices, Automations, Safety).
  - Gold: 8 achievements (Streaks).
  - Diamond: 11 achievements (Explorer).
  - (Some spill across categories; totals in dump.json show 128 total.)
- **Full achievement list (from dump.json "ach" array):**
  - **Getting started (20):** First words, It did the thing, Yes please, Not that one, Stop right there, Undo undo, Name tag, About you, A soul of its own, House rules, Connected, Signed in with ChatGPT, Keeps itself fresh, Stays up late, Found the palette, Tour guide, Asked first, Temporary, Picture this, Paper trail.
  - **Trunks & devices (16):** A Trunk of your own, Three's company, Dressed up, Shape shifter, Paired, In your pocket, Borrowed browser, Room for two, @ you, Handoff, Renamed, Rearranged, KeepOak account, Lent a hand, Family, Kids' corner.
  - **Automations (12):** On a schedule, Good morning, While you slept, Saved steps, Run it again, Tripwire, Webhook hello, Chat app on duty, Standing order, Inbox zero, Check-in, Waiting line.
  - **Looks & fun (28):** Every leaf on the tree, Night shift, Daylight saving, Follow the sun, Four seasons, Rings of time, Your own view, Moving pictures, Third dimension, Pet project, Name that squirrel, Pat pat, Moving house, See-through, Clear view, Wide load, Resized, It's lonely over here, Minimalist, (Plus 9 more related to pets, scenes, layout).
  - **Streaks (8):** Back again, Week of work, Weekend off, Early bird, Night owl, Lunch break, Monday person, Anniversary.
  - **Safety (14):** Lockdown drill, And off again, Plan first, Read only, Second look, Kept secret, Keychain keeper, Safety copy, Checkpoint, Budgeted, Pinned, No surprises, Health check, Walled garden.
  - **Explorer (11):** Technical, Advanced, Hidden setting, Every page, Terminal tourist, Side drawer, Browser tab, Shell game, Memory lane, Library card, (Plus 1 more).
- **Source:** Lines 5046–5700+ (ach array in dump.json); achievements defined in passes 9, 10, 11, 12.

---

### Summary

These eleven journey categories cover every significant user flow in the prototype: first-time setup, learning, configuration, messaging, collaboration, and gamification. Each journey is designed to be transparent (showing what Branch is doing), controllable (user can pause, approve, undo), and iterative (settings can be changed at any time). All exact text, button labels, and control sequences are preserved from the source code to ensure a faithful rebuild.

---

### 6.12 An update arrives while work is running

1. Settings › Updates & about (and the update popover) say 0.20.0 is ready.
2. You click "Install when nothing is running". Four tasks are working, so "Install 0.20.0" opens with "Let them finish first" already chosen.
3. **Most people press Continue.** The dialog closes: "It installs when the running tasks finish. You can keep working." Nothing else changes.
4. **If you choose "Install now",** the install walk runs across the bottom of the window with the Branch figure walking the bar. When it finishes, the Inbox shows "Pick up what the update cut off" for Scout's task.
5. "Pick it up" opens Scout's conversation where it stopped. "Leave it" removes the card; the task stays in History.

### 6.13 Branch proposes a change to its own code

1. Something went wrong in a task (the Downloads sweep moved a spreadsheet you had open). Branch writes a fix on a copy of its own code and runs its tests.
2. Inbox › Needs you shows "Branch wants to improve itself" after the approvals, so it never pushes ahead of a real yes someone is waiting for.
3. "Review" shows exactly which files it may touch, that anything else is refused, that 14 of 14 tests pass on the copy, and that it lands as a draft pull request, never on main. The diff is short and readable.
4. "Approve the edits" is the first yes. The dialog stays open so you can read it again; the button becomes "Publish the draft".
5. "Publish the draft" is the second yes: a draft pull request opens on GitHub. Merging is always a person's job.
6. "Decline" at any point throws the fix away.

### 6.14 A Trunk needs the screen on a Mac

1. You ask Scout to find the Hartwell invoice. It needs to sign in to Outlook, which means seeing the screen and using the mouse.
2. After its computer card, Scout's conversation shows "Scout needs to see the screen and use the mouse", with why.
3. "Open System Settings" opens Privacy & Security at Screen Recording. Branch is in the list with its leaf icon. You switch it on and
   confirm with Touch ID. macOS says Branch may not record the screen until it is quit: "Later" or "Quit & Reopen".
4. If you choose Later, the card becomes "Restart Branch so Scout can see the screen". Switch to Accessibility in the sidebar and allow
   that too.
5. Back in Branch, it checks again by itself and says what changed. Settings › Permissions › This Mac shows the same statuses.
6. "Restart Branch" reopens it in a moment, with every conversation where it was. The card is gone and Scout carries on. Sending the
   email still waits for your yes: system permissions let Branch *reach* the screen; Branch's own approvals decide what it *does*.

## 7. Catalogs: every service, app, connector, model, character, pet and scene

These lists are generated from the prototype's own data, so names and wording are exact. The real Branch install data they come from lives in `C:\Users\bishi\Code\Branch-Agent\data\` (`providers.json`, `channel-setup.json`, `local-models.json`).

### 7.1 Account services (53)

**Intent:** Branch answers with whatever accounts the person already has. A person can add several accounts per service and choose the order they are tried in. Only the 5 base services (plus any the person has signed in to) show on the Accounts page. All 53 show in the add-account picker, grouped as below.

| # | id | Name | Group | How it signs in | Plans / notes | Site |
|---|---|---|---|---|---|---|
| 1 | `openai` | ChatGPT | Your plan | plan | Plus, Pro, Team — Your ChatGPT plan, through its own sign-in page. | chatgpt.com |
| 2 | `anthropic` | Claude | Your plan | plan | Pro, Max, Team — Your Claude plan, through Claude Code. Branch never signs in to Claude.ai itself. | claude.ai |
| 3 | `gemini` | Gemini | Your plan | plan | AI Pro, AI Ultra — Your Google AI plan, through Gemini’s own sign-in. | gemini.google.com |
| 4 | `cc-claude` | Claude Code | Coding assistants | plan | Pro, Max — Uses your Claude plan through Claude Code on this computer. | claude.ai |
| 5 | `cc-codex` | Codex | Coding assistants | plan | Plus, Pro — Uses your ChatGPT plan through the Codex command line. | chatgpt.com |
| 6 | `cc-gemini` | Gemini CLI | Coding assistants | plan | Free, AI Pro — Google’s command line with your Google sign-in. | gemini.google.com |
| 7 | `cc-copilot` | Copilot CLI | Coding assistants | plan | Pro, Pro+ — GitHub’s own Copilot command line; Branch runs it for you. | github.com |
| 8 | `openrouter` | OpenRouter | A key | key | Key | openrouter.ai |
| 9 | `openai` | OpenAI | A key | key | Key — The usual OpenAI account. Nothing extra to fill in. | platform.openai.com |
| 10 | `openai-responses` | OpenAI (Responses API) | A key | key | Key — The same OpenAI account over OpenAI's newer Responses route. Same key as the entry above. | platform.openai.com |
| 11 | `azure-openai` | Azure OpenAI | A key | key | Key — Needs your resource name and the name you gave the deployment; the model is chosen by the deployment, not by the model name. | portal.azure.com |
| 12 | `azure-openai-v1` | Azure OpenAI (v1 address) | A key | key | Key — Azure's newer address with no dated version to keep up with. Put your deployment name where the model goes. | portal.azure.com |
| 13 | `anthropic` | Anthropic | A key | key | Key — Your own Anthropic API key. Nothing extra to fill in. To use a Claude plan instead, add Claude Code under coding assistants; Branch never signs in to Claude.ai itself. | console.anthropic.com |
| 14 | `anthropic-vertex` | Claude on Google Vertex AI | A key | key | Key — Claude billed through your own Google Cloud project. Needs a project id, a region and a sign-in token rather than an API key: paste one from `gcloud auth print-access-token`. Tokens expire after about an hour. | console.cloud.google.com |
| 15 | `gemini` | Google Gemini | A key | key | Key — A Google AI Studio key. The key travels in a header, never in the address. To use a Google plan instead, add Gemini CLI under coding assistants; Branch never reuses Gemini CLI's sign-in. | aistudio.google.com |
| 16 | `vertex-ai` | Google Vertex AI | A key | key | Key — Needs a project id and a region, and a sign-in token rather than an API key. Branch does not fetch that token for you: paste one from `gcloud auth print-access-token`. Tokens expire after about an hour. | console.cloud.google.com |
| 17 | `mistral` | Mistral | A key | key | Key — Nothing extra to fill in. | console.mistral.ai |
| 18 | `groq` | Groq | A key | key | Key — Very fast, text only. Nothing extra to fill in. | console.groq.com |
| 19 | `openrouter` | OpenRouter | A key | key | Key — One key that reaches many services. Model names carry the maker in front, like openai/gpt-4-turbo. Prices differ per model, so Branch keeps none on file. | openrouter.ai |
| 20 | `together` | Together AI | A key | key | Key — Nothing extra to fill in. | together.ai |
| 21 | `fireworks` | Fireworks AI | A key | key | Key — Model names start with accounts/fireworks/models/. Nothing extra to fill in. | fireworks.ai |
| 22 | `deepseek` | DeepSeek | A key | key | Key — Nothing extra to fill in. | platform.deepseek.com |
| 23 | `xai` | xAI (Grok) | A key | key | Key — Nothing extra to fill in. | console.x.ai |
| 24 | `perplexity` | Perplexity | A key | key | Key — Answers questions with sources of its own, through Perplexity's Agent API. Pick a preset (fast, low, medium, high, xhigh) or a provider/model name. Older Sonar connections were moved over for you. | www.perplexity.ai |
| 25 | `cohere` | Cohere | A key | key | Key — Cohere speaks its own shape rather than OpenAI's. Nothing extra to fill in. | dashboard.cohere.com |
| 26 | `cerebras` | Cerebras | A key | key | Key — Nothing extra to fill in. | cloud.cerebras.ai |
| 27 | `sambanova` | SambaNova | A key | key | Key — Nothing extra to fill in. | cloud.sambanova.ai |
| 28 | `huggingface` | Hugging Face Inference | A key | key | Key — Hugging Face's router, which speaks OpenAI's shape and passes your request on to whoever hosts the model. | huggingface.co |
| 29 | `cloudflare` | Cloudflare Workers AI | A key | key | Key — Needs your Cloudflare account id as well as a token. Model names start with @cf/. | dash.cloudflare.com |
| 30 | `bedrock` | AWS Bedrock | A key | key | Key — Signs each request with your AWS keys rather than sending them. The secret access key is the key you paste in; the access key id and region go in the boxes above. Some regions want a cross-region name such as us.anthropic.claude-sonnet-5, and Anthropic models need AWS's first-use form. | console.aws.amazon.com |
| 31 | `portkey` | Portkey | A key | key | Key — A gateway that sits in front of other services and speaks OpenAI's shape. Which model answers depends on the configuration you set up there. | app.portkey.ai |
| 32 | `vercel-ai-gateway` | Vercel AI Gateway | A key | key | Key — The gateway the AI SDK talks to: one key reaches many services, and models are named vendor/model. A bare name such as claude-sonnet-4 is given its vendor for you. | vercel.com |
| 33 | `moonshot` | Moonshot (Kimi) | A key | key | Key — Kimi models. International keys use api.moonshot.ai (the usual choice); keys from the Chinese platform use api.moonshot.cn. Branch keeps no price on file for it. | platform.kimi.ai |
| 34 | `zhipu` | Zhipu GLM (China) | A key | key | Key — Zhipu's platform in mainland China, billed in yuan. Outside China, use Z.ai instead. Branch keeps no price on file for it. | open.bigmodel.cn |
| 35 | `zai` | Z.ai (GLM) | A key | key | Key — Zhipu's GLM models for the rest of the world. Branch keeps no price on file for it. | z.ai |
| 36 | `dashscope` | Qwen (Alibaba DashScope) | A key | key | Key — Alibaba Model Studio in its OpenAI-compatible mode. International (Singapore) is the usual choice; the US and mainland China addresses are offered too. A workspace address works through "Something else". Branch keeps no price on file. | modelstudio.console.alibabacloud.com |
| 37 | `minimax` | MiniMax | A key | key | Key — International keys use api.minimax.io (the usual choice); keys from the Chinese platform use api.minimax.cn. Branch keeps no price on file for it. | platform.minimax.io |
| 38 | `modelscope` | ModelScope | A key | key | Key — Alibaba's model hub in its OpenAI-compatible mode. Branch keeps no price on file for it. | modelscope.cn |
| 39 | `doubao` | Doubao (Volcengine Ark) | A key | key | Key — ByteDance's Ark service. The model name is usually an endpoint id you created there. Billed in yuan; Branch keeps no price on file. | console.volcengine.com |
| 40 | `qianfan` | Baidu Qianfan | A key | key | Key — Baidu's Qianfan in its OpenAI-compatible mode. Billed in yuan; Branch keeps no price on file. | console.bce.baidu.com |
| 41 | `voyageai` | Voyage AI | A key | key | Key — Compares passages only; it does not hold conversations, so it cannot be a connection that answers you. Use it for searching your own documents. | dash.voyageai.com |
| 42 | `ollama` | Ollama | On this computer | local | Key — Runs on this computer, so nothing leaves it and nothing is charged. Install Ollama and run `ollama serve`. No key needed. | ollama.com |
| 43 | `lm-studio` | LM Studio | On this computer | local | Key — Runs on this computer. Load a model in LM Studio and start its server. Any placeholder key works. | lmstudio.ai |
| 44 | `vllm` | vLLM | On this computer | local | Key — Runs on this computer. Start vLLM with its OpenAI-compatible server. Any placeholder key works. | docs.vllm.ai |
| 45 | `llama-cpp` | llama.cpp | On this computer | local | Key — Runs on this computer. Start llama-server from llama.cpp. Any placeholder key works. | github.com |
| 46 | `localai` | LocalAI | On this computer | local | Key — Runs on this computer and can also make speech and pictures. Any placeholder key works. | localai.io |
| 47 | `jan` | Jan | On this computer | local | Key — Runs on this computer. Turn on Jan's local server. Any placeholder key works. | jan.ai |
| 48 | `litellm` | LiteLLM proxy | On this computer | local | Key — A proxy you run yourself that speaks OpenAI's shape and forwards to whichever service you configured behind it. Point this at wherever you run it. | docs.litellm.ai |
| 49 | `custom` | Something else that speaks OpenAI's shape | Your own | key | Key — For a service Branch does not know about yet. Paste its address; it must be an https address, or a plain http one on this computer. | its site |
| 50 | `github` | GitHub Copilot | Retired | plan | Pro, Pro+ — GitHub supports Copilot sign-in only in its own tools. Use GitHub’s Copilot command line instead. | github.com |
| 51 | `github-models` | GitHub Models | Retired | key | Key — Retired by GitHub on 30 July 2026. A saved connection stays on the list with this note and is never used. | github.com |
| 52 | `github-copilot` | GitHub Copilot (sign-in) | Retired | key | Key — Not offered. Use the GitHub Copilot command line under coding assistants instead: it is GitHub's own program with your own sign-in. | github.com |
| 53 | `google-palm` | Google PaLM | Retired | key | Key — Retired by Google. PaLM's models were replaced by Gemini, which uses the same kind of key: connect Gemini instead. | aistudio.google.com |

### 7.2 Chat apps (55)

**Intent:** the person can message Branch from any chat app they already use. Each app has a setup recipe: **Create** (a link and a QR code to make the bot), **Paste** (the token or keys, checked live against a pattern), **Check** (Branch tests the connection), **Pair** (a six-digit code sent from the app, when the app needs it), then **Save** (who answers, and who may message). The filters are All, Popular (core), Work chat (chat) and More (parity).

| # | id | Name | Family | Turn-on style | Create link | What you paste | Check | Pairing |
|---|---|---|---|---|---|---|---|---|
| 1 | `telegram` | Telegram | Popular | guided | https://t.me/BotFather?text=%2Fnewbot | The token BotFather sends: digits, a colon, then a long run of letters | yes | Send any message to your bot in Telegram. It answers with a six-digit code; type that code here. |
| 2 | `discord` | Discord | Popular | file | https://discord.com/developers/applications?new_application=true | The bot token from the Bot page | yes | Invite the bot to your server and send it a direct message. It answers with a six-digit code; approve it under Customize, Chat apps. |
| 3 | `slack` | Slack | Popular | file | https://api.slack.com/apps?new_app=1&manifest_json={{manifest}} | The Bot User OAuth Token, starting xoxb-; The app-level token, starting xapp- | yes | Send the app a direct message in Slack. It answers with a six-digit code; approve it under Customize, Chat apps. |
| 4 | `whatsapp` | WhatsApp Business | Popular | file | https://developers.facebook.com/docs/whatsapp/cloud-api/get-started | The access token; The app secret; A word of your own choosing, typed into WhatsApp's webhook page too | no: Meta's read-only check needs the token inside the address, which Branch never does, so the token is checked when WhatsApp first posts to Branch. | Send a WhatsApp message to the business number. It answers with a six-digit code; approve it under Customize, Chat apps. |
| 5 | `email` | Email | Popular | file | — | The app password (not your usual password) | no: Mail is checked by signing in to the IMAP server when Branch starts, not by a web request. | — |
| 6 | `messenger` | Facebook Messenger | Popular | file | https://developers.facebook.com/docs/messenger-platform/getting-started/quick-start | The page access token; The app secret; A word of your own choosing, typed into Meta's webhook page too | no: Meta's read-only check needs the token inside the address, which Branch never does. | — |
| 7 | `instagram` | Instagram | Popular | file | https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api | The access token; The app secret; A word of your own choosing, typed into Meta's webhook page too | no: Meta's read-only check needs the token inside the address, which Branch never does. | — |
| 8 | `matrix` | Matrix (Element) | Popular | file | https://app.element.io/#/register | The assistant account's access token | yes | — |
| 9 | `signal` | Signal | Popular | file | — | path; account | no: Nothing to paste: signal-cli holds the account itself. | — |
| 10 | `mattermost` | Mattermost | Work chat | file | https://docs.mattermost.com/integrations-guide/incoming-webhooks.html | The incoming webhook address; The outgoing webhook's token | no: The only way to test an incoming address is to post a message into your chat, so Branch checks that it is an https address and leaves the first message to you. | — |
| 11 | `rocketchat` | Rocket.Chat | Work chat | file | https://docs.rocket.chat/docs/integrations | The incoming integration's address; The outgoing integration's token | no: The only way to test an incoming address is to post a message into your chat, so Branch checks that it is an https address and leaves the first message to you. | — |
| 12 | `googlechat` | Google Chat | Work chat | file | https://developers.google.com/workspace/chat/quickstart/webhooks | The space's webhook address; The token Google Chat sends with each post | no: The only way to test an incoming address is to post a message into your chat, so Branch checks that it is an https address and leaves the first message to you. | — |
| 13 | `msteams` | Microsoft Teams (webhook) | Work chat | file | https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook | The incoming webhook address; The outgoing webhook's security token | no: The only way to test an incoming address is to post a message into your chat, so Branch checks that it is an https address and leaves the first message to you. | — |
| 14 | `zulip` | Zulip | Work chat | file | {{server}}/#settings/your-bots | The bot's API key | no: The only way to test an incoming address is to post a message into your chat, so Branch checks that it is an https address and leaves the first message to you. | — |
| 15 | `feishu` | Feishu / Lark | Work chat | file | https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot | The custom bot's address; The signing secret | no: The only way to test an incoming address is to post a message into your chat, so Branch checks that it is an https address and leaves the first message to you. | — |
| 16 | `dingtalk` | DingTalk | Work chat | file | https://open.dingtalk.com/document/robots/custom-robot-access | The robot's address; The signing secret | no: The only way to test an incoming address is to post a message into your chat, so Branch checks that it is an https address and leaves the first message to you. | — |
| 17 | `wecom` | WeCom (group robot) | Work chat | file | https://developer.work.weixin.qq.com/document/path/91770 | The group robot's address | no: The only way to test an incoming address is to post a message into your chat, so Branch checks that it is an https address and leaves the first message to you. | — |
| 18 | `line` | LINE | Work chat | file | https://developers.line.biz/console/ | The channel access token; The channel secret | yes | — |
| 19 | `viber` | Viber | Work chat | file | https://developers.viber.com/docs/api/rest-bot-api/ | The bot's token | yes | — |
| 20 | `irc` | IRC | More | switch | — | The registered nick's password | no: There is nothing Branch can ask a web service to check; the connection is tried when the switch goes on. | — |
| 21 | `twitch` | Twitch chat | More | switch | https://dev.twitch.tv/console/apps/create | The bot account's user access token | yes | — |
| 22 | `gotify` | Gotify | More | switch | {{server}}/#/applications | The application token | no: An application token can only send, so there is no read-only check; the first message is the test. | — |
| 23 | `imessage` | iMessage | More | switch | — | — | no: There is nothing Branch can ask a web service to check; the connection is tried when the switch goes on. | — |
| 24 | `msteams-bot` | Microsoft Teams (bot) | More | switch | https://dev.teams.microsoft.com/bots | The client secret | yes | — |
| 25 | `webex` | Webex | More | switch | https://developer.webex.com/docs/bots | The bot's access token; A secret of your own for the webhook | yes | — |
| 26 | `synology-chat` | Synology Chat | More | switch | https://kb.synology.com/en-global/DSM/help/Chat/chat_integration | The incoming webhook address; The outgoing webhook's token | no: The only way to test an incoming address is to post a message into your chat, so Branch checks that it is an https address and leaves the first message to you. | — |
| 27 | `zalo` | Zalo Official Account | More | switch | https://developers.zalo.me/ | The app secret; The Official Account secret key; The access token; The refresh token | no: Zalo's check would spend the refresh token, so Branch leaves it for the first connection. | — |
| 28 | `flock` | Flock | More | switch | https://dev.flock.com/ | The app secret; The bot token | no: Flock does not document a read-only check for a bot token. | — |
| 29 | `pumble` | Pumble | More | switch | https://pumble.com/help/integrations/add-pumble-apps/ | The app key; The bot token; The signing secret | no: Pumble does not document a read-only check for a bot token. | — |
| 30 | `mastodon` | Mastodon | More | switch | {{server}}/settings/applications/new | The application's access token | yes | — |
| 31 | `bluesky` | Bluesky | More | switch | https://bsky.app/settings/app-passwords | The app password | no: Checking an app password means signing in, which Branch does when the switch goes on. | — |
| 32 | `reddit` | Reddit | More | switch | https://www.reddit.com/prefs/apps | The script app's secret; The bot account's password | no: Reddit's check means signing in, which Branch does when the switch goes on. | — |
| 33 | `discourse` | Discourse | More | switch | {{server}}/admin/api/keys/new | The API key | yes | — |
| 34 | `x-dm` | X direct messages | More | switch | https://developer.x.com/en/portal/dashboard | The user access token | yes | — |
| 35 | `twist` | Twist | More | switch | https://developer.twist.com/v3/ | The access token | no: Twist's read-only check was not confirmed in its documentation, so Branch does not guess one. | — |
| 36 | `nextcloud-talk` | Nextcloud Talk | More | switch | {{server}}/settings/user/security | The app password | yes | — |
| 37 | `sms` | Text messages (Twilio) | More | switch | https://console.twilio.com/ | The Auth Token | yes | — |
| 38 | `ntfy` | ntfy | More | switch | — | An access token, only for a server that asks for one | no: A public topic has nothing to check; the first notification is the test. | — |
| 39 | `pushover` | Pushover | More | switch | https://pushover.net/apps/build | The application's API token; Your user key | yes | — |
| 40 | `threema` | Threema Gateway | More | switch | https://gateway.threema.ch/ | The Gateway secret | no: Threema's check needs the secret inside the address, which Branch never does. | — |
| 41 | `homeassistant` | Home Assistant | More | switch | {{server}}/profile/security | The long-lived access token | yes | — |
| 42 | `xmpp` | XMPP (Jabber) | More | switch | — | The account's password | no: There is nothing Branch can ask a web service to check; the connection is tried when the switch goes on. | — |
| 43 | `mqtt` | MQTT | More | switch | — | The broker password | no: There is nothing Branch can ask a web service to check; the connection is tried when the switch goes on. | — |
| 44 | `keybase` | Keybase | More | switch | — | path | no: Nothing to paste: the keybase program holds the account. | — |
| 45 | `simplex` | SimpleX Chat | More | switch | — | — | no: Nothing to paste: SimpleX has no tokens. | — |
| 46 | `deltachat` | Delta Chat | More | switch | — | path | no: Nothing to paste: the program holds the account. | — |
| 47 | `nostr` | Nostr | More | switch | — | The assistant's private key | no: There is nothing Branch can ask a web service to check; the connection is tried when the switch goes on. | — |
| 48 | `vk` | VK | More | switch | https://dev.vk.com/en/api/bots/getting-started | The community token | yes | — |
| 49 | `qq-bot` | QQ (official bot) | More | switch | https://q.qq.com/ | The AppSecret | yes | — |
| 50 | `guilded` | Guilded | More | switch | https://www.guilded.gg/ | The bot token | yes | — |
| 51 | `revolt` | Revolt (Stoat) | More | switch | https://app.revolt.chat/settings/bots | The bot token | yes | — |
| 52 | `mumble` | Mumble | More | switch | — | The server password, if there is one | no: Mumble is tried by connecting to the server when the switch goes on. | — |
| 53 | `kook` | KOOK | More | switch | https://developer.kookapp.cn/app/index | The bot token | yes | — |
| 54 | `wechat-mp` | WeChat Official Account | More | switch | https://mp.weixin.qq.com/ | The AppSecret; The Token you set; The EncodingAESKey | no: WeChat only takes the AppSecret inside the address, which Branch never does, so it is checked on first connection. | — |
| 55 | `wecom-app` | WeCom app | More | switch | https://work.weixin.qq.com/wework_admin/frame#apps | The app Secret; The Token you set; The EncodingAESKey | no: WeCom only takes the secret inside the address, which Branch never does, so it is checked on first connection. | — |

#### How to create each bot (the exact words on the Create step)

- **Telegram:** BotFather opens with /newbot already typed. Send it, then give the bot a name and a username ending in bot. BotFather answers with the token.
- **Discord:** Name the application, open Bot, press Reset Token and copy it. Switch on Message Content Intent on the same page.
- **Slack:** Slack opens its new-app page with Branch's settings filled in. Pick your workspace and press Create, then Install. Copy the Bot User OAuth Token, and under Basic Information make an app-level token with connections:write.
- **WhatsApp Business:** Make a Meta app with the WhatsApp product, then copy the access token, the phone number ID and the app secret from its pages.
- **Facebook Messenger:** Make a Meta app with the Messenger product, link your page, and copy the page access token and the app secret.
- **Instagram:** Make a Meta app with Instagram messaging for your professional account, then copy its token and app secret.
- **Matrix (Element):** Make a separate account for the assistant on your homeserver, sign in with it, and copy its access token from Settings, Help and About.
- **Mattermost:** In your Mattermost, open Integrations, add an incoming webhook for a channel and copy its address; add an outgoing webhook too if the assistant should answer.
- **Rocket.Chat:** In Administration, Integrations, make an incoming integration for a channel and copy its address; make an outgoing one with a token if the assistant should answer.
- **Google Chat:** In a Chat space, open Apps and integrations, add a webhook and copy its address.
- **Microsoft Teams (webhook):** In the Teams channel, add an incoming webhook (Microsoft now suggests the Workflows app for this) and copy its address.
- **Zulip:** Your Zulip opens on Personal settings, Bots. Add a new bot of the outgoing webhook kind and copy its API key.
- **Feishu / Lark:** In a group's settings, add a custom bot, switch on signature checking, and copy the address and the secret.
- **DingTalk:** In a group's settings, add a custom robot with signing switched on, and copy the address and the secret.
- **WeCom (group robot):** In a WeCom group, add a group robot and copy its address. It can only send.
- **LINE:** Make a Messaging API channel, then copy its channel access token and channel secret.
- **Viber:** Create a bot account through Viber's partner site and copy its token.
- **Twitch chat:** Register an application, then make a user access token for the bot's account with the chat:read and chat:edit scopes.
- **Gotify:** In your Gotify, open Apps, create an application and copy its token.
- **Microsoft Teams (bot):** In the Teams Developer Portal, open Bot management, add a bot, make a client secret, and copy the bot id and the secret.
- **Webex:** Sign in to Webex for Developers, create a bot and copy its access token.
- **Synology Chat:** In Synology Chat, open Integration, make an incoming webhook and an outgoing webhook, and copy the address and the token.
- **Zalo Official Account:** Make an app on Zalo for Developers, link your Official Account, and copy the app secret, the OA secret key and the tokens.
- **Flock:** Sign in to Flock's developer site, create an app with a bot, and copy the app secret and the bot token.
- **Pumble:** Create a Pumble app for your workspace and copy its app key, bot token and signing secret.
- **Mastodon:** Your server opens its new-application page. Give it a name, keep read and write, save, and copy Your access token.
- **Bluesky:** Bluesky opens on App passwords. Add one (allow direct messages) and copy it.
- **Reddit:** Reddit opens its apps page. Create a script app and copy its id (under the name) and its secret.
- **Discourse:** Your forum opens its new API key page (admins only). Give it a description, choose the assistant's user, and copy the key.
- **X direct messages:** In the X developer portal, make an app with direct-message access and make a user access token for the bot's account. X charges for this API.
- **Twist:** Make a Twist integration, or a test token from its OAuth section, and copy the access token.
- **Nextcloud Talk:** Your Nextcloud opens on Security. Make an app password for the assistant's account and copy it.
- **Text messages (Twilio):** In the Twilio Console, copy the Account SID and Auth Token, and buy or pick a number.
- **Pushover:** Pushover opens its new-application page. Name it Branch, create it, and copy its API token. Your user key is on the Pushover home page.
- **Threema Gateway:** Sign up for Threema Gateway, request a Basic ID, and copy the ID and its secret.
- **Home Assistant:** Your Home Assistant opens on Security. Under Long-lived access tokens, create one and copy it.
- **VK:** In your community's settings, open API usage, create a token with messages access, and switch on the Long Poll API.
- **QQ (official bot):** Sign in to the QQ bot platform, create a bot, and copy its AppID and AppSecret.
- **Guilded:** In your server's menu, open Bots, create a bot, and copy its token from the API tab.
- **Revolt (Stoat):** In Settings, My Bots, create a bot and copy its token.
- **KOOK:** On KOOK's developer site, create an application, open Bot, choose WebSocket, and copy the token.
- **WeChat Official Account:** In your verified Official Account's developer settings, copy the AppSecret, set a Token and EncodingAESKey, and choose safe mode.
- **WeCom app:** In the WeCom admin console, make a self-built app, and copy its Secret; under Receive messages set a Token and EncodingAESKey.

### 7.3 Connectors (52, in 8 categories)

**Intent:** connectors (MCP servers) let Trunks use the person's other tools. They are added from Customize › Tools › Connectors › Add, with search and category tabs. "Add your own server" covers anything not listed.

**Work** (12)

| Name | What it gives Branch |
|---|---|
| GitHub | Repos, issues, pull requests |
| GitLab | Projects, merge requests, pipelines |
| Linear | Issues and projects |
| Jira | Issues, sprints and boards |
| Confluence | Pages and spaces |
| Asana | Tasks and projects |
| Trello | Boards and cards |
| ClickUp | Tasks and docs |
| Monday.com | Boards and items |
| Notion | Pages and databases |
| Airtable | Bases and records |
| Todoist | Tasks and projects |

**Mail & calendar** (5)

| Name | What it gives Branch |
|---|---|
| Gmail | Read, search and draft mail |
| Outlook | Mail, calendar and contacts |
| Google Calendar | Events and free time |
| Fastmail | Mail and calendars |
| Proton Mail | Mail through the bridge |

**Files** (6)

| Name | What it gives Branch |
|---|---|
| Google Drive | Docs, sheets and files |
| OneDrive | Files and Office documents |
| Dropbox | Files and folders |
| Box | Files and shared folders |
| Files on this computer | Folders you choose |
| Obsidian | Notes in your vault |

**Chat** (4)

| Name | What it gives Branch |
|---|---|
| Slack | Channels and messages |
| Discord | Servers and channels |
| Microsoft Teams | Chats and channels |
| Telegram | Chats through your bot |

**Developer** (10)

| Name | What it gives Branch |
|---|---|
| Sentry | Errors from your apps |
| Vercel | Deployments and logs |
| Cloudflare | Workers, DNS and pages |
| Supabase | Database and auth |
| Postgres | Query a database |
| SQLite | A local database file |
| Docker | Containers on this computer |
| Kubernetes | Clusters and pods |
| Hugging Face | Models and datasets |
| Playwright | Drive a browser |

**Design & media** (4)

| Name | What it gives Branch |
|---|---|
| Figma | Designs and comments |
| Canva | Designs and brand kits |
| YouTube | Videos and captions |
| Spotify | Music and playlists |

**Business** (6)

| Name | What it gives Branch |
|---|---|
| Stripe | Payments and invoices |
| Shopify | Orders and products |
| HubSpot | Contacts and deals |
| Salesforce | Accounts and opportunities |
| QuickBooks | Books and invoices |
| Zendesk | Tickets and help center |

**Home & web** (5)

| Name | What it gives Branch |
|---|---|
| Home Assistant | Lights, sensors and scenes |
| Brave Search | Search the web |
| Weather | Forecasts where you are |
| Maps | Places and directions |
| Zapier | Thousands of apps through Zaps |

Total: 52.

### 7.4 Local models (10)

**Intent:** models that run on the person's own computer, free and private. Branch scans the hardware first and only offers what fits: **great** (fits the graphics card), **ok** (fits in memory, slower) or **no** (too big). The rule: needed memory = the variant's size × 1.25. It is "great" if that is at most the graphics memory, "ok" if it is at most 70% of RAM, otherwise "no". Sample hardware: AMD Ryzen 7 7800X3D, 32 GB RAM, NVIDIA GeForce RTX 4070 with 12 GB, 212 GB free, Ollama 0.12. Qwen3 8B starts installed and running.

| id | Name | Size | Tools | Vision | Context (tokens) | Summary | Variants (label: quant, size) |
|---|---|---|---|---|---|---|---|
| `llama3.2-3b` | Llama 3.2 3B | 3B | yes | no | 131072 | Small and quick: notes, tidying text and short answers. | small: Q4_K_M, 2.0 GB; balanced: Q8_0, 3.4 GB; full: F16, 6.4 GB |
| `qwen3-4b` | Qwen3 4B | 4B | yes | no | 40960 | Small, and good at using tools for its size. | small: Q4_K_M, 2.6 GB; balanced: Q8_0, 4.4 GB; full: F16, 8.1 GB |
| `gemma3-4b` | Gemma 3 4B | 4B | no | yes | 131072 | Small, and can be shown a picture. It cannot use tools. | small: Q4_K_M, 3.3 GB; balanced: Q8_0, 5.0 GB |
| `llama3.1-8b` | Llama 3.1 8B | 8B | yes | no | 131072 | A steady all-rounder for everyday questions and short documents. | small: Q4_K_M, 4.9 GB; balanced: Q8_0, 8.5 GB |
| `qwen3-8b` | Qwen3 8B | 8B | yes | no | 40960 | A capable helper that uses tools well; a good first choice with 16 GB. | small: Q4_K_M, 5.2 GB; balanced: Q8_0, 8.9 GB; full: F16, 16.4 GB |
| `qwen3-14b` | Qwen3 14B | 14B | yes | no | 40960 | Slower, but much better at reasoning and longer work. | small: Q4_K_M, 9.3 GB; balanced: Q8_0, 15.9 GB |
| `qwen2.5-14b` | Qwen2.5 14B | 14B | yes | no | 32768 | An older, well-tested model for reasoning and longer documents. | small: Q4_K_M, 9.0 GB; balanced: Q8_0, 15.7 GB |
| `gpt-oss-20b` | gpt-oss 20B | 20B | yes | no | 131072 | OpenAI's open model: strong reasoning, and it uses tools well. | balanced: MXFP4, 13.8 GB |
| `mistral-small3.2-24b` | Mistral Small 3.2 24B | 24B | yes | yes | 131072 | Large: careful answers, tools and pictures. Needs a well-equipped computer. | small: Q4_K_M, 15.2 GB; balanced: Q8_0, 25.9 GB |
| `qwen3-30b-a3b` | Qwen3 30B A3B | 30B | yes | no | 40960 | Large but quick for its size, because only part of it works on each word. | small: Q4_K_M, 18.6 GB; balanced: Q8_0, 32.5 GB |

### 7.5 Characters (Branch + 10 originals)

**Intent:** every Trunk can have a body that moves by itself according to what it is doing, like a companion rather than an icon. The person never picks an animation. They pick a character, and the Trunk's state picks the animation. All characters are original: no company, brand, studio or existing character was referenced in making them.

Default looks: Branch → Branch, Scout → Ember, Ledger → Tock, Ada → Kite, Fieldnotes → Morel, Quill → Lumen. Any other Trunk shows the classic pebble until a look is picked.

| id | Name | Description | Still | State videos |
|---|---|---|---|---|
| `branch` | Branch | The app's own mascot: a green leafy sprite with glowing orange orbs on its branches. | `assets/branch-wave.webp` | idle, work, yay, sleep, walk, think, search, read, talk, wait, oops (`assets/anim-<state>.webm`; oops also has the still `assets/branch-oops.webp`) |
| `ember` | Ember | A fox kit whose fur is layered copper-and-amber autumn leaves, tail tip glowing like an ember. | `assets/agents/ember/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/ember/<state>.webm`) |
| `tock` | Tock | A round clockwork owl of polished brass and walnut, with softly glowing glass-lens eyes. | `assets/agents/tock/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/tock/<state>.webm`) |
| `kite` | Kite | A cheerful paper crane folded from map paper printed with faint blue routes. | `assets/agents/kite/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/kite/<state>.webm`) |
| `morel` | Morel | A small mushroom scholar with a honeycomb cap, round spectacles and a leaf scarf. | `assets/agents/morel/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/morel/<state>.webm`) |
| `pebble` | Pebble | A smooth river-stone golem with moss tufts and faint glowing teal runes. | `assets/agents/pebble/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/pebble/<state>.webm`) |
| `wisp` | Wisp | A fluffy cloud spirit with a small golden spark floating above its head. | `assets/agents/wisp/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/wisp/<state>.webm`) |
| `lumen` | Lumen | A lantern moth whose warm amber wings glow softly from within. | `assets/agents/lumen/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/lumen/<state>.webm`) |
| `tide` | Tide | A teal water newt with frilly aqua gills and a gentle smile. | `assets/agents/tide/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/tide/<state>.webm`) |
| `juniper` | Juniper | A frosty pale-blue fawn with little evergreen antlers. | `assets/agents/juniper/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/juniper/<state>.webm`) |
| `bolt` | Bolt | A tiny tin-can robot with warm lamp eyes and a sprout on its head. | `assets/agents/bolt/still.webp` | idle, think, work, search, read, talk, wait, yay, oops, sleep (`assets/agents/bolt/<state>.webm`) |

The 10 states and their labels: `idle` "Here", `think` "Thinking it over", `work` "Working on it", `search` "Searching", `read` "Reading", `talk` "Explaining", `wait` "Needs you", `yay` "Done", `oops` "Hit a snag", `sleep` "Resting".

### 7.6 Pets (34 painted, Little Branch, and 3 pixel pets)

**Intent:** a small companion that walks along the bottom of the sidebar. It moves faster while Trunks are working, naps when nothing is happening, and says hello when patted. It is optional decoration and never covers anything important.

| Key | Name | Description | Still | Walk video |
|---|---|---|---|---|
| `squirrel` | Squirrel | A red-brown squirrel with a huge fluffy tail | — | — |
| `owl` | Owl | Drawn as pixels on a canvas | — | — |
| `hedgehog` | Hedgehog | Drawn as pixels on a canvas | — | — |
| `sprout` | Little Branch | Branch itself, small, walking | — | — |
| `pet-mossfrog` | Moss frog | A round little frog with a soft moss-green back and a tiny leaf on its head | `assets/pets/mossfrog.webp` | `assets/pets/mossfrog-walk.webm` |
| `pet-leafhog` | Leaf hog | A hedgehog whose spines are small overlapping green-and-copper leaves | `assets/pets/leafhog.webp` | `assets/pets/leafhog-walk.webm` |
| `pet-fennec` | Fennec | A fennec fox kit with huge ears, sandy fur, fluffy tail | `assets/pets/fennec.webp` | `assets/pets/fennec-walk.webm` |
| `pet-otter` | Otter | A baby river otter, brown and cream, holding a small pebble | `assets/pets/otter.webp` | `assets/pets/otter-walk.webm` |
| `pet-capybara` | Capybara | A calm round capybara with a tiny orange flower on its head | `assets/pets/capybara.webp` | `assets/pets/capybara-walk.webm` |
| `pet-cloverbun` | Clover bun | A small cream bunny whose ears are shaped like clover leaves | `assets/pets/cloverbun.webp` | `assets/pets/cloverbun-walk.webm` |
| `pet-owlet` | Owlet | A fluffy round owl chick, brown and cream, big amber eyes | `assets/pets/owlet.webp` | `assets/pets/owlet-walk.webm` |
| `pet-shellsnail` | Shell snail | A friendly snail whose shell is a brown-capped mushroom | `assets/pets/shellsnail.webp` | `assets/pets/shellsnail-walk.webm` |
| `pet-jelly` | Jelly | A small glowing teal-blue lantern jellyfish that floats and bobs | `assets/pets/jelly.webp` | `assets/pets/jelly-walk.webm` |
| `pet-cloudsheep` | Cloud sheep | A lamb whose wool is a fluffy white cloud, grey face | `assets/pets/cloudsheep.webp` | `assets/pets/cloudsheep-walk.webm` |
| `pet-pebblecrab` | Pebble crab | A little crab with a smooth grey pebble shell, orange claws | `assets/pets/pebblecrab.webp` | `assets/pets/pebblecrab-walk.webm` |
| `pet-caterpillar` | Caterpillar | A chubby green leaf caterpillar with tiny feet | `assets/pets/caterpillar.webp` | `assets/pets/caterpillar-walk.webm` |
| `pet-sprigdragon` | Sprig dragon | A tiny green baby dragon with leaf-shaped wings | `assets/pets/sprigdragon.webp` | `assets/pets/sprigdragon-walk.webm` |
| `pet-turtle` | Turtle | A baby turtle with a mossy shell and a sprout on top | `assets/pets/turtle.webp` | `assets/pets/turtle-walk.webm` |
| `pet-penguin` | Penguin | A fluffy grey penguin chick | `assets/pets/penguin.webp` | `assets/pets/penguin-walk.webm` |
| `pet-puppy` | Puppy | A short-legged fluffy tan puppy with floppy ears | `assets/pets/puppy.webp` | `assets/pets/puppy-walk.webm` |
| `pet-kitten` | Kitten | A small orange-and-cream tabby kitten | `assets/pets/kitten.webp` | `assets/pets/kitten-walk.webm` |
| `pet-raccoon` | Raccoon | A raccoon kit with a striped tail and little mask | `assets/pets/raccoon.webp` | `assets/pets/raccoon-walk.webm` |
| `pet-koala` | Koala | A grey koala joey with fluffy ears | `assets/pets/koala.webp` | `assets/pets/koala-walk.webm` |
| `pet-sloth` | Sloth | A smiling baby sloth, tan and brown | `assets/pets/sloth.webp` | `assets/pets/sloth-walk.webm` |
| `pet-fruitbat` | Fruit Bat | A small orange-brown fruit bat with folded wings and a fluffy chest | `assets/pets/fruitbat.webp` | `assets/pets/fruitbat-walk.webm` |
| `pet-bumblebee` | Bumblebee | A round fuzzy bumblebee, yellow and black, with tiny wings | `assets/pets/bumblebee.webp` | `assets/pets/bumblebee-walk.webm` |
| `pet-beetle` | Beetle | A shiny emerald-green beetle with little legs | `assets/pets/beetle.webp` | `assets/pets/beetle-walk.webm` |
| `pet-duckling` | Duckling | A fluffy yellow duckling | `assets/pets/duckling.webp` | `assets/pets/duckling-walk.webm` |
| `pet-hamster` | Hamster | A round golden hamster with full cheeks | `assets/pets/hamster.webp` | `assets/pets/hamster-walk.webm` |
| `pet-sealpup` | Seal Pup | A white-grey fluffy seal pup | `assets/pets/sealpup.webp` | `assets/pets/sealpup-walk.webm` |
| `pet-octopus` | Octopus | A small blue baby octopus with curly tentacles | `assets/pets/octopus.webp` | `assets/pets/octopus-walk.webm` |
| `pet-chameleon` | Chameleon | A little green chameleon with a curled tail | `assets/pets/chameleon.webp` | `assets/pets/chameleon-walk.webm` |
| `pet-firefly` | Firefly | A firefly with a glowing warm-amber tail light and big eyes | `assets/pets/firefly.webp` | `assets/pets/firefly-walk.webm` |
| `pet-dustbunny` | Dust bunny | A small grey fluffball creature with big eyes and tiny feet | `assets/pets/dustbunny.webp` | `assets/pets/dustbunny-walk.webm` |
| `pet-mossgolem` | Moss Golem | A mini stone golem covered in moss with a tiny mushroom | `assets/pets/mossgolem.webp` | `assets/pets/mossgolem-walk.webm` |
| `pet-narwhal` | Narwhal | A white-and-pale-blue baby narwhal that floats in the air with a short spiral horn | `assets/pets/narwhal.webp` | `assets/pets/narwhal-walk.webm` |
| `pet-squirrel` | Squirrel | A red-brown squirrel with a huge fluffy tail | `assets/pets/squirrel.webp` | `assets/pets/squirrel-walk.webm` |
| `pet-elephant` | Elephant | A small grey baby elephant with big ears | `assets/pets/elephant.webp` | `assets/pets/elephant-walk.webm` |

### 7.7 Painted scenes (12, plus "By the season")

**Intent:** an optional painted background behind the app, calm and low-contrast so text stays readable. "By the season" picks the grove that matches the month.

| id | Name | Image |
|---|---|---|
| `auto` | By the season | chosen by month |
| `spring` | Spring grove | `assets/grove-spring.webp` |
| `autumn` | Autumn grove | `assets/grove-autumn.webp` |
| `winter` | Winter grove | `assets/grove-winter.webp` |
| `night` | Firefly night | `assets/grove-night.webp` |
| `summer` | Summer Meadow | `assets/bg/grove-summer.webp` |
| `rain` | Rainy Forest | `assets/bg/grove-rain.webp` |
| `lake` | Mountain Lake | `assets/bg/grove-lake.webp` |
| `blossom` | Blossoming Grove | `assets/bg/grove-blossom.webp` |
| `canyon` | Desert Canyon | `assets/bg/grove-canyon.webp` |
| `snownight` | Snowy Night | `assets/bg/grove-snownight.webp` |
| `bamboo` | Bamboo Grove | `assets/bg/grove-bamboo.webp` |
| `hills` | Sunflower Hills | `assets/bg/grove-hills.webp` |

---

## 8. Art and assets: what exists and how it was made

### 8.1 Use the files, don't regenerate them
AI image and video generation never produces the same picture twice, so a 1:1 rebuild must **reuse the files in
`prototype/assets/`**. Regenerate only if they are lost; the result will look similar, not identical. The original generated
character and pet images on flat magenta are kept in `prototype/art-sources/` so the loops can be re-animated from the exact same
first frame.

### 8.2 Every file and where it is used
| Files | Count | Format | Used for |
|---|---|---|---|
| `assets/branch-{wave,point,think,read,work,yay,sleep,mail,oops}.webp` | 9 | WebP stills, transparent | Branch's poses: setup, empty states, walkthrough, the classic "done" card, Branch's still when motion is off. |
| `assets/anim-{idle,work,yay,sleep,walk,think,search,read,talk,wait,oops}.webm` | 11 | VP9 WebM with alpha, 5 s loops | Branch's living animations: the agent window, setup mascot, "done" card, Little Branch pet (walk). |
| `assets/grove-{spring,autumn,winter,night}.webp` | 4 | WebP | The original painted scenes and "By the season". |
| `assets/bg/grove-{summer,rain,lake,blossom,canyon,snownight,bamboo,hills}.webp` | 8 | WebP | Painted scenes added in pass 12. |
| `assets/agents/<id>/still.webp` + `<state>.webm` × 10 | 10 characters × 11 files = 110 | WebP + VP9 alpha WebM | The 10 original characters: portrait avatars, look picker, agent window, living header avatars. States: idle, think, work, search, read, talk, wait, yay, oops, sleep. |
| `assets/pets/<id>.webp` + `<id>-walk.webm` | 34 × 2 = 68 | WebP + VP9 alpha WebM | The 34 painted pets: gallery tiles and the walking pet in the sidebar. |
| `assets/agents/manifest-A.json`, `manifest-B.json`, `assets/pets/manifest-A.json`, `manifest-B.json`, `assets/extra-manifest.json` | 5 | JSON | Names, descriptions and file paths; the build embeds them in the page. |
The published artifact holds 211 files (the page plus every file above).

### 8.3 The house style (every character and pet)
Prompt block used for every base image:
> "high-quality stylized 3D animated-film render, soft rounded chibi proportions, big expressive friendly eyes, matte tactile materials, gentle warm rim light, cute but refined, cohesive with a family of leafy forest-spirit characters"

Rules:
- ORIGINAL designs only. Never name or imitate any franchise, studio, brand, game, mascot or companion character. Generic real
  animals are fine.
- **No pink, magenta, purple or violet anywhere on the character** (the background is keyed out as magenta). Reds lean orange/copper.
- Full body, centred, the whole character inside the frame with margin, facing slightly toward the camera, neutral happy pose.
- Background line appended to every prompt: "isolated on a perfectly flat solid pure magenta (#FF00FF) background filling the
  whole frame, no floor, no shadow, no gradient, no other objects, no text".
- Each character's own description is in section 7.5; each pet's in section 7.6. Branch itself was generated from the repository
  mascot `C:\Users\bishi\Code\Branch-Agent\docs\images\mascot.png` (1254 px, transparent).

### 8.4 Step 1: the base image
- Tool: Higgsfield (MCP), model `nano_banana_pro`, resolution `2k`, aspect `1:1`; fallback model `gpt_image_2_5` quality high
  (used for Lumen, whose first image had a ghost duplicate; Lumen's wings are folded).
- Prompt = the description + the house style + the background line. About 2 credits each.
- QA: build a contact sheet on dark grey and look at it. Reject and retry once if off-model, any pink/magenta on the character,
  background not flat, cropped, extra characters or text.

### 8.5 Step 2: the animated loops
- Tool: Higgsfield, model `kling3_0`, mode `std`, sound `off`, duration `5` s, aspect `1:1`, with the base image's job id given
  as both `start_image` and `end_image` so the loop is seamless. About 6.25 credits each.
- Prompt pattern: "The character stays centered in place on a perfectly flat solid magenta background and **<ACTION>**, then
  returns exactly to the starting pose. Locked camera, no camera movement, background stays pure flat magenta with no shadows,
  lighting unchanged, seamless loop."
- The exact ACTION per state (recovered from the generation records):
| State | ACTION text |
|---|---|
| idle | "gently breathes and bobs" |
| think | "taps its chin thoughtfully and looks up" (Branch: "taps its chin with a small leaf-hand thoughtfully and looks up") |
| work | "busily taps and swipes on a small glowing slate it holds" |
| search | "holds up a small magnifying glass and scans slowly from left to right" |
| read | "reads a small open book" (Branch: "reads a small open leaf-book") |
| talk | "talks cheerfully to the viewer with lively gestures" (Branch: "…with lively leaf-hand gestures") |
| wait | "looks at the viewer expectantly and raises one hand as if politely asking a question" (Branch: "…one leaf-hand…") |
| yay | "hops up happily twice celebrating with both arms raised" |
| oops | "looks sheepish" |
| sleep | "dozes off" |
| pet walk | "walks happily in place with a bouncy little walk cycle" (crawlers: "crawls happily in place"; flyers and floaters: "flies/floats and bobs gently in place") |

### 8.6 Step 3: removing the magenta background
Do **not** use Higgsfield's video background remover: it returns H.264 with no transparency. AutoSprite is not available
through the MCP. Keying is done locally:
- **Videos, `prototype/keyvid.py`:** per frame with numpy: sample the background colour at the frame border; compute a
  green-weighted colour distance (weights 1.0, 1.4, 1.0); alpha ramps from 0 at distance 62 to 1 at 125; remove magenta spill
  from edges (red and blue pulled toward green); pipe frames to ffmpeg as VP9 `yuva420p`, `-crf 38`. Output WebM with alpha.
- **Stills, `prototype/rekey.py`:** the same keying, then crop to the visible pixels (alpha > 24), centre in a square with 5%
  margin, resize, save WebP quality 86, method 6. Special cases used: the moss golem needed thresholds 38/80; the squirrel
  needed its white frame cropped off first, and its walk video cropped to 84% before keying.
- **QA:** extract frames and composite them on light (`#F5F6F7`) and dark (`#14181C`) backgrounds, then look for fringes and holes.
- `prototype/dlkey.py` downloads results from the generator's CDN by probing timestamps; `prototype/mklist.py` builds the
  publish list.

### 8.7 How the page uses the art
- Characters: `figure12(look, state)` returns a looping `<video>` for the state, or the still when motion is off.
- Motion is off (stills) when the person turned on still mode, when the system asks for reduced motion, and on **Safari and every
  iPhone/iPad browser**, which cannot show see-through WebM. On Safari the stills move with light CSS per state (`html.move13`).
- Videos pause when off-screen or when the tab is hidden, and keep playing across redraws when the state has not changed.
- Pets: the walking video plays faster while Trunks work and pauses while the pet naps.

### 8.8 What it cost
About 84 credits for pass 11 (Branch's poses, groves, first loops) and roughly 1,300 more for pass 12 (10 characters × 11 files,
34 pets × 2, 6 Branch states, 8 scenes, plus regenerations). The Higgsfield balance went from 2,692.9 to 1,306.15.

---

## 9. Building, running and testing

### 9.1 Running the prototype
1. Open `prototype/branch-redesign.html` in Chrome or Edge (double-click works). Keep `prototype/assets/` beside it.
2. It is fully self-contained: all code, styles and data are inside the one file. The only outside request is the QR-code library
   from `https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js`; offline, a drawn stand-in code appears.
3. Choices are saved in the browser's storage for that file (see 9.5). Guide › "Start the prototype over" clears them.
4. To publish it as a claude.ai artifact, publish the HTML with every file under `assets/` as a supporting file (WebM files need
   content type `video/webm`). The live artifact is https://claude.ai/artifact/QnX6D3p3kALrVtRfa4MWTt.

### 9.2 How the file is built: layers
The prototype was built in passes. Passes 1–5 wrote the base page directly (`branch-redesign.v2.html` … `v5.html`). From pass 6,
each pass is a Python "patch" that takes the previous build and inserts new CSS and JavaScript:
| Build | Command (run inside `prototype/`) | Adds |
|---|---|---|
| v6 | `cp branch-redesign.v5.html branch-redesign.html && python patch6.py` | surfaces, themes, backgrounds, accounts, KeepOak, Team (`patch6a-d.js`, `patch6.css`) |
| v7 | `cp branch-redesign.v6.html branch-redesign.html && python patch7.py` | its computer, full-size stage, picture-in-picture (`patch7.js/.css`) |
| v8 | `… v7 … python patch8.py` | full phone apps, several computers per Trunk (`patch8.js`, `patch8b.js`, `patch8c.js`, `patch8.css`) |
| v9 | `… v8 … python patch9.py` | search, find, past sessions, tools panel, Customize › Tools (`patch9.js/.css`) |
| v10 | `… v9 … python patch10.py` | setup, walkthrough, group chats, A2A, teammates, sharing, resizable panels, keepoak.com (`patch10a-d.js/.css`) |
| v11 | `… v10 … python patch11.py` | painted art, pets, animations, backgrounds, confetti (`patch11.js/.css`) |
| v12 | `… v11 … python patch12.py` | 53 services, local models, 55 chat apps, 52 connectors, characters, 34 pets, scenes (`patch12a-c.js/.css`, embeds data) |
| v13 | `… v12 … python patch13.py` | Safari/iPhone, saved choices, speed, every surface, keyboard, first visit, What's new (`patch13a-d.js`, `patch13a-b.css`) |
| v14 | `cp branch-redesign.v13.html branch-redesign.html && python patch14.py` | the flush top bar, fading scrollbars, minimal sidebar rows, the level control, collapsible places (`patch14a-c.js`, `patch14a-d.css`; `patch14.py` also rewrites the header lookups and the two sidebar row templates) |
| v15 | `cp branch-redesign.v14.html branch-redesign.html && python patch15.py` | pins, side by side, media, material, background work, waiting line; the record, board, ideas, health, memory tidy-up, map, office files; setup steps, updates, self-change, shortcuts, Telegram, usage report, lending a phone; patterns, emoji faces, pet placement; every remaining setting at Advanced/Technical (`patch15a-h.js`, `patch15b-h.css`). `patch15a.js` is a small registry (`addTab15`, `addSection15`, `addSettings15`, `afterChat15`) so the other pass-15 files add tabs, sections, settings rows and conversation decorations without wrapping the same function twice. |
| v16 | `cp branch-redesign.v15.html branch-redesign.html && python patch16.py` | what ships on (changes the defaults in place and says why in each sub-line), This Mac / This PC permissions, the System Settings flow, the in-chat request, the Mac setup tile, the wake-word offer (`patch16a.js`, `patch16a.css`) |

How a patch works (so you can add pass 17 the same way):
- CSS is inserted just before the marker comment `/* ---------- narrow windows ---------- */` in the `<style>`.
- JavaScript is inserted just before the last lines of the script: `render();` `scheduleScout(15000);` `})();`.
- Each replacement is guarded: the patch fails if its target text is not found exactly once.
- New behaviour wraps old functions instead of editing them: `const _render14 = render; render = function () { _render14.apply(this, arguments); … };`.
  So the **last** assignment of a name is the one that runs. Actions live in `ACTS`, menus in `POPS`, Settings pages in `PAGES`.
- `patch12.py` also embeds the install's data files (trimmed) as `DATA12`, read from `C:\Users\bishi\Code\Branch-Agent\data\`
  and the manifests in `assets/`. If that repo is missing, the data is still inside `branch-redesign.v12.html` and later builds.

### 9.3 The tests
Tests are Node scripts using Playwright (the copy bundled with the installed Branch app:
`C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright`; any Playwright works if you change
that path). Each opens `branch-redesign.html` beside it headlessly and prints `NO ERRORS` or the failures. Run one with
`node check13.cjs`. The full suite, in order:
| Test | What it proves |
|---|---|
| `check6.cjs` | Settings gear, Models › Connections, five provider groups on the Accounts page, adding ChatGPT accounts and an OpenRouter key. |
| `check7.cjs` | No banner in chat, places above conversations, the full-size computer stage, big screen, two computer tabs. |
| `check9.cjs` | Sidebar search keeps focus, marked message results, past sessions, filters, opening a result. |
| `check10.cjs`, `check10c.cjs`, `check10d.cjs` | Resizing the sidebar (wider, rail, hidden); the Guide menu and setup; keepoak.com routes and pairing. |
| `check11.cjs` | Little Branch pet video, new chat, Scout's "done" cheer and confetti. |
| `check12.cjs`, `check12c.cjs` | Setup never rebuilds when ticking; 53 services; local models; 55 chat apps and the wizard; connectors; QR; agent window states; group chats. |
| `check13.cjs` | Safari and iPhone stills with CSS motion; reduced motion; saved choices across reloads, a broken save ignored, Start over; hidden-tab and off-screen pausing; Mac, phone, Android and terminal features; keyboard (focus stays in dialogs, Escape returns focus, arrows in galleries, pairing-code Backspace); first visit opens setup, "Checking… N of 6". |
| `check15.cjs` | Pass 15 at 1366 px light and 390 px dark: pins and the pinned strip, summary card, cost line, background chip, the audio waveform draws and plays, material chips, side by side (and waiting for room on narrow windows), record verify, the self-change stages, health, ideas, the board and moving a card, time travel, the memory ring and tidy-up, the map, office files, patterns, suggested skills; no fine controls at Regular on six Settings pages, 20+ groups at Technical; the usage report; select several accounts; press-to-set shortcuts; the update choice; the two new setup steps; lending the phone; no console errors. Takes a file path. |
| `check16.cjs` | Pass 16 at 1366 px light and 390 px dark: This PC on Windows, the seven Mac permissions and their starting statuses, System Settings with Branch listed, the Touch ID sheet and Cancel, Screen Recording's quit-and-reopen, re-checking on return, the in-chat restart card and the restart, the microphone alert and a refusal, Automation's per-app list, the wake-word offer after three dictations, the new defaults, the Mac setup tile. Takes a file path. |
| `tour10.cjs`, `surf10.cjs` | The walkthrough runs with no page errors; every surface renders. |
| `agchurn13.cjs` | Redraws that change nothing never restart an agent's video or replay the window's pop-in. |
| `human12.cjs` | A person with a real mouse: every click lands on its target and nothing covers it; setup, walkthrough, sending a message, every sidebar item. Set the window with `W`, `H` and `SCHEME` (e.g. `W=390 H=844 SCHEME=dark node human12.cjs`). |
| `sweep13.cjs` | Nine screens at 390, 768, 910, 1024 and 1440 px, light and dark: no sideways scrolling, nothing past the edge, the agent window never covers the composer or the newest message, title-bar buttons stay on screen, text contrast. Screenshots go to `claude-session-files/branch-redesign/sweep13/`. |
Run the whole suite before calling any change finished (see 1.7).

### 9.4 Checking internals
To inspect state while testing, make a copy of the page that exposes internals: insert
`window.__D = {ACTS, S, POPS, PAGES, …};` just before the final `render();` line (this is how `docwork/debug.html` was made for
writing this file). The app's real code keeps everything private inside one function.

### 9.5 What the page saves in the browser
| Key | Holds |
|---|---|
| `branch-proto-state13` | Pet, pet name, scene, background (not your own file), still mode, each Trunk's look, the agent window settings, connected chat apps, installed and running local models, accounts, usage rows. Every value is checked before use. |
| `branch-proto-seen13` | Setup has been seen in this version (so it opens by itself only once). |
| `branch-proto-welcomed` | Setup finished or skipped (older key, still written). |
| `branch-proto-theme`, `branch-proto-looks` | Theme, contrast, accent and saved themes. |
| `branch-proto-layout` | Sidebar, pane and dock widths, rail mode, hidden list. |
| `branch-proto-places14` | Whether the Places list is folded into the icon row. |

### 9.6 Making it the real app
The prototype is one HTML page with example data; the real Branch Agent is an Electron app with its own code in
`C:\Users\bishi\Code\Branch-Agent`. The prototype cannot be pasted in as-is: its behaviour is simulated (hardware scan, pairing,
account checks, installs, replies). To build it for real, treat this file and the prototype as the specification: rebuild each
screen as real components in the app, wire each action in Appendix A to the real feature, keep every word and value from sections
2–7, reuse the art from `prototype/assets/`, and port the tests in section 9.3 to the real app.

---

## 10. History and the owner's decisions

### 10.1 The owner's decisions (binding)
| Decision | Detail |
|---|---|
| Direction | Mostly GrokBot, then Hermes Agent desktop; ideas from OpenClaw and Meta Muse ("Musa AI" was read as Meta Muse; unconfirmed). Copy none of them. |
| Logo | The green leafy Branch sprite. The acorn is removed everywhere (supersedes critiques #26, #41, #57). |
| KeepOak mark | Only on keepoak.com pages and the KeepOak account. |
| Default theme | Slate (critique #56). |
| Features | Ship ON. Never remove a feature; move it somewhere logical. |
| Models | gpt-6-sol medium and Claude Opus 5.5 medium. |
| Art | Original characters and pets; no company, brand or studio referenced. Credits may be spent freely. |
| Its computer | Is not the web browser and not the "which Branch" switcher. It must be immersive (full size), a Trunk may use several, and more can be added. |
| Settings | Nothing from the real app's settings may be skipped; "How much to show" (Regular / Advanced / Technical) controls depth. |
| What ships on | Useful things ship on (1.9). Off only for money, sending, deleting, mic/camera, or heavy CPU/disk; those ask, turn on when connected, or wait with an offer. Context is not a reason: tools load on demand. |
| Mac permissions | "Full access" on a Mac is the system's own permissions, requested the way OpenClaw does: asked when first needed, granted in System Settings where Branch is listed with its own name and leaf icon, re-checked when you come back (5.7). |
| Protected things the owner loves | The "Who is using Branch" menu (#23), the usage popover "What each connection has left" and the bottom ring (#31), the Add a Trunk studio (#34), the "Keep Branch up to date by itself? Recommended" bar (#43). |

The full numbered critique list is Appendix B.

### 10.2 Pass by pass
| Pass | Artifact version | What the owner asked | What was built |
|---|---|---|---|
| 1–4 | 1–4 | Redesign Branch "more towards GrokBot" with every feature of "Branch, Grown Up" and the installed app | Base layout, calm chat, places, Settings; built against OWNER-CRITIQUES #1–#62. |
| 5 | 5 | Details | Base page finished (`branch-redesign.v5.html`). |
| 6 | 6 | Surfaces, 44 real themes, colour editor, backgrounds, several accounts per provider, KeepOak connect, Team | Surface switcher (Windows, Mac, Terminal, iPhone, Android, keepoak.com), themes, backgrounds, accounts wizard, KeepOak pairing, Team. |
| 7 | 7 | "Its computer" must be immersive, not a cropped side panel; less busy | Per-Trunk computer choice, full-size stage with docked conversation, picture-in-picture, full-screen browser; banner and chips moved. |
| 8 | 8 | Phone apps with real detail; several computers per Trunk | Full iPhone/Android apps; allowed computers per Trunk, computer tabs, "All screens", Add a computer. |
| 9 | 9 | Telegram/WhatsApp/GrokBot-style search; a plug button for MCP, plugins, skills, CLIs | Sidebar search with filters, Ctrl+F find, past sessions, the composer plug, Customize › Tools. |
| 10 | 10–11 | Onboarding and walkthrough, group chats, A2A, teammates, sharing, resizable/hideable panels, centred settings, every aspect ratio, keepoak.com, agents that know each other and make agents, Branch that changes itself and never dies | All of it. |
| 11 | 12 | Beautify with generated art: pets, sprites, agent animations, backgrounds, confetti | Branch poses and loops, painted groves, confetti, the "done" cheer. |
| 12 | 13–14 | Onboarding glitch fixed; every account type and one-click local models; 50+ chat apps with real QR and pairing; 30+ pets; more backgrounds; many agents with 10+ automatic animations | 53 services, local models, 55 chat apps, 52 connectors, 10 characters × 10 states, 34 pets, 12 scenes; fixed setup flicker, lost clicks during the health check, blocking "done" card, the pebble id clash. |
| 13 | 15–16 | Cover every edge case | Safari/iPhone stills, saved choices and Start over, video pausing, all surfaces, keyboard and screen readers, reduced motion, first visit opens setup, "Checking… N of 6", tablet settings tabs, the newest message never covered, What's new. |
| 14 | 17 | Merge the title bar and the chat header "so its flush and looks more sleek"; hide scrollbars "after 1 second" like other apps; drop "Online · you are here" ("why not just the green dot") and "Ask first · all good"; make "How much to show" modern; let the places list collapse; mark prototype-only parts in this file | One flush 52 px top bar split at the sidebar edge; scrollbars appear only while scrolling and fade after a second; the machine switcher is its name and a green dot; the person's row is just the name; a sliding segmented level control that never hides; a collapsible Places list that folds to an icon row; section 1.8. |
| 15 | 18 | In this pass we are adding more details, features and aesthetic and simplicity to the current build while showcasing all features branch agent offers perfectly - i dont want a wall of slop i want aestetics | Pins and timestamps; side by side conversations; media playback (audio waveform, video with seeking); material (@ references read as context, not commands); background work (up to 3 parallel tasks); Inbox › History verify, Automations › Board (Kanban), Automations › ideas (13 blueprints), Flow editor time travel, Library › Memory (ring + tidy), Library › Documents (map view), Made for you files, Customize › Specialists patterns, Customize › Tools › suggested skills, emoji faces for Trunks, pet placement options, Accounts bulk select & move, Setup › two new steps (Make it yours, Two more things), Updates dialog, self-development proposal, keyboard shortcuts dialog, Telegram topics & media, Data & usage report, Lend this phone, fine controls (Advanced and Technical), two new slash commands (/loop, /handoff), three new walkthrough stops. Design density rule applied: new features at Advanced/Technical level; at Regular, Settings grew by 8 visible controls (usage 4, pet 3, phone 1) and Places by about 20. |
| 16 | 19 | "we need to have useful things ship with the app already"; full access on a Mac "is meant to request in settings like openclaw does" | What ships on (1.9, 5.8), with defaults changed to match and sub-lines that say why; This Mac and This PC permissions, the System Settings flow, the in-chat request and restart, the Mac setup tile, and the wake-word offer (5.7, 6.14). |

### 10.3 Bugs found by testing like a person (and how they were fixed)
| Bug | Cause | Fix |
|---|---|---|
| Setup flickered when ticking the promise | Every tick rebuilt the whole wizard and replayed its fade-in | Ticking only toggles the two buttons; rebuilds keep the window, mascot, scroll and focus. |
| Clicks did nothing during setup's health check | The wizard was rebuilt every 0.4 s, replacing the button mid-click | Timed refreshes swap only the parts that changed. |
| Setup came back after closing it | A pending health-check tick reopened it | Timers never open a wizard that is not already on screen. |
| The walkthrough's Next did nothing for a moment | The "done" card sat on top and caught clicks | The card lets clicks pass through. |
| Pebble could never be chosen | "pebble" was both the classic look and a character id | The classic look is `classic`. |
| Codex, Gemini CLI and Copilot CLI all showed "CC" | Initials came from the internal key | Initials come from the name (CX, GC, GH). |
| A "Close" tooltip stayed on screen | The focused X was removed without a blur | Tooltips leave with their button. |
| The agent window covered the newest message | The column ran under the floating window | The end of the conversation gets room the window's height. |
| Agent videos restarted on every redraw | Each redraw rebuilt the window | Figures in the same state are kept and keep playing. |

### 10.4 Things tried and rejected
- Higgsfield's video background remover: returns video without transparency.
- AutoSprite through the MCP: not supported.
- Installing competitor desktop apps: skipped in favour of their documentation and videos.
- The Firecrawl MCP: needs an account and API key, so it was not set up.

---

## 11. Known limits and open questions

### 11.1 What is simulated in the prototype
Everything behind the screens is example behaviour, so it can be judged as a design:
- Replies are a fixed prototype line ("This is a prototype, so I can’t really do that yet…"); the Scout invoice job is scripted.
- The hardware scan, local-model downloads, account checks, chat-app token checks and pairing codes, QR pairing, keepoak.com
  sign-in and cloud computers are simulated. The QR codes themselves are real codes for the shown links.
- Numbers (usage, spend, limits, "room left") are sample data.

### 11.2 What was verified, and how
- Automated in headless Chromium: every test in 9.3, including real-mouse clicks at 1366, 910, 768 and 390 px, light and dark,
  and a layout sweep at 390, 768, 910, 1024 and 1440 px.
- **Safari and iPhone were simulated** by telling Chromium it was Safari (user agent). That proves the still-image fallback
  switches on; it does not prove how real Safari draws it. Check on a real iPhone and Mac before shipping.
- The claude.ai artifact viewer itself was not clicked through after pass 12 (the browser available was signed in to a different
  account). "Start the prototype over" reloads the page inside the viewer's frame; that reload is untested there.

### 11.3 Open questions for the owner
- Black or copper primary buttons (black is used today).
- How much forest scenery to bring back by default (scenes are opt-in today).
- Whether "Muse AI" meant Meta Muse.
- Whether the merged top bar should also show a title on places and Settings (it is empty there today; each page has its own
  title below).

---

## Appendix A. Every action (453)

Every control in the app carries `data-act="<name>"`; clicking it runs `ACTS[<name>]`. This is the complete list, grouped by area. "Reads" lists the data attributes the action uses (for example `data-v`, `data-id`).

### A.1 Window and navigation (27)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `dlg-close` | Dialog › close button (X) or cancel button | `data-then` = optional context (removed, quit, flagged, invited, signedin) | Closes dialog. If `data-then` set, shows context-specific toast (e.g., "Signed in. It shows under Accounts."). |
| `focus` | Titlebar › focus mode button, or Ctrl+. | — | Calls `toggleFocus()` to toggle focus mode (hide sidebar and status bar). |
| `new-with` | Sidebar › new conversation menu › Trunk option | id | Creates new conversation with selected Trunk; shows toast; re-renders |
| `new13-go` | Various dialog › action button | a | Closes dialog; executes the action specified in data-a attribute |
| `newconv` | Button › Edit | — | Creates a new conversation |
| `newmenu` | Sidebar › + button menu (new conversation/trunk/room/automation) | — | Opens new item menu |
| `notes-toggle` | Guide menu › design notes button | — | Toggles `S.notes` and `S.openNote` to show or hide design notes in a side panel; calls `renderNotes()` or `countNotes()`. |
| `notif-x` | Notification popup › dismiss button | — | Removes the notification banner. |
| `palette` | Side top › "Find anything" search button | — | Calls `openPalette()` and unlocks "Found the palette" achievement. |
| `pane` | Head › computer or activity toggle button, or pane close | `data-p` (pane id or 'close') | If close, sets `S.pane = null`; if in head and same pane, toggles off; otherwise sets `S.pane` (maps 'computer' to 'browser'). |
| `ph-go8` | Phone › More › navigation item | `data-v` (screen: 'usage', 'profile', etc.) | Calls `phGo(el.dataset.v)` and renders. |
| `pip-x` | PiP (picture-in-picture) › close button | — | Sets `S.pip = null` and renders. |
| `places14` | Sidebar › "Places" header (arrow) above Overview … Customize | — | Toggles `S.placesShut14`: folds the places list into one row of six icon buttons (names become tooltips and screen-reader labels, Inbox and Team counts stay as badges) or unfolds it; saves the choice in `branch-proto-places14` and redraws the sidebar. |
| `proto-reset` | Guide menu › "Start the prototype over" | — | Clears all localStorage keys starting with 'branch-proto-' and reloads the page. |
| `ptabp` | Pane › panel tabs (Activity, Browser, Terminal) | `data-p` (pane id) | Sets `S.pane` and renders. |
| `quit` | Title bar › close button | — | If work is running, opens confirmation dialog; otherwise shows toast "Branch closes to the tray.". |
| `savefile` | File editor › Save button | — | Closes dialog, shows "Saved. Every Trunk reads it before its next task." toast |
| `side` | Titlebar › menu button (mobile only) | — | Toggles app.classList 'side-open' class |
| `side-toggle` | Titlebar › sidebar toggle button | — | On mobile (width ≤760px), toggles side-open class; on desktop, toggles S.sideHidden, saves layout, rerenders |
| `surface` | Surface switcher › a surface button | `data-v` (surface type) | Sets S.surface, optionally sets S.web.route from data-route, closes dialog and popover, removes side-open class, rerenders |
| `surfpop` | Titlebar › surface dropdown button | — | Opens popover with POPS.surfaces() content, right-aligned |
| `switchperson` | Menu › Switch person | — | Closes popover, toggles S.person between 0 and 1, rerenders, shows "Switched to {name}." toast |
| `switchto` | Owner menu › a person row | `data-i` (person index) | If switching to owner (index 0) and not already there, opens PIN dialog; otherwise sets S.person, rerenders, shows switch toast |
| `tasks10` | Statusbar › tasks button | — | Opens popover with list of background tasks |
| `updmenu` | Statusbar › version button | — | Opens popover with POPS.updmenu() |
| `usagepop` | Statusbar › usage button | — | Opens popover with POPS.usagepop(), right-aligned |
| `view` | Sidebar › navigation buttons (Overview, Inbox, Automations, etc.) | `data-v` (view name), `data-tab` (optional tab) | Sets S.view and optionally S.tabs[view], removes side-open class, closes dialog, rerenders |

### A.2 Sidebar and search (12)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `chat` | Sidebar › conversation row | `data-id` = conversation ID | Removes notification, opens conversation via `openChat()`. |
| `closepop` | Sidebar › tip popover › "Remind me tomorrow" button | — | Closes popover. Toast: "We'll remind you tomorrow." |
| `fileopen` | Pane › Files tab › file row | `data-n` = filename, `data-st` = state | Calls `fileOpen()` with filename and state. |
| `find-close` | Find bar › close (X) button | — | Clears find state, re-renders to hide find bar. |
| `find-open` | Main › head › search icon | — | Toggles find state (null or {q, i}), re-renders, focuses find input if opening. |
| `find-step` | Find bar › prev/next buttons | `data-v` = +1 or -1 | Cycles hit index, updates highlight and scroll, updates counter text. |
| `forget` | Library › memory › row › "Forget" button | `data-i` = memory item index | Removes item from `library.memory`, re-renders. Toast: "Forgotten." (Undo callback restores for 3s.) |
| `sess-carry` | Search results › Past sessions › a session row › Carry it on button | `data-v` (session ID) | Creates new main chat from session, opens it, clears search, shows "Carried on. It remembers everything from that session." toast |
| `sq-clear` | Sidebar › Search › X button | — | Clears S.sq.q to empty string, sets S.sq.f to "all", sets S.sq.focus to true and S.sq.caret to 0, rerenders sidebar |
| `sq-f` | Search results › filter buttons (All, Chats, Messages, etc.) | `data-v` (filter type) | Sets S.sq.f to the filter type, rerenders search results |
| `sr-msg` | Search results › Messages › a message row | `data-id` (message ID) | Sets S.find with query and index 0, opens the message's chat |
| `sr-sess` | Search results › Past sessions › a session row | `data-v` (session ID) | Calls showSession(session ID) |

### A.3 Conversation and composer (64)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `artbig` | Conversation › chart › "Open larger" button | — | Opens dialog showing the chart full-width with title from block and hint about data source and date. |
| `beside15` | Chat ⋯ › "Open another conversation beside"; picker rows; beside pane › × | `data-v` = conversation id, empty to close; absent opens the picker | Without `data-v` opens the "Open beside this one" picker; with an id splits the view (`S.beside15`); empty closes it. Under 1000 px it toasts "Side by side needs a wider window. It opens when there is room." |
| `bg-new` | Composer › menu › "Start something in the background" | — | Closes popover, pre-fills composer with "/bg ", focuses composer, re-renders. |
| `bglist15` | "N in the background" chip over the message box | — | Opens "Running in the background" with Stop or Open for each. |
| `bgopen15` | Background popover › Open | `data-id` = background task id | Opens the finished task's conversation. |
| `bgrun15` | + menu › "Run it in the background" | — | Starts the current draft as a background conversation (as `/bg` does); at most three at once. Empty draft: toast "Type what to do first, then run it in the background." |
| `bgstop15` | Background popover › Stop | `data-id` = background task id | Stops it; toast "Stopped. Nothing it started was left half done." |
| `call` | Trunk menu › "Talk out loud" | — | Calls `openVoice()` to start voice call. |
| `call-end` | Voice call bar › "End" button | — | Clears `S.call`, stops timer, re-renders. Toast: "Call ended. A transcript is in the conversation's Files." |
| `chatmenu` | Main › head › three-dot menu icon | — | Opens popover menu with conversation options via `POPS.chatmenu()`. |
| `ckpt` | Checkpoint block › "Put it all back" button | `data-id` = block ID | Sets block state to 'restored', re-renders, shows toast "All 171 files are back where they were." After 3s, state changes to 'kept'. |
| `compare` | Conversation › task block › "Compare it with last Friday's" button | — | Opens wide dialog "Two tasks side by side" showing cost, time, rounds, tools used in table format, and a diff of what changed. |
| `dict` | Composer › microphone button (when not active) | — | Sets `S.dict = true`, re-renders to show listening UI. |
| `dict-done` | Composer › "Done" button (in listening mode) | — | Sets `S.dict = false`, appends transcribed text to draft (example: "Also check whether Hartwell charged the late fee."), re-renders, focuses composer. |
| `flag` | Conversation › message actions › flag icon | — | Calls `flagDlg()` to open flag/report dialog. |
| `imagine` | Composer › + menu › "Make a picture" | — | Opens "Make a picture" dialog for image generation |
| `img-again` | Button › Save to Library | id | Regenerates all image variants; re-renders |
| `img-bg` | Action buttons | id | Sets selected image as app background; shows toast; re-renders |
| `img-go` | Button › Cancel | — | Closes dialog; posts image request with prompt to conversation |
| `img-pick` | Image generation result › variant button | i, id | Selects which generated image variant to display; re-renders |
| `insert` | Composer › + menu › insert option | v | Closes menu; inserts text (@ mention, /) into message draft; focuses composer |
| `inspect` | Conversation › message actions › "Look inside" | — | Shows dialog with model, context, tools, time and cost details |
| `jit16` | The in-chat permission card › Not now / Later | — | Hides the card for this session; toast "Scout will use the sealed browser instead. You can allow it later in Settings › Permissions." |
| `matrm15` | Material chip over the message box › × | `data-v` = the @ reference | Removes that `@reference` from the draft and puts the cursor back at the end. |
| `mention-pick` | Menu › Call a Trunk | v | Inserts @TrunkName into message draft; closes menu; focuses composer |
| `mplay15` | Media block › play / pause button, or the video poster | `data-id` = media id | Toggles playback; a 250 ms timer advances the time and redraws only that player; it stops and rewinds at the end. |
| `mseek15` | Media block › waveform or track | `data-id` = media id | Seeks to where it was clicked. The Left and Right arrow keys seek 5 s when the waveform has focus. |
| `offgo15` | "Write a file" › Write it | — | Empty description: marks the field and focuses it. Otherwise closes and toasts where the file will appear. |
| `office15` | + menu › "Write a document, spreadsheet or slides" | — | Opens "Write a file": Document, Spreadsheet or Slides, and what it should be. |
| `offk15` | "Write a file" › a kind | `data-v` = docx, xlsx or pptx | Selects that kind. |
| `pausetrunk` | Customize › Trunks › trunk row › Pause/Resume button, or chat menu › Pause option | `data-id` (trunk id) | Toggles pause state for trunk; if pausing while working, sets status to idle; renders; shows toast. |
| `ph-voice` | Phone › chat › talk button, or speak to Branch button | — | Calls `phGo('voice')` and renders. |
| `pick` | Conversation › choice block › option button | `data-id` (block id), `data-i` (option index) | If block not yet picked, calls `pick(block, index)`. |
| `pin` | Conversation › chat menu › Pin button | — | Toggles `C(S.chat).pinned` and renders. |
| `pin-id` | Conversation menu (via rowmenu) › Pin button | `data-id` (chat id) | Toggles `C(id).pinned`, closes popover, renders. |
| `pin15` | Message hover actions › pin; Pinned popover › × | `data-i` = the block's index in the thread | Pins or unpins that message for this conversation (`S.pins15[chat]`); redraws; toast "Pinned. It stays in front of the assistant however long this runs." or "Unpinned." |
| `pinjump15` | Pinned strip under the header; Pinned popover row | `data-i` = block index | Closes the popover and scrolls that message to the middle of the thread, flashing it for 1.4 s. |
| `pinlist15` | Pinned strip › count button; chat ⋯ › "Pinned messages" | — | Opens the "Pinned in this conversation" popover (each row jumps; × unpins). |
| `plusmenu` | Composer › "+" button | — | Opens popover with `POPS.plusmenu()`. |
| `project` | Sidebar › Projects › project button | `data-v` (project id) | Sets `S.view = 'project'`, `S.project`, removes 'side-open' class, renders. |
| `projtoggle` | Sidebar › Projects › expand/collapse button | — | Toggles `S.projOpen` and renders. |
| `prompt-use` | Customize › Prompts › saved prompt › Use button | `data-v` (prompt command) | Finds prompt, sets `S.view = 'chat'`, loads prompt text to `S.drafts[S.chat]`, focuses composer. |
| `prompts-fill` | Composer › + menu › "Saved prompts" item | — | Closes popover, sets draft to '/', renders, opens slash command handler. |
| `qrm15` | Waiting line › × | `data-i` = position | Removes that queued message and reopens the list. |
| `queue15` | "N waiting" chip over the message box (while a Trunk works) | — | Opens the waiting line: each queued message is editable, can move up, or be removed. |
| `qup15` | Waiting line › up arrow | `data-i` = position | Moves that queued message one place earlier and reopens the list. |
| `remove` | Conversation › chat menu › "Remove Trunk..." | `data-id` (chat id) | Opens confirmation dialog saying conversations go to archive 30 days then delete, automations stop. |
| `rename` | Conversation › chat menu › Rename | — | Closes popover, sets `S.renaming = S.chat`, renders. |
| `rename-id` | Conversation menu (via rowmenu) › Rename | `data-id` (chat id) | Closes popover, switches to `S.chat = id`, sets `S.renaming`, renders. |
| `roommenu` | Status bar › "Room left %" button | — | Opens popover (implementation in POPS.roommenu). |
| `roster10` | Chat menu › "Who it knows" button | — | Opens roster popover showing Trunk members and relationships |
| `roster10h` | Head › "Who it knows" button | — | Opens popover with `rosterPop()` positioned right. |
| `rw-go` | Rewind dialog › Send button | — | Validates rewind state and text, removes message range from threads, restores drafts, calls `send()`, shows undo toast. |
| `rw-what` | Rewind dialog › radio buttons | `data-v` ('both', 'conv', 'files') | Sets `S.rewind.what` (what to restore). |
| `seg` | Settings/menus › segmented control (radio button group) | — | Sets aria-pressed on all buttons in parent, marking only clicked element as pressed |
| `slash-pick` | Slash command menu › a command option | `data-v` (command string) | Removes partial slash command from draft, appends selected command with space, closes popover, rerenders, focuses end of input |
| `slash6-pick` | Slash command picker › a command row | `data-i` (index) | Calls pickSlash() with the index |
| `spendmenu` | Composer › Today button | — | Opens popover with POPS.spendmenu() content |
| `sugg` | Empty chat › suggestion chip | `data-v` (suggestion text) | Sets S.drafts[S.chat] to suggestion, calls send() |
| `toast` | Various buttons throughout interface with data-msg attribute | `data-msg` (message string) | Closes popover if open, displays toast notification with the specified message |
| `u-edit` | Conversation › user message › Edit button | — | Opens rewind dialog to edit message, with options to revert conversation/files/both |
| `undo` | Toast › Undo button | — | Removes toast, calls toast.undo() callback |
| `voice` | Composer › Talk live button | — | Calls openVoice() to start voice mode |
| `wake16` | "Turn on the wake word?" card › Not now / Turn on | `data-v` = no or yes | Dismisses the offer for good, or turns the wake word on (asking for the microphone first on a Mac if needed). |

### A.4 Approvals and modes (31)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `allowall` | Inbox › needs tab › "Allow all [n]…" button | — | Opens confirmation dialog: "Allow all [n]?". Body describes pending actions. Foot has "Cancel" and "Allow all [n]" buttons. |
| `allowall-go` | Confirmation dialog › "Allow all [n]" button | — | Closes dialog, marks all pending requests as 'allowed', updates threads and inbox, re-renders. Toast: "All allowed." |
| `ask` | Approval card › "Send it", "Always allow", or "Don't send" button | `data-v` = response (allowed, always, or denied), `data-id` = request ID | Marks request with chosen state, calls `_ask()` and `unlock()` with appropriate message. |
| `ckpt-demo` | Settings › On this computer › checkpoint checkbox › "Show me" button | — | Calls `checkpointPrompt(true)` to display checkpoint prompt demo. |
| `ckpt-no` | Checkpoint offer bar › "Not now" button | — | Removes checkpoint prompt element. |
| `ckpt-save` | Checkpoint offer bar › "Save progress" button | — | Removes prompt, finds running tasks, pushes "Saved progress" block to each, unlocks "Checkpoint", re-renders. Toast counts tasks asked to save. |
| `g-all` | Button › Yes to both | id | Marks all pending approvals as allowed; shows toast "Both allowed."; re-renders |
| `g-ans` | Action buttons | i, id, v | Sets approval state (yes/no) for a request; re-renders |
| `lock` | Button › Turn it off | — | Toggles Lockdown mode on/off |
| `lockscreen` | Owner menu › "Lock Branch" | — | Closes menu; locks the app (shows lock screen until unlocked) |
| `mode` | Composer › mode menu item | v | Sets permission mode (Ask for everything/Ask first/Just do it); clears Lockdown |
| `model` | Composer › model menu item | v | Closes menu; shows toast with selected model name |
| `modelmenu` | Composer › model button (opens model/account selection menu) | — | Opens model and account selection menu |
| `modelmenu2` | Composer › model button (expanded variant with thinking levels) | — | Opens model selection menu with thinking levels |
| `modemenu` | Composer › mode button (opens permission mode menu) | — | Opens permission mode selection menu with scope options |
| `modemenu2` | Composer › mode button (expanded variant with granular control) | — | Opens permission mode menu with Auto/Ask first/Plan first/Full access options |
| `pauseall` | Settings › Permissions › "Pause all Trunks" or "Resume all Trunks" button | — | Checks if all Trunks are paused; toggles pause state for all, sets idle status if resuming; renders; shows appropriate toast. |
| `ph-allowall` | Phone › Inbox › "Allow all N" button | — | Calls `ACTS.ask()` for each pending approval with `v='allowed'` and renders. |
| `rec` | Recommendations card › Yes, Not now, Never buttons | `data-k` (kind: 'gw' or 'upd'), `data-v` ('yes', 'later', 'never') | Sets `S[kind].asked = true`; if 'yes', sets mode on and unlocks achievement; if 'later', shows "ask again tomorrow"; renders. |
| `scope` | Mode menu › Applies to › "This conversation" or "Everywhere" button | `data-v` (here\|everywhere) | Sets S.scope to the value, rerenders, reopens modemenu2 popover |
| `self-apply` | Self-update card › Apply button | `data-id` (block ID) | Gets button's bounding rect, calls f(el), triggers leafBurst animation |
| `self-no` | Self-update card › Not now button | `data-id` (block ID) | Sets block state to "back", rerenders |
| `self-undo` | Self-update card › Roll back button | `data-id` (block ID) | Sets block state to "back", adds entry to S.selfLog, rerenders, shows "Rolled back." toast |
| `set-mode` | Mode menu › a mode option | `data-v` (mode ID) | Sets S.modeDefault or S.convMode depending on S.scope, syncs mode word, closes popover, rerenders, shows mode name in toast |
| `suggest` | Suggestion card › automation button | `data-id` (block ID), `data-v` (made\|no) | Sets block state, if "made" adds to automations.scheduled, rerenders, shows "Added to Automations › Scheduled." toast |
| `think` | Mode menu › Thinking › button | `data-v` (Quick\|Normal\|Deep) | Sets S.think, rerenders, reopens plusmenu popover |
| `v-ans` | Voice answer card › Yes/No button | `data-id` (ask ID), `data-v` (allowed\|denied) | Calls ACTS.ask() to process the answer, if spoken unlocks "Answered by voice", rerenders voice UI |
| `v-end` | Voice call › End button | — | Clears voice state, adds spoken lines to conversation thread, rerenders, shows "Call ended. What was said is in the conversation." toast |
| `v-mute` | Voice call › Mute button | — | Toggles S.voice.muted, rerenders voice UI |
| `who` | Mode menu › Who answers › radio button | `data-v` (who name) | Sets S.whoBy[S.chat] to who, closes popover, if room unlocks "Room for two", shows who change toast |
| `xdo` | Inbox › extra request › button | `data-id` (request ID), `data-v` (allowed\|denied) | Sets request state in inboxExtra, rerenders, shows "{tool} installed for {trunk}." or "Nothing was installed." toast |

### A.5 Computer and browser (16)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `br-take` | Scout pane (browser section) › "Take over" or "Hand back" button | `data-v` = take or back | Sets `S.browserTaken`, updates Scout's computer block state if active, re-renders. Toast indicates control handoff. |
| `comp-grid` | Stage (browser preview) › "All screens" tab | — | Sets `S.stageGrid = true`, re-renders to show grid of all computer screens. |
| `comp-view` | Stage › computer tabs or grid cell | `data-v` = computer ID | Sets this Trunk's computer, exits grid view, re-renders. |
| `machine` | Menu › Talk to the assistant on… | v | Switches to specified machine; shows toast with machine name |
| `machines` | Sidebar › machine selector menu | — | Opens menu showing workspace and available machines |
| `ph-comp` | Phone › chats › computer status, or thumbnail | `data-id` (chat/trunk id) | Sets `S.ph.chat`, calls `phGo('computer')`, renders. |
| `ph-stop8` | Phone › computer view › Stop button | — | Temporarily sets `S.chat = S.ph.chat`, calls `stopWork()`, restores, calls `phGo('chat')`, renders. |
| `rc-save` | "Rename this computer" dialog › Save button | `data-i` (machine index) | Reads name input, updates `machines[i][0]`, closes dialog, renders, shows toast "Renamed.". |
| `renamecomp` | Settings › Computers › machine › edit button | `data-i` (machine index) | Opens dialog with name input pre-filled from `machines[i][0]`, focuses input. |
| `stage` | Stage view › show dropdown or pip display › a stage option | `data-v` (computer\|browser), `data-id` (chat ID) | Sets S.stage and S.chat, clears S.pip and S.stageStep, sets S.view to "chat", closes popover, rerenders |
| `stage-close` | Stage view › back button | — | Sets S.stage to null, rerenders |
| `stage-dock` | Stage view › panel toggle button | — | Toggles S.dock, rerenders |
| `stage-pip` | Stage view › picture-in-picture button | — | Sets S.pip to {kind: S.stage, chat: S.chat}, clears S.stage, rerenders |
| `stage-step` | Stage view › step buttons | `data-v` (step index or "live") | Sets S.stageStep to step index or null for live, rerenders |
| `stage-stop` | Stage view › Stop button | — | Calls stopWork(), sets S.stage to null, rerenders |
| `takeover` | Stage view › Take over button | `data-id` (block ID) | Gets block by ID, sets state to "yours", sets Scout status to idle, rerenders, shows "You have the mouse. Scout is paused." toast |

### A.6 Places (18)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `bmove15` | Board card › ⋯ | `data-id` = card id | Opens the "Move to" popover listing the five columns. |
| `bto15` | "Move to" popover › a column | `data-id` = card id, `data-v` = column | Moves the card; toast "Moved to <column>." (Dragging a card onto a column does the same.) |
| `cutgo15` | Inbox card "Pick up what the update cut off" › Pick it up | — | Opens the cut-off task's conversation and toasts where it picked up. |
| `cutno15` | Inbox card › Leave it | — | Removes the card. |
| `dv15` | Library › Documents › List / Map | `data-v` = list or map | Switches the Documents view; Map draws the knowledge map. |
| `idea15` | An idea card (section or dialog) | `data-i` = idea index | Goes to Automations › Scheduled and fills the describe box with that idea; toast "Filled in. Change anything, then Add." |
| `ideas15` | Automations › Scheduled › Ideas › "See all 13" | — | Opens "Ideas for automations", all 13 grouped by Money, Mornings, Home, Research and Work. |
| `mem` | Button › Remember | id, v | Marks message as kept/forgotten; adds to memory if kept; re-renders |
| `memarch15` | Memory ⋯ › Archived facts | — | Opens "Archived facts" with Restore per fact and Purge all. |
| `memexp15` | Memory ⋯ › Export / Save a full archive | `data-v` = zip for the archive | Toast naming the saved file (branch-memory.jsonl or Branch-memory-archive.zip). |
| `memmore15` | Library › Memory › ⋯ | — | Opens Export, Save a full archive, Archived facts, and (Advanced) Memory settings. |
| `selfdo15` | Self-change review › Approve the edits / Publish the draft / Decline | `data-v` = editing, published or gone | Advances the stage (the dialog stays open after approving edits), publishes the draft, or declines; toast for each. |
| `selfrev15` | Inbox › Needs you › "Branch wants to improve itself" › Review | — | Opens "A change to Branch’s own code": scope tiles, the bounded diff, and the two stages. |
| `tidy15` | Library › Memory › "Tidy up" | — | Opens "Tidy up memory": Said twice, Disagree, Not used in 120 days, each with Leave it and an action. |
| `tidydo15` | Tidy up dialog › Leave it / Merge them / Keep the newer one / Archive it | `data-v` = row kind, `data-x` = skip | Marks that row done ("Done" or "Left as it is") without closing the dialog. |
| `tt15` | Flow editor › "Last run" › a step dot | `data-v` = step index | Selects (or clears) that step and shows what it had at that moment. |
| `ttback15` | Flow editor › "Go back to this step" | — | Toast: runs a copy from that step; the real run is untouched. |
| `verify15` | Inbox › History › "Record intact · Verify" | — | Opens "Checking the record"; after 1.3 s (instant with reduced motion) shows "Record intact" and the entry count; at Technical also the chain head. |

### A.7 Customize and Trunks (38)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `addcomp` | Customize › Computers › context menu › "Add a computer or phone…" | — | Closes popover, calls `addComputer('network')` to start network-based computer addition. |
| `comp-add` | Customize › Computers › "Add a computer" button | — | Calls `addCompDlg()` to open computer addition dialog. |
| `comp-add-go` | Computer type selection dialog › computer type button | `data-v` = type (network, ssh, cloud, etc.) | Calls `addCompDlg(type)` to continue with that type. |
| `comp-chip` | Customize › Trunk config › Computers row › computer chip | `data-id` = Trunk ID, `data-v` = computer ID | Toggles computer in Trunk's allowed list, re-renders. |
| `comp-cloud` | KeepOak cloud computer dialog › size button | `data-v` = size (Small, Standard, Large) | Adds KeepOak cloud computer to `COMPUTERS` with size and current timestamp ID, closes dialog, re-renders. Toast: "KeepOak computer 2 is starting. It's ready in about a minute." |
| `comp-max` | Customize › Trunk config › "At once" buttons (1–4) | `data-id` = Trunk ID, `data-v` = max number | Sets max concurrent computer use for Trunk, re-renders. |
| `comp-pick` | Stage › top › computer dropdown button (when multiple available) | — | Opens popover with `POPS.comps()` listing available computers. |
| `comp-set` | Computers popover › single-select menu item | `data-v` = computer ID or "none" | Sets computer for current Trunk, closes popover, re-renders. Toast: "[Trunk name] won't use a computer." or "[Trunk name] uses the [computer name] from its next step." |
| `comp-toggle` | Computers popover (multi-select mode) › menu item | `data-v` = computer ID | Toggles computer in Trunk list, re-renders and reopens popover. Toast: "[Trunk name] may use [count] computer[s]." |
| `dev-col` | Device pairing dialog › color button | `data-v` = hex color | Saves name input, sets color, redraws naming dialog via `drawNameDev()`. |
| `dev-glyph` | Device pairing dialog › glyph button (icon picker) | `data-v` = glyph name | Saves name input, sets glyph, redraws naming dialog. |
| `dev-save` | Device pairing dialog › "Save" button | — | Reads name input, closes dialog, inserts device into machines list, re-renders. Unlocks "Paired". Toast: "Paired with [name]. Its Trunks show in the switcher." |
| `devtab` | Customize › tabs (Trunks, Library, etc.) | `data-v` = tab name | Sets `S.dev`, re-renders. |
| `edit` | Customize › Trunks › Trunk row › "Edit" button | `data-id` = Trunk ID | Calls `editTrunk()` to open Trunk editor dialog. |
| `emo15` | Trunk editor › Look › "Or an emoji face" | `data-v` = emoji, empty for None | Gives the Trunk an emoji face (drawn on its coloured pebble everywhere) or removes it. |
| `flow` | Customize › Library › automation › "Open" button | `data-i` = procedure index | Loads procedure steps into editor, calls `drawFlow()`. |
| `flow-add` | Flow editor › "Add a step" button | — | Pushes new step, redraws flow, focuses new input. |
| `flow-mv` | Flow editor › "Move up" or "Move down" button | `data-j` = step index, `data-d` = +1 or -1 | Swaps steps, redraws flow diagram. |
| `flow-rm` | Flow editor › "Take it out" button | `data-j` = step index | Removes step from array, redraws flow. |
| `flow-run` | Flow editor › "Run" button | — | Toast: "Running [procedure name]. Steps show in its conversation." |
| `flow-save` | Flow editor › "Save" button | — | Validates steps (no empty text), updates `PROCS[name]`, updates procedure's when text. Closes dialog, re-renders. Toast: "Saved. It runs the new way next time." |
| `grp-make` | Button › Cancel | — | Saves group chat; plays leaf-burst animation from button position |
| `grp-new` | New group chat dialog › settings control | — | Updates group chat settings; reopens dialog |
| `grp-pick` | New group chat dialog › member picker | k, v | Updates group chat settings; reopens dialog |
| `grp-rule` | New group chat dialog › rule control | v | Updates group chat settings; reopens dialog |
| `mk-create` | Button › Make Quill | — | Performs a visual leaf-burst animation effect |
| `mk-go` | Button › Cancel | — | Closes dialog; posts Trunk creation request with description to Branch |
| `mk-new` | Sidebar › + menu › "Have Branch make a Trunk" | — | Opens dialog titled "Have Branch make a Trunk" |
| `mk-no` | Button › Make Quill | id | Marks proposal as rejected; re-renders |
| `pat15` | Customize › Specialists › a pattern card | `data-v` = pattern id | Chooses how Trunks work together; toast "<pattern>: used for rooms and big tasks from now on." |
| `st-anim` | Edit Trunk dialog › How it moves › button | `data-v` (none\|breathe\|bob) | Sets animation on trunk definition, calls keepFields() and editTrunk.state.draw() |
| `st-colour` | Edit Trunk dialog › Colour › swatch | `data-v` (color hex) | Sets trunk color, calls keepFields() and editTrunk.state.draw() |
| `st-eyes` | Edit Trunk dialog › Eyes › button | `data-v` (round\|wide\|sleepy) | Sets trunk eyes, calls keepFields() and editTrunk.state.draw() |
| `st-save` | Edit Trunk dialog › Save button | — | Calls _stsave(), unlocks "Dressed up" achievement |
| `st-shape` | Edit Trunk dialog › Shape › button | `data-v` (shape index number) | Sets trunk shape as number, calls keepFields() and editTrunk.state.draw() |
| `st-shuffle` | Edit Trunk dialog › Shuffle button | — | Randomly selects color, shape, and eyes for trunk, calls keepFields() and editTrunk.state.draw() |
| `st-tab` | Edit Trunk dialog › tabs (Look, What it may do) | `data-v` (tab ID) | Calls keepFields(), sets editTrunk.state.tab to the tab ID, calls editTrunk.state.draw() |
| `tmpl` | Templates › a template card › Use this job button | `data-i` (template index) | Creates new Trunk from template with preset role, color, shape, eyes; adds to chats; opens it; shows "{name} is ready." toast |

### A.8 Tools and connectors (28)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `ag-add` | Tools › Agents › agent type button (card, studio, ko) | `data-v` = agent type (card, pair, or ko) | Adds agent to `TOOLS9.agents`, navigates to Customize › Tools › Agents, displays toast with agent name. |
| `cli-add` | Tools › CLIs › "Allow" button | `data-v` = CLI name, `data-ver` = version, `data-d` = description | Adds CLI to `TOOLS9.clis`, replaces button with "Allowed" pill. Toast: "[CLI] is allowed. It asks before every command until you say which it may run." |
| `mcp-add` | Customize › Tools › Add MCP server button | v | Adds MCP connector from catalog; shows tool picker; shows toast |
| `mcp-cat` | Customize › Tools › MCP catalog filter button | v | Filters MCP catalog by selected category; reopens dialog |
| `mcp-save` | Button › Test it | — | Adds custom local MCP server; closes dialog; shows toast |
| `mcp-test` | Button › Test it | — | Shows test result: 3 tools available (sample demo) |
| `pal` | Palette › menu item | `data-i` (item index) | Gets the item from `palItems`, closes dialog, and calls `it.run()`. |
| `ph-lib` | Phone › navigation (from various screens) | — | Navigates to Library tab on phone surface |
| `ph-lib8` | Phone › Library › Memory/Documents tab | `data-v` (tab) | Sets `S.ph.libTab` and renders. |
| `plug-add` | Customize › Tools › plugin card › button | `data-v` (plugin name), `data-d` (description) | Adds plugin to `TOOLS9.plugins`, closes dialog, switches to Tools tab, shows toast. |
| `prompt-new` | Customize › Prompts › "New prompt" button | — | Opens dialog to create new saved prompt. |
| `prompt-save` | Prompt creation dialog › Save button | — | Validates name, command, and text; pushes to `PROMPTS`, closes dialog, renders, shows toast `/cmd`. |
| `replay` | History card › "Watch a task again" button | — | Opens wide dialog with replay controls (Step, Play) and options to save or make workflow. |
| `rev` | Tools › revision card › radio buttons | `data-v` ('tried', 'kept', 'gone') | Sets `S.rev` and shows toast based on the value. |
| `rp` | Replay dialog › Step or Play button | `data-v` ('step' or 'play') | If 'step', advances to next frame; if 'play', auto-plays from current frame with 800ms intervals. |
| `sk-draft` | Add skill dialog › Draft it button | — | Reads textarea #sk-what, writes preview HTML to #sk-draft with YAML and steps |
| `sk-save` | Add skill dialog › Add skill button | — | Adds skill to TOOLS9.skills array, closes dialog, navigates to Customize › Tools, shows "price-watch is added." toast |
| `sk-src` | Add skill dialog › source option buttons | `data-v` (lib\|file\|git\|write) | Calls toolAdd for write mode; for others, closes dialog, adds skill template, updates view, shows toast |
| `sugg15` | Customize › Tools › Skills › "Suggested for you" › Add | `data-v` = skill id | Adds the skill (off for every Trunk until chosen) and removes it from the suggestions. |
| `t9-kind` | Tools › kind navigation | `data-v` (kind ID) | Sets S.tools9.k to kind, sets S.tools9.sel to first item in that kind, sets S.tabs.customize to "tools", rerenders |
| `t9-own` | Tools › Add own server button | — | Calls toolAdd("mcp", "own") |
| `t9-sel` | Tools › item list › a tool button | `data-v` (tool ID) | Sets S.tools9.sel to the tool ID, sets S.tabs.customize to "tools", rerenders |
| `tool-add` | Tools › kind navigation button or Add dialog | `data-v` (kind: mcp\|skills\|clis\|plugins), `data-step` (optional) | Closes popover, calls toolAdd() with kind and optional step |
| `tool-rm` | Tool detail › Remove button | `data-k` (kind), `data-id` (tool ID) | Removes tool from TOOLS9[kind] array, resets selection, rerenders, shows "{name} removed." toast with undo |
| `tool-who` | Tool detail › Which Trunks may use it › chip | `data-k` (kind), `data-id` (tool ID), `data-v` (trunk ID) | Toggles trunk in tool's who array, rerenders |
| `tools-manage` | Tools › manage tools link | — | Closes popover, sets S.view to "customize" and S.tabs.customize to "tools", rerenders |
| `tools9` | Composer › Tools button | — | Clears S.toolQ, opens popover with toolsHub(), adds pop9 class |
| `widget6` | Tools › widget code › Get the snippet button | — | Opens dialog with widget embed code and preview |

### A.9 Chat apps (10)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `ch-fam` | Chat apps › family filter buttons | `data-v` = family (core, messaging, social, etc.) | Sets `S.ch12.fam`, redraws channels grid or full page. |
| `ch-open` | Chat apps › app card | `data-v` = app ID | Clears wizard state, starts `chWizard()` setup or management flow. |
| `chf-eye` | Chat app setup wizard › secret field › eye icon | `data-k` = field key | Toggles field visibility between password and text input. |
| `chw-back` | Chat wizard dialog › "Back" button | — | Moves back one step via `chWizard()`. |
| `chw-next` | Chat wizard dialog › "Continue" or "Approve" button | — | Cleans code input, advances one step via `chWizard()`. |
| `chw-save` | Chat wizard dialog (Save step) › "Save" button | — | Marks app as connected (`S.ch12.on[id] = 'ok'`), closes wizard, re-renders. Toast: "[App name] is connected. Messages there reach Branch." Triggers `leafBurst()` and `unlock('Pen pal')`. |
| `ph-ch13` | Phone › Chat apps › app row | `data-v` (app id) | Sets `S.ph.ch13`, calls `phGo('chatapp')`, renders. |
| `ph-ch13-off` | Phone › Chat app detail › Disconnect button | `data-v` (app id) | Deletes `S.ch12.on[id]`, renders, shows toast "Disconnected...". |
| `ph-ch13-on` | Phone › Chat app detail › Connect button | `data-v` (app id) | Sets `S.ch12.on[id] = 'ok'`, renders, shows toast with app name. |
| `ph-chf13` | Phone › Chat apps › filter tabs | `data-v` ('on' or 'all') | Sets `S.ph.chF13` and renders. |

### A.10 Accounts and models (25)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `aa-back` | "Add an account" dialog › back button (step 2 or 3) | — | Resets to step 1, clears provider choice, and redraws the account-adding dialog. |
| `aa-done` | "Add account" dialog › "Add account" button (step 3) | — | Calls `finishAcct()` to save the account and close the dialog. Toast: account name now showing in the Accounts section. |
| `aa-gone` | Account card in Accounts section (when available) | `data-v` = provider ID | Toast: "This service is retired. The connection stays listed with a warning and is never used." |
| `aa-grp` | "Add an account" dialog › tab group (service categories) | `data-v` = group ID | Sets selected group, redraws the account-adding dialog to show services in that group. |
| `aa-key` | "Add account" dialog › "Add key" button (step 2, key-based services) | — | Advances to step 3 (key entry), redraws the dialog. |
| `aa-local` | "Add an account" dialog › link to local models | — | Closes dialog, navigates to Settings › On this computer (local model page). |
| `aa-nm` | "Add account" dialog › "Quick names" chips (step 2) | `data-v` = name preset (e.g., "Service · Personal") | Fills the account name field, sets `S.addAcct.name`. |
| `aa-pos` | Account ordering dialog | `data-v` = position | Saves name input, sets position for the account, redraws dialog. |
| `aa-prov` | "Add an account" dialog › provider button (step 1) | `data-v` = provider ID | Selects provider, advances to step 2. If auth via sign-in (`how === 'plan'`), triggers sign-in flow via `addAcctSignin()`. |
| `aa-tr` | "Add account" dialog › Trunk toggle chips (step 3) | `data-v` = Trunk ID | Saves account name, toggles Trunk selection (adds or removes from `d.trunks` array). |
| `ac-pair` | "Add a computer or phone" dialog › "Pair" tab › "Pair" button (showing "Mac mini") | — | Pre-fills device name "Mac mini", glyph "desktop", color "#4F6FA8", and redraws naming dialog via `drawNameDev()`. |
| `ac-tab` | "Add a computer or phone" dialog › tab (Network or Pair) | `data-v` = tab (network or pair) | Clears wizard state, calls `addComputer()` with the tab type. |
| `acct-first` | Account context menu › "Answer first" | `data-i` = account index | Moves account to the beginning of the list. Toast: "[Account name] answers first now." |
| `acct-menu` | Account row › three-dot menu icon | `data-i` = account index | Opens popover menu with options: Answer first, Rename, Which Trunks use it, Sign out. |
| `acct-out` | Account context menu › "Sign out" | `data-i` = account index | Removes account from `ACCTS` array. Toast: "Signed out of [name]. Nothing else changed." |
| `acct-up` | Account row › up arrow button | `data-i` = account index (if > 0) | Swaps account with the one above (if not already first), re-renders. |
| `addacct` | Accounts › "Add an account" button, or account list › add button per provider | `data-v` = optional provider ID | Opens "Add an account" dialog via `addAcct()` for the provider (or shows all if null). |
| `low-x` | Status bar › low account balance notification › dismiss | — | Dismisses the low-account-balance notification; re-renders |
| `owner` | Status bar › owner button (person avatar and name) | — | Opens popover menu with `POPS.owner()` showing theme, person, settings, shortcuts, help, and lock options. |
| `ph-mode` | Phone › Model card › mode button | `data-v` (mode) | Sets `S.convMode[S.ph.chat]` and renders. |
| `ph-model` | Phone › Model card › model choice button | `data-v` (model name) | Sets `S.model.name`, clears `S.ph.sheet`, renders, shows toast. |
| `ph-plus` | Phone › compose › "Add to message" sheet option | `data-v` (option: 'Camera', 'Photos', etc.) | Clears `S.ph.sheet`, renders, shows toast describing the option. |
| `pick-model` | Composer › model menu › model radio button | `data-v` (model name) | Sets `S.model.name` and thinking level, if Qwen, changes mode to 'ask'; renders and reopens menu. |
| `pick-think` | Composer › model menu › thinking level radio | `data-v` ('Quick', 'Medium', 'Deep') | Sets `S.model.think`, renders, reopens menu. |
| `signin` | Settings › Add an account button | `data-v` (account provider) | Opens dialog: "Sign in to {provider}" with explanation and "Continue on their site" button |

### A.11 Local models (8)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `dl-go` | Settings › On this computer › model row › "Download" button | `data-i` = model index | Shows progress bar, simulates download with interval (9% increments every 220ms), updates progress text. On 100%, text shows "Ready. It shows under On this computer." |
| `download` | Settings › On this computer › "Get another model" button | — | Calls `downloadDlg()` to open model download dialog. |
| `lm-chat` | Button › Stop | — | Closes dialog; opens "branch" conversation to chat with running local model |
| `lm-get` | Button › Run it | id | Starts model download with progress tracking; unlocks achievement |
| `lm-rm` | Button › Say hello | id | Removes installed local model; re-renders |
| `lm-run` | Button › Say hello | id | Starts running the local model on port 11434; shows toast |
| `lm-stop` | Button › Stop | — | Stops model download; keeps partial download for next time |
| `lm-v` | Settings › On this computer › model variant button | id, v | Selects which quantization variant to download (small/balanced/full); re-renders |

### A.12 Settings (40)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `acbulk15` | Accounts bulk bar › Move to the top / Pause / Sign out | `data-v` = top, pause or remove | Acts on the ticked accounts (Move to the top reorders `ACCTS`), ends selection, toasts. |
| `acsel15` | Accounts (Advanced) › "Select several" / "Done" | — | Turns selection on or off; ticks appear on each account and a bulk bar above. |
| `ask16` | This Mac › "Allow…" (Microphone, Camera, Notifications); turning on the wake word without the microphone | `data-v` = mic, cam or notif | Shows the macOS-style alert "“Branch” would like to access the microphone." with a reason, Don't Allow and Allow. |
| `askdo16` | That alert › Don't Allow / Allow | `data-v` = permission, `data-x` = off for Don't Allow | Sets Granted or Turned off; after a refusal the row offers only "Open System Settings". |
| `doctor` | Settings › Engine › "Check and fix" button | — | Calls `_d(el)`, waits 2.1s, then inserts "Everything is healthy" confirmation message with confetti burst at target location. |
| `editfile` | Settings › Files › file row › "Edit" button | `data-f` = filename | Calls `editFile()` to open file editor. |
| `eval-run` | Settings › Usage › "Run the test" button | — | Sets `S.evalSt = 'running'`, re-renders. After 2.2s, sets to 'done' and re-renders if on Usage page. |
| `hb-every` | Settings › Automations › Check-ins › "How often" buttons | v | Sets heartbeat check interval; re-renders |
| `hb-rm` | Settings › Automations › Check-ins › "Remove" button | i | Removes a heartbeat check item; re-renders |
| `if-back` | Button › Put this back | f, i | Restores previous version of file into editor; shows toast |
| `if-open` | Settings › Instructions & personality › file button | f | Opens the specified file (SOUL.md, USER.md, etc.) in editor |
| `if-owner` | Action buttons | v | Sets whose files are shown (branch vs. selected owner); re-renders |
| `if-save` | Button › Cancel | f | Saves file; keeps previous version in history; closes dialog; shows toast |
| `if-write` | Button › Put this back | f | Generates template for file by examining current workspace; shows toast |
| `key15` | Keyboard shortcuts › a shortcut | `data-i` = action index | Starts listening; the next key press with Ctrl or Alt becomes the shortcut (clashes and bare keys are refused; Esc cancels). |
| `keyreset15` | Keyboard shortcuts › × beside a changed shortcut | `data-i` = action index | Puts back the default. |
| `mtab` | Dialog › Models | v | Switches models tab (Me/CloudGPT/Claude/On this computer); re-renders |
| `pin-add8` | Settings › Pins › "Pin a setting" button | — | Opens popover showing unpinned settings to choose from. |
| `pin-do8` | Popover › pinnable setting button | `data-n` (setting name), `data-s` (description) | Pushes `[name, desc]` to `S.pins`, closes popover, renders, shows toast. |
| `pin-ok` | Settings › "Enter PIN to switch" dialog › submit button | — | Validates PIN is 4 digits; if valid, sets `S.person = 0`, closes dialog, renders, shows toast "Welcome back...". |
| `pin-rm8` | Settings › Pins › unpinned setting › Unpin button | `data-i` (pin index) | Removes pin at index, renders, shows toast. |
| `ptab` | Settings › tabs or Inbox › History tab | `data-place` (view), `data-v` (tab id) | Sets `S.view` and `S.tabs[place]` to the tab, renders. |
| `rep15` | Data & usage › report card › 7 / 30 / 90 days | `data-v` = days | Switches the period. |
| `repopen15` | Data & usage › "Open the report" | — | Opens the usage report: totals, by model, by where it came from, by person, and Save as a spreadsheet. |
| `restart16` | "Restart Branch" (This Mac row or the in-chat card) | — | Shows "Reopening Branch…" for about 1.4 s, turns Screen Recording on, redraws with everything where it was, and toasts. |
| `setgo` | Various controls with data-act="setgo" (buttons/links leading to settings pages) | `data-v` (page ID) | Closes dialog, navigates to Settings page (permissions, usage, accounts, etc.), rerenders |
| `setlevel` | Settings › How much to show › difficulty buttons | `data-v` (regular\|advanced\|technical) | Sets S.level, rerenders, unlocks "Technical" achievement if technical is selected |
| `setpage` | Settings navigation › a settings page button | `data-v` (page ID) | Sets S.setPage to the page ID, rerenders |
| `shortcuts` | Menu › Keyboard shortcuts or Guide menu › Show all button | — | Closes popover, calls showShortcuts() |
| `sys16` | Settings › Permissions › This Mac › "Open System Settings"; the in-chat card; the System Settings sidebar | `data-v` = acc, scr, auto, fda, mic, cam or notif | Opens the System Settings window at that pane (in the real app: opens the real pane). Remembers the statuses from before, to report what changed. |
| `sysclose16` | System Settings › red traffic light, "Back to Branch", or Esc | — | Closes the window, re-checks every status, redraws and toasts what changed. |
| `sysflip16` | System Settings › the switch beside Branch (or Safari under Automation) | — | Off → shows the Touch ID sheet first; on → turns it off at once. Under Automation, toggles Safari. |
| `sysquit16` | Screen Recording sheet › Later / Quit & Reopen | `data-v` = later or now | Later closes the sheet (status stays "Restart to finish"); Quit & Reopen closes System Settings and reopens Branch. |
| `syssheet16` | Touch ID sheet › Cancel | — | Closes the sheet; nothing changes. |
| `systouch16` | Touch ID sheet › the fingerprint or "Use Password…" | — | Grants the permission. For Screen Recording it becomes "Restart to finish" and the quit-and-reopen sheet appears. |
| `updgo15` | Install dialog › Continue | — | "wait": closes and toasts that it installs when tasks finish. "now": installs, then Inbox offers to pick up what was cut off. |
| `updmenu-go` | Menu › Update to version or Menu › Update item | — | Closes popover, sets S.view to "settings" and S.setPage to "updates", rerenders |
| `updpick15` | Install dialog › Let them finish first / Install now | `data-v` = wait or now | Selects that option. |
| `widthset` | Appearance › Conversation width button | `data-v` (width value) | Sets S.width to the value (Comfortable/Wide/Full), rerenders |
| `ws` | Workspace selector menu | `data-v` (personal\|team) | Sets S.ws to workspace, if team sets S.view to "team", closes popover, rerenders, shows workspace change toast |

### A.13 Appearance, pets, scenes and looks (37)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `about` | Main menu › "About Branch" | — | Closes popover, opens "About Branch" dialog showing version "0.19.4", attribution "By KeepOak · Windows · a design prototype with example data." |
| `acc-save` | Appearance › Accent color › "Save as a theme" button | — | Saves current accent color as a theme via `startCed()` with current skin or 'branch' as base. |
| `acc-set` | Appearance › Accent color › color button | `data-v` = hex color or "theme" | Sets `S.accentOv` to the color (or null if "theme"), applies look, saves, and re-renders. |
| `ag-hide` | Agent window › hide button (X) | — | Sets `S.agentUI.show = false`, redraws agent window, toast: "Hidden. Bring it back in Appearance › Agents." |
| `ag-min` | Agent window › minimize/expand button | — | Toggles `S.agentUI.min`, redraws agent window via `agentWin12()`. |
| `ag-size` | Agent window › size picker (settings only) | `data-v` = size | Sets `S.agentUI.size`, re-renders. |
| `bg-peek` | Appearance › Background › "See it clearly" button | — | Adds 'peek' class to app (clears background), closes popover and dialog. |
| `bg-remove` | Appearance › Background (when set) › "Remove" button | — | Opens confirmation dialog: "Remove your background?" with "Keep it" and "Remove" buttons. |
| `bg-remove-yes` | Background removal dialog › "Remove" button | — | Revokes background object URL, sets `S.own = null`, `S.bg = 'none'`, closes dialog, re-renders. Toast: "Removed. Nothing is kept." |
| `bgfit` | Appearance › Background › fit option | `data-v` = fit mode | Sets `S.bgFit`, re-renders. |
| `bgset` | Appearance › Background › background option button | `data-v` = background name | Sets `S.bg`, re-renders. |
| `ce-acc` | Color editor dialog › accent color buttons | `data-v` = hex color | Calls `cedField('accent', color)`, updates all accent buttons' aria-pressed state. |
| `ce-cancel` | Color editor dialog › "Cancel" button | — | Calls `cedEnd(false)` to discard theme edits and close dialog. |
| `ce-fill` | Color editor dialog › "Fill in the rest from background, text and accent" button | — | Derives missing colors via `deriveEF()`, reopens editor dialog via `openCed()`. |
| `ce-mode` | Color editor dialog › Daylight/Moonlight buttons | `data-v` = light or dark | Saves name input, switches `S.ced.edit` mode, reopens editor. |
| `ce-new` | Appearance › Themes › "Make your own" button | — | Starts theme creation via `startCed()` with current skin or 'branch'. |
| `ce-save` | Color editor dialog › "Save theme" or "Save changes" button | — | Calls `cedEnd(true)` to save theme and close dialog. |
| `hide` | Appearance › "What's shown" section › checkbox | v | Hides the specified UI element (usage ring, gateway, pet, etc.); shows toast; re-renders |
| `look-set` | Edit Trunk › Look tab › look button | id, v | Changes Trunk appearance to selected look (Classic pebble, Branch, Ember, etc.); updates editor if open |
| `my-code` | Appearance › custom theme › theme code button | v | Opens dialog showing theme code (copies to clipboard) |
| `my-del` | Button › Edit | v | Opens delete confirmation dialog for theme |
| `my-del-yes` | Button › Keep it | v | Deletes custom theme; re-renders; shows toast |
| `my-dup` | Appearance › custom theme › duplicate button | v | Duplicates theme with " copy" suffix; shows toast |
| `my-edit` | Appearance › custom theme › edit button | v | Opens theme editor for selected custom theme |
| `my-paste` | Button › Paste a theme code | — | Opens dialog titled "Paste a theme code" |
| `my-paste-go` | Button › Cancel | — | Parses and adds pasted theme; closes dialog; shows toast |
| `petset` | Appearance › pet choice button | `data-v` (pet kind) | Sets `S.petChosen11 = true` and calls `_ps(el)`. |
| `petwhere15` | Appearance › The pet › "Where it walks" | `data-v` = side, status or dock | Moves the pet to the list, the status bar, or beside the message box (the last only on 1000 px and wider). |
| `scene-set` | Appearance › Scene picker › a scene thumbnail | `data-v` (scene ID) | Sets S.scene to the scene ID, sets S.bg to "painted", removes dataset.k11 from bgLayer, rerenders |
| `season` | Appearance › Scene picker › season button | `data-v` (season) | Sets S.season to the value, rerenders |
| `size` | Settings › Text size › button | `data-v` (small\|Regular\|large) | Deletes or sets document.documentElement.dataset.size, rerenders |
| `skin` | Appearance › Skins › a skin button | `data-v` (skin ID) | Applies skin, calls skinGallery(S.skinF) to rerender gallery |
| `skin-ph` | Phone appearance › a skin button | `data-v` (skin ID) | Applies skin, shows "{skin name} on every surface." toast |
| `skinf` | Skins dialog › category tabs | `data-v` (category) | Sets S.skinF to category, calls skinGallery(S.skinF) |
| `skinprev` | Skins dialog › light/dark mode switch | `data-v` (light\|dark) | Sets S.skinPrev to the mode, calls skinGallery(S.skinF) |
| `skins` | Settings › Skins › Browse skins button | — | Calls skinGallery(S.skinF) |
| `themeset` | Settings › Look › theme buttons or mirror panels | `data-v` (light\|dark\|system) | Calls setTheme() with theme value (or null for system) |

### A.14 Setup, walkthrough and first run (27)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `firstrun` | Main menu › "Replay the first run" | — | Calls `startFirst()` to begin first-run sequence. |
| `fr-acc` | First-run panel | i | Marks selected account as signed in; re-renders |
| `fr-next` | Button › Let’s start | — | Advances to next first-run screen; re-renders |
| `fr-recs` | Button › Next | — | Enables selected features (gateway/updates); advances first-run; re-renders |
| `fr-skip` | Button › Let’s start | — | Exits first-run walkthrough; stops download timer; re-renders |
| `fr-tmpl` | First-run screen › Trunk template button | i | Selects Trunk template; advances to template features screen; re-renders |
| `fr-tour` | Button › Take the 2-minute tour | — | Starts the guided tour |
| `fr-way` | Dialog › Getting Qwen3.6 ready | v | Selects model/mode (ChatGPT/Claude/computer/practice); may start download |
| `help` | Owner menu › "Guide: why each thing is here" or onboarding | — | Starts the guided tour |
| `ob-close` | Onboarding side panel › Skip for now button | — | Sets localStorage flag and calls `f(el)` (the handler passed in, which closes onboarding). |
| `ob-done` | Onboarding › Continue/Start button on final step | — | Sets localStorage flag and calls `f(el)`; button is disabled until 6 checks complete. |
| `ob-go` | Onboarding step list › step number button | `data-v` (step index) | Calls `openOnboarding(+el.dataset.v)` to navigate to that step. |
| `ob-gw` | Onboarding › gateway choice button | `data-v` (gateway choice) | Sets `S.ob.gw` and re-opens the current onboarding step. |
| `ob-next` | Onboarding › Continue button | — | Calls `openOnboarding(S.ob.i + 1)` to advance to next step. |
| `ob-propose` | Onboarding › "Let Branch propose Trunks" button | — | Reads textarea value, sets `S.ob.life`, `S.ob.proposed = true`, `S.ob.tpls = [0, 1, 5]`, and re-opens current step. |
| `ob-set` | Onboarding › provider choice button (where, people) | `data-k` (field), `data-v` (choice value) | Sets `S.ob[field]` to the chosen value and re-opens current step. |
| `ob-test` | Onboarding › "Say hello to test it" button | — | Sets `S.ob.tested = true` and re-opens current step. |
| `ob-tpl` | Onboarding › Trunk choice button | `data-i` (trunk index) | Toggles trunk index in `S.ob.tpls` array and re-opens current step. |
| `ob15` | Setup › Make it yours / Two more things | `data-k` = look, asks, mail15 or restore15; `data-v` = the choice | Stores the choice; `look` also changes the theme, `asks` sets the default mode; redraws the step. |
| `onboard` | Welcome card › "Set up" button or Guide menu › "Set up Branch" | — | Calls `closePop()`, `closeDlg()`, and `openOnboarding(0)` to start setup from step 0. |
| `teach-start` | Menu › Show it how, once or Automations › a button | — | Closes popover, sets S.teach to Trunk ID (prefers current if trunk), sets S.view and S.chat to that Trunk, rerenders |
| `teach-stop` | Conversation › teach mode bar › I'm done, save it button | — | Clears S.teach, adds new procedure to automations.procedures, rerenders, shows "Saved to Automations › Procedures." toast |
| `tour` | Welcome card › Walkthrough button or Menu › Take the tour | — | Calls startTour() |
| `tour-back` | Walkthrough card › Back button | — | Sets S.tourDir to -1, calls goTour(S.tourI - 1) |
| `tour-end` | Walkthrough card › Close/Skip button | — | Calls endTour() |
| `tour-next` | Walkthrough card › Next button | — | Sets S.tourDir to 1, calls goTour(S.tourI + 1) |
| `welcome-x` | Welcome card › X button | — | Saves "branch-proto-welcomed" to localStorage, removes welcome card |

### A.15 Phone app (22)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `comp-view-ph` | Phone app › Settings › computer tabs | `data-v` = computer ID | Sets computer for current Trunk in phone context, re-renders. |
| `lend15` | Phone › Settings › Lend this phone (and each ability); desktop "Stop lending" | `data-v` = on, cam, loc, photos or notif | Toggles lending or one ability; toasts when lending starts or stops. |
| `pair` | Settings › Connections › "Pair a phone" button | — | Calls `pairPhone()` to open the pairing dialog. |
| `ph-back` | Phone › chat view › back button | — | Sets `S.ph.scr = 'chats'` and renders. |
| `ph-back8` | Phone › various screens › back button | — | Sets `S.ph.scr` based on `PH_BACK` mapping or 'home'; clears `S.ph.sheet`. |
| `ph-cf` | Phone › chats › filter chips | `data-v` (filter: 'all', 'trunks', 'rooms', 'unread') | Sets `S.ph.chatF` and renders. |
| `ph-in` | Phone › Inbox › tab ('needs', 'done', 'hist') | `data-v` (tab id) | Sets `S.ph.inTab` and renders. |
| `ph-island` | Phone › floating action island | — | Toggles `S.ph.island` and renders. |
| `ph-new8` | Phone › chats or trunks › new button (FAB or icon) | — | Calls `newConv()`, sets `S.ph.chat`, calls `phGo('chat')`, renders. |
| `ph-open` | Phone › chats older layout › chat row | `data-id` (chat id) | Sets `S.ph.chat`, `S.ph.scr = 'chat'`, marks unread false, renders. |
| `ph-open8` | Phone › notifications or document list › row | `data-id` (id), `data-to` (optional screen) | Sets `S.ph.chat`, marks unread false, calls `phGo(data-to \| 'chat')`, renders. |
| `ph-paired` | Phone › pair screen › Connect button | — | Sets `S.ph.scr = 'chats'`, renders, shows toast "Connected...". |
| `ph-paired-dlg` | Phone pairing dialog › "The phone says it's paired" button | — | Closes dialog, shows toast "Paired...", unlocks "Pocket Branch" achievement. |
| `ph-scan` | Phone › Ledger › scan receipt button | — | Shows toast "Point the camera at a receipt or a page...". |
| `ph-scr` | Phone › compose › file button or sheet bg, or pair screen back | `data-v` (screen: 'chat', 'share', 'pair', 'settings') | If 'chat' and no chat set, defaults to 'ledger'; sets `S.ph.scr` and renders. |
| `ph-shared` | Phone › share sheet › Send button | — | Sets `S.ph.scr = 'chat'`, defaults `S.ph.chat` to 'ledger', adds message block to thread, renders, shows toast "Sent to Branch.". |
| `ph-sheet` | Phone › compose › "+", model button, or sheet bg | `data-v` (sheet type or empty) | Sets `S.ph.sheet` to the value (or null if empty) and renders. |
| `ph-sheet-model` | Phone › compose › model selector sheet | — | Shows model selection sheet in compose mode; calls phGo('chat') |
| `ph-sw` | Phone › settings › toggle switch (pair, lockdown, etc.) | `data-v` (setting key) | Cycles through ['off', 'when-needed', 'on'] and renders. |
| `ph-tab8` | Phone › bottom tabs | `data-v` (tab id: home, chats, inbox, etc.) | Calls `phGo(el.dataset.v)` and renders. |
| `ph-try8` | Phone › first-run overlay › try buttons | `data-v` (screen) | Optionally sets `S.ph.chat`, calls `phGo(el.dataset.v)`, renders. |
| `phtab` | Phone early version › bottom tabs | `data-v` (tab: 'chats', 'inbox', 'settings') | Sets `S.phTab` and renders. |

### A.16 Terminal (3)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `shell` | Settings › Terminal › a button | `data-v` (open\|close) | Sets S.shell.open to true/false, rerenders, focuses shell input after 0ms |
| `t-place` | Terminal › tabs | `data-v` (place ID) | Sets S.term.place to the place ID, rerenders |
| `t-sel` | Terminal › chat list › a chat row | `data-id` (chat ID) | Sets S.term.sel to the chat ID and S.term.place to "chat", rerenders |

### A.17 keepoak.com web (20)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `k10-aside` | KeepOak web › side panel toggle | — | Toggles side panel visibility; re-renders |
| `k10-bill` | KeepOak web › billing option button | v | Sets billing option (monthly/annual); re-renders |
| `k10-branch-people` | Button › see them in Branch | — | Opens desktop surface; navigates to Team › People view; re-renders |
| `k10-del` | KeepOak web › agent action menu › delete option | id | Closes menu; opens delete confirmation dialog |
| `k10-del-go` | Button › Cancel | — | Validates "DELETE" confirmation; closes dialog; shows sample deletion message |
| `k10-desk` | Button › Connect Branch | — | Shows toast; opens KeepOak desktop surface; sets computer context; re-renders |
| `k10-drawer` | KeepOak web › menu drawer toggle | — | Toggles main menu drawer visibility; re-renders |
| `k10-more` | Button › Open | id | Opens action menu for an agent (restart/repair/export/delete) |
| `k10-pair` | Button › Add my workspace | — | Advances to next pairing step (max step 4); re-renders |
| `k10-pair-x` | Button › They match | — | Resets pairing to step 0; re-renders |
| `k10-plan` | KeepOak web › plan option button | v | Shows toast confirming plan request (Operator/Power/Private) |
| `k10-quiet` | KeepOak web › quiet mode toggle | — | Toggles quiet mode (minimal UI); re-renders |
| `k10-rail` | KeepOak web › sidebar toggle | — | Toggles sidebar collapse; re-renders |
| `ko-approve` | Button › Don’t allow | — | Validates approval code; connects to KeepOak workspace |
| `ko-cancel` | Button › Open keepoak.com/activate | — | Closes dialog; sets ko status to "off"; re-renders |
| `ko-off` | Button › pen your KeepOak computer | — | Opens dialog titled "Disconnect keepoak.com?" |
| `ko-off-yes` | Button › Stay connected | — | Disconnects from KeepOak; resets to personal workspace; shows toast |
| `ko-start` | Button › Connect your keepoak.com account | — | Opens dialog titled "Connect keepoak.com" |
| `w-chat` | KeepOak web › chat list › a chat button | `data-id` (chat ID) | Sets S.web.chat to chat ID, sets S.web.route to "branch" if not already set, rerenders, scrolls to chat |
| `w-go` | KeepOak web › a navigation link or button | `data-v` (route) | Sets S.web.route from K10_OLD map or directly, sets S.web.drawer to false, rerenders, scrolls body to top |

### A.18 Team and sharing (12)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `invite` | Button › Edit | — | Opens invite dialog |
| `p-inv-go` | Team invite dialog › "Add them" or "Invite" button | — | Reads name from input, creates new person with id `'x' + Date.now()`, adds to `TEAM` and `PEOPLE10`, sets `S.pSel`, closes dialog, shows toast `"${n} is added."`. |
| `p-inv-tab` | Invite dialog › "this", "device", or "keepoak" tab | `data-v` (invite type) | Sets `S.pInvite` and calls `inviteDlg()` to redraw the dialog body. |
| `p-invite` | Team tab › "Invite someone" button | — | Calls `inviteDlg()` to open the invite dialog. |
| `p-open-team` | Team settings card › "Groups", "Signing in", or "What you share" button | `data-v` (tab id) | Sets `S.view = 'team'`, `S.tabs.team` to the tab, and renders. |
| `p-role` | Team › person row › Adult/Child button | `data-v` (role) | Sets the role for `S.pSel` person and renders. |
| `p-sel` | Team › person list › person button | `data-v` (person id) | Sets `S.pSel` to the selected person and renders. |
| `run-watch` | History › run row › Watch button | `data-i` (run index) | Opens dialog showing read-only task details: steps, questions, progress. |
| `share-tab` | Share dialog › tabs | `data-v` (tab), `data-k` (kind), `data-id` (ID) | Sets S.share10 to the tab, calls shareDlg with kind and ID |
| `share10` | Chat menu › Share… or Share this Trunk… | `data-k` (kind), `data-id` (ID) | Closes popover, sets S.share10 to "people", calls shareDlg with kind and ID |
| `team-invite` | Team › Invite someone button | — | Calls inviteDlg() to open invite dialog |
| `team-invite-go` | Invite dialog › Send invite button | — | Validates email from #inv-mail input, adds member to TEAM array, closes dialog, rerenders, shows "Invite sent to {email}." toast |

### A.19 Achievements and other (15)

| Action | Where | Reads | What it does |
|---|---|---|---|
| `ach-close` | Achievement unlock card › "Nice" button | — | Removes the `.ach-big` overlay element. |
| `achcat` | Achievements › category tabs | `data-v` = category name | Sets selected category, re-renders achievements list for that category. |
| `goal-fill` | Composer › + menu › "Set a goal" | — | Closes menu; inserts "/goal " into composer; focuses message field |
| `goal-st` | Button › Pause | v | Pauses/resumes/stops goal; shows toast; re-renders |
| `guide` | Owner menu › "Guide: why each thing is here" | — | Opens guide menu showing design notes, walkthrough, set up options |
| `gw-mode` | Menu › What it has been doing | v | Opens menu › gateway |
| `gw-prop` | Button › Use it | v | Accepts or rejects a gateway timing proposal; shows toast |
| `gw-restart` | Button › Use it | — | Closes menu; shows message about restart status |
| `gwpop` | Machines menu › gateway option | — | Opens gateway status and control menu |
| `handback` | Button › Take over | id | Hands block back to Scout; updates Scout state to working; shows toast; re-renders |
| `install` | Button › Install when nothing is running | — | Closes menu; shows installation progress bar (animated to 100%); shows completion toast |
| `note` | Guide menu › design note pin (or on-screen design note button) | k | Toggles design note visibility at click position; re-renders |
| `pat` | Pet canvas or video in sidebar | — | Increments `S.petPats`, calls `petSay(petWords())`, unlocks achievements at 10, 100 pats, shows random tip via `toast()`. |
| `pet` | Status bar › pet button | — | Increments `ACTS.tipI` through array of 5 tips, shows random tip via `toast()`. |
| `whatsnew13` | Guide menu › What's new item | — | Opens dialog showing NEW13 list with details and navigation |

Count check: 453 actions listed; the prototype defines 453.

---

## Appendix B. The owner's critiques (#1–#62)

The owner's numbered critiques from the redesign reviews, verbatim from `owner/OWNER-CRITIQUES.md` ("State" is as last recorded there).

Every critique the owner has given, with where it went and its state. Update this after every round.

| # | Critique | Where | State |
|---|---|---|---|
| 1 | "Text vomit", doesn't make sense | 0.18.1 calm screen | Done, merged |
| 2 | Message box "looks like shit" | 0.18.1 (real app) and sample | Done, merged (48d3295a); in sample |
| 3 | Atom icon on the Windows taskbar | 0.18.1 | Done, merged (88430db3) |
| 4 | Our logo missing (sprout stand-in) | Sample | Done (v3) |
| 5 | Theme pop-up too tight; give it its own place in Settings | Sample | Done (v4) |
| 6 | Menu doesn't close when its button is clicked again | Sample (v4, all menus); real app | Done in both (real app 8cb6225e) |
| 7 | Trunks all look the same; can't choose colour, photo, shape, animation | Sample | In progress |
| 8 | No way to edit a Trunk after it's made (right-click shows browser menu) | Sample | In progress, with #7 |
| 9 | Build the KeepOak-portal-style rail for Trunks; look like Hermes, OpenClaw, Claude and ChatGPT desktop; research keepoak.com themes and backgrounds | Sample | Done (v2+); keeps being refined |
| 11 | Where do I see my team mates? People invisible; Overview page empty; guide bar crowds the top | Sample | In progress |
| 12 | Chat bar too thick; more see-through but readable in every theme | Sample | In progress |
| 13 | Transparency slider in themes | Sample | In progress |
| 14 | Where do I connect my keepoak.com account? | Sample (proposal: Branch has no KeepOak account link today) | In progress |
| 15 | Conversation and chat bar too narrow; wasted space on wide screens | Sample | In progress |
| 16 | Where are the browser and terminal? Side-panel switch is 4 buttons, should be one | Sample | In progress |
| 17 | Where is the CodexBar (usage bar) feature? Exists in 0.18.1 but buried in Settings › Data & usage | Sample (visible indicator + popover; menu-bar version as proposal); real app later | In progress |
| 18 | Replies show our logo instead of the assistant's own look; status dots look broken | Sample | In progress |
| 19 | Don't skip any settings | Audit: 428 of 530 real settings missing (81%), 20 wrong defaults (6 turn on things Branch ships off), 15 unmarked extras. Sample settings being regenerated from a full inventory, verified 530/530 | In progress |
| 20 | Only Lockdown — want a permission-mode dropdown: Auto (greyed where unsupported), Ask, Plan, Full access | Sample | In progress |
| 21 | Use the real logos of providers and services (not lettered tiles) | Sample | In progress |
| 22 | Thinking options should depend on the provider/model | Sample | In progress |
| 23 | Loves "Who is using Branch" menu — keep (faces added with People update) | Sample | Keep |
| 24 | Theme preview squished in a wide box; Settings not using the width | Sample | In progress |
| 25 | Theme preview disappears when scrolling the grid; contrast numbers are jargon; Undo toast covers tiles | Sample | In progress |
| 26 | LOVES the dithered acorn "keeper.acorn · drag to turn" — protect it, don't change it | Sample | Keep |
| 27 | Rename computers; unclear what happens after pairing | Sample | In progress |
| 28 | "No auto update?" — it exists (autoUpdate: off/check/install, default off) but was hidden in a dropdown | Sample (choice cards, first-run question); real app: first-run question after 0.18.1 | In progress |
| 29 | No hover explanations; dropdowns use the system's blue highlight instead of liquid glass | Sample | In progress |
| 30 | OpenAI logo is a squashed wordmark; composer chips too squished; collapse to logos/icons when narrow; work at every size and aspect ratio | Sample | In progress |
| 31 | LOVES the usage popover ("What each connection has left") and the bottom ring — protect it; only the OpenAI tile gets the #30 symbol fix; build into the real app after 0.18.1 | Sample → real app | Keep |
| 32 | Choose which Trunk per conversation; several Trunks per conversation; group chats with @-mentions / click to @ | Sample | In progress |
| 33 | No live voice mode (like Codex/ChatGPT) and no dictation bar in the composer | Sample (dictation real in 0.18.1; live voice conversation likely proposal) | In progress |
| 34 | Loves the Add a Trunk studio (protect). Bug: "Another computer"/"Your phone" open separate dialogs with no tabs/Back; pairing a computer needs a terminal command (too technical) | Sample | In progress |
| 35 | No pets? — add optional pixel pets in the acorn's style (proposal, off by default) | Sample | In progress |
| 36 | Guide button's compass looks like a browser — make it a lightbulb | Sample | In progress |
| 37 | Settings should be a gear icon, right after the account dropdown | Sample | In progress |
| 38 | Expanded theme preview covers the screen; want smaller, side by side, and a live mirror of my actual screen in both light and dark | Sample | In progress |
| 39 | Put the "Clear the view" eye right of "Moonlight" in the theme row | Sample | In progress |
| 40 | Settings far thinner than Hermes/OpenClaw; can't edit AGENTS.md / SOUL.md / HEARTBEAT.md etc.; want Regular / Advanced / Technical slider controlling how much you see and can edit | Sample (Branch really supports these files — src/context-files.ts) | In progress |
| 41 | Remove the "KEEPER.ACORN · DRAG TO TURN" caption (overrides #26's keep-caption); acorn stays in place; pets live there, walk, act, talk with context tips | Sample | In progress |
| 42 | At 95% usage, a 5-second prompt to tell Trunks to checkpoint | Sample → real app | In progress |
| 43 | Loves the "Keep Branch up to date by itself? Recommended" bar (protect). Most important recommendation should be the always-on background gateway so Telegram-connected Trunks keep running when the app closes | Sample → real app | In progress |
| 44 | Same design for the CLI, Android, iPhone and macOS apps; phone layout is designer's call | Sample (terminal + phone frames) | In progress |
| 45 | Own background: picture, video, animation, 3D object, anything | Sample | In progress |
| 46 | 3D options (later real Blender/Higgsfield models) for Trunks, pets, acorn, background, with pixel kept alongside; beautiful animations; pairing ring looks spiky | Sample (procedural 3D stand-ins) | In progress |
| 47 | Can't resize panes like Claude (drag to resize, Ctrl+B) | Sample | In progress |
| 48 | Generated settings are "slop": endless "N settings · Show details" rows, scrolling chip bars, no logos/pictures; need smart buckets and inline controls; pet glitching, bubble clipped | Sample | In progress |
| 49 | "Hide" for every element (agents, usage bar, pets…); all hidden → only the gear + "It's lonely over here" achievement; an Achievements section (~500: KeepOak connected, own background, 100-day streak…) | Sample | In progress |
| 50 | Achievements: Bronze/Silver/Gold/Diamond/Godly ×100 + 5 near-impossible SSS+ (505); small toast in top bar ~7 s for regular; bigger pop-out + confetti party scaled by rank | Sample | In progress |
| 51 | Hints shrink with rank: Bronze/Silver get pet hints at most hourly; Gold and up get no hints | Sample | In progress |
| 52 | Panel footer clipped (eye and gear cut off); check all aspect ratios | Sample (automated sweep: sizes × panel widths × drawer × zoom) | In progress |
| 53 | Terminal/phone/tablet previews should be detailed, fully interactive; still can't find the in-app browser and terminal | Sample | In progress |
| 54 | Every click resets scroll to the top; level box covers "Updates & about" in the Settings nav | Sample | In progress |
| 55 | Pet speech bubbles keep flashing (two bubbles, "!hi" flickers) | Sample | In progress |
| 56 | Default theme = Slate (owner decision; real app ships Forest today → change in the redesign build) | Sample → real app | In progress |
| 57 | v11 regressions: pixel acorn replaced by a plain acorn; footer over-collapses to icons at normal width; header wraps; stray handle grip; pet over text | Sample | In progress |
| 58 | After Yes in the terminal view the composer collapses to a tiny box, chips vanish, usage warning squashed; drawer tabs wrap | Sample | In progress |
| 59 | Footer drops all text just before the panel folds (weird in-between state); "Theme · …" truncation | Sample | In progress |
| 60 | No logos in Secrets; raw internal labels there; letter tiles for Teams/IRC/Gotify etc. | Sample | In progress |
| 61 | Manage many accounts across providers easily (Accounts page, assignment, fallback order) — within provider terms; no ban/limit evasion | Sample | In progress |
| 62 | Status chips overflow cards (password managers); sweep must cover every Settings page and chips | Sample | In progress |
| 10 | Benchmark: Branch 7.5/10, "game dashboard"; 10 recommendations | Sample (all 10); 0.18.1 (message box, no glow behind forms) | Done |
